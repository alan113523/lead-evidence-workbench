"""Compare two explicitly supplied customer signal snapshots offline; no collection."""
import argparse
import hashlib
import json
import re
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import urlsplit

SNAPSHOT = "lew.customer-signal-snapshot.v1"
REPORT = "lew.customer-signal-diff.v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def stamp(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value), "timestamp requires timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.timestamp()


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fingerprint(content):
    return digest(" ".join(content.split()))


def public_url(value):
    require(text(value), "public URL required")
    p = urlsplit(value)
    require(p.scheme in ("http", "https") and p.hostname and "@" not in p.netloc and not p.query and not p.fragment, "public URL must have no credentials, query or fragment")
    return value


def validate(snapshot):
    require(isinstance(snapshot, dict) and snapshot.get("schema_version") == SNAPSHOT, "snapshot schema required")
    captured = stamp(snapshot.get("captured_at"))
    entity = snapshot.get("entity")
    require(isinstance(entity, dict) and text(entity.get("id")) and text(entity.get("domain")), "entity ID and domain required")
    require(urlsplit(public_url("https://" + entity["domain"])).hostname == entity["domain"].lower() and "/" not in entity["domain"], "entity domain must be a bare hostname")
    require(isinstance(entity.get("confirmed"), bool), "entity confirmation must be boolean")
    require(not entity["confirmed"] or text(entity.get("evidence_ref")), "confirmed entity needs evidence reference")
    keywords = snapshot.get("keywords")
    require(isinstance(keywords, list) and bool(keywords) and all(text(k) for k in keywords), "explicit keywords required")
    require(isinstance(snapshot.get("sources"), list), "sources array required")
    ids = set()
    for source in snapshot["sources"]:
        require(isinstance(source, dict) and text(source.get("id")) and source["id"] not in ids, "source ID missing or duplicate")
        ids.add(source["id"])
        public_url(source.get("scope_url"))
        require(source.get("status") in ("checked", "blocked", "not_connected"), "invalid source status")
        require(isinstance(source.get("complete"), bool), "source completeness must be explicit")
        require(text(source.get("evidence_ref")), "source evidence reference required")
        require(stamp(source.get("observed_at")) <= captured, "source observed after snapshot")
        require(isinstance(source.get("items"), list), "source items array required")
        if source["status"] != "checked":
            require(not source["items"] and not source["complete"] and text(source.get("reason")), "blocked/unconnected source needs reason, no items, incomplete")
        for item in source["items"]:
            require(isinstance(item, dict) and text(item.get("content")) and text(item.get("evidence_ref")), "item content/evidence required")
            require("source_id" not in item or item["source_id"] == source["id"], "item source_id conflicts with parent source")
            require(item.get("content_sha256") == digest(item["content"]), "item content hash mismatch")
            public_url(item.get("url"))
            observed = stamp(item.get("observed_at"))
            require(observed <= stamp(source["observed_at"]), "item observed after source")
            if item.get("published_at") is not None:
                require(stamp(item["published_at"]) <= observed, "publication after observation")
    return snapshot


