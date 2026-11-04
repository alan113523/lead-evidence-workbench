"""生成会议用新商机转化看板（单文件 HTML，离线可开）。

输入 final-data.json 与 followup_metrics.py 输出；页面内按店铺/业务员筛选，
所有数字、图表和清单随筛选同步。客户姓名等明细嵌入页面，只放在被忽略的 outputs/。
"""
import argparse
import hashlib
import json
import sys
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from html import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))
from country import country_zh  # noqa: E402
from buyer_background_view import background_view  # noqa: E402
from background_reuse import load_reuse  # noqa: E402
from followup_metrics import load_final_data, parse_ms, validate_metrics  # noqa: E402

CN = timezone(timedelta(hours=8))
PAYMENT_CLAIM = re.compile(r"(自述|自称|称|表示进行)[^；，。]*(付款|Paid|Done)|收到付款|称已付款")


def cn_date(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(CN).strftime("%m-%d")


def card_message_index(content, metrics):
    """Explicit optional frozen JSONL only; never discover/open a private source path."""
    if content is None:
        return None
    if hashlib.sha256(content).hexdigest() != metrics["source_binding"]["messages_sha256"].lower():
        raise ValueError("action card messages sha256 does not match metrics binding")
    records, offset = {}, 0
    for line, raw in enumerate(content.splitlines(keepends=True), 1):
        record = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(record, dict):
            raise ValueError("invalid action card message record")
        key = record.get("key")
        if not isinstance(key, str) or not key or key in records:
            raise ValueError("duplicate or invalid action card message key")
        records[key] = {"record": record, "line": line, "byte_offset": offset, "byte_length": len(raw)}
        offset += len(raw)
    return records


def card_quote(row, evidence, messages, cutoff):
    """Only a scoped, single-version, readable original may supply a displayed quote."""
    if messages is None:
        return None, "未显式提供冻结消息原件；不展示聊天原句"
    binding = row.get("reviewed_message_binding") or {}
    path = (binding.get("messages_file") or {}).get("path")
    locator = evidence.get("locator")
    source_ref = evidence.get("source_ref")
    if "source_ref" in evidence:
        if not isinstance(source_ref, dict) or not isinstance(path, str) or source_ref.get("path") != path or not isinstance(source_ref.get("message_key"), str) or not source_ref["message_key"] or source_ref.get("role") != "current_inquiry_window" or any(not isinstance(source_ref.get(k), int) or isinstance(source_ref[k], bool) or source_ref[k] < minimum for k, minimum in [("line", 1), ("byte_offset", 0), ("byte_length", 1)]):
            return None, "证据 source_ref 缺少同文件消息键、本期角色或有效行字节定位"
        key = source_ref["message_key"]
        if isinstance(locator, str) and "#" in locator and locator != path + "#" + key:
            return None, "证据 source_ref 与 locator 定位冲突，不展示原句"
        if source_ref.get("content_conflict"):
            return None, "证据 source_ref 标记内容冲突，不展示原句"
    else:
        if not isinstance(path, str) or not isinstance(locator, str) or not locator.startswith(path + "#"):
            return None, "证据未精确定位到本行声明的消息文件#key"
        key = locator[len(path) + 1:]
    refs = [r for r in binding.get("messages", []) if isinstance(r, dict) and r.get("message_key") == key and r.get("role") == "current_inquiry_window"]
    if len(refs) != 1 or key not in messages:
        return None, "消息断链或不属于本商机本期窗口绑定"
    ref, entry = refs[0], messages[key]
    record = entry["record"]
    if ref.get("content_conflict") or record.get("content_conflict"):
        return None, "同键内容冲突尚未闭合，不展示原句"
    if any(field in ref and ref[field] != entry[field] for field in ["line", "byte_offset", "byte_length"]):
        return None, "消息行号或字节定位与原件不一致"
    if source_ref is not None and any(source_ref[field] != entry[field] for field in ["line", "byte_offset", "byte_length"]):
        return None, "证据 source_ref 行号或字节定位与原件不一致"
    variants = record.get("variants") or []
    if not isinstance(variants, list) or any(not isinstance(v, dict) for v in variants):
        return None, "消息版本格式不可用"
    if len(variants) != 1:
        return None, "同键存在多个版本或原版本缺失，本轮不接受自报SHA选择版本，不展示原句"
    variant = variants[0]
    message = variant.get("message") or {}
    if variant.get("content_conflict") or not isinstance(message, dict):
        return None, "消息版本存在内容冲突或正文格式不可用"
    if record.get("store_key") != row["store_key"] or any(not isinstance(record.get(k), str) or not record[k] for k in ["conversation_id", "message_id"]) or record.get("key") != "|".join([record["store_key"], record["conversation_id"], record["message_id"]]) or message.get("message_id") != record["message_id"]:
        return None, "消息店铺/会话/消息ID精确身份不一致"
    proofs = []
    for item in [record, variant]:
        ids, associations, inquiry_keys = item.get("inquiry_ids"), item.get("associations"), item.get("inquiry_keys")
        if ids is not None and not isinstance(ids, list) or associations is not None and not isinstance(associations, list) or inquiry_keys is not None and (not isinstance(inquiry_keys, list) or any(not isinstance(k, str) or not k for k in inquiry_keys)):
            return None, "原件商机关联格式不可用，未展示原句"
        if isinstance(ids, list) and ids:
            proofs.append(row["inquiry_id"] in ids)
        if isinstance(associations, list) and associations:
            proofs.append(any(a.get("store_key") == row["store_key"] and a.get("inquiry_id") == row["inquiry_id"] and a.get("conversation_id", record["conversation_id"]) == record["conversation_id"] for a in associations if isinstance(a, dict)))
        if isinstance(inquiry_keys, list) and inquiry_keys:
            proofs.append(f"{row['store_key']}|{row['inquiry_id']}" in inquiry_keys)
    if not proofs or not all(proofs):
        return None, "原件缺少同商机关联证明或关联冲突，仅有行内绑定声明/待复核"
    ms = message.get("send_time_ms")
    try:
        in_window = isinstance(ms, int) and not isinstance(ms, bool) and parse_ms(row["created_at"]) <= ms < parse_ms(cutoff)
        if message.get("sent_at") and parse_ms(message["sent_at"]) != ms:
            in_window = False
    except (TypeError, ValueError, KeyError):
        in_window = False
    if not in_window:
        return None, "发送时间缺失、冲突或不在本商机本期窗口"
    body = message.get("text")
    if message.get("content_status") != "read" or not isinstance(body, str) or not body.strip() or message.get("direction") not in ("buyer", "seller"):
        return None, "正文未读、不可用或买卖方方向未确认"
    quote = evidence.get("quote")
    if quote is not None and (not isinstance(quote, str) or not quote or quote not in body):
        return None, "提交的摘录不在冻结消息正文中"
    flags = message.get("automation_flags")
    if flags is not None and not isinstance(flags, dict):
        return None, "消息自动标记格式不可用，方向性质待复核"
    flags = flags or {}
    automatic = message.get("reply_source") == "ai" or any(flags.get(k) for k in ["auto_reply", "robot_message"])
    speaker = "买方" if message["direction"] == "buyer" else "卖方"
    speaker += "自动消息" if automatic else "（非自动；人工身份未确认）" if message["direction"] == "seller" else "消息"
    text = quote if quote is not None else body
    return {"text": text[:450], "truncated": len(text) > 450, "speaker": speaker,
            "sent_at": datetime.fromtimestamp(ms / 1000, tz=CN).strftime("%Y-%m-%d %H:%M:%S +08:00"),
            "message_key": key, "source": f"{path}#{key} · line {entry['line']} · byte {entry['byte_offset']}"}, None


def action_card(row, metric, evidence_rows, messages, cutoff):
    sources, gaps, refs = [], [], {}
    for index, evidence in enumerate(evidence_rows):
        if not isinstance(evidence, dict):
            continue
        if evidence.get("store_key") != row["store_key"] or evidence.get("inquiry_id") != row["inquiry_id"]:
            continue
        if evidence.get("row_key") and evidence.get("row_key") != row.get("row_key"):
            gaps.append("证据判断编号与本行不一致，未用于卡片")
            continue
        eid = evidence.get("evidence_id") or evidence.get("id") or f"evidence-{index + 1}"
        quote, gap = card_quote(row, evidence, messages, cutoff)
        source = {"id": str(eid), "use": evidence.get("use") or "复核依据", "summary": evidence.get("description") or "未提供复核摘要",
                  "locator": evidence.get("locator") or "未提供定位", "observed_at": evidence.get("observed_at"), "source_sent_at": evidence.get("sent_at"),
                  "source_type": evidence.get("source_type") or "未标注来源性质", "quote": quote, "gap": gap}
        sources.append(source)
        if gap:
            gaps.append(f"{eid}：{gap}")
        if evidence.get("id") or evidence.get("evidence_id"):
            refs[str(eid)] = source if str(eid) not in refs else None
    if not sources:
        gaps.append("没有同店同商机的可追溯证据；仅保留本期复核摘要，不能据此核验原句")
    def text_gaps(value, label):
        if value is None:
            return [], True
        if isinstance(value, str):
            return [value] if value else [], True
        if isinstance(value, list):
            valid = all(isinstance(item, str) for item in value)
            if valid:
                return [item for item in value if item], True
        gaps.append(f"{label}格式不可用，覆盖待复核；仅提供内部复核草稿")
        return [], False
    coverage, metadata_usable = text_gaps(row.get("coverage_gaps"), "coverage_gaps")
    gaps.extend(coverage)
    continuation = row.get("collection_continuation")
    if continuation is None:
        continuation = {}
    elif not isinstance(continuation, dict):
        gaps.append("collection_continuation格式不可用，覆盖待复核；仅提供内部复核草稿")
        metadata_usable = False
        continuation = {}
    limitations, limitations_usable = text_gaps(continuation.get("limitations"), "覆盖限制")
    metadata_usable = metadata_usable and limitations_usable
    gaps.extend(limitations)
    if continuation.get("gap_closed") is False:
        gaps.append("本轮覆盖缺口尚未闭合")
    action = row.get("action") if isinstance(row.get("action"), dict) else {}
    scoped = action.get("store_key", row["store_key"]) == row["store_key"] and action.get("inquiry_id", row["inquiry_id"]) == row["inquiry_id"]
    valid = scoped and action.get("status") == "ai_proposed" and action.get("executed") is False
    def resolved(ids):
        return isinstance(ids, list) and bool(ids) and all(isinstance(i, str) and refs.get(i) and refs[i]["quote"] for i in ids)
    supported = valid and metadata_usable and resolved(action.get("evidence_refs"))
    if action and not supported:
        gaps.append("输入行动的状态、范围或证据引用待复核；本卡不作为执行回执")
    next_action = action.get("next_action") if supported else row.get("next_action")
    next_action = next_action if isinstance(next_action, str) and next_action.strip() else "先补齐本商机问题和证据，再由业务确定回复重点"
    owner = action.get("owner") if valid and resolved(action.get("owner_evidence_refs")) else None
    due = action.get("due_date") if valid and resolved(action.get("due_date_evidence_refs")) else None
    owner = owner if isinstance(owner, str) and owner.strip() else None
    due = due if isinstance(due, str) and due.strip() else None
    if due:
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
                raise ValueError("expected YYYY-MM-DD")
            datetime.fromisoformat(due.replace("Z", "+00:00"))
        except ValueError:
            gaps.append("行动到期格式不可用，保持待分配")
            due = None
    if not owner or not due:
        gaps.append("行动负责人或到期缺少独立可追溯依据，保持待分配；商机业务员不自动等于行动负责人")
    provided_steps = action.get("steps") or []
    if not isinstance(provided_steps, list):
        gaps.append("行动窗口steps格式不可用，改为内部复核草稿")
        provided_steps = []
    accepted = {}
    for window in ["24h", "72h", "一周"]:
        candidates = [step for step in provided_steps if isinstance(step, dict) and step.get("window") == window]
        if not candidates:
            continue
        step = candidates[0]
        if len(candidates) != 1 or not supported or step.get("store_key", row["store_key"]) != row["store_key"] or step.get("inquiry_id", row["inquiry_id"]) != row["inquiry_id"] or step.get("status", "ai_proposed") != "ai_proposed" or step.get("executed", False) is not False or not resolved(step.get("evidence_refs")) or not all(isinstance(step.get(field), str) and step[field].strip() for field in ["suggestion", "draft"]):
            gaps.append(f"{window}客户草稿范围、状态或原句引用未通过，改为内部复核草稿")
            continue
        accepted[window] = {"window": window, "suggestion": step["suggestion"], "draft": step["draft"],
                            "audience": "customer_draft", "evidence_refs": step["evidence_refs"]}
    defaults = {
        "24h": f"核对本期原句与覆盖缺口，先补证再由业务确认当前下一步：{next_action}",
        "72h": f"先复核是否有新增回复和已处理记录，再决定是否补充本条下一步：{next_action}；不凭缺页推定买家未回复。",
        "一周": f"复核本条需求与待核事项是否仍有效，并更新后续安排：{next_action}；拒绝或停止联系信号交业务处理，不自动催联。",
    }
    support_note = "；".join(gaps[:3]) if gaps else "引用仅覆盖本期可见原句，客户话术仍需业务复核"
    steps = [accepted.get(window) or {"window": window, "suggestion": suggestion, "audience": "internal_review", "evidence_refs": [],
             "draft": f"[内部复核草稿，非客户发送话术]\n精确范围：{row['store_key']} / {row['inquiry_id']}\n本期下一步：{next_action}\n{window}复核安排：{suggestion}\n需核对：{support_note}\n行动负责人/到期待分配项应由业务确认；本记录未执行、未发送，不确认到账。"}
             for window, suggestion in defaults.items()]
    return {"status": "ai_proposed", "executed": False, "payment_verified": False,
            "scope": f"{row['store_key']} / {row['inquiry_id']}", "owner": owner or "待分配", "due": due or "待分配",
            "coverage": row.get("chat_status") or "采集覆盖状态未提供", "gaps": list(dict.fromkeys(gaps)),
            "sources": sources[:8], "sources_omitted": max(0, len(sources) - 8),
            "followup_days": metric.get("seller_followup_days_after_last_buyer") if metric.get("last_buyer_at") else None,
            "steps": steps}


def rows_for_page(data, metrics, *, source_sha256=None, messages_content=None, include_action_cards=False, include_background=False, background_reuse=None):
    by_key = validate_metrics(data, metrics, source_sha256)
    messages = card_message_index(messages_content, metrics) if include_action_cards else None
    out = []
    for r in data["rows"]:
        base = {"s": r["store_key"], "o": r.get("owner") or "未取得", "x": r["excluded"]}
        if r["excluded"]:
            out.append(base)
            continue
        m = by_key[(r["store_key"], r["inquiry_id"])]
        overlay = (background_reuse or {}).get((r['store_key'],r['inquiry_id']),{})
        background_row = {**r,**{k:v for k,v in overlay.items() if k!='evidence'}}
        background_evidence = [*(data.get('evidence') or []),*overlay.get('evidence',[])]
        name = r.get("buyer_name")
        out.append({
            **base,
            "id": r["inquiry_id"],
            "n": name if name and name != "未提供" else f"商机 {r['inquiry_id']}",
            "c": country_zh(r.get("country")) or "",
            "d": cn_date(r["created_at"]),
            "q": r["quality"],
            "dp": r.get("deep_communication") if r.get("deep_communication") in ("Y", "N") else "未核实",
            "p": r.get("product") or "待确认",
            "qr": r.get("quality_reason") or "",
            "na": r.get("next_action") or "",
            "ds": r.get("deal_status") or "",
            "pay": bool(PAYMENT_CLAIM.search(r.get("deal_status") or "")),
            "rt": m["reason_tag"],
            "rs": m.get("reason_source"),
            "st": m["silence_stage"],
            "bt": m["buyer_turns"],
            "fr": m["first_response_minutes"],
            "sd": m["buyer_silent_days"],
            "sm": m["seller_messages"],
            "am": m["seller_auto_messages"],
            **({"ac": action_card(r, m, data.get("evidence") or [], messages, data["analysis_before_exclusive"])} if include_action_cards else {}),
            **({"bg": background_view(background_row, background_evidence)} if include_background else {}),
        })
    return out


def render(data, metrics, period, cutoff_label, *, source_sha256=None, messages_content=None, background_reuse=None, background_reuse_audit=None):
    page_rows = rows_for_page(data, metrics, source_sha256=source_sha256, messages_content=messages_content, include_action_cards=True, include_background=True, background_reuse=background_reuse)
    included = [r['bg'] for r in page_rows if not r['x']]
    positive = lambda a: a['state']=='initial' and any(c['state'] in ('supported','candidate') for c in a['claims'])
    stats = {'records':len(included), 'reused':sum(bool((b.get('reuse') or {}).get('account_binding')) for b in included),
             'business_initial':sum(positive(b['business']) for b in included),
             'business_candidate':sum(positive(b['business']) and all(c['state']=='candidate' for c in b['business']['claims'] if c['state']!='denied') for b in included),
             'purpose_initial':sum(positive(b['purpose']) for b in included),
             'business_legacy_traced':sum(bool(b['business'].get('legacy_review')) and not positive(b['business']) for b in included),
             'purpose_legacy_traced':sum(bool(b['purpose'].get('legacy_review')) and not positive(b['purpose']) for b in included),
             'axis_coverage':{name:{state:sum(b[name]['coverage']['state'] == state for b in included)
                                    for state in sorted({b[name]['coverage']['state'] for b in included})}
                              for name in ('business','purpose')},
             'dimension_coverage':[{state:sum(b['dimensions'][i]['coverage']['state'] == state for b in included)
                                     for state in sorted({b['dimensions'][i]['coverage']['state'] for b in included})}
                                   for i in range(5)],
             'dimension_sources':[sum(bool(b['dimensions'][i]['sources']) for b in included) for i in range(5)]}
    payload = json.dumps({"rows":page_rows,"period":period,"cutoff":cutoff_label,"background_reuse_audit":background_reuse_audit,"background_stats":stats}, ensure_ascii=False)
    payload = payload.replace("<", "\\u003c")
    return re.sub(r"__(DATA|PERIOD)__", lambda token: payload if token.group(1) == "DATA" else escape(period), TEMPLATE)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--messages", help="可选：显式提供同一冻结消息JSONL以核验行动卡原句；不自动打开输入声明的路径")
    parser.add_argument("--background-reuse", help="可选：显式已有画像复用清单；重验原件哈希与纯画像校验，不改冻结输入")
    parser.add_argument("--out", required=True, help="输出 html；已存在则拒绝覆盖")
    parser.add_argument("--period", required=True, help="页面标题中的期间，如 10月1日–21日")
    args = parser.parse_args(argv)
    out = Path(args.out)
    if out.exists():
        parser.error(f"{out} already exists; preserve the frozen prior file")
    data, source_sha256 = load_final_data(args.input)
    metrics = json.loads(Path(args.metrics).read_text(encoding="utf-8"))
    cutoff = datetime.fromisoformat(data["analysis_before_exclusive"]).astimezone(CN)
    messages_content = Path(args.messages).read_bytes() if args.messages else None
    reuse, reuse_audit = load_reuse(args.background_reuse,data,source_sha256) if args.background_reuse else (None,None)
    html = render(data, metrics, args.period, f"{cutoff:%m月%d日 %H:%M}", source_sha256=source_sha256, messages_content=messages_content,background_reuse=reuse,background_reuse_audit=reuse_audit)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(out)


TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>多店新商机转化看板 · __PERIOD__</title>
<style>
.viz-root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10); --wash: rgba(11,11,11,0.04);
  --series-1: #2a78d6; --series-1-soft: rgba(42,120,214,0.10);
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b; --pending: #c3c2b7;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
    --series-1: #3987e5; --series-1-soft: rgba(57,135,229,0.14); --pending: #5d5c58;
  }
}
* { box-sizing: border-box; }
body { margin: 0; }
.viz-root { background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; min-height: 100vh; padding: 28px 36px 60px; }
h1 { font-size: 26px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
.sub { color: var(--ink-2); margin: 0; }
.note { color: var(--muted); font-size: 13px; margin: 6px 0 0; }
.filters { display: flex; gap: 16px; align-items: center; margin: 20px 0 24px; flex-wrap: wrap; }
.filters label { color: var(--ink-2); font-size: 14px; display: flex; gap: 8px; align-items: center; }
select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--axis); border-radius: 6px; padding: 5px 10px; }
.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.tile, .card { background: var(--surface); border-radius: 10px; box-shadow: 0 0 0 1px var(--ring); }
.tile { padding: 16px 18px; }
.tile .label { color: var(--ink-2); font-size: 14px; }
.tile .value { font-size: 34px; font-weight: 600; line-height: 1.2; margin-top: 4px; }
.tile .value small { font-size: 16px; font-weight: 500; color: var(--ink-2); margin-left: 4px; }
.tile .foot { color: var(--muted); font-size: 13px; margin-top: 4px; }
.tile.hero .value { font-size: 52px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 18px; }
.card { padding: 20px 22px; }
.bars { margin-top: 14px; display: grid; gap: 10px; }
.bar-row { display: grid; grid-template-columns: 150px 1fr; gap: 12px; align-items: center; cursor: default; border-radius: 6px; }
.bar-row:hover, .bar-row:focus { background: var(--wash); outline: none; }
.bar-row .cat { color: var(--ink-2); font-size: 14px; text-align: right; }
.track { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.bar { height: 22px; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 2px; }
.bar-row .val { font-size: 14px; white-space: nowrap; }
.bar-row .val b { font-weight: 600; }
.bar-row .val span { color: var(--muted); margin-left: 4px; }
.callout { margin-top: 16px; padding: 12px 14px; background: var(--series-1-soft); border-radius: 8px; font-size: 14px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th { text-align: left; color: var(--ink-2); font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--axis); white-space: nowrap; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--ink); }
td { padding: 9px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.stack { display: flex; height: 18px; width: 260px; gap: 2px; }
.stack > div { height: 100%; }
.stack > div:first-child { border-radius: 4px 0 0 4px; }
.stack > div:last-child { border-radius: 0 4px 4px 0; }
.stack > div:only-child { border-radius: 4px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 10px; color: var(--ink-2); font-size: 13px; }
.legend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.flag { color: var(--critical); font-weight: 600; }
.tag { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; white-space: nowrap; }
.tag::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.pri { font-weight: 600; white-space: nowrap; }
.prio-table td.detail { color: var(--ink-2); max-width: 420px; }
.prio-table tr.main-row { cursor: pointer; }
.prio-table tr.main-row:hover { background: var(--wash); }
.prio-table tr.expand td { background: var(--wash); color: var(--ink-2); font-size: 13px; }
.action-card { padding: 12px 0; line-height: 1.6; }
.background-card { padding: 12px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; line-height: 1.7; }
.background-card summary { cursor: pointer; font-weight: 600; }
.background-card h3 { margin: 14px 0 4px; font-size: 15px; }
.background-card .background-source { border-left: 2px solid var(--axis); padding-left: 10px; margin: 8px 0; white-space: pre-wrap; }
.background-card .background-gap { color: var(--critical); }
.action-card h3 { margin: 12px 0 6px; color: var(--ink); font-size: 14px; }
.action-card .card-gap { color: var(--critical); white-space: pre-wrap; }
.action-card .evidence-source { border-left: 2px solid var(--axis); margin: 8px 0; padding: 4px 12px; overflow-wrap: anywhere; }
.action-card .card-quote { margin: 6px 0; white-space: pre-wrap; color: var(--ink); }
.action-card .draft { display: block; box-sizing: border-box; width: 100%; min-height: 86px; margin: 7px 0; padding: 9px; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--axis); border-radius: 6px; resize: vertical; }
.action-card .copy-status { margin-left: 8px; color: var(--muted); }
.prio-table .who { font-weight: 600; }
.prio-table .meta { color: var(--muted); font-size: 13px; }
.more { margin-top: 12px; font: inherit; font-size: 14px; color: var(--ink); background: var(--surface); border: 1px solid var(--axis); border-radius: 6px; padding: 6px 14px; cursor: pointer; }
#tip { position: fixed; pointer-events: none; background: var(--surface); color: var(--ink); box-shadow: 0 0 0 1px var(--ring), 0 6px 18px rgba(0,0,0,0.12); border-radius: 8px; padding: 8px 12px; font-size: 13px; display: none; z-index: 10; max-width: 300px; }
#tip b { font-size: 15px; display: block; }
.section { margin-bottom: 18px; }
footer { color: var(--muted); font-size: 12.5px; margin-top: 28px; line-height: 1.7; }
@media print { .filters, .more { display: none; } .viz-root { padding: 0; } }
</style>
</head>
<body>
<div class="viz-root">
  <h1>多店新商机转化看板</h1>
  <p class="sub" id="subtitle"></p>

  <div class="filters">
    <label>店铺 <select id="f-store"><option value="">全部店铺</option></select></label>
    <label>业务员 <select id="f-owner"><option value="">全部业务员</option></select></label>
  </div>

  <div class="tiles" id="tiles"></div>

  <div class="grid2">
    <div class="card">
      <h2>复核结论与回复行为</h2>
      <p class="note">质量、深入沟通与回复行为分别计数，可交叉重叠；回复轮数不替代复核结论。</p>
      <div class="bars" id="funnel"></div>
    </div>
    <div class="card">
      <h2>"差"的商机为什么差</h2>
      <p class="note" id="reason-note"></p>
      <div class="bars" id="reasons"></div>
      <div class="callout" id="reason-callout"></div>
    </div>
  </div>

  <div class="card section">
    <h2>业务员对比</h2>
    <p class="note">点表头排序。首次响应 = 买家首条消息到第一条非自动的卖方消息。</p>
    <div style="overflow-x:auto"><table id="owners"></table></div>
    <div class="legend" id="q-legend"></div>
  </div>

  <div class="card section">
    <h2>重点跟进清单</h2>
    <p class="note">优先级：① 买家最后发言、我们还没回 → ② 质量好 → ③ 质量中且已深入沟通。同级按买家沉默天数从短到长。点一行看完整依据。</p>
    <div style="overflow-x:auto"><table class="prio-table" id="prio"></table></div>
    <button class="more" id="more" type="button"></button>
  </div>

  <div class="card section">
    <h2>客户背景 · 五维阅读视图</h2>
    <p class="note" id="background-summary"></p>
    <p class="note">覆盖当前筛选的全部纳入复核商机。展开查看本次采购、五维背景、来源与缺口。保留候选、未知与原核验状态。</p>
    <p class="note">“旧结论已追溯”仅核对原结论文件，不新增画像判断。“未调查”表示当前冻结资料未记录该轴或维度调查；“查过无结果”须有原检索状态；“资料不足”表示已有复核但缺依据；“待适配”表示已有资料尚未接通。各行分别计数，不相加为公司数。</p>
    <div style="overflow-x:auto"><table id="background-coverage"></table></div>
    <div id="backgrounds"></div>
    <button class="more" id="background-more" type="button"></button>
  </div>
  <footer id="foot"></footer>
  <div id="tip" role="tooltip"></div>
