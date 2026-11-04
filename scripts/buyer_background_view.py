"""Read-only daily background projection. No search, scoring or completion receipt."""
from datetime import datetime


DIMENSIONS = [
    ("身份与关联", {"identity", "身份", "companyFundamentals"}),
    ("主营与品类", {"core_category", "主营", "procurementPreferences"}),
    ("商业实力", {"business_strength", "实力", "procurementScale", "supplyChain"}),
    ("采购决策链", {"decisionChain", "决策链"}),
    ("商业联系出口", {"contact_matrix", "商业联系出口"}),
]


def text(value):
    return value.strip() if isinstance(value, str) else ""


def legacy_has_judgment(row, name):
    value = text(row.get(name))
    return bool(text(row.get(name + '_basis')) and value
                and value not in ('未明确', '待判断', '未判断', '未知', '待确认', '未提供')
                and not value.startswith('证据不足'))


def axis_coverage(row, name, axis):
    if axis['state'] == 'initial' and any(c['state'] in ('supported', 'candidate') for c in axis['claims']):
        return {'state': '新版有据初判', 'reason': '沿用已有v2画像的状态、范围及引用，不代表独立企业认证'}
    if axis.get('legacy_review'):
        return {'state': '旧结论已追溯', 'reason': '原结论、依据与不确定性已逐字段核对；保留原判断等级'}
    if legacy_has_judgment(row, name):
        pending = (row.get('legacy_pending') or {}).get(name) or {}
        return {'state': '待适配', 'reason': pending.get('reason') or '冻结数据已有结论及依据，但尚未闭合与原源记录的逐字段对应；未自动转换',
                'checked_sources': pending.get('checked_sources', [])}
    if axis['state'] == '未提供' and text(row.get(name)) in ('待判断', '未判断', '未提供', '') and not text(row.get(name + '_basis')):
        return {'state': '未调查', 'reason': '本轴原字段待判断且无依据记录；仅说明当前冻结资料未记录完成调查'}
    return {'state': '资料不足', 'reason': '已有复核文字或画像，但当前资料不足以提供本轴有据判断'}


