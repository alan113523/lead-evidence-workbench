// Extend the existing opportunity review; semantic judgments still come from cited AI review.
import {createHash} from 'node:crypto';
import * as opportunity from './opportunity_review.mjs';
export const OPPORTUNITY_VERSION=opportunity.OPPORTUNITY_VERSION;
export const DEPTH_FIELDS={deep_communication:'是否深度沟通',deep_communication_stage:'深度沟通阶段',deep_communication_basis:'深度沟通依据'};
const check=(ok,code)=>{if(!ok)throw Error(code);};
const text=v=>typeof v==='string'&&Boolean(v.trim());
const key=r=>JSON.stringify([r.store_key,r.inquiry_id]);
const unique=a=>[...new Set(a)];
const time=v=>{check(typeof v==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v)),'invalid_depth_time');return Date.parse(v);};
const refs=a=>{check(Array.isArray(a)&&a.every(text)&&unique(a).length===a.length,'invalid_depth_refs');return a;};
// Only the manifest binding path can install coverage; JSON input cannot forge this map.
const coverageByAssessment=new WeakMap();

function depthRefs(d) {
  if(!d)return [];
  return unique([refs(d.evidence_refs),...['product_evidence_refs','proposal_evidence_refs','buyer_evidence_refs']
    .map(field=>refs(d.qualification?.[field]||[]))].flat());
}
export function opportunityEvidenceRefs(a) {
  return unique([...opportunity.opportunityEvidenceRefs(a),...depthRefs(a.deep_communication)]);
}
export function emptyOpportunityAssessment(unitKey,ref,at) {
  return {...opportunity.emptyOpportunityAssessment(unitKey,ref,at),
    deep_communication:{status:'待评估',stage:'未核实',reason:'尚未审阅沟通深度',evidence_refs:[]}};
}

/** Called only after the existing manifest/account/message checks. No new collection occurs. */
export function bindDepthCoverage(local,analysis,manifest,messages,snapshotAt,windowFromMs=null) {
  for(const a of analysis.opportunities||[]) {
    const ref=local.units.find(u=>u.unit_key===a.unit_key)?.inquiry_refs.find(r=>key(r)===key(a));
    const association=manifest.associations.find(r=>key(r)===key(a));
    if(!ref||!association)continue;
    const until=Math.min(time(snapshotAt),time(a.assessed_at));
    const rows=association.message_indexes.map(index=>messages[index]?.message);
    const unread=rows.some(m=>!m||(time(m.sent_at)>=time(ref.created_at)&&time(m.sent_at)<=until&&
      ['buyer','seller'].includes(m.direction)&&(m.content_status!=='read'||!text(m.text)&&!text(m.source_content))));
    const sufficient=Number.isFinite(windowFromMs)&&windowFromMs<=time(ref.created_at)&&
      time(snapshotAt)>=time(a.assessed_at)&&association.pages_read>0&&
      ['window_complete','endpoint_exhausted'].includes(association.status)&&!unread;
    coverageByAssessment.set(a,{sufficient,chat_until:new Date(until).toISOString(),history_complete:false,
      basis:'validated_available_current_window',limitation:sufficient?'仅覆盖本次已采窗口，不证明公司全部历史':
        '当前窗口边界、分页、截止时间或可读内容不足以排除深度交流'});
  }
}