</div>
<script>
const DATA = __DATA__;
const Q = {"好": "var(--good)", "中": "var(--warning)", "差": "var(--critical)", "待判断": "var(--pending)"};
const QORDER = ["好", "中", "差", "待判断"];
function reasonSourceNote(bad) { const d = bad.filter(r => r.rs !== "code").length; return d === 0 ? "原因来自复核写入的原因代码。" : d === bad.length ? "原因按质量依据文字归类（本期数据尚无原因代码）。" : `原因来自原因代码；其中 ${d} 条缺代码，按质量依据文字归类。`; }
const REASON = [["no_reply", "买家不再回复"], ["quote_no_reply", "报价后买家不回"], ["product_mismatch", "产品不匹配"], ["buyer_declined", "买家放弃"], ["other", "其他"]];
const STAGE = {awaiting_seller: "等我们回复", awaiting_buyer_after_first_turn: "首轮后买家没再回", awaiting_buyer_multi_turn: "多轮后买家没再回", no_chat: "无可用聊天"};
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); for (const k of kids) n.append(k); return n; };
const pct = (a, b) => b ? Math.round(a * 100 / b) : null;
const fmtPct = value => value == null ? "—" : `${value}%`;
const median = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const fmtMin = m => m == null ? "—" : m < 60 ? `${Math.round(m)} 分钟` : `${(m / 60).toFixed(1)} 小时`;
let showAll = false, backgroundAll = false, sortKey = "n", sortDir = -1;