def background_view(row, evidence):
    """Project explicitly classified evidence only, bound to this exact opportunity."""
    gaps, sources, ids = [], [], {}
    for index, e in enumerate(evidence):
        if not isinstance(e, dict) or any(e.get(k) != row.get(k) for k in ("store_key", "inquiry_id")):
            continue
        if e.get("row_key") and e["row_key"] != row.get("row_key"):
            continue
        eid = text(e.get("id") or e.get("evidence_id"))
        ids.setdefault((eid, None if eid else index), []).append(e)
    for (eid, index), entries in ids.items():
        if len(entries) != 1:
            gaps.append(f"{eid}：证据编号重复，未投影")
            continue
        e = entries[0]
        observed = text(e.get("observed_at"))
        try:
            stamp = datetime.fromisoformat(observed.replace("Z", "+00:00"))
            valid_date = stamp.tzinfo is not None and stamp.utcoffset() is not None
        except ValueError:
            valid_date = False
        if not text(e.get("locator")) or not valid_date or not text(e.get("description")):
            gaps.append(f"{eid}：缺来源定位、有效观察日期或摘要，未投影")
            continue
        sources.append({"id": eid or f"展示来源-{index + 1}", "explicit_id": bool(eid), "use": text(e.get("use")),
                        "dimension_uses": e.get("dimension_uses") if isinstance(e.get("dimension_uses"),list) else [],
                        "summary": e["description"], "locator": e["locator"],
                        "observed_at": observed, "nature": text(e.get("source_type") or e.get("kind")) or "来源性质未提供"})
    by_id = {s["id"]: s for s in sources if s["explicit_id"]}

    def refs(value):
        return isinstance(value, list) and bool(value) and all(isinstance(i, str) and i in by_id for i in value)

    profile = row.get("profile")
    legacy_fields = ['business_model', 'business_model_basis', 'business_model_uncertainty',
                     'purchase_purpose', 'purchase_purpose_basis', 'purchase_purpose_uncertainty',
                     'entity_assessment', 'risk_assessment', 'assessed_at']
    legacy = {k: text(row.get(k)) for k in legacy_fields if text(row.get(k))}
    profile_ok = (isinstance(profile, dict) and profile.get("schema_version") == "lew.buyer-profile.v2"
                  and bool(row.get("unit_key")) and profile.get("unit_key") == row["unit_key"])
    if profile is not None and not profile_ok:
        gaps.append("画像版本或单元归属未对齐，未投影两轴判断")

    def axis(name):
        if not profile_ok:
            return {"summary": "已有冻结旧版复核文字，见下方；未转换为v2初判" if legacy.get(name) else "未提供可关联的本期两轴判断", "claims": [], "question": "", "state": "未提供"}
        a = profile.get(name)
        if not isinstance(a, dict):
            return {"summary": "该轴未提供", "claims": [], "question": "", "state": "未提供"}
        if name == "purchase_purpose" and a.get("inquiry_scope") != {k: row[k] for k in ("store_key", "inquiry_id")}:
            gaps.append("采购用途未精确绑定本商机，不将同账号其他采购用途带入")
            return {"summary": "本次采购用途待确认", "claims": [], "question": "", "state": "范围待确认"}
        claims = []
        for c in a.get("claims", []) if isinstance(a.get("claims"), list) else []:
            if not isinstance(c, dict) or not refs(c.get("evidence_refs")):
                gaps.append(f"{name}：判断引用断链，未投影")
                continue
            claims.append({"label": text(c.get("label")), "state": text(c.get("disposition")),
                           "reason": text(c.get("reason")), "uncertainty": text(c.get("uncertainty")),
                           "inferred": c.get("inferred"), "confidence": text(c.get("confidence")),
                           "source_natures": c.get("source_natures") if isinstance(c.get("source_natures"), list) else [],
                           "refs": c["evidence_refs"]})
        # Conflicts and questions are retained as reviewed context, never promoted to facts.
        return {"summary": text(a.get("summary")) if claims else "未取得有完整引用的正判断；见具体缺口",
                "state": text(a.get("status")) or text(a.get("review_state")) or "未提供",
                "claims": claims, "question": text(a.get("question")),
                "uncertainty": text(a.get("uncertainty")),
                "conflicts": a.get("conflicts") if isinstance(a.get("conflicts"), list) else []}

    business, purpose = axis('business_model'), axis('purchase_purpose')
    traced = row.get('legacy_traced') or {}
    for name, value in [('business_model', business), ('purchase_purpose', purpose)]:
        value['legacy_review'] = traced.get(name)
        value['coverage'] = axis_coverage(row, name, value)
    dimensions = [{"title": title, "sources": [s for s in sources if s["use"] in uses or any(u in uses for u in s['dimension_uses'] if isinstance(u,str))]}
                  for title, uses in DIMENSIONS]
    d = row.get("diligence") if isinstance(row.get("diligence"), dict) else {}
    raw_gaps = d.get("gaps")
    if isinstance(raw_gaps, str):
        gaps.append(raw_gaps)
    elif isinstance(raw_gaps, list):
        gaps.extend(g if isinstance(g, str) else text(g.get("description") or g.get("reason"))
                    for g in raw_gaps if isinstance(g, (str, dict)))
    context = []
    for s in d.get("public_sources", []) if isinstance(d.get("public_sources"), list) else []:
        if isinstance(s, str):
            context.append(s)
        elif isinstance(s, dict):
            context.append(" · ".join(text(s.get(k)) for k in ("title", "url", "path", "locator") if text(s.get(k))))
    def assessment(name):
        record = profile.get(name) if profile_ok else None
        if not isinstance(record, dict):
            return None
        if record.get("status") not in ("not_reviewed", "unexecuted") and not refs(record.get("evidence_refs")):
            gaps.append(f"{name}：核验记录引用断链，未投影")
            return None
        return record
    entity_record, risk_record = assessment("entity_assessment"), assessment("risk_assessment")
    for index, dimension in enumerate(dimensions):
        if index == 1:
            dimension['coverage'] = business['coverage']
        elif dimension['sources']:
            dimension['coverage'] = {'state': '已有分类来源', 'reason': '已有显式维度来源；来源存在不等于该维度核验完成'}
        elif index == 0:
            category = (row.get('background_gap_review') or {}).get('final_category')
            if d.get('status') == '已实际公开检索，主体仍待确认':
                dimension['coverage'] = {'state': '查过无结果', 'reason': '原记录已检索但未建立可靠主体对应；不表示企业不存在'}
            elif d.get('status') == '已补公开证据，五类核验有限覆盖':
                dimension['coverage'] = {'state': '待适配', 'reason': '已有公开背景或同名候选记录，未映射为本维度完整来源；不升级主体状态'}
            elif category == 'searched_no_match':
                dimension['coverage'] = {'state': '查过无结果', 'reason': '原历史检索记录未建立可靠主体对应；本轮仅复用该状态'}
            elif category == 'usable_public_context':
                dimension['coverage'] = {'state': '待适配', 'reason': '已有历史公开背景或同名候选，未映射为本维度完整来源；不升级主体状态'}
            elif d or category:
                dimension['coverage'] = {'state': '资料不足', 'reason': '已复核可见资料，但缺企业锚点、主体对应或可用来源'}
            else:
                dimension['coverage'] = {'state': '未调查', 'reason': '当前冻结资料未记录本维度调查；不能据此断言历史从未查过'}
        else:
            dimension['coverage'] = {'state': '未调查', 'reason': '当前冻结资料未记录本维度专项调查或显式分类来源；不由其他核验类别推定'}
    return {"scope": f"{row['store_key']} / {row['inquiry_id']}",
            "company": text(row.get("company_name")) or "企业名称未提供",
            "product": text(row.get("product")) or "采购产品待确认",
            "next_action": text(row.get("next_action")) or "下一步待复核",
            "business": business, "purpose": purpose,
            "dimensions": dimensions, "sources": sources, "gaps": [g for g in gaps if g],
            "entity": text(d.get("entity_status")) or "未提供主体关联核验状态",
            "risk": "见原画像风险记录（本视图不签发核验结论）" if risk_record else "未提供可关联的风险核验记录",
            "risk_record": risk_record,
            "entity_record": entity_record,
            "legacy": legacy,
            "reuse": row.get("background_reuse"),
            "formal": text(d.get("formal_v3_status")) or "未执行正式v3",
            "public": text(d.get("public_status")) or "公开研究状态未提供",
            "context_sources": context}
