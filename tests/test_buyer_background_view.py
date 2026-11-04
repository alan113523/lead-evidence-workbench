"""Synthetic regressions for daily five-dimension projection and scope boundaries."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from buyer_background_view import background_view


class BackgroundViewTests(unittest.TestCase):
    def setUp(self):
        self.row = {"store_key": "syn-A", "inquiry_id": "101", "row_key": "R1", "unit_key": "syn-unit"}
        self.evidence = [{**self.row, "id": "E1", "use": "contact_matrix", "source_type": "公开来源候选",
                          "observed_at": "2026-10-28T09:00:00+08:00", "locator": "https://synthetic.invalid/contact",
                          "description": "仅公司公开渠道候选 </script><script>unsafe</script>"}]
        claim = {"label": "线上零售", "disposition": "candidate", "reason": "平台自报", "uncertainty": "未核实",
                 "evidence_refs": ["E1"]}
        self.row["profile"] = {"schema_version": "lew.buyer-profile.v2", "unit_key": "syn-unit",
                               "business_model": {"status": "initial", "claims": [claim], "summary": "经营候选"},
                               "purchase_purpose": {"status": "conflicted", "claims": [claim], "summary": "用途有冲突",
                                                    "inquiry_scope": {"store_key": "syn-A", "inquiry_id": "101"},
                                                    "conflicts": [{"reason": "保留冲突"}], "question": "请确认本次用途"}}

    def view(self):
        return background_view(self.row, self.evidence)

    def test_missing_data_has_five_gaps_and_no_completion(self):
        view = background_view({k: v for k, v in self.row.items() if k != "profile"}, [])
        self.assertEqual(len(view["dimensions"]), 5)
        self.assertTrue(all(not d["sources"] for d in view["dimensions"]))
        self.assertEqual(view["formal"], "未执行正式v3")
        self.assertEqual(view["purpose"]["claims"], [])

    def test_scoped_sources_dates_candidates_and_conflicts_retained_without_mutation(self):
        old = copy.deepcopy((self.row, self.evidence))
        view = self.view()
        self.assertEqual(view["dimensions"][4]["sources"][0]["observed_at"], self.evidence[0]["observed_at"])
        self.assertEqual(view["business"]["claims"][0]["state"], "candidate")
        self.assertEqual(view["purpose"]["state"], "conflicted")
        self.assertTrue(view["purpose"]["conflicts"])
        self.assertEqual((self.row, self.evidence), old)

    def test_wrong_store_inquiry_row_and_duplicate_refs_do_not_project(self):
        for key, value in [("store_key", "syn-B"), ("inquiry_id", "102"), ("row_key", "R2")]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.evidence)
                changed[0][key] = value
                self.assertEqual(background_view(self.row, changed)["sources"], [])
        self.evidence *= 2
        self.assertEqual(self.view()["sources"], [])
        self.assertEqual(self.view()["business"]["claims"], [])

    def test_missing_and_invalid_dates_and_locator_keep_explicit_gaps(self):
        for field, value in [("observed_at", "2026-10-28"), ("observed_at", "invalid"), ("locator", "")]:
            changed = copy.deepcopy(self.evidence)
            changed[0][field] = value
            view = background_view(self.row, changed)
            self.assertFalse(view["sources"])
            self.assertTrue(view["gaps"])

    def test_other_inquiry_purpose_and_wrong_profile_unit_not_reused(self):
        self.row["profile"]["purchase_purpose"]["inquiry_scope"]["inquiry_id"] = "102"
        self.assertEqual(self.view()["purpose"]["claims"], [])
        self.assertTrue(self.view()["business"]["claims"])
        self.row["profile"]["unit_key"] = "another-unit"
        self.assertFalse(self.view()["business"]["claims"])

    def test_legacy_source_is_context_and_not_verified_fact(self):
        self.row["diligence"] = {"public_sources": ["same name candidate"], "entity_status": "有候选", "gaps": ["归属待确认"]}
        view = self.view()
        self.assertEqual(view["entity"], "有候选")
        self.assertEqual(view["context_sources"], ["same name candidate"])
        self.assertEqual(view["formal"], "未执行正式v3")

    def test_legacy_evidence_without_id_displays_but_cannot_repair_claim_refs(self):
        del self.evidence[0]["id"]
        view = self.view()
        self.assertEqual(view["sources"][0]["id"], "展示来源-1")
        self.assertFalse(view["sources"][0]["explicit_id"])
        self.assertTrue(view["dimensions"][4]["sources"])
        self.assertFalse(view["business"]["claims"])

    def test_risk_and_entity_without_refs_are_not_projected(self):
        self.row['profile']['risk_assessment'] = {'status': 'reviewed', 'reason': 'unsupported', 'evidence_refs': []}
        self.row['profile']['entity_assessment'] = {'status': 'matched', 'reason': 'unsupported', 'evidence_refs': ['missing']}
        view = self.view()
        self.assertIsNone(view['risk_record'])
        self.assertIsNone(view['entity_record'])

    def test_inference_confidence_and_source_nature_survive_projection(self):
        claim = self.row['profile']['business_model']['claims'][0]
        claim.update(disposition='supported', inferred=True, confidence='low', source_natures=['platform_self_report'])
        projected = self.view()['business']['claims'][0]
        self.assertIs(projected['inferred'], True)
        self.assertEqual(projected['confidence'], 'low')
        self.assertEqual(projected['source_natures'], ['platform_self_report'])

    def test_flat_legacy_text_is_preserved_without_becoming_claims(self):
        row = {**self.row, 'profile': None, 'business_model': 'Synthetic old candidate',
               'business_model_basis': 'Synthetic old reference', 'purchase_purpose': '未明确',
               'entity_assessment': '未核验', 'assessed_at': '2026-10-21T10:00:00+08:00'}
        view = background_view(row, [])
        self.assertEqual(view['legacy']['business_model'], row['business_model'])
        self.assertFalse(view['business']['claims'])
        self.assertFalse(view['purpose']['claims'])


if __name__ == "__main__":
    unittest.main()