const tip = $("tip");
function bindTip(node, lines) {
  node.tabIndex = 0;
  const show = e => { tip.replaceChildren(el("b", {textContent: lines[0]}), ...lines.slice(1).map(t => el("div", {textContent: t}))); tip.style.display = "block"; move(e); };
  const move = e => { const r = node.getBoundingClientRect(); const x = e && e.clientX != null ? e.clientX : r.right; const y = e && e.clientY != null ? e.clientY : r.top; tip.style.left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (y + 14) + "px"; };
  node.addEventListener("pointerenter", show); node.addEventListener("pointermove", move);
  node.addEventListener("pointerleave", () => tip.style.display = "none");
  node.addEventListener("focus", () => show()); node.addEventListener("blur", () => tip.style.display = "none");
}

function barRows(target, items, max) {
  target.replaceChildren(...items.map(([label, n, sub, tipLines]) => {
    const row = el("div", {className: "bar-row"});
    const bar = el("div", {className: "bar"}); bar.style.width = `calc((100% - 120px) * ${max ? n / max : 0})`;
    const val = el("div", {className: "val"}, el("b", {textContent: n}), el("span", {textContent: sub || ""}));
    row.append(el("div", {className: "cat", textContent: label}), el("div", {className: "track"}, bar, val));
    bindTip(row, tipLines || [`${n}`, label]);
    return row;
  }));
}