def compare(before, after, seen=None):
    validate(before)
    validate(after)
    require(stamp(before["captured_at"]) <= stamp(after["captured_at"]), "snapshot order reversed")
    identity = lambda e: (e["id"], e["domain"].lower())
    require(identity(before["entity"]) == identity(after["entity"]), "entity ID/domain mismatch")
    require(sorted(before["keywords"]) == sorted(after["keywords"]), "keyword scope changed; create a comparable baseline")
    confirmed = before["entity"]["confirmed"] and after["entity"]["confirmed"]
    prior = {s["id"]: s for s in before["sources"]}
    current = {s["id"]: s for s in after["sources"]}
    # URL and observation date are provenance, not event identity. Dedupe exact normalized
    # content across declared sources; semantic paraphrases remain manual review candidates.
    old_content = {fingerprint(i["content"]) for s in before["sources"] for i in s["items"]}
    seen_keys = set()
    if seen is not None:
        require(isinstance(seen, dict) and seen.get("schema_version") == REPORT and identity(seen.get("entity", {})) == identity(after["entity"]), "prior report entity/schema mismatch")
        require(isinstance(seen.get("events"), list), "prior report events required")
        for event in seen["events"]:
            require(isinstance(event, dict) and isinstance(event.get("event_key"), str) and re.fullmatch(r"[0-9a-f]{64}", event["event_key"]), "invalid prior event key")
            if event.get("category") in ("true_change", "duplicate"):
                seen_keys.add(event["event_key"])
    grouped, coverage = {}, []
    for sid in sorted(prior.keys() | current.keys()):
        old, new = prior.get(sid), current.get(sid)
        comparable = bool(old and new and old["status"] == new["status"] == "checked" and old["complete"] and new["complete"] and old["scope_url"] == new["scope_url"])
        state = new["status"] if new else "not_connected"
        coverage.append({"source_id": sid, "before": old["status"] if old else "not_connected", "after": state,
                         "comparable": comparable, "reason": (new or {}).get("reason", ""),
                         "result": state if state != "checked" else "checked_in_scope" if comparable else "baseline_or_coverage_limited",
                         "before_ref": old["evidence_ref"] if old else None, "after_ref": new["evidence_ref"] if new else None})
        if not new or new["status"] != "checked":
            continue
        for item in new["items"]:
            fp = fingerprint(item["content"])
            record = {**item, "source_id": sid, "comparable": comparable}
            grouped.setdefault(fp, []).append(record)
    events = []
    for fp, records in sorted(grouped.items()):
        records.sort(key=lambda r: (r["source_id"], r["url"], r["observed_at"]))
        normalized = " ".join(records[0]["content"].split()).casefold()
        matches = [k for k in after["keywords"] if " ".join(k.split()).casefold() in normalized]
        # Stable key binds entity + content fingerprint; all sources and business dates
        # remain revision evidence. A URL/date correction cannot create a second event.
        key = digest(json.dumps([*identity(after["entity"]), fp], ensure_ascii=False))
        dates = {stamp(r["published_at"]) for r in records if r.get("published_at")}
        dated_change = len(dates) == 1 and stamp(before["captured_at"]) < next(iter(dates)) <= stamp(after["captured_at"])
        if not confirmed:
            category, reason = "unconfirmed", "主体未确认，仅保留候选"
        elif fp in old_content or key in seen_keys:
            category, reason = "duplicate", "已见内容，保留本次来源修订，不新增机会"
        elif not matches:
            category, reason = "weak", "未匹配关注词，仅保留观察记录"
        elif not all(r["comparable"] for r in records):
            category, reason = "weak", "基线、来源范围或完整性不足，不能确认期间新增"
        elif not dated_change:
            category, reason = "weak", "仅本次发现；发布时间缺失、冲突或不在两次快照之间"
        else:
            category, reason = "true_change", "输入声明的可比范围内出现新发布内容，业务意义待复核"
        events.append({"event_key": key, "content_fingerprint": fp, "category": category, "reason": reason,
                       "matched_keywords": matches, "content": records[0]["content"], "evidence": records,
                       "before_evidence_refs": sorted({s["evidence_ref"] for s in before["sources"] if any(r["source_id"] == s["id"] for r in records)}),
                       "next_action": "内部复核新旧证据与客户当前需求，再决定是否跟进" if category == "true_change" else "保留记录，按具体缺口复核；不生成客户话术"})
    for c in coverage:
        if c["comparable"]:
            c["result"] = "checked_with_new_content" if any(fingerprint(i["content"]) not in old_content for i in current[c["source_id"]]["items"]) else "checked_no_new_content"
    return {"schema_version": REPORT, "entity": after["entity"], "before": before["captured_at"], "after": after["captured_at"],
            "coverage": coverage, "events": events,
            "counts": {k: sum(e["category"] == k for e in events) for k in ("true_change", "duplicate", "weak", "unconfirmed")},
            "executed": False, "limitations": ["仅比较显式输入快照，不证明网页实际抓取、主体确认或全网覆盖", "未观察到内容不代表删除；无发布时间只写本次发现", "相同规范文本可去重，改写或摘要不同仍需人工合并", "不执行通知、检索、定时任务或客户联系"]}


