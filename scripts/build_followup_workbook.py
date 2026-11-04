"""由周期 final-data.json 生成多店新商机跟进工作簿（四表），可选并入跟进行为指标。

移植自 data/review-20261022-1001-1021/delivery/build_workbook.mjs，版式与列口径保持一致，
去掉硬编码日期/路径，改用 openpyxl，不依赖 Codex 运行时。汇总写入静态计数（不留公式），
便于任何读取工具直接看到数值。
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from country import country_zh  # noqa: E402
from followup_metrics import load_final_data, validate_metrics  # noqa: E402

CN = timezone(timedelta(hours=8))
QUALITIES = ["好", "中", "差", "待判断"]
RANK = {q: i for i, q in enumerate(QUALITIES)}
FONT = "Microsoft YaHei"
HEADER_FILL = PatternFill("solid", fgColor="244C57")
GRADE_STYLE = {"好": ("DEF0E6", "185B38"), "中": ("FFF0CB", "7B5400"), "差": ("F9E1DE", "90392A"), "待判断": ("E8EDF4", "455B76")}
REASON_LABEL = {"no_reply": "买家未回复", "quote_no_reply": "报价后未回", "product_mismatch": "产品不匹配", "buyer_declined": "买家放弃", "existing_customer": "老客", "duplicate_customer": "撞客", "other": "其他"}
STAGE_LABEL = {
    "awaiting_seller": "等卖方回复",
    "awaiting_buyer_after_first_turn": "首轮后买家未再回",
    "awaiting_buyer_multi_turn": "多轮后买家未再回",
    "no_chat": "无可用聊天",
}

MAIN_HEADERS = ["序号", "创建日期", "店铺", "客户地区", "客户层级", "客户姓名", "产品", "质量", "质量依据 / 备注", "下一步跟进", "业务员", "公司经营模式", "本次采购用途", "深入沟通", "成交 / 到账", "聊天截止（中国，不含）", "聊天来源", "采集状态", "商机ID", "完整创建时间（中国）", "证据编号", "经营模式依据", "经营模式不确定性", "采购用途依据", "采购用途不确定性", "实体核验", "风险核验", "前次→本次变化"]
MAIN_WIDTHS = [17, 15, 17, 13, 10, 24, 31, 10, 49, 43, 17, 27, 25, 48, 24, 18, 18, 28, 23, 23, 12, 65, 61, 65, 61, 60, 60, 65]
METRIC_HEADERS = ["差的原因", "首次卖方非自动响应（分钟）", "最后买家消息（中国）", "买家沉默天数", "当前停在", "自动消息数"]
METRIC_WIDTHS = [16, 20, 18, 12, 18, 10]
EXCLUDED_HEADERS = ["序号", "店铺", "客户姓名", "创建时间（中国）", "入组状态", "排除依据", "商机ID", "证据时间（中国）", "聊天来源", "证据编号"]
EVIDENCE_HEADERS = ["证据编号", "店铺", "商机ID", "用途", "来源性质", "消息 / 网页定位", "证据时间（中国）", "依据与限制"]
BACKGROUND_HEADERS = ["序号", "店铺", "商机ID", "客户 / 企业", "名单处理", "复用 / 刷新 / 补查", "背调状态", "平台资料", "企业主体", "公开研究", "画像复核", "资料实际观察时间（中国）", "证据来源", "剩余缺口", "下一步", "正式背调状态", "判断编号"]


def reason_label(m):
    """代码 → 中文标签；文本派生的加“（派生）”，与复核写入的代码区分。"""
    label = REASON_LABEL.get(m.get("reason_tag"), "")
    return f"{label}（派生）" if label and m.get("reason_source") != "code" else label

def parse_time(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def local(value):
    """带时区 ISO → 中国时间的无时区 datetime（Excel 不存时区）。"""
    t = parse_time(value)
    return t.astimezone(CN).replace(tzinfo=None) if t else None


def short_axis(value):
    return "未明确" if not value or value.startswith("证据不足") else value


def text_height(value, width, minimum, line=15, pad=14):
    lines = 0
    for part in str(value or "").split("\n"):
        units = sum(2 if ord(c) > 255 else 1 for c in part)
        lines += max(1, -(-units // max(1, int(width * 0.88))))
    return min(400, max(minimum, lines * line + pad))


def style_header(ws, row, count):
    for col in range(1, count + 1):
        c = ws.cell(row, col)
        c.fill = HEADER_FILL
        c.font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 32


def write_table(ws, header_row, headers, rows, name, widths, wrap_from=1, text_cols=(), date_cols=None, min_height=23, height_cols=()):
    for col, h in enumerate(headers, 1):
        ws.cell(header_row, col, h)
    style_header(ws, header_row, len(headers))
    body = Font(name=FONT, size=10, color="273545")
    date_cols = date_cols or {}
    for i, values in enumerate(rows):
        r = header_row + 1 + i
        for col, v in enumerate(values, 1):
            c = ws.cell(r, col, v)
            c.font = body
            c.alignment = Alignment(vertical="center", wrap_text=col >= wrap_from)
            if col in text_cols:
                c.number_format = "@"
            elif col in date_cols:
                c.number_format = date_cols[col]
        ws.row_dimensions[r].height = max([min_height] + [text_height(values[c - 1], widths[c - 1], min_height) for c in height_cols])
    for col, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(col)].width = w
    last = header_row + max(1, len(rows))
    table = Table(displayName=name, ref=f"A{header_row}:{get_column_letter(len(headers))}{last}")
    table.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
    ws.add_table(table)
    ws.freeze_panes = ws.cell(header_row + 1, 1)
    ws.sheet_view.showGridLines = False
    return last


def title(ws, text, color, note, note_cols="J"):
    ws["A1"] = text
    ws["A1"].font = Font(name=FONT, size=16, bold=True, color=color)
    ws.row_dimensions[1].height = 34
    ws.merge_cells(f"A2:{note_cols}2")
    ws["A2"] = note
    ws["A2"].font = Font(name=FONT, size=10, color="536A70")
    ws["A2"].alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[2].height = 30


def validate(data, start, end):
    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("final-data rows are required; empty output is prohibited")
    if not isinstance(data.get("evidence"), list):
        raise ValueError("final-data evidence array is required")
    if data.get("population_total") != len(rows):
        raise ValueError("population_total does not match rows")
    keys = {(r["store_key"], r["inquiry_id"]) for r in rows}
    if len(keys) != len(rows):
        raise ValueError("duplicate store/inquiry keys")
    for r in rows:
        if not isinstance(r.get("inquiry_id"), str) or not isinstance(r.get("excluded"), bool):
            raise ValueError(f"invalid identity or excluded flag: {r.get('inquiry_id')}")
        created = parse_time(r["created_at"])
        if not (start <= created < end):
            raise ValueError(f"{r['inquiry_id']} created_at {r['created_at']} outside window")
        if not r["excluded"] and r.get("quality") not in QUALITIES:
            raise ValueError(f"{r['inquiry_id']} has unknown quality {r.get('quality')!r}")


def build(data, start, end, split=None, metrics=None, label=None, *, source_sha256=None):
    validate(data, start, end)
    stores = list(dict.fromkeys(r["store_key"] for r in data["rows"]))
    rows = sorted((r for r in data["rows"] if not r["excluded"]), key=lambda r: (RANK[r["quality"]], r["created_at"], r["store_key"], r["inquiry_id"]))
    old = sorted((r for r in data["rows"] if r["excluded"]), key=lambda r: (r["store_key"], r["created_at"]))
    by_key = validate_metrics(data, metrics, source_sha256) if metrics is not None else {}

    wb = Workbook()
    main = wb.active
    main.title = "新商机跟进"
    main.sheet_properties.tabColor = "244C57"
    cutoff = local(data["analysis_before_exclusive"])
    last_day = (end.astimezone(CN) - timedelta(days=1))
    period = label or f"{start.astimezone(CN):%Y年%m月%d日}至{last_day:%m月%d日}"
    title(main, "多店新商机跟进表", "244C57", f"商机创建时间：{period}。聊天截至{cutoff:%m月%d日 %H:%M}（中国时间，不含）；资料按实际观察日期标注。")
    main["A1"].font = Font(name=FONT, size=18, bold=True, color="244C57")
    main.merge_cells("K2:U2")
    main["K2"] = "按商机计数，同会员多条商机保留。名单为当前账号可见范围，不代表公司全部新客。"
    main["K2"].font = Font(name=FONT, size=10, color="536A70")

    split_cn = split.astimezone(CN) if split else None
    summary_headers = ["店铺", "跟进商机", *QUALITIES, "排除记录"]
    if split:
        summary_headers += [f"{start.astimezone(CN):%m.%d}–{(split_cn - timedelta(days=1)):%m.%d}名单", f"{split_cn:%m.%d}–{last_day:%m.%d}名单"]
    for col, h in enumerate(summary_headers, 1):
        main.cell(4, col, h)
    style_header(main, 4, len(summary_headers))
    totals = [0] * (len(summary_headers) - 1)
    for i, store in enumerate(stores + ["多店合计"]):
        r = 5 + i
        if store == "多店合计":
            values = totals
        else:
            mine = [x for x in rows if x["store_key"] == store]
            values = [len(mine), *[sum(1 for x in mine if x["quality"] == q) for q in QUALITIES], sum(1 for x in old if x["store_key"] == store)]
            if split:
                everyone = [x for x in data["rows"] if x["store_key"] == store]
                values += [sum(1 for x in everyone if parse_time(x["created_at"]) < split), sum(1 for x in everyone if parse_time(x["created_at"]) >= split)]
            totals = [a + b for a, b in zip(totals, values)]
        main.cell(r, 1, store)
        for col, v in enumerate(values, 2):
            main.cell(r, col, v).alignment = Alignment(horizontal="center")
        if store == "多店合计":
            for col in range(1, len(summary_headers) + 1):
                main.cell(r, col).fill = PatternFill("solid", fgColor="E3EEEB")
                main.cell(r, col).font = Font(name=FONT, bold=True)
    notes_row = 5 + len(stores) + 2
    for offset, text in enumerate([
        "好：需求、适配与推进均有依据。中：有需求，关键条件仍待确认。",
        "老客、撞客及已确认钓鱼商机移至排除记录。采集失败保留待核，不解释为客户未回复。",
        "旧聊天及背景按证据复用，已有记录只补增量。前后变化及背调缺口分别列明；付款陈述不代表到账。",
    ]):
        r = notes_row + offset
        main.merge_cells(f"A{r}:J{r}")
        main.cell(r, 1, text).font = Font(name=FONT, size=10, color="536A70")

    header_row = notes_row + 4
    headers = MAIN_HEADERS + (METRIC_HEADERS if metrics else [])
    widths = MAIN_WIDTHS + (METRIC_WIDTHS if metrics else [])
    values = []
    for i, r in enumerate(rows):
        line = [i + 1, local(r["created_at"]), r["store_key"], country_zh(r.get("country")) or "未取得", r.get("buyer_level") or "未取得", r.get("buyer_name") or "未提供", r.get("product") or "待确认", r["quality"], r.get("quality_reason"), r.get("next_action"), r.get("owner") or "未取得", short_axis(r.get("business_model")), short_axis(r.get("purchase_purpose")), "｜".join(x for x in [r.get("deep_communication") or "未核实", r.get("deep_stage"), r.get("deep_reason")] if x), r.get("deal_status") or "未核实", local(r.get("chat_snapshot_at")), r.get("chat_origin"), r.get("chat_status"), r["inquiry_id"], local(r["created_at"]), r.get("row_key"), r.get("business_model_basis"), r.get("business_model_uncertainty"), r.get("purchase_purpose_basis"), r.get("purchase_purpose_uncertainty"), r.get("entity_assessment"), r.get("risk_assessment"), r.get("change_summary") or "本轮变化待核验"]
        if metrics:
            m = by_key[(r["store_key"], r["inquiry_id"])]
            line += [reason_label(m), m["first_response_minutes"], local(m["last_buyer_at"]), m["buyer_silent_days"], STAGE_LABEL[m["silence_stage"]], m["seller_auto_messages"]]
        values.append(line)
    date_cols = {2: "yyyy-mm-dd", 16: "mm-dd hh:mm", 20: "yyyy-mm-dd hh:mm"}
    if metrics:
        date_cols[len(MAIN_HEADERS) + 3] = "yyyy-mm-dd hh:mm"
    last = write_table(main, header_row, headers, values, "NewOpportunityFollowup", widths, wrap_from=4, text_cols={19}, date_cols=date_cols, min_height=76, height_cols=(7, 9, 10, 14, 15, 18, 26, 27, 28))
    for grade, (fill, color) in GRADE_STYLE.items():
        main.conditional_formatting.add(f"H{header_row + 1}:H{last}", FormulaRule(formula=[f'ISNUMBER(SEARCH("{grade}",H{header_row + 1}))'], fill=PatternFill("solid", fgColor=fill), font=Font(bold=True, color=color), stopIfTrue=True))
    main.conditional_formatting.add(f"G{header_row + 1}:G{last}", FormulaRule(formula=[f'ISNUMBER(SEARCH("待确认",G{header_row + 1}))'], fill=PatternFill("solid", fgColor="FFF8E8")))

    excluded = wb.create_sheet("排除记录")
    excluded.sheet_properties.tabColor = "A46D4E"
    title(excluded, "老客、撞客及钓鱼排除记录", "7C563E", "按原排除依据保留台账。已确认钓鱼商机停止采集和背调；历史往来不等于历史成交。")
    excluded["A4"], excluded["B4"] = "排除数量", len(old)
    write_table(excluded, 6, EXCLUDED_HEADERS, [[i + 1, r["store_key"], r.get("buyer_name") or "未提供", local(r["created_at"]), "排除", r.get("exclusion_reason") or r.get("quality_reason") or "排除依据待核验", r["inquiry_id"], local(r.get("exclusion_evidence_at")), r.get("chat_origin"), r.get("row_key")] for i, r in enumerate(old)], "ExcludedOpportunityContacts", [8, 18, 25, 23, 12, 61, 24, 23, 18, 12], wrap_from=3, text_cols={7}, date_cols={4: "yyyy-mm-dd hh:mm", 8: "yyyy-mm-dd hh:mm"}, min_height=57, height_cols=(6,))

    evidence = wb.create_sheet("判断依据")
    evidence.sheet_properties.tabColor = "87959A"
    title(evidence, "产品与质量判断依据", "244C57", "按证据编号关联跟进表。引用只保留判断所需片段；卖方陈述、买家陈述、公开来源及采集缺口分别标明。", "H")
    write_table(evidence, 5, EVIDENCE_HEADERS, [[e.get("row_key"), e.get("store_key"), e.get("inquiry_id"), e.get("use"), e.get("source_type"), e.get("locator"), local(e.get("sent_at") or e.get("observed_at")), e.get("description")] for e in data["evidence"]], "OpportunityEvidence", [12, 18, 24, 15, 18, 36, 22, 87], text_cols={3}, date_cols={7: "yyyy-mm-dd hh:mm"}, min_height=74, height_cols=(4, 5, 8))

    background = wb.create_sheet("全量背调状态")
    background.sheet_properties.tabColor = "6D7D69"
    title(background, "本期全部商机背调状态", "465E45", f"覆盖{period}全部商机，排除项保留原因。平台资料、企业主体、公开研究与画像分别验收，公开候选不等于企业核验完成。", "Q")
    bg_rows = []
    for i, r in enumerate(data["rows"]):
        d = r.get("diligence") or {}
        fallback = "按排除依据保留" if r["excluded"] else "未核验"
        sources = [s if isinstance(s, str) else "：".join(x for x in [s.get("title") or s.get("source_type"), s.get("url") or s.get("path") or s.get("locator")] if x) for s in [*(d.get("public_sources") or []), *(d.get("evidence_refs") or [])]]
        gaps = d.get("gaps")
        gaps = "\n".join(g if isinstance(g, str) else g.get("description") or g.get("reason") or g.get("url") or g.get("path") or "" for g in gaps) if isinstance(gaps, list) else gaps if isinstance(gaps, str) else ""
        bg_rows.append([i + 1, r["store_key"], r["inquiry_id"], r.get("company_name") or r.get("buyer_name") or "未提供", "排除" if r["excluded"] else "纳入复核", d.get("action") or ("保留排除" if r["excluded"] else "待核验"), d.get("status") or fallback, d.get("platform_status") or fallback, d.get("entity_status") or fallback, d.get("public_status") or fallback, d.get("profile_status") or fallback, local(d.get("observed_at")), "\n".join(x for x in sources if x) or "未提供", gaps or (r.get("exclusion_reason") or "见排除记录" if r["excluded"] else "本轮背调状态或证据尚未完整提供"), d.get("next_action") or ("保持排除" if r["excluded"] else r.get("next_action") or "补齐证据后复核"), d.get("formal_v3_status") or ("不适用" if r["excluded"] else "未执行正式v3"), r.get("row_key")])
    for col, (h, v) in enumerate([("总商机", len(data["rows"])), ("纳入复核", len(rows)), ("排除", len(old)), ("未提供来源", sum(1 for x in bg_rows if x[12] == "未提供"))]):
        background.cell(4, col * 2 + 1, h)
        background.cell(4, col * 2 + 2, v)
    write_table(background, 6, BACKGROUND_HEADERS, bg_rows, "AllOpportunityDiligence", [8, 18, 24, 27, 13, 22, 32, 32, 42, 42, 35, 25, 72, 64, 50, 24, 12], text_cols={3}, date_cols={12: "yyyy-mm-dd hh:mm"}, min_height=66, height_cols=(7, 8, 9, 10, 11, 13, 14, 15))

    counts = {"followup": len(rows), "excluded": len(old), "evidence": len(data["evidence"]), "quality": {q: sum(1 for r in rows if r["quality"] == q) for q in QUALITIES}}
    if counts["followup"] + counts["excluded"] != data["population_total"]:
        raise AssertionError("follow-up + excluded must equal population")
    return wb, counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", required=True, help="final-data.json")
    parser.add_argument("--out", required=True, help="输出 xlsx；已存在则拒绝覆盖")
    parser.add_argument("--from", dest="start", required=True, help="创建时间下界（含），如 2026-10-01T00:00:00+08:00")
    parser.add_argument("--to", dest="end", required=True, help="创建时间上界（不含）")
    parser.add_argument("--split", help="名单分段点（可选）")
    parser.add_argument("--metrics", help="followup_metrics.py 输出（可选）")
    parser.add_argument("--label", help="期间说明文字（可选）")
    args = parser.parse_args(argv)

    out = Path(args.out)
    if out.exists():
        parser.error(f"{out} already exists; preserve the frozen prior file")
    data, source_sha256 = load_final_data(args.input)
    metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8")) if args.metrics else None
    wb, counts = build(data, parse_time(args.start), parse_time(args.end), parse_time(args.split), metrics, args.label, source_sha256=source_sha256)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    print(json.dumps({"output": str(out), **counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