function tile(label, value, unit, foot, hero) {
  const v = el("div", {className: "value", textContent: value}); if (unit) v.append(el("small", {textContent: unit}));
  return el("div", {className: "tile" + (hero ? " hero" : "")}, el("div", {className: "label", textContent: label}), v, el("div", {className: "foot", textContent: foot}));
}

function reviewCounts(rows) {
  const included = rows.filter(r => !r.x);
  return {n: included.length,
    q: Object.fromEntries(QORDER.map(q => [q, included.filter(r => r.q === q).length])),
    deep: {Y: included.filter(r => r.dp === "Y").length, N: included.filter(r => r.dp === "N").length,
      unknown: included.filter(r => r.dp !== "Y" && r.dp !== "N").length}};
}

function render() {
  const fs = $("f-store").value, fo = $("f-owner").value;
  const all = DATA.rows.filter(r => (!fs || r.s === fs) && (!fo || r.o === fo));
  const rows = all.filter(r => !r.x), excluded = all.length - rows.length;
  const reviewed = reviewCounts(rows), n = reviewed.n;
  const replied = rows.filter(r => r.bt >= 2).length, deep = reviewed.deep.Y, good = reviewed.q["好"];
  const bad = rows.filter(r => r.q === "差"), pay = rows.filter(r => r.pay);
  const awaiting = rows.filter(r => r.st === "awaiting_seller");
  const scope = [fs, fo].filter(Boolean).join(" · ") || "多店全部";
  $("subtitle").textContent = `商机创建 ${DATA.period}，聊天截至 ${DATA.cutoff}（中国时间）· 当前范围：${scope}${n ? "" : " · 当前筛选无有效商机，比例无分母（—）"}`;

  $("tiles").replaceChildren(
    tile("有效新商机", n, "条", `另排除老客/撞客/钓鱼 ${excluded} 条`, true),
    tile("深入沟通过", deep, `条 · ${fmtPct(pct(deep, n))}`, `复核：Y ${deep} · N ${reviewed.deep.N} · 未核实 ${reviewed.deep.unknown}`),
    tile("质量好", good, `条 · ${fmtPct(pct(good, n))}`, "按本期已复核质量独立计数"),
    tile("聊天中提到已付款", pay.length, "条", "均为聊天陈述，到账未核实"),
    tile("等我们回复", awaiting.length, "条", "买家最后发言、卖方尚未回")
  );

  barRows($("funnel"), [
    ["有效新商机", n, "", [`${n} 条`, "排除老客、撞客、钓鱼后的商机"]],
    ["买家回应过我们", replied, fmtPct(pct(replied, n)), [`${replied} 条（${fmtPct(pct(replied, n))}）`, "行为指标：买家在卖方非自动回复后至少再发过一轮消息，不代表深入沟通"]],
    ["深入沟通 Y", deep, fmtPct(pct(deep, n)), [`${deep} 条（${fmtPct(pct(deep, n))}）`, "采用本期已复核的深入沟通结论"]],
    ["深入沟通 N", reviewed.deep.N, fmtPct(pct(reviewed.deep.N, n))],
    ["深入沟通未核实", reviewed.deep.unknown, fmtPct(pct(reviewed.deep.unknown, n))],
    ["质量好", good, fmtPct(pct(good, n)), [`${good} 条（${fmtPct(pct(good, n))}）`, "采用本期已复核质量，不要求深入沟通 Y 或多轮回应"]],
  ], n);

  $("reason-note").textContent = `共 ${bad.length} 条判为差（占有效商机 ${fmtPct(pct(bad.length, n))}）。${reasonSourceNote(bad)}`;
  const reasons = REASON.map(([k, label]) => { const c = bad.filter(r => r.rt === k).length; return [label, c, fmtPct(pct(c, bad.length)), [`${c} 条（${fmtPct(pct(c, bad.length))}）`, label]]; });
  barRows($("reasons"), reasons, Math.max(1, ...reasons.map(r => r[1])));
  const silent = bad.filter(r => r.rt === "no_reply" || r.rt === "quote_no_reply").length;
  const firstTurn = rows.filter(r => r.st === "awaiting_buyer_after_first_turn").length;
  $("reason-callout").textContent = bad.length
    ? `${fmtPct(pct(silent, bad.length))} 的"差"是买家沉默，产品或价格不合适的只占 ${fmtPct(pct(bad.filter(r => r.rt === "product_mismatch" || r.rt === "buyer_declined").length, bad.length))}。全部有效商机中，有 ${firstTurn} 条（${fmtPct(pct(firstTurn, n))}）买家只说了一轮就没再回——第一轮回复的内容值得复盘。`
    : "当前范围没有判为差的商机。";

  renderOwners(rows);
  renderPriority(rows);
  renderBackgrounds(rows);
}

