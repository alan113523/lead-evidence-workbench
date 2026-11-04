import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/followup_metrics.py"
spec = importlib.util.spec_from_file_location("followup_metrics", SCRIPT)
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)

CUTOFF = "2026-10-22T00:00:00+08:00"
T0 = metrics.parse_ms("2026-10-10T02:00:00Z")
MIN = 60_000


def message(key, direction, minutes, reply_source="unknown", auto=False):
    return {
        "key": key,
        "variants": [{"message": {
            "direction": direction,
            "send_time_ms": T0 + minutes * MIN,
            "reply_source": reply_source,
            "automation_flags": {"auto_reply": auto, "robot_message": False},
        }}],
    }


def row(inquiry_id, keys, quality="中", reason="", owner="A", role="current_inquiry_window"):
    return {
        "store_key": "s1",
        "inquiry_id": inquiry_id,
        "owner": owner,
        "excluded": False,
        "quality": quality,
        "quality_reason": reason,
        "reviewed_message_binding": {
            "messages_file": {"path": "unused.jsonl"},
            "messages": [{"message_key": k, "role": role} for k in keys],
        },
    }


class FollowupMetricsTests(unittest.TestCase):
    def run_metrics(self, rows, records):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "m.jsonl"
            path.write_text("\n".join(json.dumps(r) for r in records), encoding="utf-8")
            data = {"analysis_before_exclusive": CUTOFF, "rows": rows}
            return metrics.compute(data, metrics.load_messages(path),
                                   source_sha256=hashlib.sha256(json.dumps(data).encode()).hexdigest(),
                                   messages_sha256=hashlib.sha256(path.read_bytes()).hexdigest())

    def test_first_response_ignores_auto_replies_and_counts_turns(self):
        records = [
            message("b1", "buyer", 0),
            message("a1", "seller", 1, reply_source="ai", auto=True),
            message("s1", "seller", 30),
            message("b2", "buyer", 60),
            message("b3", "buyer", 61),
            message("s2", "seller", 90),
        ]
        result = self.run_metrics([row("1", [r["key"] for r in records])], records)
        r = result["records"][0]
        self.assertEqual(r["first_response_minutes"], 30.0)
        self.assertEqual(r["buyer_turns"], 2)
        self.assertEqual(r["seller_auto_messages"], 1)
        self.assertEqual(r["silence_stage"], "awaiting_buyer_multi_turn")
        self.assertEqual(r["seller_followup_days_after_last_buyer"], 1)

    def test_buyer_last_is_awaiting_seller_and_messages_after_cutoff_ignored(self):
        late = 20 * 24 * 60
        records = [message("b1", "buyer", 0), message("s1", "seller", 5), message("b2", "buyer", 10), message("s2", "seller", late)]
        r = self.run_metrics([row("1", [x["key"] for x in records])], records)["records"][0]
        self.assertEqual(r["silence_stage"], "awaiting_seller")
        self.assertEqual(r["seller_messages"], 1)

    def test_supplemental_history_and_excluded_rows_are_skipped(self):
        records = [message("b1", "buyer", 0)]
        excluded = row("2", ["b1"])
        excluded["excluded"] = True
        result = self.run_metrics([row("1", ["b1"], role="before_window_supplemental"), excluded], records)
        self.assertEqual(len(result["records"]), 1)
        self.assertEqual(result["records"][0]["silence_stage"], "no_chat")

    def test_missing_bound_message_fails_loudly(self):
        with self.assertRaises(KeyError):
            self.run_metrics([row("1", ["missing"])], [message("b1", "buyer", 0)])

    def test_reason_tags(self):
        cases = [
            ("报价后未回复（截至10/14）", "quote_no_reply"),
            ("接待或跟进后未回复", "no_reply"),
            ("卖方询数量后未见买家回复。", "no_reply"),
            ("买家明确已查看合同但选择了另一供应商", "buyer_declined"),
            ("核心要求未满足", "product_mismatch"),
            ("需管理复核", "other"),
        ]
        for text, expected in cases:
            self.assertEqual(metrics.reason_tag("差", text), (expected, "derived"), text)
        self.assertEqual(metrics.reason_tag("中", "报价后未回复"), (None, None))

    def test_structured_code_wins_over_text(self):
        low = {"code": "product_mismatch", "reason": "买家要的电压本店没有", "evidence_refs": ["m1"]}
        self.assertEqual(metrics.reason_tag("差", "接待或跟进后未回复", low), ("product_mismatch", "code"))
        self.assertEqual(metrics.reason_tag("差", "接待或跟进后未回复", {"code": "bogus"}), ("no_reply", "derived"))

    def test_seller_followups_on_same_china_day_count_once(self):
        records = [message("buyer", "buyer", 0), message("morning", "seller", 1), message("evening", "seller", 2),
                   message("auto", "seller", 3, reply_source="ai"), message("missing", "seller", 4)]
        for record, stamp in zip(records, ["2026-10-10T08:00:00+08:00", "2026-10-10T09:00:00+08:00", "2026-10-10T17:00:00+08:00", "2026-10-11T12:00:00+08:00", None]):
            record["variants"][0]["message"]["send_time_ms"] = metrics.parse_ms(stamp)
        r = self.run_metrics([row("1", [x["key"] for x in records])], records)["records"][0]
        self.assertEqual(r["seller_followup_days_after_last_buyer"], 1)
        self.assertEqual(r["seller_messages"], 2)
        self.assertEqual(r["seller_auto_messages"], 1)
        self.assertEqual(r["buyer_silent_days"], round((metrics.parse_ms(CUTOFF) - metrics.parse_ms("2026-10-10T08:00:00+08:00")) / metrics.DAY_MS, 1))

    def test_seller_followups_crossing_china_midnight_count_two_days(self):
        records = [message("buyer", "buyer", 0), message("late", "seller", 1), message("early", "seller", 2)]
        for record, stamp in zip(records, ["2026-10-10T22:00:00+08:00", "2026-10-10T23:00:00+08:00", "2026-10-11T01:00:00+08:00"]):
            record["variants"][0]["message"]["send_time_ms"] = metrics.parse_ms(stamp)
        r = self.run_metrics([row("1", [x["key"] for x in records])], records)["records"][0]
        self.assertEqual(r["seller_followup_days_after_last_buyer"], 2)


if __name__ == "__main__":
    unittest.main()