export function buildOpportunityReview(a,evidence,ref,prior=null) {
  const d=a.deep_communication;
  if(!d) {
    check(!prior?.deep_communication,'prior_depth_assessment_must_be_retained');
    return opportunity.buildOpportunityReview(a,evidence,ref,prior);
  }
  check(['Y','N','未核实','待评估'].includes(d.status)&&text(d.reason),'invalid_depth_assessment');
  const stages={Y:['方案实谈','样品/订单推进'],N:['基础接触','需求澄清'],'未核实':['未核实'],'待评估':['未核实']};
  check(stages[d.status].includes(d.stage),'invalid_depth_stage');
  check(a.review_state==='reviewed'?d.status!=='待评估':d.status==='待评估','depth_review_state_mismatch');
  const ids=depthRefs(d),byId=new Map(evidence.map(s=>[s.id,s]));
  const assessmentScope=d.assessment_scope||'current_window';
  check(['current_window','visible_evidence'].includes(assessmentScope),'invalid_depth_assessment_scope');
  // Reuse the established inquiry, creation-time, quote and chat identity validator for every depth reference.
  const base=opportunity.buildOpportunityReview({...a,reviewed_evidence_refs:unique([...(a.reviewed_evidence_refs||[]),...ids])},evidence,ref);
  const coverage=coverageByAssessment.get(a)||{sufficient:false,chat_until:null,history_complete:false,basis:'unverified',limitation:'未绑定当前窗口覆盖'};
  const realBuyer=s=>s?.direction==='buyer'&&s.automatic!==true&&s.reply_source!=='ai';
  const support=list=>refs(list).map(id=>{check(ids.includes(id)&&byId.has(id),'depth_evidence_required');return byId.get(id);});
  let reachedAt=null;
  if(d.status==='Y') {
    const q=d.qualification;
    check(q&&['substantive_feedback','concrete_progress'].includes(q.path),'depth_qualification_required');
    check((q.path==='substantive_feedback'?'方案实谈':'样品/订单推进')===d.stage,'depth_path_stage_mismatch');
    const products=support(q.product_evidence_refs),buyers=support(q.buyer_evidence_refs),proposals=support(q.proposal_evidence_refs||[]);
    check(products.length&&a.products.some(p=>p.status!=='rejected'&&p.evidence_refs.some(id=>q.product_evidence_refs.includes(id))),'depth_product_required');
    check(buyers.length&&buyers.every(realBuyer),'depth_requires_real_buyer');
    if(q.path==='substantive_feedback') {
      check(proposals.some(s=>s.direction==='seller'),'depth_proposal_context_required');
      check(buyers.some(b=>proposals.some(s=>s.direction==='seller'&&time(s.sent_at)<time(b.sent_at))),'depth_feedback_must_follow_proposal');
    }
    reachedAt=new Date(Math.max(...buyers.map(s=>time(s.sent_at)))).toISOString();
  } else if(d.status==='N') {
    if(assessmentScope==='current_window')check(coverage.sufficient,'depth_negative_requires_window_coverage');
    else check(coverageByAssessment.has(a)&&support(d.evidence_refs).some(s=>s.kind==='chat_message'&&s.chat_bound===true&&s.content_status==='read'),
      'depth_visible_negative_requires_bound_readable_context');
    check(ids.length,'depth_negative_requires_reviewed_context');
  } else if(d.status==='未核实') check(text(d.gap),'depth_gap_required');
  else check(!ids.length&&!d.qualification,'unassessed_depth_has_claims');
  if(prior?.deep_communication?.status==='Y'&&(d.status!=='Y'||
    prior.deep_communication.stage==='样品/订单推进'&&d.stage!=='样品/订单推进'))
    check(text(d.correction_reason)&&ids.length,'depth_downgrade_requires_evidence_correction');
  const depth={status:d.status,stage:d.stage,reason:d.reason,evidence_refs:ids,reached_at:reachedAt,coverage,
    ...(assessmentScope==='visible_evidence'?{assessment_scope:assessmentScope}:{}),
    ...(d.qualification?{qualification:structuredClone(d.qualification)}:{}),...(d.gap?{gap:d.gap}:{}),
    ...(d.correction_reason?{correction_reason:d.correction_reason}:{})};
  const fingerprint=createHash('sha256').update(JSON.stringify({base:base.source_fingerprint,depth})).digest('hex');
  if(prior?.source_fingerprint===fingerprint)return structuredClone(prior);
  const old=prior?structuredClone(prior):null;if(old)delete old.history;
  return {...base,deep_communication:depth,evidence_refs:unique([...base.evidence_refs,...ids]),source_fingerprint:fingerprint,
    revision:(prior?.revision||0)+1,history:[...(prior?.history||[]),...(old?[old]:[])]};
}

export function depthColumns(review) {
  const d=review.deep_communication;
  if(!d||!['Y','N','未核实'].includes(d.status))return {};
  if(d.status==='未核实')check(text(d.gap),'depth_gap_required');
  else check(d.evidence_refs?.length,'depth_evidence_required');
  return {deep_communication:d.status,deep_communication_stage:d.stage,
    deep_communication_basis:`${d.assessment_scope==='visible_evidence'?'按可见快照与聊天判断：':''}${d.reason}${d.gap?`；缺口：${d.gap}`:''}${d.evidence_refs.length?`〔${d.evidence_refs.join(', ')}〕`:''}`};
}
export function opportunitySummary(units) {
  const result=opportunity.opportunitySummary(units),counts={Y:0,N:0,'未核实':0,'待评估':0};
  for(const ref of units.flatMap(u=>u.inquiry_refs||[])) {
    if(ref.opportunity_review?.excluded_from_new_customer_review===true)continue;
    counts[ref.opportunity_review?.deep_communication?.status||'待评估']++;
  }
  return {...result,deep_communication:counts};
}