function ownerStats(rows) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.o)) by.set(r.o, []); by.get(r.o).push(r); }
  return [...by].map(([o, rs]) => {
    const reviewed = reviewCounts(rs);
    const seller = rs.reduce((a, r) => a + r.sm, 0), auto = rs.reduce((a, r) => a + r.am, 0);
    const withResp = rs.filter(r => r.fr != null);
    return {o, rs, n: reviewed.n, q: reviewed.q, depth: reviewed.deep,
      bad: pct(reviewed.q["差"], reviewed.n), deep: pct(reviewed.deep.Y, reviewed.n),
      fr: median(rs.map(r => r.fr)), hour: pct(withResp.filter(r => r.fr <= 60).length, withResp.length),
      auto: pct(auto, seller + auto), first: pct(rs.filter(r => r.st === "awaiting_buyer_after_first_turn").length, rs.length),
      wait: rs.filter(r => r.st === "awaiting_seller").length};
  });
}

function renderOwners(rows) {
  const stats = ownerStats(rows);
  const cols = [["o", "业务员"], ["n", "商机", 1], ["dist", "质量分布"], ["deep", "深入沟通%（Y/N/未核实）", 1], ["bad", "差%", 1], ["fr", "非自动首次响应中位", 1], ["hour", "1小时内非自动回复%", 1], ["auto", "自动消息%", 1], ["first", "首轮后买家没再回%", 1], ["wait", "等我们回复", 1]];
  stats.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; return (x == null) - (y == null) || (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir; });
  const head = el("tr", {}, ...cols.map(([k, label, num]) => {
    const th = el("th", {textContent: label + (sortKey === k ? (sortDir > 0 ? " ↑" : " ↓") : ""), className: (num ? "num " : "") + (k !== "dist" ? "sortable" : "")});
    if (k !== "dist") th.onclick = () => { sortDir = sortKey === k ? -sortDir : (k === "o" ? 1 : -1); sortKey = k; renderOwners(rows); };
    return th;
  }));
  const body = stats.map(s => {
    const stack = el("div", {className: "stack"});
    for (const q of QORDER) if (s.q[q]) { const seg = el("div"); seg.style.flex = s.q[q]; seg.style.background = Q[q]; bindTip(seg, [`${s.q[q]} 条（${fmtPct(pct(s.q[q], s.n))}）`, `${s.o} · 质量${q}`]); stack.append(seg); }
    const cell = (v, warn) => el("td", {className: "num" + (warn ? " flag" : ""), textContent: v});
    return el("tr", {}, el("td", {textContent: s.o}), cell(s.n), el("td", {}, stack), cell(`${fmtPct(s.deep)}（${s.depth.Y}/${s.depth.N}/${s.depth.unknown}）`), cell(fmtPct(s.bad), s.bad >= 75),
      cell(fmtMin(s.fr), s.fr != null && s.fr > 120), cell(fmtPct(s.hour)), cell(fmtPct(s.auto), s.auto >= 30), cell(fmtPct(s.first), s.first >= 45), cell(s.wait || "—", s.wait > 0));
  });
  $("owners").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
  $("q-legend").replaceChildren(...QORDER.map(q => { const i = el("i"); i.style.background = Q[q]; return el("span", {}, i, `质量${q}`); }),
    el("span", {textContent: "红字 = 差% ≥ 75%、首次响应 > 2 小时、自动消息 ≥ 30%、首轮后没再回 ≥ 45%，或有待回复客户"}));
}

