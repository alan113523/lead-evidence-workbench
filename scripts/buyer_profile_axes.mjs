/** Private operational judgments. This module does not issue formal research receipts. */
export const PROFILE_AXES_VERSION = 'lew.buyer-profile.v2';
export const AXIS_FIELDS = {
  business_model: '公司经营模式初判', business_model_basis: '经营模式来源与依据',
  business_model_uncertainty: '经营模式不确定性', purchase_purpose: '本次采购用途初判',
  purchase_purpose_basis: '采购用途来源与依据', purchase_purpose_uncertainty: '采购用途不确定性',
  entity_assessment: '实体核验', risk_assessment: '风险核验',
};
export const PURCHASE_PURPOSES = ['个人自用', '商业自用', '转售', '自有品牌销售', '客户项目采购', '其他明确用途'];
const check = (ok, code) => { if (!ok) throw Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => [...new Set(values)];
const positive = claim => claim.disposition !== 'denied';
const natureNames = {platform_self_report:'平台自报', buyer_statement:'买家陈述', public_observation:'公开来源', manual_record:'人工记录'};
const time = value => {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value.slice(0,10)).toISOString().slice(0,10) === value.slice(0,10), 'invalid_axis_timestamp');
  return Date.parse(value);
};
function refs(value) {
  check(Array.isArray(value) && value.every(text) && unique(value).length === value.length, 'invalid_axis_evidence_refs');
  return value;
}
function sourceNature(source) {
  if (source.kind === 'public_source') return 'public_observation';
  if (source.kind === 'buyer_profile') return 'platform_self_report';
  if (source.kind === 'chat_message' || source.kind === 'manual_record' && source.record_kind === 'saved_buyer_statement') return 'buyer_statement';
  check(source.kind === 'manual_record', 'unsupported_axis_evidence_kind');
  return 'manual_record';
}
export function assessmentEvidenceRefs(assessment) {
  const groups = [assessment.evidence_refs || [], assessment.procurement_intent?.evidence_refs || []];
  for (const axis of ['business_model', 'purchase_purpose']) {
    groups.push(assessment[axis]?.reviewed_evidence_refs || []);
    for (const claim of assessment[axis]?.claims || []) groups.push(claim.evidence_refs);
    for (const conflict of assessment[axis]?.conflicts || []) groups.push(conflict.evidence_refs);
  }
  for (const field of ['entity_assessment','risk_assessment']) if (assessment[field]) groups.push(assessment[field].evidence_refs);
  return unique(groups.flatMap(refs));
}
export function emptyAxesAssessment(unitKey, assessedAt) {
  const axis = () => ({review_state:'unassessed', claims:[], conflicts:[], summary:'尚未复核', uncertainty:'需要审阅已有证据', question:null});
  return {schema_version:PROFILE_AXES_VERSION, unit_key:unitKey, assessed_at:assessedAt,
    business_model:axis(), purchase_purpose:axis(),
    entity_assessment:{status:'not_reviewed',strength:null,reason:'尚未复核',evidence_refs:[]},
    risk_assessment:{status:'unexecuted',reason:'尚未复核',evidence_refs:[],category_statuses:{}},
    public_research_status:'not_performed'};
}
export function buildAxesProfile(assessment, evidence = [], prior = null) {
  check(assessment?.schema_version === PROFILE_AXES_VERSION && text(assessment.unit_key), 'invalid_axes_profile');
  check(!Object.hasOwn(assessment,'role') && !Object.hasOwn(assessment,'initialRole'), 'mixed_role_forbidden_in_axes_profile');
  const at = time(assessment.assessed_at), byId = new Map();
  for (const source of evidence) {
    check(text(source.id) && !byId.has(source.id), 'duplicate_axis_evidence_id'); byId.set(source.id,source);
  }
  const sourcesFor = (ids, content = false) => refs(ids).map(id => {
    const source = byId.get(id);
    check(source && source.unit_key === assessment.unit_key, 'axis_evidence_unit_mismatch');
    check(text(source.locator) && time(source.observed_at) <= at, 'invalid_axis_evidence_observation');
    if (content) {
      check((source.state ?? 'observed') === 'observed' && !['recalled_or_hidden','placeholder','empty','unparsed'].includes(source.content_status), 'unavailable_axis_content');
      check(!Object.hasOwn(source,'raw_value') || source.raw_value !== null && source.raw_value !== '' &&
        !(typeof source.raw_value === 'string' && !source.raw_value.trim()) &&
        !(typeof source.raw_value === 'object' && Object.keys(source.raw_value).length === 0), 'empty_axis_evidence');
      const nature = sourceNature(source);
      if (nature === 'buyer_statement') {
        check(source.direction === 'buyer', 'axis_requires_buyer_message');
        check(source.automatic !== true && !/^(ai|system|auto)/i.test(source.reply_source || ''), 'automated_statement_is_not_buyer_evidence');
      }
      if (nature === 'public_observation') {
        let url; try { url = new URL(source.locator); } catch { throw Error('public_axis_url_required'); }
        check(['http:','https:'].includes(url.protocol) && !url.username && !url.password &&
          !['i.alibaba.com','alicrm.alibaba.com','message.alibaba.com','crm.alibaba.com','profile.alibaba.com'].includes(url.hostname) &&
          [...url.searchParams.keys()].every(k=>!/token|cookie|authorization|signature|secret|session/i.test(k)), 'private_locator_is_not_public_evidence');
        check(source.attribution === 'account_business', 'public_axis_attribution_required');
      }
    }
    return source;
  });
  const buildAxis = name => {
    const input = assessment[name];
    check(input && ['reviewed','unassessed'].includes(input.review_state) && Array.isArray(input.claims) &&
      Array.isArray(input.conflicts) && text(input.summary) && text(input.uncertainty) &&
      (input.question === null || text(input.question)), 'invalid_axis_assessment');
    check(input.review_state === 'reviewed' || !input.claims.length && !input.conflicts.length, 'unassessed_axis_has_claims');
    const reviewed = refs(input.reviewed_evidence_refs || []); sourcesFor(reviewed);
    const seen = new Set();
    const claims = input.claims.map(claim => {
      check(text(claim.label) && claim.label.length <= 160 && ['supported','candidate','denied'].includes(claim.disposition) &&
        ['low','medium','high'].includes(claim.confidence) && typeof claim.inferred === 'boolean' && text(claim.reason) && text(claim.uncertainty), 'invalid_axis_claim');
      check(name !== 'purchase_purpose' || PURCHASE_PURPOSES.includes(claim.label), 'invalid_purchase_purpose');
      const key = JSON.stringify([claim.label,claim.disposition]); check(!seen.has(key),'duplicate_axis_claim'); seen.add(key);
      const sources = sourcesFor(claim.evidence_refs,true); check(sources.length,'axis_claim_requires_evidence');
      check(name !== 'purchase_purpose' || sources.some(s=>s.scope === 'current_purchase'), 'current_purchase_evidence_required');
      return {...structuredClone(claim),source_natures:unique(sources.map(sourceNature))};
    });
    const conflicts = input.conflicts.map(c=>{
      check(text(c.reason) && refs(c.evidence_refs).length,'invalid_axis_conflict'); sourcesFor(c.evidence_refs,true); return structuredClone(c);
    });
    for (const claim of claims.filter(positive)) {
      const denied = claims.filter(c=>c.label === claim.label && c.disposition === 'denied');
      if (denied.length) conflicts.push({reason:`同一标签同时有支持与否定证据：${claim.label}`,evidence_refs:unique([ ...claim.evidence_refs,...denied.flatMap(c=>c.evidence_refs)])});
    }
    const supported = claims.filter(positive);
    return {...structuredClone(input),claims,conflicts,
      status:input.review_state === 'unassessed' ? 'unassessed' : conflicts.length ? 'conflicted' : supported.length ? 'initial' : 'insufficient',
      reviewed_evidence_refs:reviewed,
      evidence_refs:unique([...reviewed,...claims.flatMap(c=>c.evidence_refs),...conflicts.flatMap(c=>c.evidence_refs)]),
      source_natures:unique(claims.flatMap(c=>c.source_natures)),
      confidence:supported.length ? (supported.every(c=>c.confidence === 'high')?'high':supported.some(c=>c.confidence === 'low')?'low':'medium') : 'unknown'};
  };
  const business = buildAxis('business_model'), purpose = buildAxis('purchase_purpose');
  // Derive the purchase scope from cited sources, never from an assessment-supplied label.
  // A mixed or legacy unit-level purpose cannot be broadcast to every inquiry of that buyer.
  const purchaseSources = purpose.evidence_refs.map(id=>byId.get(id)).filter(s=>s.scope === 'current_purchase');
  const purchaseScopes = unique(purchaseSources.filter(s=>text(s.store_key)&&text(s.inquiry_id)).map(s=>JSON.stringify([s.store_key,s.inquiry_id])));
  const exactScope = purchaseSources.length && purchaseSources.every(s=>text(s.store_key)&&text(s.inquiry_id)) && purchaseScopes.length === 1;
  purpose.inquiry_scope = exactScope ? Object.fromEntries(['store_key','inquiry_id'].map((field,i)=>[field,JSON.parse(purchaseScopes[0])[i]])) : null;
  const entity = assessment.entity_assessment, risk = assessment.risk_assessment;
  check(entity && ['matched','unconfirmed','not_reviewed'].includes(entity.status) && [null,'low','medium','high'].includes(entity.strength) && text(entity.reason), 'invalid_axis_entity_assessment');
  check(entity.status !== 'matched' || ['medium','high'].includes(entity.strength) && refs(entity.evidence_refs).length, 'matched_entity_evidence_required');
  sourcesFor(entity.evidence_refs);
  check(risk && ['reviewed','limited','unexecuted'].includes(risk.status) && text(risk.reason) && risk.category_statuses &&
    Object.entries(risk.category_statuses).every(([k,v])=>['legal','compliance','payment','reputation'].includes(k) && ['passed','limited','unexecuted'].includes(v)), 'invalid_axis_risk_assessment');
  sourcesFor(risk.evidence_refs); check(risk.status === 'unexecuted' || refs(risk.evidence_refs).length,'risk_evidence_required');
  check(assessment.formal_complete !== true, 'formal_completion_not_issued_by_axes');
  check(['not_performed','sources_reviewed'].includes(assessment.public_research_status ?? 'not_performed'), 'upstream_research_validation_separate');
  const allRefs = assessmentEvidenceRefs(assessment); sourcesFor(allRefs);
  if (assessment.public_research_status === 'sources_reviewed') check(allRefs.some(id=>byId.get(id)?.kind==='public_source'),'public_source_review_evidence_required');
  const old = prior ? structuredClone(prior) : null; if (old) delete old.history;
  return {schema_version:PROFILE_AXES_VERSION,unit_key:assessment.unit_key,assessed_at:assessment.assessed_at,
    business_model:business,purchase_purpose:purpose,entity_assessment:structuredClone(entity),risk_assessment:structuredClone(risk),
    evidence_refs:allRefs,public_research_status:assessment.public_research_status ?? 'not_performed',formal_complete:false,
    revision:(prior?.revision || 0)+1,history:[...(prior?.history || []),...(old?[{...old,reason:assessment.revision_reason || 'separate_axes_review'}]:[])]};
}
export function axisSummary(profiles) {
  const rows = profiles.filter(p=>p?.schema_version === PROFILE_AXES_VERSION);
  const can = (p,k)=>p[k].status === 'initial';
  const count = fn=>rows.filter(fn).length;
  return {total:profiles.length,axes_reviewed:rows.length,legacy_or_missing:profiles.length-rows.length,
    business_model_initial:count(p=>can(p,'business_model')),purchase_purpose_initial:count(p=>can(p,'purchase_purpose')),
    business_candidate_only:count(p=>can(p,'business_model')&&p.business_model.claims.filter(positive).every(c=>c.disposition==='candidate')),
    purchase_candidate_only:count(p=>can(p,'purchase_purpose')&&p.purchase_purpose.claims.filter(positive).every(c=>c.disposition==='candidate')),
    both_insufficient:count(p=>p.business_model.status==='insufficient'&&p.purchase_purpose.status==='insufficient'),
    business_conflicted:count(p=>p.business_model.status==='conflicted'),purchase_conflicted:count(p=>p.purchase_purpose.status==='conflicted'),
    unassessed:count(p=>[p.business_model,p.purchase_purpose].some(a=>a.status==='unassessed'))};
}
export function axisText(axis) {
  const labels = axis.claims.map(c=>`${c.label}${c.disposition==='candidate'?'（候选）':c.disposition==='denied'?'（否定）':''}`);
  return `${{initial:'初判',insufficient:'证据不足',conflicted:'存在冲突',unassessed:'尚未复核'}[axis.status]}：${labels.join('；') || axis.summary}`;
}
export function profileAxisColumns(profile) {
  check(profile?.schema_version === PROFILE_AXES_VERSION,'axes_profile_required');
  const values = {};
  for (const name of ['business_model','purchase_purpose']) {
    const a = profile[name]; values[name] = axisText(a);
    values[`${name}_basis`] = a.claims.map(c=>`${c.label}｜${c.source_natures.map(n=>natureNames[n]).join('、')}${c.inferred?'、推断':''}｜置信度${c.confidence}｜${c.reason}〔${c.evidence_refs.join(', ')}〕`).join('\n') || `${a.summary}〔${(a.reviewed_evidence_refs || []).join(', ')}〕`;
    values[`${name}_uncertainty`] = [a.uncertainty,...a.claims.map(c=>c.uncertainty),...a.conflicts.map(c=>`冲突：${c.reason}〔${c.evidence_refs.join(', ')}〕`),a.question&&`最小问题：${a.question}`].filter(Boolean).join('\n');
  }
  values.entity_assessment = `${profile.entity_assessment.status}：${profile.entity_assessment.reason}`;
  values.risk_assessment = `${profile.risk_assessment.status}：${profile.risk_assessment.reason}`;
  return values;
}
export function sameAxisChanges(before, after) {
  return Object.fromEntries(['business_model','purchase_purpose'].map(name=>{
    if (before?.schema_version !== PROFILE_AXES_VERSION) return [name,{status:'not_comparable',reason:'旧混合角色不自动转换为任一轴'}];
    const snapshot = a=>({status:a.status,claims:a.claims.map(c=>[c.label,c.disposition]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
    const old = snapshot(before[name]), current = snapshot(after[name]);
    return [name,{status:JSON.stringify(old)===JSON.stringify(current)?'unchanged':'changed',before:old,after:current}];
  }));
}
