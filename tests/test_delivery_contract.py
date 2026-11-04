"""Offline delivery regressions: synthetic final-data/messages, no private files or live tools."""
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
from unittest import mock

from openpyxl import load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import followup_metrics as metrics
import build_followup_workbook as workbook
import build_dashboard as dashboard


CUTOFF = "2026-10-22T00:00:00+08:00"
START = "2026-10-01T00:00:00+08:00"
NODE = os.environ.get("NODE_EXECUTABLE") or shutil.which("node")
JS_HARNESS = r"""
const fs = require('node:fs'), vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
class Element {
  constructor() { this.children = []; this.style = {setProperty() {}}; this.value = ''; }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener() {}
}
const nodes = {};
const document = {
  getElementById(id) { return nodes[id] ||= new Element(); },
  createElement() { return new Element(); },
};
const context = vm.createContext({document, innerWidth: 1600, console});
vm.runInContext(input.script, context);
if (input.filters) {
  document.getElementById('f-store').value = input.filters.store || '';
  document.getElementById('f-owner').value = input.filters.owner || '';
  vm.runInContext('render()', context);
}
const result = vm.runInContext(`JSON.stringify({
  tiles: document.getElementById('tiles').children.map(t => ({
    label: t.children[0].textContent, value: t.children[1].textContent,
    unit: t.children[1].children[0]?.textContent, foot: t.children[2].textContent
  })),
  subtitle: document.getElementById('subtitle').textContent,
  barWidths: ['funnel', 'reasons'].flatMap(id => document.getElementById(id).children.map(row => row.children[1].children[0].style.width)),
  owners: ownerStats(DATA.rows.filter(r => !r.x)),
  ownerTable: document.getElementById('owners').children[1].children.map(row =>
    row.children.map(cell => cell.textContent ?? null)),
  priority: document.getElementById('prio').children.map(section =>
    section.children.map(row => row.children.map(cell => cell.textContent ?? null)))
})`, context);
process.stdout.write(result);
"""


class DeliveryContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.input = self.directory / "final-data.json"
        self.messages_path = self.directory / "messages.jsonl"
        self.metrics_path = self.directory / "metrics.json"
        self.messages = []
        self.data = {
            "schema_version": "lew.final-operational-data.v1",
            "analysis_before_exclusive": CUTOFF,
            "population_total": 6,
            "rows": [],
            "evidence": [{"row_key": "R1", "description": "synthetic review evidence"}],
        }
        cases = [
            ("1", "差", "Y", ["buyer"], False),
            ("2", "好", "N", ["buyer", "seller"], False),
            ("3", "中", "N", ["buyer", "seller", "buyer", "seller"], False),
            ("4", "待判断", None, ["buyer", "seller_auto", "buyer"], False),
            ("5", "差", "N", ["seller_auto"], False),
            ("6", "好", "Y", [], True),
        ]
        for inquiry, quality, deep, speakers, excluded in cases:
            refs = []
            for minute, who in enumerate(speakers):
                key = f"synthetic-{inquiry}-{minute}"
                refs.append({"message_key": key, "role": "current_inquiry_window"})
                self.messages.append({"key": key, "variants": [{"message": {
                    "direction": "buyer" if who == "buyer" else "seller",
                    "send_time_ms": metrics.parse_ms("2026-10-10T02:00:00Z") + minute * 60_000,
                    "reply_source": "ai" if who == "seller_auto" else "unknown",
                    "automation_flags": {"auto_reply": who == "seller_auto"},
                }}]})
            self.data["rows"].append({
                "store_key": "synthetic-store", "inquiry_id": inquiry,
                "row_key": f"R{inquiry}", "created_at": "2026-10-10T02:00:00Z",
                "owner": "Synthetic Owner", "excluded": excluded,
                "quality": quality, "deep_communication": deep,
                "quality_reason": "synthetic reviewed conclusion",
                "deep_reason": "synthetic depth evidence; not inferred from turns",
                "reviewed_message_binding": {
                    "messages_file": {"path": str(self.messages_path)}, "messages": refs,
                },
            })
        self.messages_path.write_text("\n".join(json.dumps(r) for r in self.messages), encoding="utf-8")
        self.messages_sha = hashlib.sha256(self.messages_path.read_bytes()).hexdigest()
        self.write_input()
        self.generate_metrics()

    def write_input(self):
        # BOM and indentation ensure the producer binds actual bytes, not a reserialization.
        self.input.write_bytes(b"\xef\xbb\xbf" + json.dumps(self.data, ensure_ascii=False, indent=2).encode("utf-8"))

    def generate_metrics(self):
        with contextlib.redirect_stdout(io.StringIO()):
            metrics.main(["--input", str(self.input), "--messages", str(self.messages_path), "--out", str(self.metrics_path)])
        self.result = json.loads(self.metrics_path.read_text(encoding="utf-8"))

    def write_metrics(self, result):
        self.metrics_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

    def consume(self, consumer, output):
        arguments = ["--input", str(self.input), "--metrics", str(self.metrics_path), "--out", str(output)]
        if consumer is workbook:
            arguments += ["--from", START, "--to", CUTOFF]
        else:
            arguments += ["--period", "synthetic period"]
        with contextlib.redirect_stdout(io.StringIO()):
            consumer.main(arguments)

    def dashboard_page(self, filename, filters=None):
        output = self.directory / filename
        self.consume(dashboard, output)
        script = output.read_text(encoding="utf-8").split("<script>", 1)[1].split("</script>", 1)[0]
        result = subprocess.run([NODE, "-e", JS_HARNESS], input=json.dumps({"script": script, "filters": filters}), text=True, encoding="utf-8", capture_output=True, check=True)
        return json.loads(result.stdout)

    def assert_consumers_reject(self, pattern):
        for consumer, suffix in [(workbook, "xlsx"), (dashboard, "html")]:
            with self.subTest(consumer=consumer.__name__):
                output = self.directory / f"rejected.{suffix}"
                with self.assertRaisesRegex(ValueError, pattern):
                    self.consume(consumer, output)
                self.assertFalse(output.exists(), "validation must precede output creation")

    def test_producer_binds_actual_source_bytes_cutoff_rules_and_message_bytes(self):
        binding = self.result["source_binding"]
        self.assertEqual(binding["sha256"], hashlib.sha256(self.input.read_bytes()).hexdigest())
        self.assertEqual(binding["messages_sha256"], self.messages_sha)
        self.assertEqual(binding["analysis_before_exclusive"], CUTOFF)
        self.assertEqual(binding["record_key_fields"], ["store_key", "inquiry_id"])
        self.assertEqual(self.result["rules_version"], metrics.RULES_VERSION)

    def test_valid_cli_artifacts_and_nonautomatic_response_label(self):
        output = self.directory / "valid.xlsx"
        self.consume(workbook, output)
        saved = load_workbook(output)
        headers = [cell.value for cell in saved["新商机跟进"][12]]
        self.assertIn("首次卖方非自动响应（分钟）", headers)
        self.assertNotIn("首次人工响应（分钟）", headers)
        html = self.directory / "valid.html"
        self.consume(dashboard, html)
        self.assertIn("synthetic period", html.read_text(encoding="utf-8"))

    def test_same_key_stale_source_is_rejected(self):
        self.data["rows"][0]["quality_reason"] = "changed review, same keys and cutoff"
        self.write_input()
        self.assert_consumers_reject("source.*sha256|source.*SHA256")

    def test_stale_input_cutoff_is_rejected(self):
        self.data["analysis_before_exclusive"] = "2026-10-23T00:00:00+08:00"
        self.write_input()
        self.result["source_binding"]["sha256"] = hashlib.sha256(self.input.read_bytes()).hexdigest()
        self.write_metrics(self.result)
        self.assert_consumers_reject("cutoff")

    def test_stale_metric_cutoff_is_rejected(self):
        self.result["analysis_before_exclusive"] = "2026-10-23T00:00:00+08:00"
        self.write_metrics(self.result)
        self.assert_consumers_reject("cutoff")

    def test_stale_rules_are_rejected(self):
        self.result["rules_version"] = "obsolete-rules"
        self.write_metrics(self.result)
        self.assert_consumers_reject("rules")

    def test_legacy_unbound_metrics_are_rejected(self):
        self.write_metrics({"records": self.result["records"], "analysis_before_exclusive": CUTOFF})
        self.assert_consumers_reject("binding|schema")

    def test_duplicate_metric_keys_are_rejected(self):
        self.result["records"].append(copy.deepcopy(self.result["records"][0]))
        self.write_metrics(self.result)
        self.assert_consumers_reject("duplicate")

    def test_missing_metric_key_is_rejected(self):
        self.result["records"].pop()
        self.write_metrics(self.result)
        self.assert_consumers_reject("missing")

    def test_extra_excluded_metric_key_is_rejected(self):
        extra = copy.deepcopy(self.result["records"][0])
        extra["inquiry_id"] = "6"
        self.result["records"].append(extra)
        self.write_metrics(self.result)
        self.assert_consumers_reject("extra")

    def test_same_count_wrong_keys_are_rejected(self):
        self.result["records"][0]["inquiry_id"] = "not-in-this-period"
        self.write_metrics(self.result)
        self.assert_consumers_reject("missing.*extra")

    def test_same_inquiry_id_in_different_stores_is_not_merged(self):
        self.data["rows"][1]["store_key"] = "second-synthetic-store"
        self.data["rows"][1]["inquiry_id"] = "1"
        self.write_input()
        self.generate_metrics()
        keys = {(r["store_key"], r["inquiry_id"]) for r in self.result["records"]}
        self.assertEqual(len(keys), 5)
        self.assertIn(("synthetic-store", "1"), keys)
        self.assertIn(("second-synthetic-store", "1"), keys)
        self.consume(workbook, self.directory / "store-identity.xlsx")
        self.consume(dashboard, self.directory / "store-identity.html")

    def test_wrong_record_key_contract_is_rejected(self):
        self.result["source_binding"]["record_key_fields"] = ["inquiry_id"]
        self.write_metrics(self.result)
        self.assert_consumers_reject("record key")

    def test_duplicate_source_keys_are_rejected_by_producer(self):
        self.data["rows"].append(copy.deepcopy(self.data["rows"][0]))
        self.data["population_total"] += 1
        self.write_input()
        self.metrics_path.unlink()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.generate_metrics()
        self.assertFalse(self.metrics_path.exists())

    def test_declared_message_sha_is_checked_before_producer_output(self):
        self.data["rows"][0]["reviewed_message_binding"]["messages_file"]["sha256"] = "0" * 64
        self.write_input()
        self.metrics_path.unlink()
        with self.assertRaisesRegex(ValueError, "messages.*sha256|messages.*SHA256"):
            self.generate_metrics()
        self.assertFalse(self.metrics_path.exists())

    def test_consumers_check_declared_messages_without_opening_message_file(self):
        for row in self.data["rows"]:
            row["reviewed_message_binding"]["messages_file"]["sha256"] = self.messages_sha
        self.write_input()
        self.generate_metrics()
        self.messages_path.unlink()
        self.consume(workbook, self.directory / "without-messages.xlsx")
        self.consume(dashboard, self.directory / "without-messages.html")

    def test_metric_message_sha_mismatch_is_rejected(self):
        self.data["rows"][0]["reviewed_message_binding"]["messages_file"]["sha256"] = self.messages_sha
        self.write_input()
        self.generate_metrics()
        self.result["source_binding"]["messages_sha256"] = "0" * 64
        self.write_metrics(self.result)
        self.assert_consumers_reject("messages.*sha256|messages.*SHA256")

    def test_invalid_metrics_do_not_overwrite_existing_dashboard(self):
        output = self.directory / "frozen.html"
        output.write_bytes(b"frozen prior delivery")
        self.write_metrics({"records": self.result["records"]})
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                self.consume(dashboard, output)
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(output.read_bytes(), b"frozen prior delivery")

    def test_valid_metrics_do_not_overwrite_existing_dashboard(self):
        output = self.directory / "frozen-with-valid-metrics.html"
        original = b"frozen prior delivery with valid same-batch metrics"
        output.write_bytes(original)
        with mock.patch.object(dashboard, "load_final_data", side_effect=AssertionError("input must not be read before refusing existing output")) as read_input:
            with contextlib.redirect_stderr(io.StringIO()) as help_output:
                with self.assertRaises(SystemExit) as error:
                    self.consume(dashboard, output)
        read_input.assert_not_called()
        self.assertEqual(error.exception.code, 2)
        self.assertIn("already exists; preserve the frozen prior file", help_output.getvalue())
        self.assertEqual(output.read_bytes(), original)

    def test_workbook_metrics_remain_optional(self):
        output = self.directory / "without-metrics.xlsx"
        with contextlib.redirect_stdout(io.StringIO()):
            workbook.main(["--input", str(self.input), "--out", str(output), "--from", START, "--to", CUTOFF])
        self.assertTrue(output.is_file())

    def test_default_message_file_cli_remains_compatible(self):
        output = self.directory / "default-message-file-metrics.json"
        with contextlib.redirect_stdout(io.StringIO()):
            metrics.main(["--input", str(self.input), "--out", str(output)])
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["source_binding"]["messages_sha256"], self.messages_sha)

    @unittest.skipUnless(NODE, "Node.js is required to exercise the embedded dashboard JavaScript")
    def test_dashboard_review_counts_do_not_depend_on_message_turns(self):
        page = self.dashboard_page("review-counts.html")
        tiles = {tile["label"]: tile for tile in page["tiles"]}
        self.assertEqual(tiles["有效新商机"]["value"], 5)
        self.assertEqual(tiles["深入沟通过"]["value"], 1, "Y+差 with one buyer turn still counts as reviewed Y")
        self.assertEqual(tiles["质量好"]["value"], 1, "好+N does not require reviewed Y or repeated replies")
        self.assertIn("未核实 1", tiles["深入沟通过"]["foot"])
        self.assertEqual(page["owners"][0]["deep"], 20)
        self.assertEqual(page["owners"][0]["q"], {"好": 1, "中": 1, "差": 2, "待判断": 1})
        headings = page["priority"][0][0]
        self.assertIn("深入沟通", headings)
        self.assertTrue(any("N" in row for row in page["priority"][1]), "detail must show the reviewed N for 好+N")

    @unittest.skipUnless(NODE, "Node.js is required to exercise the embedded dashboard JavaScript")
    def test_filtered_dashboard_keeps_top_owner_and_detail_counts_aligned(self):
        self.data["rows"][1]["store_key"] = "second-synthetic-store"
        self.data["rows"][1]["owner"] = "Second Owner"
        self.write_input()
        self.generate_metrics()
        page = self.dashboard_page("filtered.html", {"store": "second-synthetic-store", "owner": "Second Owner"})
        tiles = {tile["label"]: tile for tile in page["tiles"]}
        self.assertEqual(tiles["有效新商机"]["value"], 1)
        self.assertEqual(tiles["质量好"]["value"], 1)
        self.assertEqual(tiles["深入沟通过"]["value"], 0)
        self.assertEqual(page["ownerTable"][0][:2], ["Second Owner", 1])
        self.assertEqual(page["ownerTable"][0][3], "0%（0/1/0）")
        self.assertIn("N", page["priority"][1][0])

    @unittest.skipUnless(NODE, "Node.js is required to exercise the embedded dashboard JavaScript")
    def test_empty_combined_filter_has_no_percentage_denominator(self):
        self.data["rows"][1]["store_key"] = "second-synthetic-store"
        self.data["rows"][1]["owner"] = "Second Owner"
        self.write_input()
        self.generate_metrics()
        page = self.dashboard_page("empty-combination.html", {"store": "synthetic-store", "owner": "Second Owner"})
        tiles = {tile["label"]: tile for tile in page["tiles"]}
        self.assertEqual(tiles["有效新商机"]["value"], 0)
        self.assertEqual(tiles["深入沟通过"]["unit"], "条 · —")
        self.assertEqual(tiles["质量好"]["unit"], "条 · —")
        self.assertIn("无有效商机", page["subtitle"])
        self.assertIn("无分母", page["subtitle"])
        self.assertEqual(page["ownerTable"], [])
        self.assertEqual(page["priority"][1], [])
        self.assertNotRegex(json.dumps(page, ensure_ascii=False), r"NaN|Infinity|null%|—%")
        self.assertTrue(all(width.endswith("* 0)") for width in page["barWidths"]))

    @unittest.skipUnless(NODE, "Node.js is required to exercise the embedded dashboard JavaScript")
    def test_owner_missing_response_and_message_denominators_stay_unknown(self):
        self.data["rows"][0]["owner"] = "No Messages Owner"
        self.write_input()
        self.generate_metrics()
        page = self.dashboard_page("no-message-denominators.html", {"owner": "No Messages Owner"})
        owner = next(row for row in page["owners"] if row["o"] == "No Messages Owner")
        self.assertIsNone(owner["hour"])
        self.assertIsNone(owner["auto"])
        self.assertEqual(page["ownerTable"][0][6:8], ["—", "—"])
        self.assertNotRegex(json.dumps(page, ensure_ascii=False), r"NaN|Infinity|null%|—%")


if __name__ == "__main__":
    unittest.main()