function priority(r) {
  if (r.st === "awaiting_seller") return [1, "① 等我们回复"];
  if (r.q === "好") return [2, "② 质量好"];
  if (r.q === "中" && r.dp === "Y") return [3, "③ 中 + 深入沟通"];
  return null;
}

async function copyDraft(textarea, status) {
  try {
    if (!globalThis.navigator?.clipboard?.writeText) throw new Error("clipboard unavailable");
    await globalThis.navigator.clipboard.writeText(textarea.value);
    status.textContent = "已复制草稿；尚未发送";
  } catch {
    textarea.focus(); textarea.select();
    status.textContent = "自动复制未完成，已选中草稿，请手动复制；尚未发送";
  }
}

function renderActionCard(r) {
  const a = r.ac, card = el("div", {className: "action-card"});
  if (!a) return card;
  card.append(el("h3", {textContent: "证据行动卡 · AI草稿 · 未执行/未发送"}),
    el("div", {textContent: `精确范围：${a.scope} · 行动负责人：${a.owner} · 到期：${a.due}`}),
    el("div", {textContent: `覆盖：${a.coverage}`}),
    el("div", {textContent: `最后买家消息后非自动跟进：中国自然日 ${a.followup_days == null ? "未核实/不适用" : a.followup_days + " 天"}（仅本期绑定窗口）`}),
    el("div", {textContent: "付款和订单内容均为来源陈述；本卡不确认到账，不构成执行回执。"}));
  if (a.gaps.length) card.append(el("h3", {textContent: "覆盖与引用缺口"}), ...a.gaps.map(g => el("div", {className: "card-gap", textContent: g})));
  card.append(el("h3", {textContent: "本商机证据与原件定位"}));
  for (const s of a.sources) {
    const source = el("div", {className: "evidence-source"},
      el("div", {textContent: `${s.id} · ${s.use} · ${s.source_type}`}),
      el("div", {textContent: `复核摘要（不是自动核验的聊天原句）：${s.summary}`}),
      el("div", {textContent: `证据原定位：${s.locator}`}),
      el("div", {textContent: `观察时间：${s.observed_at || "未提供"} · 证据声明发送时间：${s.source_sent_at || "未提供"}`}));
    if (s.quote) source.append(el("div", {textContent: `冻结原件摘录 · ${s.quote.speaker} · ${s.quote.sent_at}`}),
      el("blockquote", {className: "card-quote", textContent: s.quote.text}),
      el("div", {textContent: `精确消息：${s.quote.source}${s.quote.truncated ? " · 仅显示前450字符" : ""}`}));
    else source.append(el("div", {className: "card-gap", textContent: s.gap || "未核验原句"}));
    card.append(source);
  }
  if (a.sources_omitted) card.append(el("div", {textContent: `另有 ${a.sources_omitted} 条同商机证据未展开，保留在冻结输入中。`}));
    card.append(el("h3", {textContent: "交业务复核的建议窗口"}), el("div", {textContent: "以下从业务接手时起建议安排；不是承诺到期日、定时任务或已联系记录。客户话术仅投影有本行原句引用的输入，不自动判断话术事实真伪；其他内容仅内部复核。草稿可编辑，仅本机复制。"}));
  for (const step of a.steps) {
    const textarea = el("textarea", {className: "draft", value: step.draft, ariaLabel: `${step.window} 可编辑草稿`});
    const status = el("span", {className: "copy-status", textContent: "草稿 · 未发送"});
    const button = el("button", {type: "button", textContent: "复制草稿"});
    button.onclick = () => copyDraft(textarea, status);
    card.append(el("h3", {textContent: `${step.window} 建议 · ${step.audience === "customer_draft" ? "客户话术草稿（发送前需业务复核）" : "内部复核草稿（非客户话术）"}`}),
      el("div", {textContent: step.suggestion}), el("div", {textContent: step.evidence_refs.length ? `本行原句引用：${step.evidence_refs.join("、")}` : "未提供经复核客户话术，不生成通用英语催联。"}), textarea, button, status);
  }
  return card;
}

