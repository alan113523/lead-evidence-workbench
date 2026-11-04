"""Synthetic-only evidence cards, scoped originals, drafts and clipboard fallback."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_dashboard as dashboard
import followup_metrics as metrics

NODE = os.environ.get("NODE_EXECUTABLE") or shutil.which("node")
COPY_HARNESS = r"""
const fs = require('node:fs'), vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {setProperty() {}}; this.value = ''; }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener() {}
  focus() { this.focused = true; }
  select() { this.selected = true; }
  set innerHTML(_) { throw new Error('untrusted HTML insertion'); }
}
const nodes = {}, created = []; let copied = null;
const document = {
  getElementById(id) { return nodes[id] ||= new Element('div'); },
  createElement(tag) { const element = new Element(tag); created.push(element); return element; }
};
const navigator = input.mode === 'missing' ? {} : {clipboard: {writeText: async text => {
  if (input.mode === 'failure') throw new Error('clipboard denied'); copied = text;
}}};
const context = vm.createContext({document, navigator, innerWidth: 1600, console});
vm.runInContext(input.script, context);
(async () => {
  const drafts = created.filter(n => n.className === 'draft');
  const buttons = created.filter(n => n.tag === 'button' && n.textContent === '复制草稿');
  const statuses = created.filter(n => n.className === 'copy-status');
  const index = drafts.findIndex(n => n.value === input.draft);
  if (index < 0) throw new Error('target draft not rendered');
  await buttons[index].onclick();
  process.stdout.write(JSON.stringify({copied, selected: drafts[index].selected === true,
    focused: drafts[index].focused === true, status: statuses[index].textContent,
    quotes: created.filter(n => n.className === 'card-quote').map(n => n.textContent)}));
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


class EvidenceActionCardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.source = self.directory / "final-data.synthetic.json"
        self.message_path = self.directory / "messages.synthetic.jsonl"
        self.metric_path = self.directory / "metrics.json"
        self.records, rows, evidence = [], [], []
        cases = [("store-A", "101", "conv-A", "ma", "Need item __PERIOD__ __DATA__ <!--<script> </script><b>literal</b> details."),
                 ("store-A", "102", "conv-A", "mc", "Question only for inquiry 102."),
                 ("store-B", "101", "conv-B", "mb", "Separate store B requirement; I said I paid, receipt unverified.")]
        for store, inquiry, conversation, message_id, body in cases:
            key = "|".join([store, conversation, message_id])
            stamp = "2026-10-10T10:00:00+08:00"
            self.records.append({"key": key, "store_key": store, "conversation_id": conversation,
                                 "message_id": message_id, "inquiry_ids": [inquiry], "variants": [{"message": {
                                     "message_id": message_id, "direction": "buyer", "sent_at": stamp,
                                     "send_time_ms": metrics.parse_ms(stamp), "reply_source": "not_applicable",
                                     "automation_flags": {}, "content_status": "read", "text": body}}]})
            eid = f"e-{store}-{inquiry}"
            rows.append({"store_key": store, "inquiry_id": inquiry, "row_key": f"R-{store}-{inquiry}",
                         "created_at": "2026-10-01T00:00:00+08:00", "owner": "Opportunity Owner",
                         "quality": "好" if inquiry == "101" else "中", "deep_communication": "N", "excluded": False,
                         "next_action": f"复核{store}/{inquiry}仍待确认的资料", "quality_reason": "Synthetic reviewed decision",
                         "chat_status": "Synthetic visible scope only", "coverage_gaps": ["附件正文与到账未核实"],
                         "deal_status": "买家称已付款；未核实到账" if store == "store-B" else "未核实",
                         "reviewed_message_binding": {"messages_file": {"path": str(self.message_path)},
                             "messages": [{"message_key": key, "role": "current_inquiry_window"}]}})
            evidence.append({"id": eid, "row_key": rows[-1]["row_key"], "store_key": store, "inquiry_id": inquiry,
                             "use": "Synthetic scoped quote", "source_type": "bound chat", "observed_at": "2026-10-11T00:00:00+08:00",
                             "locator": str(self.message_path) + "#" + key, "description": "Review summary is not the original quote."})
        self.draft = "[SYNTHETIC DRAFT — not sent] Please identify the pending item details. Preserve __PERIOD__, <!--<script> and <b>literal</b>."
        rows[0]["action"] = {"status": "ai_proposed", "executed": False, "next_action": "复核买方所列item资料，勿推定产品能力",
                             "owner": None, "due_date": None, "evidence_refs": [evidence[0]["id"]], "steps": [
                                 {"window": "24h", "suggestion": "针对本条买方item资料核对缺项", "draft": self.draft,
                                  "evidence_refs": [evidence[0]["id"]]}]}
        self.data = {"schema_version": "lew.final-operational-data.v1", "analysis_before_exclusive": "2026-10-22T00:00:00+08:00",
                     "population_total": 3, "rows": rows, "evidence": evidence}
        self.refresh()

    def refresh(self):
        self.message_content = b"".join((json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8") for record in self.records)
        self.message_path.write_bytes(self.message_content)
        for row in self.data["rows"]:
            row["reviewed_message_binding"]["messages_file"]["sha256"] = hashlib.sha256(self.message_content).hexdigest()
        self.source.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        self.source_sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with contextlib.redirect_stdout(io.StringIO()):
            metrics.main(["--input", str(self.source), "--messages", str(self.message_path), "--out", str(self.metric_path)])
        self.result = json.loads(self.metric_path.read_text(encoding="utf-8"))

    def cards(self, messages=True):
        return dashboard.rows_for_page(self.data, self.result, source_sha256=self.source_sha,
                                       messages_content=self.message_content if messages else None, include_action_cards=True)

    def card(self, index=0, messages=True):
        return self.cards(messages)[index]["ac"]

    def assert_hidden(self, reason, index=0):
        card = self.card(index)
        self.assertIsNone(card["sources"][0]["quote"])
        self.assertIn(reason, " ".join(card["gaps"]))
        self.assertTrue(all(step["audience"] == "internal_review" for step in card["steps"]))

    def render_html(self, period="Synthetic __DATA__ <!--<script><unsafe-title>"):
        return dashboard.render(self.data, self.result, period, "synthetic cutoff", source_sha256=self.source_sha,
                                messages_content=self.message_content)

    def test_verified_quote_and_specific_step_preserve_original_text(self):
        card = self.card()
        self.assertEqual(card["sources"][0]["quote"]["text"], self.records[0]["variants"][0]["message"]["text"])
        self.assertEqual(card["sources"][0]["quote"]["speaker"], "买方消息")
        self.assertEqual(card["steps"][0]["draft"], self.draft)
        self.assertEqual(card["steps"][0]["audience"], "customer_draft")
        self.assertEqual([s["audience"] for s in card["steps"]][1:], ["internal_review", "internal_review"])

    def test_no_messages_downgrades_without_auto_opening_declared_path(self):
        self.message_path.unlink()
        card = self.card(messages=False)
        self.assertIsNone(card["sources"][0]["quote"])
        self.assertIn("未显式提供", " ".join(card["gaps"]))
        self.assertTrue(all("内部复核草稿" in s["draft"] for s in card["steps"]))

    def test_legacy_projection_remains_without_action_card_fields(self):
        rows = dashboard.rows_for_page(self.data, self.result, source_sha256=self.source_sha)
        self.assertTrue(all("ac" not in row for row in rows))

    def test_description_is_not_used_as_a_quote(self):
        self.data["evidence"][0]["description"] = "buyer: fabricated quotation only in the summary"
        self.refresh()
        self.assertNotIn("fabricated", self.card()["sources"][0]["quote"]["text"])
        self.data["evidence"][0]["quote"] = "fabricated quotation"
        self.refresh()
        self.assert_hidden("不在冻结消息")

    def test_same_store_wrong_inquiry_and_cross_store_cannot_show_original(self):
        first_key = self.records[0]["key"]
        for index in [1, 2]:
            with self.subTest(index=index):
                self.data["rows"][index]["reviewed_message_binding"]["messages"][0]["message_key"] = first_key
                self.data["evidence"][index]["locator"] = str(self.message_path) + "#" + first_key
        self.refresh()
        self.assert_hidden("同商机关联", 1)
        self.assert_hidden("精确身份", 2)

    def test_old_raw_without_inquiry_proof_is_only_a_binding_declaration(self):
        del self.records[0]["inquiry_ids"]
        self.refresh()
        self.assert_hidden("仅有行内绑定声明")

    def use_frozen_legacy_source_ref(self):
        """Same shape as the frozen assembler; values remain fully synthetic."""
        del self.records[0]["inquiry_ids"]
        self.records[0]["inquiry_keys"] = ["store-A|101"]
        self.refresh()
        self.data["evidence"][0].update(locator="旧复核编号 E001", source_ref={
            "path": str(self.message_path), "message_key": self.records[0]["key"],
            "role": "current_inquiry_window", "line": 1, "byte_offset": 0,
            "byte_length": len(self.message_content.splitlines(keepends=True)[0]), "content_conflict": False})
        self.refresh()

    def test_frozen_legacy_source_ref_and_raw_inquiry_keys_show_exact_original(self):
        self.use_frozen_legacy_source_ref()
        source = self.card()["sources"][0]
        self.assertEqual(source["quote"]["text"], self.records[0]["variants"][0]["message"]["text"])
        self.assertIn(str(self.message_path) + "#" + self.records[0]["key"], source["quote"]["source"])
        self.assertEqual(source["locator"], "旧复核编号 E001")
        self.assertEqual(self.card()["steps"][0]["audience"], "customer_draft")
        self.data["evidence"][0]["locator"] = str(self.message_path) + "#" + self.records[0]["key"]
        self.refresh()
        self.assertIsNotNone(self.card()["sources"][0]["quote"])

    def test_legacy_source_ref_requires_exact_coordinates_and_consistent_locator(self):
        self.use_frozen_legacy_source_ref()
        original = copy.deepcopy(self.data["evidence"][0])
        changes = [{"path": "other-file.jsonl"}, {"message_key": self.records[1]["key"]},
                   {"role": "before_inquiry_supplemental"}, {"line": 2}, {"byte_offset": 1},
                   {"byte_length": 1}, {"line": True}, {"content_conflict": True}]
        for change in changes:
            with self.subTest(change=change):
                self.data["evidence"][0] = copy.deepcopy(original)
                self.data["evidence"][0]["source_ref"].update(change)
                self.refresh()
                self.assertIsNone(self.card()["sources"][0]["quote"])
        for locator in [str(self.message_path) + "#" + self.records[1]["key"],
                        "other-file.jsonl#" + self.records[0]["key"]]:
            with self.subTest(locator=locator):
                self.data["evidence"][0] = copy.deepcopy(original)
                self.data["evidence"][0]["locator"] = locator
                self.refresh()
                self.assert_hidden("定位冲突")
        for bad in ["not-a-reference", {"path": str(self.message_path), "message_key": self.records[0]["key"]}]:
            with self.subTest(bad=bad):
                self.data["evidence"][0] = copy.deepcopy(original)
                self.data["evidence"][0]["source_ref"] = bad
                self.refresh()
                self.assert_hidden("source_ref")

    def test_raw_inquiry_keys_cannot_use_wrong_store_inquiry_or_conflicting_proof(self):
        self.use_frozen_legacy_source_ref()
        for keys in [["store-A|102"], ["store-B|101"], "store-A|101", [True]]:
            with self.subTest(keys=keys):
                self.records[0]["inquiry_keys"] = keys
                self.data["evidence"][0]["source_ref"]["byte_length"] = len((json.dumps(self.records[0], ensure_ascii=False) + "\n").encode("utf-8"))
                self.refresh()
                self.assertIsNone(self.card()["sources"][0]["quote"])
        self.records[0]["inquiry_keys"] = ["store-A|101"]
        self.records[0]["inquiry_ids"] = ["102"]
        self.data["evidence"][0]["source_ref"]["byte_length"] = len((json.dumps(self.records[0], ensure_ascii=False) + "\n").encode("utf-8"))
        self.refresh()
        self.assert_hidden("关联冲突")

    def test_exact_associations_are_supported_but_not_wrong_scope(self):
        del self.records[0]["inquiry_ids"]
        self.records[0]["variants"][0]["associations"] = [{"store_key": "store-A", "inquiry_id": "101", "conversation_id": "conv-A"}]
        self.refresh()
        self.assertIsNotNone(self.card()["sources"][0]["quote"])
        self.records[0]["variants"][0]["associations"][0]["inquiry_id"] = "102"
        self.refresh()
        self.assert_hidden("同商机关联")

    def test_top_level_and_variant_proofs_cannot_contradict_each_other(self):
        self.records[0]["variants"][0]["inquiry_ids"] = ["102"]
        self.refresh(); self.assert_hidden("关联冲突")
        del self.records[0]["variants"][0]["inquiry_ids"]
        self.records[0]["content_conflict"] = True
        self.refresh(); self.assert_hidden("内容冲突")

    def test_multiple_variants_and_conflicting_binding_are_not_unique_quotes(self):
        self.records[0]["variants"].append(copy.deepcopy(self.records[0]["variants"][0]))
        self.records[0]["variants"][1]["sha256"] = "1" * 64
        self.data["rows"][0]["reviewed_message_binding"]["messages"][0]["variant_sha256"] = "1" * 64
        self.refresh()
        self.assert_hidden("多个版本")
        self.records[0]["variants"].pop()
        self.data["rows"][0]["reviewed_message_binding"]["messages"][0]["content_conflict"] = True
        self.refresh()
        self.assert_hidden("内容冲突")

    def test_seven_malformed_view_types_downgrade_without_breaking_render(self):
        original_records, original_data = copy.deepcopy(self.records), copy.deepcopy(self.data)
        cases = [("message", "not-a-message"), ("message", ["not-a-message"]), ("message", True),
                 ("automation_flags", ["not-a-map"]), ("associations", 1),
                 ("coverage_gaps", 1), ("collection_continuation", [])]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.records, self.data = copy.deepcopy(original_records), copy.deepcopy(original_data)
                if field in ("coverage_gaps", "collection_continuation"):
                    self.data["rows"][0][field] = value
                elif field == "automation_flags":
                    self.records[0]["variants"][0]["message"][field] = value
                elif field == "associations":
                    self.records[0]["variants"][0][field] = value
                else:
                    selected = copy.deepcopy(self.records[0]["variants"][0])
                    selected["sha256"] = "1" * 64
                    if field == "message": selected["message"] = value
                    elif field == "automation_flags": selected["message"][field] = value
                    else: selected[field] = value
                    self.records[0]["variants"].append(selected)
                    self.data["rows"][0]["reviewed_message_binding"]["messages"][0]["variant_sha256"] = "1" * 64
                self.refresh()
                self.render_html()
                card = self.card()
                self.assertTrue(any("格式" in gap or "多个版本" in gap for gap in card["gaps"]))
                self.assertTrue(all(step["audience"] == "internal_review" for step in card["steps"]))

    def test_missing_time_unread_body_and_locator_breaks_are_explicit_gaps(self):
        message = self.records[0]["variants"][0]["message"]
        original = copy.deepcopy(message)
        for change, reason in [({"send_time_ms": None}, "发送时间"), ({"content_status": "metadata_only"}, "正文未读")]:
            with self.subTest(change=change):
                message.clear(); message.update(original); message.update(change)
                self.refresh(); self.assert_hidden(reason)
        message.clear(); message.update(original)
        self.data["evidence"][0]["locator"] = "other-file.jsonl#" + self.records[0]["key"]
        self.refresh(); self.assert_hidden("未精确定位")

    def test_duplicate_message_key_and_file_hash_mismatch_are_rejected(self):
        self.records.append(copy.deepcopy(self.records[0]))
        self.refresh()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.cards()
        self.records.pop(); self.refresh()
        with self.assertRaisesRegex(ValueError, "messages sha256"):
            dashboard.rows_for_page(self.data, self.result, source_sha256=self.source_sha,
                                    messages_content=self.message_content + b" ", include_action_cards=True)

    def test_old_v1_rule_metrics_are_rejected(self):
        self.result["rules_version"] = "lew.followup-rules.v1"
        with self.assertRaisesRegex(ValueError, "rules_version"):
            self.cards()

    def test_owner_due_and_payment_are_not_inferred_from_opportunity_metadata(self):
        card = self.card()
        self.assertEqual((card["owner"], card["due"]), ("待分配", "待分配"))
        self.assertFalse(card["executed"])
        self.assertFalse(self.card(2)["payment_verified"])
        self.assertEqual(self.card(2)["owner"], "待分配")

    def test_assignment_fields_require_independent_refs_and_valid_due_format(self):
        action = self.data["rows"][0]["action"]
        action.update(owner="Alice", due_date="2026-11-01")
        self.refresh()
        self.assertEqual((self.card()["owner"], self.card()["due"]), ("待分配", "待分配"))
        action.update(owner_evidence_refs=["e-store-A-101"], due_date_evidence_refs=["e-store-A-101"])
        self.records[0]["variants"][0]["message"]["text"] += " Please ask Alice to follow up by 2026-11-01."
        self.refresh()
        self.assertEqual((self.card()["owner"], self.card()["due"]), ("Alice", "2026-11-01"))
        for due in ["not-a-date", "2026-02-30", "2026-11-01T10:00:00+08:00"]:
            with self.subTest(due=due):
                action["due_date"] = due
                self.refresh()
                self.assertEqual(self.card()["due"], "待分配")
                self.assertIn("到期格式", " ".join(self.card()["gaps"]))

    def test_invalid_action_and_step_references_only_produce_internal_review(self):
        action = self.data["rows"][0]["action"]
        for change in ["executed", "step_ref", "step_duplicate"]:
            with self.subTest(change=change):
                original = copy.deepcopy(action)
                if change == "executed": action["executed"] = True
                elif change == "step_ref": action["steps"][0]["evidence_refs"] = ["e-store-B-101"]
                else: action["steps"].append(copy.deepcopy(action["steps"][0]))
                self.refresh()
                self.assertTrue(all(step["audience"] == "internal_review" for step in self.card()["steps"]))
                action.clear(); action.update(original)

    def test_seller_unknown_is_not_confirmed_human_and_no_buyer_time_is_unknown(self):
        message = self.records[0]["variants"][0]["message"]
        message["direction"] = "seller"; message["reply_source"] = "unknown"
        self.refresh()
        self.assertIn("人工身份未确认", self.card()["sources"][0]["quote"]["speaker"])
        self.assertIsNone(self.card()["followup_days"])

    def test_template_tokens_and_markup_remain_literal_and_title_is_escaped(self):
        html = self.render_html()
        self.assertIn("<title>多店新商机转化看板 · Synthetic __DATA__ &lt;!--&lt;script&gt;&lt;unsafe-title&gt;</title>", html)
        self.assertEqual(html.count("<script>"), 1)
        payload = json.JSONDecoder().raw_decode(html.split("const DATA = ", 1)[1])[0]
        self.assertEqual(payload["rows"][0]["ac"]["sources"][0]["quote"]["text"], self.records[0]["variants"][0]["message"]["text"])
        self.assertEqual(payload["rows"][0]["ac"]["steps"][0]["draft"], self.draft)

    @unittest.skipUnless(NODE, "Node.js is required for the synthetic clipboard/DOM regression")
    def test_copy_success_and_failure_keep_exact_draft_and_manual_selection(self):
        script = self.render_html().split("<script>", 1)[1].split("</script>", 1)[0]
        for mode in ["success", "failure", "missing"]:
            with self.subTest(mode=mode):
                result = subprocess.run([NODE, "-e", COPY_HARNESS], input=json.dumps({"script": script, "draft": self.draft, "mode": mode}), text=True, encoding="utf-8", capture_output=True, check=True)
                page = json.loads(result.stdout)
                self.assertIn("尚未发送", page["status"])
                if mode == "success": self.assertEqual(page["copied"], self.draft)
                else:
                    self.assertIsNone(page["copied"]); self.assertTrue(page["selected"]); self.assertTrue(page["focused"])
                self.assertIn(self.records[0]["variants"][0]["message"]["text"], page["quotes"])


if __name__ == "__main__":
    unittest.main()
