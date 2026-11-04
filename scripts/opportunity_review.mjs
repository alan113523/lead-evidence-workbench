import {createHash} from 'node:crypto';

export const OPPORTUNITY_VERSION='lew.opportunity-review.v1';
export const OPPORTUNITY_FIELDS={product:'产品',opportunity_quality:'质量',opportunity_quality_basis:'质量依据'};
export const LOW_QUALITY_CODES=['no_reply','quote_no_reply','product_mismatch','buyer_declined','existing_customer','duplicate_customer'];
const check=(ok,code)=>{if(!ok)throw Error(code);};
const text=v=>typeof v==='string'&&Boolean(v.trim());
const unique=a=>[...new Set(a)];
const normal=v=>v.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const time=v=>{check(typeof v==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v)),'invalid_opportunity_time');return Date.parse(v);};
const refs=a=>{check(Array.isArray(a)&&a.every(text)&&unique(a).length===a.length,'invalid_opportunity_refs');return a;};
export function opportunityEvidenceRefs(a){
  return unique([a.reviewed_evidence_refs||[],...a.products.map(p=>p.evidence_refs),
    ...Object.values(a.signals).map(s=>s.evidence_refs),...a.conflicts.map(c=>c.evidence_refs),a.low_quality_reason?.evidence_refs||[]].flatMap(refs));
}
export function emptyOpportunityAssessment(unitKey,ref,at){
  const signal=value=>({value,reason:'需由 AI 审阅本条商机聊天',evidence_refs:[]});
  return {schema_version:OPPORTUNITY_VERSION,unit_key:unitKey,store_key:ref.store_key,inquiry_id:ref.inquiry_id,
    assessed_at:at,review_state:'unassessed',products:[],signals:{need:signal('unknown'),fit:signal('unresolved'),progress:signal('unknown')},
    conflicts:[],reviewed_evidence_refs:[],summary:'尚未分析聊天',next_action:'读取已有聊天，补齐产品和需求事实'};
}
/** Codex extracts cited facts from chat; this function validates scope and derives the grade. */
export function buildOpportunityReview(a,evidence,ref,prior=null){
  check(a?.schema_version===OPPORTUNITY_VERSION&&a.store_key===ref.store_key&&a.inquiry_id===ref.inquiry_id&&text(a.unit_key),'invalid_opportunity_scope');
  const at=time(a.assessed_at),created=time(ref.created_at);
  check(['reviewed','unassessed'].includes(a.review_state)&&Array.isArray(a.products)&&Array.isArray(a.conflicts)&&text(a.summary)&&text(a.next_action),'invalid_opportunity_assessment');
  const byId=new Map(evidence.map(s=>[s.id,s]));check(byId.size===evidence.length,'duplicate_opportunity_evidence');
  const sources=(ids,{buyer=false}={})=>{
    const values=refs(ids).map(id=>{
      const s=byId.get(id);
      check(s&&s.kind==='chat_message'&&s.chat_bound===true&&s.unit_key===a.unit_key&&s.store_key===a.store_key&&s.inquiry_id===a.inquiry_id,'opportunity_requires_bound_chat');
      check(s.scope==='current_purchase'&&time(s.sent_at)>=created&&time(s.sent_at)<=at&&time(s.observed_at)<=at,'opportunity_chat_outside_window');
      check(text(s.quote)&&s.content_status!=='recalled_or_hidden'&&['buyer','seller'].includes(s.direction),'opportunity_content_required');
      return s;
    });
    if(buyer)check(values.some(s=>s.direction==='buyer'&&s.automatic!==true&&s.reply_source!=='ai'),'opportunity_requires_buyer_statement');
    return values;
  };
  const productKeys=new Set();
  const products=a.products.map(p=>{
    check(['model','category'].includes(p.kind)&&['requested','confirmed','proposed','rejected'].includes(p.status)&&text(p.label)&&text(p.source_label),'invalid_chat_product');
    check(p.label.length<=160&&p.source_label.length<=160,'chat_product_too_long');
    const key=normal(p.label)+':'+p.status;check(!productKeys.has(key),'duplicate_chat_product');productKeys.add(key);
    const support=sources(p.evidence_refs,{buyer:p.status!=='proposed'});check(support.length,'chat_product_evidence_required');
    check(support.some(s=>normal(s.quote).includes(normal(p.source_label))),'product_label_not_in_chat');
    check(p.kind!=='model'||normal(p.label)===normal(p.source_label),'model_must_preserve_chat_spelling');
    check(p.status!=='proposed'||support.some(s=>s.direction==='seller'),'seller_proposal_requires_seller_message');
    return structuredClone(p);
  });
  const enums={need:['clear','vague','unknown'],fit:['supported','unresolved','mismatch'],progress:['concrete','exploratory','unknown','declined']};
  for(const [name,values] of Object.entries(enums)){
    const s=a.signals?.[name];check(s&&values.includes(s.value)&&text(s.reason),'invalid_opportunity_signal');
    const known=!['unknown','unresolved'].includes(s.value),support=sources(s.evidence_refs,{buyer:known&&name!=='fit'});
    check(!known||support.length,'opportunity_signal_requires_evidence');
    if(known)check(support.some(e=>e.automatic!==true&&e.reply_source!=='ai'),'automated_quality_signal_forbidden');
  }
  for(const c of a.conflicts){check(text(c.reason)&&sources(c.evidence_refs).length,'invalid_opportunity_conflict');}
  const low=a.low_quality_reason??null;
  if(low){
    check(LOW_QUALITY_CODES.includes(low.code)&&text(low.reason),'invalid_low_quality_reason');
    const support=sources(low.evidence_refs,{buyer:['product_mismatch','buyer_declined'].includes(low.code)});check(support.length,'low_quality_evidence_required');
    if(['no_reply','quote_no_reply'].includes(low.code))
      check(support.some(s=>s.direction==='seller'&&s.no_buyer_reply_after===true&&time(s.reply_checked_until)>=time(s.sent_at)&&time(s.reply_checked_until)<=at),'verified_no_reply_required');
    else check(support.some(s=>s.automatic!==true&&s.reply_source!=='ai'),'automated_quality_signal_forbidden');
  }
  const allRefs=opportunityEvidenceRefs(a);sources(allRefs);
  check(a.review_state==='reviewed'||(!low&&!products.length&&!a.conflicts.length&&a.signals.need.value==='unknown'&&a.signals.fit.value==='unresolved'&&a.signals.progress.value==='unknown'),'unassessed_opportunity_has_claims');
  const active=products.filter(p=>['requested','confirmed'].includes(p.status)),{need,fit,progress}=a.signals;
  let grade='待判断';
  if(a.review_state==='reviewed'&&low)grade='差';
  else if(a.review_state==='reviewed'&&!a.conflicts.length){
    if(fit.value==='mismatch'||progress.value==='declined')grade='差';
    else if(need.value==='clear'&&fit.value==='supported'&&progress.value==='concrete'&&active.length)grade='好';
    else if(need.value!=='unknown'||['concrete','exploratory'].includes(progress.value)||active.length)grade='中';
  }
  const proposals=products.filter(p=>p.status==='proposed');
  const value={schema_version:OPPORTUNITY_VERSION,unit_key:a.unit_key,store_key:a.store_key,inquiry_id:a.inquiry_id,
    review_state:a.review_state,products,signals:structuredClone(a.signals),conflicts:structuredClone(a.conflicts),
    product:active.map(p=>p.label).join('；')||proposals.map(p=>`${p.label}（卖方推荐，待确认）`).join('；')||'待确认',quality:grade,summary:a.summary,next_action:a.next_action,
    evidence_refs:allRefs,needs_exception_review:Boolean(a.conflicts.length),basis:'AI 根据本商机聊天提取事实，按固定标准分档；不是成交概率或到账确认'};
  if(low){
    value.low_quality_reason=structuredClone(low);
    value.excluded_from_new_customer_review=['existing_customer','duplicate_customer'].includes(low.code);
    if(!value.summary.includes(low.reason))value.summary=`${low.reason}；${value.summary}`;
  }
  const support=allRefs.map(id=>{const s=byId.get(id);return {id,store_key:s.store_key,inquiry_id:s.inquiry_id,message_id:s.message_id,quote:s.quote,sent_at:s.sent_at};});
  const fingerprint=createHash('sha256').update(JSON.stringify({value,support})).digest('hex');
  if(prior?.source_fingerprint===fingerprint)return structuredClone(prior);
  const old=prior?structuredClone(prior):null;if(old)delete old.history;
  return {...value,assessed_at:a.assessed_at,source_fingerprint:fingerprint,revision:(prior?.revision||0)+1,
    history:[...(prior?.history||[]),...(old?[old]:[])]};
}
export function opportunitySummary(units){
  const all=units.flatMap(u=>(u.inquiry_refs||[]).map(r=>r.opportunity_review));
  const rows=all.filter(r=>r?.excluded_from_new_customer_review!==true);
  const counts={'好':0,'中':0,'差':0,'待判断':0};for(const r of rows)counts[r?.quality||'待判断']++;
  return {inquiries:rows.length,assessed:rows.filter(r=>r?.review_state==='reviewed').length,quality:counts,
    products_identified:rows.filter(r=>r&&r.product!=='待确认').length,exceptions:rows.filter(r=>r?.needs_exception_review).length,
    excluded_inquiries:all.length-rows.length};
}