def render(report):
    def p(value):
        return escape(str(value))
    parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>重点客户变化比较</title><style>body{font:15px/1.7 system-ui;margin:24px auto;max-width:980px;padding:0 16px;background:#f6f7f8;color:#20303b}article,section{background:white;padding:18px;margin:16px 0;border:1px solid #ddd;border-radius:10px;overflow-wrap:anywhere}pre{white-space:pre-wrap}h1{font-size:25px}h2{font-size:19px}.meta{color:#596776}</style><h1>重点客户变化比较 · 离线复核</h1>']
    labels = {"true_change": "新增变化线索", "duplicate": "重复信息", "weak": "弱线索／仅本次发现", "unconfirmed": "主体未确认候选"}
    states = {"checked": "已检查", "blocked": "访问受阻", "not_connected": "未接入", "checked_no_new_content": "声明范围内未发现新内容", "checked_with_new_content": "声明范围内取得新内容", "baseline_or_coverage_limited": "基线或覆盖不足"}
    parts += [f'<p>{p(report["entity"]["id"])} · {p(report["entity"]["domain"])}</p><p>{p(report["before"])} → {p(report["after"])}</p>',
              '<p>仅比较输入声明范围，不等于持续监控或已联系客户。</p>',
              '<p>' + ' · '.join(f'{labels[k]}：{report["counts"][k]}' for k in labels) + '</p>', '<section><h2>来源覆盖</h2>']
    for c in report["coverage"]:
        parts.append(f'<p>{p(c["source_id"])}：上次 {p(states[c["before"]])} → 本次 {p(states[c["after"]])} · {"可比" if c["comparable"] else "不可比"} · {p(states[c["result"]])} · {p(c["reason"])}</p>')
    parts.append('</section>')
    if not report["events"]:
        parts.append('<p>本次快照没有可展示内容，请结合来源覆盖判断；不据此声明全网无变化。</p>')
    for event in report["events"]:
        parts.append(f'<article><h2>{labels[event["category"]]}</h2><p>{p(event["reason"])}</p><pre>{p(event["content"])}</pre><p>{p(event["next_action"])}</p><details><summary>新旧依据与稳定事件编号</summary><p>{p(event["event_key"])}</p><p>基线依据：{p(event["before_evidence_refs"])}</p>')
        for e in event["evidence"]:
            parts.append(f'<p class="meta">来源 {p(e["source_id"])} · 发布 {p(e.get("published_at") or "未知，仅本次发现")} · 观察 {p(e["observed_at"])}<br>{p(e["url"])}<br>证据 {p(e["evidence_ref"])} · SHA256 {p(e["content_sha256"])}</p>')
        parts.append('</details></article>')
    parts += ['<section><h2>范围与限制</h2>'] + [f'<p>{p(x)}</p>' for x in report["limitations"]] + ['</section></html>']
    return "\n".join(parts)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--seen", help="可选同主体上次报告，仅用于事件去重")
    parser.add_argument("--out", required=True, help="新目录，拒绝覆盖")
    args = parser.parse_args(argv)
    paths = [Path(args.before), Path(args.after)] + ([Path(args.seen)] if args.seen else [])
    contents = [p.read_bytes() for p in paths]
    values = [json.loads(b.decode("utf-8-sig")) for b in contents]
    report = compare(*values)
    report["input_bindings"] = [{"path": str(p), "sha256": hashlib.sha256(b).hexdigest()} for p, b in zip(paths, contents)]
    out = Path(args.out)
    html = render(report)
    out.mkdir(parents=True, exist_ok=False)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "report.html").write_text(html, encoding="utf-8")
    print(json.dumps({"out": str(out), "counts": report["counts"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
