"""从已绑定聊天计算逐商机跟进行为指标（纯计算，不做语义判断、不采集）。

输入为周期交付的 final-data.json；每行的 reviewed_message_binding 指向
bound-messages*.jsonl 中的精确消息键。只统计 current_inquiry_window 角色、
且早于 analysis_before_exclusive 的消息。卖方 reply_source 多为 unknown，
因此"非自动消息"不等于已证实人工发送。
"""
import argparse
import hashlib
import json
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "lew.followup-metrics.v2"
RULES_VERSION = "lew.followup-rules.v2"
RECORD_KEY_FIELDS = ["store_key", "inquiry_id"]
DAY_MS = 86_400_000

# Codex 质量依据开头的固定前缀 → 原因标签（文本派生，非结构化代码）
REASON_PREFIXES = [
    ("报价后未回复", "quote_no_reply"),
    ("接待或跟进后未回复", "no_reply"),
    ("本轮增量复核：本次仅新增卖方跟进", "no_reply"),
]


def parse_ms(value):
    if not value:
        return None
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def iso(ms):
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def load_final_data(path):
    content = Path(path).read_bytes()
    return json.loads(content.decode("utf-8-sig")), hashlib.sha256(content).hexdigest()


def require_sha256(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise ValueError(f"{label} sha256 is required")
    return value.lower()


def unique_records(records, label):
    if not isinstance(records, list):
        raise ValueError(f"{label} records array is required")
    indexed = {}
    for record in records:
        if not isinstance(record, dict) or any(not isinstance(record.get(k), str) or not record[k].strip() for k in RECORD_KEY_FIELDS):
            raise ValueError(f"{label} requires non-empty string store_key + inquiry_id")
        key = tuple(record[k] for k in RECORD_KEY_FIELDS)
        if key in indexed:
            raise ValueError(f"duplicate {label} store_key + inquiry_id: {key}")
        indexed[key] = record
    return indexed


def final_rows(data):
    rows = unique_records(data.get("rows"), "final-data")
    if any(not isinstance(row.get("excluded"), bool) for row in rows.values()):
        raise ValueError("final-data excluded must be boolean")
    return rows


def check_declared_messages_sha256(data, actual_sha256):
    for row in data["rows"]:
        declared = (row.get("reviewed_message_binding") or {}).get("messages_file") or {}
        if "sha256" in declared and require_sha256(declared["sha256"], "declared messages") != actual_sha256:
            raise ValueError("messages sha256 does not match final-data declaration")


def validate_metrics(data, metrics, source_sha256):
    """Return an exact, unique metric index only after verifying the frozen source binding."""
    rows = final_rows(data)
    if not isinstance(metrics, dict) or metrics.get("schema_version") != SCHEMA:
        raise ValueError("metrics schema/binding is obsolete; regenerate with followup_metrics.py")
    if metrics.get("rules_version") != RULES_VERSION:
        raise ValueError("metrics rules_version is stale; regenerate with followup_metrics.py")
    binding = metrics.get("source_binding")
    if not isinstance(binding, dict):
        raise ValueError("metrics source binding is required; regenerate with followup_metrics.py")
    expected_sha256 = require_sha256(source_sha256, "final-data source")
    if require_sha256(binding.get("sha256"), "metrics source") != expected_sha256:
        raise ValueError("metrics source sha256 does not match final-data")
    cutoff = data["analysis_before_exclusive"]
    if metrics.get("analysis_before_exclusive") != cutoff or binding.get("analysis_before_exclusive") != cutoff:
        raise ValueError("metrics cutoff does not match final-data")
    if binding.get("record_key_fields") != RECORD_KEY_FIELDS:
        raise ValueError("metrics record key binding must be store_key + inquiry_id")
    messages_sha256 = require_sha256(binding.get("messages_sha256"), "metrics messages")
    check_declared_messages_sha256(data, messages_sha256)
    indexed = unique_records(metrics.get("records"), "metrics")
    expected = {key for key, row in rows.items() if not row["excluded"]}
    missing, extra = expected - indexed.keys(), indexed.keys() - expected
    if missing or extra:
        raise ValueError(f"metrics record keys mismatch: missing={sorted(missing)}, extra={sorted(extra)}")
    return indexed


def load_messages(path, *, content=None):
    messages = {}
    content = Path(path).read_bytes() if content is None else content
    for line in content.decode("utf-8-sig").splitlines():
        record = json.loads(line)
        messages[record["key"]] = record["variants"][0]["message"]
    return messages


def speaker(message):
    """buyer / seller / seller_auto / None（系统消息不计）。"""
    direction = message.get("direction")
    if direction == "buyer":
        return "buyer"
    if direction == "seller":
        flags = message.get("automation_flags") or {}
        if message.get("reply_source") == "ai" or flags.get("auto_reply") or flags.get("robot_message"):
            return "seller_auto"
        return "seller"
    return None


LOW_QUALITY_CODES = {"no_reply", "quote_no_reply", "product_mismatch", "buyer_declined", "existing_customer", "duplicate_customer"}
MISMATCH = re.compile(r"不匹配|无法满足|不能满足|要求未满足|只卖成品|不供应|不合|未形成匹配|未匹配")
DECLINED = re.compile(r"明确放弃|不需要|另一供应商|已流失|不接受|拒绝|转向")


def reason_tag(quality, quality_reason, low_quality_reason=None):
    """(代码, 来源)。来源 code=复核写入的 low_quality_reason.code；derived=由质量依据文本派生。"""
    if quality != "差":
        return None, None
    code = (low_quality_reason or {}).get("code")
    if code in LOW_QUALITY_CODES:
        return code, "code"
    return derive_reason(quality_reason or ""), "derived"


def derive_reason(text):
    for prefix, tag in REASON_PREFIXES:
        if text.startswith(prefix):
            return tag
    if MISMATCH.search(text):
        return "product_mismatch"
    if DECLINED.search(text):
        return "buyer_declined"
    if re.search(r"未见[^。；]*(回复|回应|反馈|继续|选择|确认)|未获[^。；]*回|未回|未继续|没有[^。；]*买家[^。；]*(回复|正文)|未新增买家|未答|未见[^。；]*回答|无[^。；]*(回复|回答)|尚无买家", text):
        return "no_reply"
    return "other"


def compute_row(row, messages, cutoff_ms):
    tag, source = reason_tag(row.get("quality"), row.get("quality_reason"), row.get("low_quality_reason"))
    binding = row.get("reviewed_message_binding") or {}
    events = []
    for ref in binding.get("messages", []):
        if ref.get("role") != "current_inquiry_window":
            continue
        message = messages.get(ref["message_key"])
        if message is None:
            raise KeyError(f"{row['store_key']}:{row['inquiry_id']} missing {ref['message_key']}")
        who = speaker(message)
        ms = message.get("send_time_ms")
        if who is None or ms is None or ms >= cutoff_ms:
            continue
        events.append((ms, who))
    events.sort()

    buyer = [ms for ms, who in events if who == "buyer"]
    seller = [ms for ms, who in events if who == "seller"]
    auto = [ms for ms, who in events if who == "seller_auto"]
    talk = [(ms, who) for ms, who in events if who in ("buyer", "seller")]

    buyer_turns = 0
    previous = None
    for _, who in talk:
        if who == "buyer" and previous != "buyer":
            buyer_turns += 1
        previous = who

    first_buyer = buyer[0] if buyer else None
    first_reply = next((ms for ms in seller if first_buyer is not None and ms >= first_buyer), None)
    last_buyer = buyer[-1] if buyer else None
    last_speaker = talk[-1][1] if talk else None
    followup_days_after_buyer = len({(ms + 8 * 3_600_000) // DAY_MS for ms in seller if last_buyer is not None and ms > last_buyer})

    if not talk:
        stage = "no_chat"
    elif last_speaker == "buyer":
        stage = "awaiting_seller"
    elif buyer_turns <= 1:
        stage = "awaiting_buyer_after_first_turn"
    else:
        stage = "awaiting_buyer_multi_turn"

    return {
        "store_key": row["store_key"],
        "inquiry_id": row["inquiry_id"],
        "owner": row.get("owner"),
        "quality": row.get("quality"),
        "deep_communication": row.get("deep_communication"),
        "reason_tag": tag,
        "reason_source": source,
        "buyer_messages": len(buyer),
        "buyer_turns": buyer_turns,
        "seller_messages": len(seller),
        "seller_auto_messages": len(auto),
        "first_buyer_at": iso(first_buyer),
        "first_seller_reply_at": iso(first_reply),
        "first_response_minutes": None if first_reply is None else round((first_reply - first_buyer) / 60_000, 1),
        "last_buyer_at": iso(last_buyer),
        "last_speaker": last_speaker,
        "buyer_silent_days": None if last_buyer is None else round((cutoff_ms - last_buyer) / DAY_MS, 1),
        "seller_followup_days_after_last_buyer": followup_days_after_buyer,
        "silence_stage": stage,
        "chat_available": bool(binding.get("messages")),
    }


def summarize(records):
    def median(values):
        values = [v for v in values if v is not None]
        return round(statistics.median(values), 1) if values else None

    def group(items):
        stages = {}
        for r in items:
            stages[r["silence_stage"]] = stages.get(r["silence_stage"], 0) + 1
        return {
            "inquiries": len(items),
            "median_first_response_minutes": median(r["first_response_minutes"] for r in items),
            "responded_within_60_minutes": sum(1 for r in items if r["first_response_minutes"] is not None and r["first_response_minutes"] <= 60),
            "no_seller_reply": sum(1 for r in items if r["first_buyer_at"] and r["first_seller_reply_at"] is None),
            "auto_message_share": round(sum(r["seller_auto_messages"] for r in items) / max(1, sum(r["seller_auto_messages"] + r["seller_messages"] for r in items)), 3),
            "silence_stage": stages,
        }

    owners = sorted({r["owner"] or "未取得" for r in records})
    return {
        "all": group(records),
        "by_owner": {o: group([r for r in records if (r["owner"] or "未取得") == o]) for o in owners},
        "by_store": {s: group([r for r in records if r["store_key"] == s]) for s in sorted({r["store_key"] for r in records})},
    }


def compute(data, messages, *, source_sha256=None, messages_sha256=None):
    final_rows(data)
    source_sha256 = require_sha256(source_sha256, "final-data source")
    messages_sha256 = require_sha256(messages_sha256, "messages")
    check_declared_messages_sha256(data, messages_sha256)
    cutoff_ms = parse_ms(data["analysis_before_exclusive"])
    records = [compute_row(row, messages, cutoff_ms) for row in data["rows"] if not row.get("excluded")]
    return {
        "schema_version": SCHEMA,
        "rules_version": RULES_VERSION,
        "analysis_before_exclusive": data["analysis_before_exclusive"],
        "source_binding": {
            "sha256": source_sha256,
            "messages_sha256": messages_sha256,
            "analysis_before_exclusive": data["analysis_before_exclusive"],
            "record_key_fields": RECORD_KEY_FIELDS,
        },
        "definitions": {
            "seller_messages": "卖方非自动消息；reply_source 多为 unknown，不等于已证实人工",
            "first_response_minutes": "首条买家消息到其后首条卖方非自动消息的分钟数",
            "buyer_silent_days": "截至分析截止时距最后一条买家消息的天数",
            "seller_followup_days_after_last_buyer": "最后买家消息后有卖方非自动消息的中国自然日数（UTC+08）；自动消息与缺时间戳消息不计，非连续沉默时长",
            "silence_stage": "awaiting_seller=最后发言为买家；awaiting_buyer_after_first_turn=最后发言为卖方且买家只发过一轮；awaiting_buyer_multi_turn=最后发言为卖方且买家已多轮；no_chat=无可用聊天",
            "reason_tag": "仅质量为差：优先取 low_quality_reason.code；缺代码时由质量依据文本派生，reason_source=derived",
        },
        "summary": summarize(records),
        "records": records,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", required=True, help="final-data.json")
    parser.add_argument("--messages", help="bound-messages jsonl；默认取首行绑定中的 messages_file")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    data, source_sha256 = load_final_data(args.input)
    messages_path = args.messages
    if not messages_path:
        files = {(r.get("reviewed_message_binding") or {}).get("messages_file", {}).get("path") for r in data["rows"]} - {None}
        if len(files) != 1:
            parser.error(f"expected one messages_file across rows, found {sorted(files)}")
        messages_path = ROOT / files.pop()
    messages_content = Path(messages_path).read_bytes()
    result = compute(data, load_messages(messages_path, content=messages_content),
                     source_sha256=source_sha256, messages_sha256=hashlib.sha256(messages_content).hexdigest())
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    json.dump(result["summary"]["all"], sys.stdout, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
