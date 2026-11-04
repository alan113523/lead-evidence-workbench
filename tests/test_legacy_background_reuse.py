"""Synthetic regressions for old judgments, pinned sources and distinct coverage."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import background_reuse as reuse
from buyer_background_view import background_view


class LegacyTraceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.row = {'store_key': 'synthetic', 'inquiry_id': '101', 'row_key': 'S1',
                    'buyer_member_id': 'synthetic-member', 'excluded': False,
                    'business_model': '候选：Synthetic reseller', 'business_model_basis': 'Saved synthetic basis',
                    'business_model_uncertainty': 'Account ownership unconfirmed'}
        self.source = self.root / 'source.json'
        self.record = {**self.row, 'assessed_at': '2026-01-02T00:00:00Z'}
        self.pointer = '/rows/0'
        self.save_source()

    def save_source(self, *, keyed=False):
        content = {'synthetic:101': self.record} if keyed else {'rows': [self.record]}
        self.source.write_text(json.dumps(content), encoding='utf-8')
        self.source_ref = {'path': str(self.source), 'sha256': reuse.sha(self.source.read_bytes()), 'pointer': self.pointer}
        self.row['base_prior_ref'] = {k: v for k, v in self.source_ref.items() if k != 'pointer'}
        fields = {name: self.pointer + '/' + field for name, field in
                  [('summary', 'business_model'), ('basis', 'business_model_basis'),
                   ('uncertainty', 'business_model_uncertainty')]}
        if self.record.get('assessed_at'):
            fields['assessed_at'] = self.pointer + '/assessed_at'
        self.entry = {'store_key': 'synthetic', 'inquiry_id': '101', 'row_key': 'S1',
                      'axis': 'business_model', 'source': self.source_ref, 'fields': fields}

    def load(self, entry=None, pending=None):
        overlays = {}
        def ref(value):
            content = Path(value['path']).read_bytes()
            reuse.require(reuse.sha(content) == value['sha256'], 'changed source bytes')
            return json.loads(content)
        manifest = {'legacy_entries': [self.entry if entry is None else entry]}
        if pending is not None:
            manifest = {'legacy_pending': pending}
        receipts = reuse.load_legacy_entries(manifest, {('synthetic', '101'): self.row}, overlays, ref)
        return overlays, receipts

    def test_exact_trace_preserves_strings_date_and_is_not_v2(self):
        original = copy.deepcopy(self.row)
        overlays, receipts = self.load()
        traced = overlays[('synthetic', '101')]['legacy_traced']['business_model']
        view = background_view({**self.row, **overlays[('synthetic', '101')]}, [])
        self.assertEqual(traced['summary'], self.row['business_model'])
        self.assertEqual(traced['uncertainty'], self.row['business_model_uncertainty'])
        self.assertEqual(traced['assessed_at'], self.record['assessed_at'])
        self.assertEqual(view['business']['coverage']['state'], '旧结论已追溯')
        self.assertEqual(view['business']['claims'], [])
        self.assertFalse(any(d['sources'] for d in view['dimensions']))
        self.assertEqual(self.row, original)
        self.assertEqual(len(receipts), 1)

    def test_final_changed_summary_basis_or_uncertainty_rejects(self):
        for field in ['business_model', 'business_model_basis', 'business_model_uncertainty']:
            with self.subTest(field=field):
                saved = self.row[field]
                self.row[field] = 'Different frozen field'
                with self.assertRaisesRegex(ValueError, 'differs'):
                    self.load()
                self.row[field] = saved

    def test_source_not_declared_by_this_row_or_changed_bytes_rejects(self):
        saved = self.row.pop('base_prior_ref')
        with self.assertRaisesRegex(ValueError, 'not pinned'):
            self.load()
        self.row['base_prior_ref'] = saved
        self.source.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed source'):
            self.load()

    def test_other_semantic_fields_cannot_masquerade_as_axis_or_date(self):
        self.record['other_basis'] = self.record['business_model_basis']
        self.record['other_date'] = self.record['assessed_at']
        self.save_source()
        for field, replacement in [('basis', 'other_basis'), ('assessed_at', 'other_date')]:
            entry = copy.deepcopy(self.entry)
            entry['fields'][field] = self.pointer + '/' + replacement
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'semantic role|retained'):
                self.load(entry)

    def test_keyed_decision_without_date_keeps_missing_date(self):
        self.pointer = '/synthetic:101'
        self.record = {k: v for k, v in self.record.items() if k not in ['store_key', 'inquiry_id', 'assessed_at']}
        self.save_source(keyed=True)
        overlays, _ = self.load()
        self.assertIsNone(overlays[('synthetic', '101')]['legacy_traced']['business_model']['assessed_at'])

    def test_exact_root_key_does_not_override_conflicting_explicit_identity(self):
        self.pointer = '/synthetic:101'
        self.record['store_key'] = 'other-store'
        self.save_source(keyed=True)
        with self.assertRaisesRegex(ValueError, 'identity conflict'):
            self.load()

    def test_wrong_source_row_or_member_rejects(self):
        for field in ['row_key', 'buyer_member_id']:
            saved = self.record[field]
            self.record[field] = 'other'
            self.save_source()
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'row mismatch|member mismatch'):
                self.load()
            self.record[field] = saved

    def test_original_date_must_not_be_suppressed(self):
        entry = copy.deepcopy(self.entry)
        del entry['fields']['assessed_at']
        with self.assertRaisesRegex(ValueError, 'date must be retained'):
            self.load(entry)

    def test_target_key_and_excluded_row_rejects(self):
        entry = copy.deepcopy(self.entry)
        entry['inquiry_id'] = 'other'
        with self.assertRaisesRegex(ValueError, 'target scope'):
            self.load(entry)
        self.row['excluded'] = True
        with self.assertRaisesRegex(ValueError, 'target scope'):
            self.load()

    def test_pending_requires_actual_uncertainty_difference_and_preserves_reason(self):
        self.record.pop('business_model_uncertainty')
        self.save_source()
        pending = [{k: self.entry[k] for k in ['store_key', 'inquiry_id', 'row_key', 'axis']}]
        pending[0]['checked_sources'] = [self.source_ref]
        overlays, _ = self.load(pending=pending)
        view = background_view({**self.row, **overlays[('synthetic', '101')]}, [])
        self.assertEqual(view['business']['coverage']['state'], '待适配')
        self.assertIn('不确定性', view['business']['coverage']['reason'])
        self.assertFalse(view['business']['legacy_review'])
        self.record['business_model_uncertainty'] = self.row['business_model_uncertainty']
        self.save_source()
        pending[0]['checked_sources'] = [self.source_ref]
        with self.assertRaisesRegex(ValueError, 'must actually differ'):
            self.load(pending=pending)

    def test_duplicate_axis_entry_and_pending_cannot_both_apply(self):
        manifest = {'legacy_entries': [self.entry, self.entry]}
        with self.assertRaisesRegex(ValueError, 'duplicate legacy axis'):
            reuse.load_legacy_entries(manifest, {('synthetic', '101'): self.row}, {},
                                      lambda source: json.loads(self.source.read_bytes()))


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.row = {'store_key': 'synthetic', 'inquiry_id': '101'}

    def test_unrecorded_and_insufficient_axes_remain_distinct(self):
        view = background_view({**self.row, 'business_model': '待判断'}, [])
        self.assertEqual(view['business']['coverage']['state'], '未调查')
        view = background_view({**self.row, 'business_model': '证据不足：已核对聊天', 'business_model_basis': 'No clear statement'}, [])
        self.assertEqual(view['business']['coverage']['state'], '资料不足')

    def test_public_search_failure_applies_only_to_identity(self):
        view = background_view({**self.row, 'diligence': {'status': '已实际公开检索，主体仍待确认'}}, [])
        self.assertEqual(view['dimensions'][0]['coverage']['state'], '查过无结果')
        self.assertEqual(view['purpose']['coverage']['state'], '未调查')
        self.assertTrue(all(d['coverage']['state'] == '未调查' for d in view['dimensions'][2:]))

    def test_saved_profile_review_precedes_stale_flat_pending_text(self):
        row = {**self.row, 'unit_key': 'synthetic-unit', 'business_model': '待判断', 'purchase_purpose': '待判断',
               'profile': {'schema_version': 'lew.buyer-profile.v2', 'unit_key': 'synthetic-unit',
                           'business_model': {'status': 'insufficient', 'claims': []},
                           'purchase_purpose': {'status': 'insufficient', 'claims': [], 'inquiry_scope': None}}}
        view = background_view(row, [])
        self.assertEqual(view['business']['coverage']['state'], '资料不足')
        self.assertEqual(view['purpose']['coverage']['state'], '资料不足')

    def test_public_candidate_is_pending_and_does_not_become_company_verified(self):
        view = background_view({**self.row, 'diligence': {'status': '已补公开证据，五类核验有限覆盖'}}, [])
        self.assertEqual(view['dimensions'][0]['coverage']['state'], '待适配')
        self.assertIsNone(view['entity_record'])
        self.assertEqual(view['formal'], '未执行正式v3')

    def test_missing_anchor_is_insufficient_and_never_searched_no_result(self):
        view = background_view({**self.row, 'diligence': {'status': '已复核可见材料，公开主体待补证'}}, [])
        self.assertEqual(view['dimensions'][0]['coverage']['state'], '资料不足')

    def test_current_public_result_precedes_different_historical_result(self):
        for current, previous, expected in [
            ('已补公开证据，五类核验有限覆盖', 'searched_no_match', '待适配'),
            ('已实际公开检索，主体仍待确认', 'usable_public_context', '查过无结果'),
        ]:
            view = background_view({**self.row, 'diligence': {'status': current},
                                    'background_gap_review': {'final_category': previous}}, [])
            self.assertEqual(view['dimensions'][0]['coverage']['state'], expected)


if __name__ == '__main__':
    unittest.main()