function renderBackground(r) {
  const b = r.bg, card = el("details", {className: "background-card"});
  if (!b) return card;
  card.append(el("summary", {textContent: `${r.n} · ${r.s} / ${r.id} · ${b.company}`}),
    el("h3", {textContent: "本次商机摘要"}),
    el("div", {textContent: `采购产品：${b.product}`}),
    el("div", {textContent: `下一步建议：${b.next_action}`}),
    el("div", {textContent: "日常证据阅读视图 · 来源摘要由原输入提供，未在此重新核验网页或聊天。"}));
  if (b.reuse) card.append(el("div", {textContent: `已有复核记录复用：${b.reuse.status} · 评估日期：${b.reuse.assessed_at || "未提供"} · 来源：${b.reuse.review_path || "见复用清单"} · ${b.reuse.note || ""}`}));
  if (b.legacy && Object.keys(b.legacy).length) {
    const old = el("details", {}, el("summary", {textContent: "冻结旧版复核文字（原样保留，不作为新增v2判断）"}));
    const names = {business_model: "公司经营模式", business_model_basis: "经营模式原依据", business_model_uncertainty: "经营模式不确定性", purchase_purpose: "本次采购用途", purchase_purpose_basis: "采购用途原依据", purchase_purpose_uncertainty: "采购用途不确定性", entity_assessment: "原实体核验文字", risk_assessment: "原风险核验文字", assessed_at: "原评估时间"};
    for (const [key, value] of Object.entries(b.legacy)) old.append(el("div", {textContent: `${names[key] || key}：${value}`}));
    card.append(old);
  }
  function axis(label, a) {
    const natures = {platform_self_report: "平台自报", buyer_statement: "买家陈述", public_observation: "公开来源", manual_record: "人工记录"};
    card.append(el("h3", {textContent: label}), el("div", {textContent: `覆盖状态：${a.coverage.state} · ${a.coverage.reason}`}));
    for (const source of a.coverage.checked_sources || []) card.append(el("div", {textContent: `已核待适配源：${source.path} · ${source.pointer} · SHA256 ${source.sha256}`}));
    const old = a.legacy_review;
    if (old) card.append(el("div", {className: "legacy-traced", textContent: `旧结论已追溯（保留原等级，不转换为v2）：${old.summary}`}),
      el("div", {textContent: `原依据：${old.basis}`}), el("div", {textContent: `原不确定性：${old.uncertainty || "原记录未提供"}`}),
      el("div", {textContent: `原源记录评估日期：${old.assessed_at || "原记录未提供；未用本次出表日期代填"}`} ),
      el("div", {textContent: `原结论出处：${old.source.path} · ${old.source.pointer} · SHA256 ${old.source.sha256}`}),
      el("div", {textContent: old.verification}));
    if (a.claims.length || !old) card.append(el("div", {textContent: `${a.state} · ${a.summary}`}));
    for (const c of a.claims) card.append(el("div", {textContent: `${c.state} · ${c.label} · ${c.reason} · ${c.inferred === true ? "推断" : c.inferred === false ? "原记录未标推断" : "推断标记未提供"} · 置信度：${c.confidence || "未提供"}（AI意见，非概率） · 来源性质：${c.source_natures.map(n => natures[n] || n).join("、") || "未提供"} · 不确定性：${c.uncertainty || "原记录未提供"} · 引用：${c.refs.join("、")}`}));
    if (a.uncertainty) card.append(el("div", {textContent: `不确定性：${a.uncertainty}`}));
    if (a.conflicts?.length) for (const conflict of a.conflicts) card.append(el("div", {className: "background-gap", textContent: `冲突记录：${typeof conflict === "string" ? conflict : conflict.reason || conflict.summary || "存在冲突，详见原复核记录"}`}));
    if (a.question) card.append(el("div", {textContent: `待确认问题：${a.question}`}));
  }
  axis("本次采购用途（独立判断）", b.purpose);
  b.dimensions.forEach((d, i) => {
    card.append(el("h3", {textContent: `${i + 1}. ${d.title}`}));
    card.append(el("div", {className: "background-gap", textContent: `本维度覆盖：${d.coverage.state} · ${d.coverage.reason}`}));
    if (i === 0) card.append(el("div", {textContent: `企业名称记录：${b.company} · 主体关联原状态：${b.entity}`}), el("div", {textContent: "公司注册在营、账号归属与本次采购意图须分别判断。"}));
    if (i === 0 && b.reuse?.account_binding) card.append(el("div", {textContent: `平台账号/商机关联：原文件精确对应 · ${b.reuse.account_binding.note} · 依据：${b.reuse.review_path} · 原文件SHA ${b.reuse.account_binding.final_data_sha256}`}));
    if (i === 1) axis("公司经营模式（平时做什么生意）", b.business);
    if (!d.sources.length) card.append(el("div", {className: "background-gap", textContent: "未取得可按本维度展示的完整证据；不表示不存在。"}));
    for (const s of d.sources) card.append(el("div", {className: "background-source", textContent: `来源记录 ${s.id} · ${s.nature}\n${s.summary}\n观察日期：${s.observed_at}\n出处：${s.locator}`}));
    if (i === 2) card.append(el("div", {textContent: "历史规模、融资或进口记录不直接代表本次采购预算。"}));
    if (i === 3) card.append(el("div", {textContent: "公开职位不自动代表负责本单或拥有最终决策权。"}));
    if (i === 4) card.append(el("div", {textContent: "公开公司渠道不自动归属当前平台联系人；联系建议须经业务复核。"}));
  });
  card.append(el("h3", {textContent: "核验状态与缺口"}), el("div", {textContent: `公开研究原状态：${b.public} · 正式v3原状态：${b.formal}`}),
    el("div", {textContent: `${b.risk}；五维栏目齐全不签发正式研究完成证明。`}));
  for (const [label, record] of [["主体原记录", b.entity_record], ["风险原记录", b.risk_record]]) if (record) {
    card.append(el("div", {textContent: `${label}：${record.status} · ${record.reason || "原因未提供"} · 引用：${(record.evidence_refs || []).join("、") || "无"}`}));
    const categories = {legal: "法律", compliance: "合规", payment: "付款", reputation: "声誉"};
    for (const [key, state] of Object.entries(record.category_statuses || {})) card.append(el("div", {textContent: `${categories[key] || key}原状态：${state}`}));
  }
  for (const gap of b.gaps) card.append(el("div", {className: "background-gap", textContent: gap}));
  card.append(el("h3", {textContent: "本商机证据索引（含未分维度的依据）"}));
  for (const s of b.sources) card.append(el("div", {className: "background-source", textContent: `${s.id} · ${s.nature} · ${s.use}\n${s.summary}\n观察日期：${s.observed_at}\n出处：${s.locator}`}));
  if (!b.sources.length) card.append(el("div", {className: "background-gap", textContent: "本商机尚无完整来源索引，背景判断待补证。"}));
  for (const source of b.context_sources) card.append(el("div", {textContent: `旧公开来源定位（未用于提升事实等级）：${source}`}));
  return card;
}

