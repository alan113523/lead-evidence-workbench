import importlib.util
from pathlib import Path
import tempfile
import unittest

from openpyxl import load_workbook

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/build_followup_workbook.py"
spec = importlib.util.spec_from_file_location("build_followup_workbook", SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

START = builder.parse_time("2026-10-01T00:00:00+08:00")
END = builder.parse_time("2026-10-22T00:00:00+08:00")
SPLIT = builder.parse_time("2026-10-15T00:00:00+08:00")


def row(inquiry_id, store, created, quality="中", excluded=False, **extra):
    return {"store_key": store, "inquiry_id": inquiry_id, "created_at": created, "excluded": excluded, "quality": quality, "row_key": f"R{inquiry_id}", "buyer_level": "", **extra}


def sample():
    rows = [
        row("100000000000000001", "s1", "2026-09-30T16:30:00Z", "差", quality_reason="报价后未回复"),
        row("2", "s1", "2026-10-16T02:00:00Z", "好"),
        row("3", "s2", "2026-10-02T02:00:00Z", "中"),
        row("4", "s2", "2026-10-03T02:00:00Z", excluded=True, exclusion_reason="老客"),
    ]
    return {"rows": rows, "population_total": 4, "evidence": [{"row_key": "R2", "store_key": "s1", "inquiry_id": "2", "description": "x"}], "analysis_before_exclusive": "2026-10-22T00:00:00+08:00"}


class BuildWorkbookTests(unittest.TestCase):
    def test_counts_split_and_local_time(self):
        wb, counts = builder.build(sample(), START, END, SPLIT)
        self.assertEqual(counts["followup"], 3)
        self.assertEqual(counts["quality"], {"好": 1, "中": 1, "差": 1, "待判断": 0})
        main = wb["新商机跟进"]
        summary = [[c.value for c in r] for r in main["A5:I7"]]
        self.assertEqual(summary[0], ["s1", 2, 1, 0, 1, 0, 0, 1, 1])
        self.assertEqual(summary[2], ["多店合计", 3, 1, 1, 1, 0, 1, 3, 1])
        header = [c.value for c in main[13]]
        self.assertEqual(header[:3], ["序号", "创建日期", "店铺"])
        first = [c.value for c in main[14]]
        self.assertEqual(first[7], "好")
        bad = next(r for r in main.iter_rows(min_row=14, values_only=True) if r[7] == "差")
        self.assertEqual(bad[1].isoformat(), "2026-10-01T00:30:00")
        self.assertEqual(bad[4], "未取得")
        self.assertEqual(bad[18], "100000000000000001")
        self.assertEqual(wb["排除记录"]["B4"].value, 1)

    def test_metrics_columns_must_cover_followup(self):
        metrics = {"records": [{"store_key": "s1", "inquiry_id": "2", "reason_tag": None, "first_response_minutes": 3.0, "last_buyer_at": None, "buyer_silent_days": None, "silence_stage": "no_chat", "seller_auto_messages": 0}]}
        with self.assertRaises(ValueError):
            builder.build(sample(), START, END, metrics=metrics)

    def test_rejects_rows_outside_window_and_unknown_quality(self):
        data = sample()
        data["rows"][0]["created_at"] = "2026-09-30T15:59:59Z"
        with self.assertRaises(ValueError):
            builder.build(data, START, END)
        data = sample()
        data["rows"][1]["quality"] = "未知"
        with self.assertRaises(ValueError):
            builder.build(data, START, END)

    def test_cli_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "x.xlsx"
            out.write_bytes(b"frozen")
            with self.assertRaises(SystemExit):
                builder.main(["--input", "unused", "--out", str(out), "--from", "2026-10-01T00:00:00+08:00", "--to", "2026-10-22T00:00:00+08:00"])
            self.assertEqual(out.read_bytes(), b"frozen")

    def test_saved_file_round_trips(self):
        wb, _ = builder.build(sample(), START, END, SPLIT)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "x.xlsx"
            wb.save(out)
            loaded = load_workbook(out)
            self.assertEqual(loaded.sheetnames, ["新商机跟进", "排除记录", "判断依据", "全量背调状态"])
            self.assertEqual(loaded["新商机跟进"].freeze_panes, "A14")


if __name__ == "__main__":
    unittest.main()