function renderBackgrounds(rows) {
  const backgrounds=rows.filter(r=>r.bg).map(r=>r.bg), positive=a=>a.state==='initial'&&a.claims.some(c=>['supported','candidate'].includes(c.state));
  const reused=backgrounds.filter(b=>b.reuse?.account_binding).length;
  const bm=backgrounds.filter(b=>positive(b.business)), pp=backgrounds.filter(b=>positive(b.purpose));
  const candidates=bm.filter(b=>b.business.claims.filter(c=>c.state!=='denied').every(c=>c.state==='candidate')).length;
  const oldBusiness=backgrounds.filter(b=>b.business.legacy_review&&!positive(b.business)).length, oldPurpose=backgrounds.filter(b=>b.purpose.legacy_review&&!positive(b.purpose)).length;
  $("background-summary").textContent=`当前筛选 ${rows.length} 条 · 已有复核复用/账号关联 ${reused} 条（不等于法定主体核实） · 经营模式：新版有据初判 ${bm.length} 条（其中仅候选 ${candidates}）＋旧结论已追溯 ${oldBusiness} 条 · 本次用途：新版有据初判 ${pp.length} 条＋旧结论已追溯 ${oldPurpose} 条。两类分别保留原等级，不代表完整企业背调完成。`;
  const states=['新版有据初判','旧结论已追溯','已有分类来源','待适配','查过无结果','资料不足','未调查'];
  const coverageRows=[['公司经营模式',backgrounds.map(b=>b.business.coverage)],['本次采购用途',backgrounds.map(b=>b.purpose.coverage)],
    ...[0,2,3,4].map(i=>[["身份与关联","主营与品类","商业实力","采购决策链","商业联系出口"][i],backgrounds.map(b=>b.dimensions[i].coverage)])];
  $("background-coverage").replaceChildren(el("thead",{},el("tr",{},...["内容",...states].map(t=>el("th",{textContent:t})))),
    el("tbody",{},...coverageRows.map(([label,values])=>el("tr",{},el("td",{textContent:label}),...states.map(state=>el("td",{textContent:String(values.filter(v=>v.state===state).length)}))))));
  const shown = backgroundAll ? rows : rows.slice(0, 25);
  $("backgrounds").replaceChildren(...shown.map(renderBackground));
  const button = $("background-more");
  button.hidden = rows.length <= 25;
  button.textContent = backgroundAll ? "收起客户背景" : `显示全部 ${rows.length} 条客户背景`;
  button.onclick = () => { backgroundAll = !backgroundAll; renderBackgrounds(rows); };
}

function renderPriority(rows) {
  const list = rows.map(r => ({r, p: priority(r)})).filter(x => x.p)
    .sort((a, b) => a.p[0] - b.p[0] || (a.r.sd ?? 99) - (b.r.sd ?? 99));
  const shown = showAll ? list : list.slice(0, 25);
  const head = el("tr", {}, ...["优先级", "客户", "业务员", "产品", "质量", "深入沟通", "买家沉默", "下一步"].map(t => el("th", {textContent: t})));
  const body = [];
  for (const {r, p} of shown) {
    const who = el("td", {}, el("div", {className: "who", textContent: r.n}), el("div", {className: "meta", textContent: [r.s, r.c, r.d && `创建 ${r.d}`].filter(Boolean).join(" · ")}));
    const q = el("span", {className: "tag", textContent: r.q}); q.style.setProperty("--c", Q[r.q]);
    const tr = el("tr", {className: "main-row"}, el("td", {className: "pri", textContent: p[1]}), who, el("td", {textContent: r.o}),
      el("td", {className: "detail", textContent: r.p}), el("td", {}, q), el("td", {textContent: r.dp}), el("td", {className: "num", textContent: r.sd == null ? "—" : `${r.sd} 天`}),
      el("td", {className: "detail", textContent: r.na}));
    const ex = el("tr", {className: "expand"}, el("td", {colSpan: 8}, el("div", {}, el("b", {textContent: "现状："}), r.qr), el("div", {}, el("b", {textContent: "成交/到账："}), r.ds || "未核实"), el("div", {}, el("b", {textContent: "商机ID："}), r.id), renderActionCard(r)));
    ex.hidden = true; tr.onclick = () => { ex.hidden = !ex.hidden; };
    body.push(tr, ex);
  }
  $("prio").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
  const btn = $("more");
  btn.hidden = list.length <= 25;
  btn.textContent = showAll ? "收起" : `显示全部 ${list.length} 条`;
  btn.onclick = () => { showAll = !showAll; renderPriority(rows); };
}

function init() {
  const stores = [...new Set(DATA.rows.map(r => r.s))], owners = [...new Set(DATA.rows.filter(r => !r.x).map(r => r.o))].sort();
  for (const s of stores) $("f-store").append(el("option", {value: s, textContent: s}));
  for (const o of owners) $("f-owner").append(el("option", {value: o, textContent: o}));
  $("f-store").onchange = $("f-owner").onchange = () => { showAll = false; backgroundAll = false; render(); };
  $("foot").textContent = "口径：质量、深入沟通、下一步由 AI 依据已采聊天判断；首次响应、沉默天数、自动消息由聊天时间与发送方向计算。卖方消息多数未标明人工或工具发送，\"非自动\"不等于确认人工。\"差\"的原因优先取复核写入的原因代码，缺代码的按质量依据文字归类。付款均为聊天陈述，未核实到账。排除项不进入任何比例的分母。";
  render();
}
init();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
