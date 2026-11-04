import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {spawnSync} from 'node:child_process';
import { dataPath } from './chat_collection.mjs';
import { validateChatEvidence, validateChatRun } from './chat_evidence_router.mjs';
import { PROFILE_AXES_VERSION, buildAxesProfile, emptyAxesAssessment, assessmentEvidenceRefs, axisSummary } from './buyer_profile_axes.mjs';
import { OPPORTUNITY_VERSION, buildOpportunityReview, emptyOpportunityAssessment, opportunityEvidenceRefs, opportunitySummary, bindDepthCoverage } from './deep_communication.mjs';
import {DEFAULT_DB,openHistory,indexResearch,lookupHistory} from './history_index.mjs';

export const LOCAL_VERSION = 'lew.buyer-due-diligence-local.v1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (value, reason) => { if (!value) throw Error(reason); };
const key = row => JSON.stringify([row.store_key, row.inquiry_id]);
export function instant(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'timestamp_timezone_required');
  const datePart = value.slice(0,10), day = new Date(datePart+'T00:00:00Z');
  check(Number.isFinite(Date.parse(value)) && day.toISOString().slice(0,10) === datePart, 'invalid_timestamp');
  return Date.parse(value);
}
export function selectCohort(bundle, scope, prior = { units: [] }, companyLinks = []) {
  check(bundle && Array.isArray(bundle.inquiries), 'inquiries_required');
  check(scope && Array.isArray(scope.stores) && scope.stores.length && scope.stores.every(s=>typeof s==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(s)), 'explicit_store_scope_required');
  const from=instant(scope.from_inclusive), to=instant(scope.to_exclusive);
  check(from<to && scope.time_zone==='Asia/Shanghai' && typeof scope.batch_id==='string' && scope.batch_id, 'invalid_scope');
  check(Array.isArray(prior.units), 'invalid_prior');
  const identities=new Map(), members=new Map(), all=new Map();
  for(const link of companyLinks) {
    check(link.company_customer_id && link.review_status==='confirmed' && typeof link.evidence_ref==='string' && link.evidence_ref, 'company_merge_evidence_required');
    check(!identities.has(key(link)), 'duplicate_company_link');identities.set(key(link),link);
  }
  for(const link of bundle.buyer_member_links || []) {
    check(['alibaba-message-querySummary-contact-loginId-v1','alibaba-buyer-profile-visible-member-id-v1'].includes(link.source_system) && /^alibaba-visible-member:[a-z0-9]{3,64}$/i.test(link.buyer_member_id), 'buyer_link_evidence_required');
    check(!members.has(key(link)) || members.get(key(link))===link.buyer_member_id, 'buyer_link_conflict');members.set(key(link),link.buyer_member_id);
  }
  for(const row of bundle.inquiries) {
    check(typeof row.store_key==='string' && typeof row.inquiry_id==='string' && row.inquiry_id, 'inquiry_identity_required');
    check(!all.has(key(row)), 'duplicate_inquiry');all.set(key(row),row);
  }
  const selected=[...all.values()].filter(row=>scope.stores.includes(row.store_key) &&
    (row.created_at==null || instant(row.created_at)>=from && instant(row.created_at)<to));
  const units=new Map(),memberUnits=new Map();
  for(const old of prior.units) {
    check(typeof old.unit_key==='string' && Array.isArray(old.inquiry_refs) && !units.has(old.unit_key), 'invalid_prior_unit');
    for(const ref of old.inquiry_refs)if(ref.buyer_member_id){
      check(!memberUnits.has(ref.buyer_member_id)||memberUnits.get(ref.buyer_member_id).unit_key===old.unit_key,'prior_member_identity_conflict');
      memberUnits.set(ref.buyer_member_id,old);
    }
    if(old.lifecycle!=='closed' && old.inquiry_refs.some(r=>scope.stores.includes(r.store_key)))
      units.set(old.unit_key,{...structuredClone(old),selection_reason:'unfinished_prior'});
  }
  for(const row of selected) {
    const member=members.get(key(row)) || null, merge=identities.get(key(row));
    const knownMember=member?memberUnits.get(member):null;
    check(!merge||!knownMember||knownMember.company_customer_id===merge.company_customer_id,'member_company_reconciliation_required');
    const unitKey=knownMember?.unit_key || (merge ? `company:${merge.company_customer_id}` : member ? `account:${member}` : `inquiry:${key(row)}`);
    const priorUnit=prior.units.find(u=>u.unit_key===unitKey),existing=units.get(unitKey) || priorUnit;
    check(!prior.units.some(u=>u.unit_key!==unitKey&&u.inquiry_refs.some(r=>key(r)===key(row))), 'prior_identity_reconciliation_required');
    const unit=units.get(unitKey) || (existing ? {...structuredClone(existing),lifecycle:'active'} : {
      unit_key:unitKey,company_customer_id:merge?.company_customer_id ?? null,company_identity_status:merge?'confirmed':'unconfirmed',
      original_batch:scope.batch_id,enrolled_at:row.created_at ?? null,lifecycle:'active',inquiry_refs:[],profile:null });
    if(row.created_at && (!unit.enrolled_at || !priorUnit&&instant(row.created_at)<instant(unit.enrolled_at)))unit.enrolled_at=row.created_at;
    const priorRef=unit.inquiry_refs.find(r=>key(r)===key(row));
    if(priorRef&&row.created_at){
      check(!priorRef.created_at||priorRef.created_at===row.created_at,'inquiry_creation_time_conflict');
      if(!priorRef.created_at)priorRef.created_at=row.created_at;
    }
    if(!unit.inquiry_refs.some(r=>key(r)===key(row)))unit.inquiry_refs.push({store_key:row.store_key,inquiry_id:row.inquiry_id,
      buyer_member_id:member,crm_customer_id:row.customer_id ?? null,created_at:row.created_at ?? null,
      buyer_name:row.buyer_name ?? null,owner:row.owner ?? null,company_link_evidence:merge?.evidence_ref ?? null});
    unit.selection_reason=row.created_at==null?'creation_time_unknown':existing?'new_inquiry_for_existing_unit':'created_in_scope';
    units.set(unitKey,unit);
    if(member)memberUnits.set(member,unit);
  }
  const rows=[...units.values()].sort((a,b)=>a.unit_key.localeCompare(b.unit_key));
  const memberIds=new Set(rows.flatMap(u=>u.inquiry_refs.map(r=>r.buyer_member_id)).filter(Boolean));
  return {schema_version:LOCAL_VERSION,scope:structuredClone(scope),units:rows,
    transactions:structuredClone((prior.transactions||[]).filter(t=>units.has(t.unit_key))),
    source_order_candidates:[...new Map([...(prior.source_order_candidates||[]),...(bundle.orders||[])].map(order=>[fingerprint(order),structuredClone(order)])).values()],
    counts:{new_inquiries:selected.filter(r=>r.created_at!=null).length,creation_time_unknown:selected.filter(r=>r.created_at==null).length,
      tracking_units:rows.length,known_member_accounts:memberIds.size,company_customers:rows.every(u=>u.company_identity_status==='confirmed')?rows.length:null},
    coverage:{status:bundle.coverage?.status ?? 'observed_only',source:bundle.coverage ?? null,
      basis:'inquiry_created_time_plus_unfinished_prior; registration_date_and_latest_message_do_not_select_cohort'},
    research_status:'local_input_prepared; public_research_not_performed',assurance:'Supplied source labels and reviewed links; no independent company-history assertion.'};
}

export const BUYER_ROLES = ['个人自用','商业自用','渠道商','品牌方','代理项目采购','待确认'];
function referenced(refs,evidence){
  check(Array.isArray(refs)&&new Set(refs).size===refs.length,'invalid_evidence_refs');
  const byId=new Map(evidence.map(e=>[e.id,e]));
  check(byId.size===evidence.length&&refs.every(ref=>byId.has(ref)),'missing_evidence');
  return refs.map(ref=>byId.get(ref));
}
export function buildProfile(assessment, evidence = [], prior = null) {
  if(assessment?.schema_version===PROFILE_AXES_VERSION){
    const axes=buildAxesProfile(assessment,evidence,prior);
    // Keep the existing quantity rules independent of both descriptive axes.
    const quantity=buildProfile({role:'待确认',confidence:'unknown',evidence_refs:[],assessed_at:assessment.assessed_at,
      procurement_intent:assessment.procurement_intent},evidence);
    return {...axes,procurement_intent:quantity.procurement_intent,large_volume_intent:quantity.large_volume_intent};
  }
  check(assessment&&BUYER_ROLES.includes(assessment.role),'invalid_buyer_role');
  const refs=assessment.evidence_refs || [],sources=referenced(refs,evidence);
  check(assessment.role==='待确认'||sources.length>0,'role_evidence_required');
  check(['unknown','low','medium','high'].includes(assessment.confidence),'invalid_confidence');
  check(assessment.role==='待确认'||assessment.confidence!=='unknown','role_confidence_required');
  const observed=instant(assessment.assessed_at);
  for(const source of sources){
    check(['public_source','chat_message','buyer_profile','manual_record'].includes(source.kind),'invalid_evidence_kind');
    check(instant(source.observed_at)<=observed&&typeof source.locator==='string'&&source.locator,'invalid_profile_evidence');
    if(source.kind==='public_source'){
      let url;try{url=new URL(source.locator);}catch{throw Error('public_source_url_required');}
      check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&
        !['i.alibaba.com','message.alibaba.com','crm.alibaba.com'].includes(url.hostname)&&
        [...url.searchParams.keys()].every(name=>!/token|cookie|authorization|signature|secret|session/i.test(name)), 'private_locator_is_not_public_evidence');
    }
  }
  check(assessment.public_research_status==null||['not_performed','sources_reviewed'].includes(assessment.public_research_status),'upstream_research_validation_separate');
  check(assessment.public_research_status!=='sources_reviewed'||sources.some(s=>s.kind==='public_source'),'public_source_review_evidence_required');
  const intent=structuredClone(assessment.procurement_intent || {}),intentRefs=intent.evidence_refs || [];
  const intentSources=referenced(intentRefs,evidence);
  const quantities=['single_order_quantity','annual_quantity','min_per_order_quantity'];
  for(const field of quantities)check(intent[field]==null||Number.isSafeInteger(intent[field])&&intent[field]>=0,'invalid_procurement_quantity');
  const explicit=intent.buyer_confirmed===true&&intent.quantity_unit==='台'&&intentSources.length>0&&
    intentSources.every(s=>['chat_message','manual_record'].includes(s.kind));
  for(const source of intentSources)check(instant(source.observed_at)<=observed&&typeof source.locator==='string'&&source.locator,'invalid_intent_evidence');
  const completePlan=intent.single_order_quantity!=null||intent.annual_quantity!=null&&intent.min_per_order_quantity!=null;
  const large=explicit&&completePlan&&((intent.single_order_quantity??-1)>=1000||
    (intent.annual_quantity??-1)>=3000&&(intent.min_per_order_quantity??-1)>=500);
  const profile={role:assessment.role,confidence:assessment.confidence,evidence_refs:refs,
    assessed_at:assessment.assessed_at,source_observed_at:sources.map(s=>s.observed_at),
    procurement_intent:intent,large_volume_intent:large?'supported':explicit&&completePlan?'below_threshold':'unconfirmed',
    unresolved:assessment.unresolved || [],public_research_status:assessment.public_research_status || 'not_performed'};
  const old=prior?structuredClone(prior):null;if(old)delete old.history;
  return {...profile,revision:(prior?.revision || 0)+1,
    history:[...(prior?.history || []),...(old?[{...old,reason:assessment.revision_reason || 'new_evidence'}]:[])]};
}

// Upstream business type is a clue; it never directly establishes one of our roles.
export function businessTypeClue(value) {
  const candidates={2000:['渠道商'],2001:['品牌方','商业自用'],2002:['渠道商'],2003:['渠道商'],
    2004:['渠道商'],2005:['代理项目采购'],2006:['渠道商'],2007:['个人自用'],2008:[]};
  return {source_value:value,role:'待确认',candidates:candidates[value] || [],assurance:'candidate_only; actual purpose and role need evidence'};
}

export function evaluateCompanyTransactions(unit, orders, {as_of,confirmation=null,historical_purchase_signals=[],conflicts=[],payment_review=null}={}) {
  const asOf=instant(as_of),enrolled=unit.enrolled_at==null?null:instant(unit.enrolled_at);
  const seen=new Set(),linked=[],candidates=[];
  for(const order of orders){
    check(order.store_key&&typeof order.order_id==='string'&&order.order_id,'order_identity_required');
    const orderKey=JSON.stringify([order.store_key,order.order_id]);check(!seen.has(orderKey),'duplicate_order');seen.add(orderKey);
    const sameCompany=unit.company_customer_id&&order.company_customer_id===unit.company_customer_id;
    const sameUnit=order.unit_key===unit.unit_key;
    check(!(sameCompany&&order.unit_key&& !sameUnit)&&!(sameUnit&&order.company_customer_id&& !sameCompany),'order_company_unit_conflict');
    const exact=order.association_status==='verified_id'&&(sameCompany||sameUnit)&&order.association_evidence;
    const crosscheck=conflicts.length===0&&order.association_status==='manual_crosscheck'&&sameUnit&&order.association_evidence&&order.buyer_name&&order.owner&&order.review_status==='confirmed'&&
      unit.inquiry_refs?.some(r=>r.buyer_name===order.buyer_name&&r.owner===order.owner);
    if(!exact&&!crosscheck){candidates.push(order);continue;}
    for(const field of ['total_amount','first_payment_amount','received_amount'])check(order[field]==null||Number.isFinite(order[field])&&order[field]>=0,'invalid_order_amount');
    const receipt=order.payment_status==='verified'&&typeof order.payment_evidence==='string'&&order.payment_evidence&&
      typeof order.first_payment_amount==='number'&&order.first_payment_amount>0&&order.first_payment_at!=null;
    const paid=receipt?instant(order.first_payment_at):null;
    linked.push({...order,receipt_verified:Boolean(receipt&&paid<=asOf),known_payment_at:receipt&&paid<=asOf?order.first_payment_at:null,
      order_kind:order.currency==='USD'&&typeof order.total_amount==='number'?(order.total_amount<500?'sample':'bulk'):'unknown'});
  }
  const receipts=linked.filter(o=>o.receipt_verified).sort((a,b)=>instant(a.first_payment_at)-instant(b.first_payment_at)||a.order_id.localeCompare(b.order_id));
  const priorPaid=enrolled==null?[]:receipts.filter(o=>instant(o.first_payment_at)<enrolled);
  for(const signal of historical_purchase_signals){
    check(signal.kind==='company_purchase_history'&&signal.evidence_ref&&(signal.purchased_at||signal.purchased_on),'company_history_evidence_required');
    if(!signal.purchased_at)check(/^\d{4}-\d{2}-\d{2}$/.test(signal.purchased_on)&&
      new Date(signal.purchased_on+'T00:00:00Z').toISOString().slice(0,10)===signal.purchased_on,'invalid_history_date');
  }
  // A date-only source has no invented payment time or timezone. The entire
  // possible UTC interval must predate enrolment before it supports "old".
  const priorClues=enrolled==null?[]:historical_purchase_signals.filter(s=>s.purchased_at?instant(s.purchased_at)<enrolled:
    Date.parse(s.purchased_on+'T00:00:00Z')+38*60*60*1000<=enrolled);
  const aiStatus=conflicts.length||enrolled==null?'pending':priorPaid.length||priorClues.length?'old':'new';
  let confirmedStatus=null;
  if(confirmation){
    check(['new','old'].includes(confirmation.value)&&confirmation.review_status==='confirmed'&&confirmation.evidence_ref&&confirmation.enrolled_at===unit.enrolled_at,'invalid_enrolment_confirmation');
    check(!(confirmation.value==='new'&&(priorPaid.length||priorClues.length)),'enrolment_confirmation_conflict');confirmedStatus=confirmation.value;
  }
  const after=enrolled==null?[]:receipts.filter(o=>instant(o.first_payment_at)>=enrolled);
  const milestone=kind=>after.find(o=>kind==null||o.order_kind===kind);
  const compact=o=>o?{store_key:o.store_key,order_id:o.order_id,paid_at:o.first_payment_at,order_kind:o.order_kind,payment_evidence:o.payment_evidence}:null;
  const uncertain=linked.filter(o=>!o.receipt_verified&&!(o.payment_status==='not_received_verified'&&o.payment_evidence)&&
    !(o.first_payment_at&&instant(o.first_payment_at)>asOf));
  if(payment_review)check(payment_review.status==='complete'&&payment_review.evidence_ref&&payment_review.as_of===as_of&&
    candidates.length===0&&uncertain.length===0,'invalid_payment_review');
  return {unit_key:unit.unit_key,company_customer_id:unit.company_customer_id,company_identity_status:unit.company_identity_status,
    original_batch:unit.original_batch,enrolled_at:unit.enrolled_at,ai_enrolment_status:aiStatus,
    ai_basis:'按当前可见资料初判；主页平台交易不是本公司购买历史',confirmation_status:confirmedStatus,
    confirmation_evidence:confirmation?.evidence_ref ?? null,confirmation_current_valid:confirmedStatus!==null&&conflicts.length===0,
    conflicts,order_candidates:candidates.length,candidate_orders:candidates,linked_orders:linked,
    historical_purchase_signals,payment_review,payment_review_status:after.length?'receipt_established':payment_review?'no_receipt_after_review':'pending',
    payment_pending_order_count:candidates.length+uncertain.length,
    first_known_payment_after_enrolment:compact(milestone()),sample_payment:compact(milestone('sample')),bulk_payment:compact(milestone('bulk')),
    history_complete:false,profile_trade_signals_used_for_company_status:false};
}
export function conversionSummary(rows) {
  check(new Set(rows.map(r=>r.unit_key)).size===rows.length,'duplicate_tracking_unit');
  check(new Set(rows.map(r=>r.original_batch)).size<=1,'one_original_batch_required');
  const confirmed=rows.filter(r=>r.company_identity_status==='confirmed'&&r.confirmation_status==='new'&&!r.conflicts.length);
  check(new Set(confirmed.map(r=>r.company_customer_id)).size===confirmed.length,'duplicate_confirmed_company');
  const pending=rows.filter(r=>r.company_identity_status!=='confirmed'||r.confirmation_status==null||r.conflicts.length||
    r.confirmation_status==='new'&&!r.first_known_payment_after_enrolment&&r.payment_review_status!=='no_receipt_after_review');
  const count=field=>confirmed.filter(r=>r[field]!=null).length;
  return {confirmed_new_customers:confirmed.length,confirmed_first_paid_customers:count('first_known_payment_after_enrolment'),
    sample_paid_customers:count('sample_payment'),bulk_paid_customers:count('bulk_payment'),confirmation_pending_units:pending.length,
    final_conversion_rate:!pending.length&&confirmed.length?count('first_known_payment_after_enrolment')/confirmed.length:null,
    status:pending.length?'confirmation_coverage_incomplete':confirmed.length?'confirmed_batch':'no_confirmed_new_customers',
    note:'Sample and bulk customer counts overlap; do not add them. Payment candidates and AI preliminary status are excluded from confirmed rates.'};
}

export function updateLocal(local,analysis){
  check(local.schema_version===LOCAL_VERSION&&['lew.local-analysis.v1','lew.local-analysis.v2'].includes(analysis.schema_version),'invalid_local_analysis');
  const result=structuredClone(local),evidence=analysis.evidence || [],byUnit=new Map(result.units.map(u=>[u.unit_key,u]));
  check(byUnit.size===result.units.length,'duplicate_tracking_unit');
  instant(analysis.as_of);
  for(const field of ['confirmations','payment_reviews']){
    const keys=new Set();for(const row of analysis[field]||[]){check(byUnit.has(row.unit_key)&&!keys.has(row.unit_key),'duplicate_or_unknown_unit_review');keys.add(row.unit_key);}
  }
  const orderKeys=new Set();for(const order of analysis.orders||[]){
    check(order.store_key&&typeof order.order_id==='string'&&order.order_id,'order_identity_required');
    const orderKey=JSON.stringify([order.store_key,order.order_id]);check(!orderKeys.has(orderKey),'duplicate_order');orderKeys.add(orderKey);
    const target=byUnit.get(order.unit_key);
    check(!target||!order.company_customer_id||target.company_customer_id===order.company_customer_id,'order_company_unit_conflict');
  }
  const oldOrderOwners=new Map();
  for(const t of local.transactions||[])for(const order of [...(t.linked_orders||[]),...(t.candidate_orders||[])]){
    const orderKey=JSON.stringify([order.store_key,order.order_id]);
    check(!oldOrderOwners.has(orderKey)||oldOrderOwners.get(orderKey).unit_key===t.unit_key,'prior_order_association_conflict');
    oldOrderOwners.set(orderKey,t);
  }
  for(const order of analysis.orders||[]){
    const old=oldOrderOwners.get(JSON.stringify([order.store_key,order.order_id]));
    if(old)check((!order.unit_key||order.unit_key===old.unit_key)&&
      (!order.company_customer_id||order.company_customer_id===old.company_customer_id),'prior_order_association_reconciliation_required');
  }
  const seen=new Set();
  for(const assessment of analysis.profiles || []){
    check(byUnit.has(assessment.unit_key)&&!seen.has(assessment.unit_key),'invalid_profile_unit');seen.add(assessment.unit_key);
    check(analysis.schema_version!=='lew.local-analysis.v2'||assessment.schema_version===PROFILE_AXES_VERSION,'axes_profile_required');
    check(instant(assessment.assessed_at)<=instant(analysis.as_of),'analysis_after_cutoff');
    const unit=byUnit.get(assessment.unit_key),support=referenced(assessmentEvidenceRefs(assessment),evidence);
    const sourceFingerprint=fingerprint({assessment,support});
    if(unit.profile?.source_fingerprint===sourceFingerprint)continue;
    unit.profile={...buildProfile(assessment,evidence,unit.profile),source_fingerprint:sourceFingerprint};
  }
  const actionUnits=new Set();
  const opportunityKeys=new Set();
  for(const assessment of analysis.opportunities||[]){
    const unit=byUnit.get(assessment.unit_key),ref=unit?.inquiry_refs.find(r=>key(r)===key(assessment));
    check(ref&&!opportunityKeys.has(key(assessment)),'duplicate_or_unknown_opportunity');opportunityKeys.add(key(assessment));
    check(instant(assessment.assessed_at)<=instant(analysis.as_of),'analysis_after_cutoff');
    ref.opportunity_review=buildOpportunityReview(assessment,evidence,ref,ref.opportunity_review);
  }
  for(const action of analysis.actions || []){
    check(byUnit.has(action.unit_key)&&typeof action.next_action==='string'&&action.next_action,'invalid_action');
    check(!actionUnits.has(action.unit_key),'duplicate_action_unit');actionUnits.add(action.unit_key);
    check(action.evidence_refs?.length>0,'action_evidence_required');referenced(action.evidence_refs,evidence);
    const unit=byUnit.get(action.unit_key);
    unit.action={next_action:action.next_action,owner:action.owner ?? null,due_date:action.due_date ?? null,
      status:'ai_proposed',executed:false,evidence_refs:action.evidence_refs,
      missing:[...(!action.owner?['owner']:[]),...(!action.due_date?['due_date']:[])]};
    if(action.due_date)check(/^\d{4}-\d{2}-\d{2}$/.test(action.due_date)&&new Date(action.due_date+'T00:00:00Z').toISOString().slice(0,10)===action.due_date,'invalid_action_date');
  }
  const oldTransactions=new Map((local.transactions||[]).map(t=>[t.unit_key,t]));
  result.transactions=result.units.map(unit=>{
    const old=oldTransactions.get(unit.unit_key),orders=new Map();
    for(const order of [...(old?.linked_orders||[]),...(old?.candidate_orders||[]),...(analysis.orders||[]).filter(o=>
      o.company_customer_id&&o.company_customer_id===unit.company_customer_id||o.unit_key===unit.unit_key)]){
      const orderKey=JSON.stringify([order.store_key,order.order_id]),known=orders.get(orderKey);
      let merged=known?{...known,...Object.fromEntries(Object.entries(order).filter(([,value])=>value!=null))}:order;
      if(known?.receipt_verified){
        check(order.payment_status==null||['verified','unverified'].includes(order.payment_status),'verified_payment_correction_required');
        for(const field of ['first_payment_at','first_payment_amount'])check(order[field]==null||order[field]===known[field],'verified_payment_correction_required');
        for(const field of ['payment_status','payment_evidence','first_payment_at','first_payment_amount'])merged[field]=known[field];
      }
      if(known&&['verified_id','manual_crosscheck'].includes(known.association_status)&&
        (order.association_status==null||['candidate','unverified'].includes(order.association_status)))
        for(const field of ['association_status','association_evidence','review_status'])merged[field]=known[field];
      orders.set(orderKey,merged);
    }
    const confirmation=analysis.confirmations?.find(c=>c.unit_key===unit.unit_key) || (old?.confirmation_status?{
      value:old.confirmation_status,review_status:'confirmed',evidence_ref:old.confirmation_evidence,enrolled_at:old.enrolled_at}:null);
    const history=[...(old?.historical_purchase_signals||[]),...(analysis.historical_purchase_signals||[]).filter(s=>s.unit_key===unit.unit_key)];
    const conflicts=[...(old?.conflicts||[]),...(analysis.conflicts||[]).filter(c=>c.unit_key===unit.unit_key)];
    return evaluateCompanyTransactions(unit,[...orders.values()],{as_of:analysis.as_of,confirmation,
      historical_purchase_signals:[...new Map(history.map(s=>[fingerprint(s),s])).values()],conflicts:[...new Map(conflicts.map(s=>[fingerprint(s),s])).values()],
      payment_review:analysis.payment_reviews?.find(c=>c.unit_key===unit.unit_key) || null});
  });
  result.batch_summaries=[...new Set(result.units.map(u=>u.original_batch))].map(batch=>({batch_id:batch,...conversionSummary(result.transactions.filter(r=>r.original_batch===batch))}));
  const unassociated=[...(local.unassociated_orders||[]),...(analysis.orders||[]).filter(o=>!byUnit.has(o.unit_key)&&
    !result.units.some(unit=>unit.company_customer_id&&unit.company_customer_id===o.company_customer_id))];
  result.unassociated_orders=[...new Map(unassociated.map(order=>[JSON.stringify([order.store_key,order.order_id]),order])).values()];
  result.analysis_as_of=analysis.as_of;
  result.research_status='private_operational_assessments; upstream_v3_research_completion_separate';
  result.profile_axes_summary=axisSummary(result.units.map(u=>u.profile));
  result.opportunity_summary=opportunitySummary(result.units);
  return result;
}
/** Bind private message references to exact local identities, never to a similar buyer name. */
export function checkLocalChatBindings(local,analysis,manifest,messages,snapshotAt=analysis.as_of,windowFromMs=null){
  const refs=new Map();
  const noReplyRefs=new Set((analysis.opportunities||[]).filter(a=>['no_reply','quote_no_reply'].includes(a.low_quality_reason?.code)).flatMap(a=>a.low_quality_reason.evidence_refs));
  for(const unit of local.units)for(const ref of unit.inquiry_refs){
    check(!refs.has(key(ref)),'duplicate_local_inquiry_binding');refs.set(key(ref),{unit,ref});
  }
  const associations=new Set();
  for(const association of manifest.associations){
    check(!associations.has(key(association)),'duplicate_chat_association');associations.add(key(association));
    const bound=refs.get(key(association));
    check(bound&&bound.ref.buyer_member_id===association.buyer_member_id,'chat_manifest_outside_local_scope');
  }
  for(const source of analysis.evidence || []){
    if(source.kind!=='chat_message')continue;
    const bound=refs.get(key(source)),association=manifest.associations.find(a=>key(a)===key(source));
    check(bound&&association&&source.unit_key===bound.unit.unit_key&&
      source.buyer_member_id===bound.ref.buyer_member_id,'chat_evidence_unit_mismatch');
    const rows=association.message_indexes.map(index=>messages[index]).filter(row=>row?.message.message_id===source.message_id);
    check(rows.length===1&&rows[0].buyer_member_id===source.buyer_member_id&&
      rows[0].conversation_id===association.identity?.conversation_id&&
      source.locator===`chat-message:${source.message_id}`,'chat_evidence_message_mismatch');
    check(rows[0].message.content_status!=='recalled_or_hidden','hidden_message_is_not_content_evidence');
    check(instant(source.observed_at)>=instant(rows[0].message.sent_at)&&instant(source.observed_at)<=instant(analysis.as_of),'invalid_chat_evidence_observation');
    source.direction=rows[0].message.direction;
    source.reply_source=rows[0].message.reply_source;
    source.content_status=rows[0].message.content_status;
    source.sent_at=rows[0].message.sent_at;
    source.automatic=Object.values(rows[0].message.automation_flags||{}).some(v=>v===true);
    delete source.no_buyer_reply_after;delete source.reply_checked_until;
    if(noReplyRefs.has(source.id)){
      const checkedUntil=Math.min(instant(snapshotAt),instant(analysis.as_of));
      source.reply_checked_until=new Date(checkedUntil).toISOString();
      source.no_buyer_reply_after=source.direction==='seller'&&association.pages_read>0&&instant(source.sent_at)<=checkedUntil&&
        !association.message_indexes.some(index=>{
          const message=messages[index]?.message;
          return message?.direction==='buyer'&&message.reply_source!=='ai'&&!Object.values(message.automation_flags||{}).some(v=>v===true)&&
            instant(message.sent_at)>=instant(source.sent_at)&&instant(message.sent_at)<=checkedUntil;
        });
    }
    if(source.quote!=null){
      const normal=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
      check(typeof source.quote==='string'&&source.quote.trim()&&[rows[0].message.text,rows[0].message.source_content].some(body=>typeof body==='string'&&normal(body).includes(normal(source.quote))),'chat_quote_not_in_message');
    }
    source.chat_bound=true;
  }
  bindDepthCoverage(local,analysis,manifest,messages,snapshotAt,windowFromMs);
  for(const entry of [...(analysis.profiles || []),...(analysis.actions || [])]){
    const ids=assessmentEvidenceRefs(entry);
    for(const source of referenced(ids,analysis.evidence || []))if(source.kind==='chat_message')
      check(source.unit_key===entry.unit_key,'chat_evidence_used_for_wrong_unit');
    if(entry.procurement_intent?.buyer_confirmed===true)for(const source of referenced(entry.procurement_intent.evidence_refs || [],analysis.evidence || []))
      if(source.kind==='chat_message')check(source.direction==='buyer','buyer_intent_requires_buyer_message');
  }
  for(const entry of analysis.opportunities||[])for(const source of referenced(opportunityEvidenceRefs(entry),analysis.evidence||[]))
    check(source.kind==='chat_message'&&source.unit_key===entry.unit_key&&key(source)===key(entry),'opportunity_evidence_scope_mismatch');
}
export function reviewLocal({input,analysis,out,chatManifest},projectRoot=root){
  const inputPath=dataPath(input,projectRoot),analysisPath=dataPath(analysis,projectRoot),outPath=dataPath(out,projectRoot),raw=read(analysisPath);
  const inputHash=createHash('sha256').update(readFileSync(inputPath)).digest('hex');
  check(raw.input_sha256===inputHash,'analysis_input_changed');
  const local=read(inputPath);
  check(chatManifest||!(raw.evidence||[]).some(e=>e.kind==='chat_message'),'chat_manifest_required');
  if(chatManifest){
    const manifestPath=dataPath(chatManifest,projectRoot),manifest=read(manifestPath);
    const expectedSha256=createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    validateChatEvidence({manifest:chatManifest,expectedSha256},projectRoot);
    const verified=validateChatRun({chatRun:manifest.chatRun,source:manifest.source},projectRoot);
    check(Object.entries(verified.artifacts).every(([path,hash])=>manifest.artifactsSha256[path]===hash),'chat_manifest_artifacts_changed');
    checkLocalChatBindings(local,raw,manifest,verified.messages,new Date(verified.config.snapshot_at_ms).toISOString(),verified.config.from_ms??null);
  }
  const result=updateLocal(local,raw);result.analysis_source_sha256=createHash('sha256').update(readFileSync(analysisPath)).digest('hex');
  result.chat_manifest=chatManifest?{path:chatManifest,sha256:createHash('sha256').update(readFileSync(dataPath(chatManifest,projectRoot))).digest('hex')}:null;
  if(existsSync(outPath))check(fingerprint(read(outPath))===fingerprint(result),'existing_review_conflict');else save(outPath,result);
  const historyDb=local.history_reuse?.db||DEFAULT_DB;
  if(existsSync(dataPath(historyDb,projectRoot))){const db=openHistory(historyDb,projectRoot);try{indexResearch(db,outPath,projectRoot);}finally{db.close();}}
  return {out:outPath,units:result.units.length,profiled_units:result.units.filter(u=>u.profile).length,
    profile_axes_summary:result.profile_axes_summary,opportunity_summary:result.opportunity_summary,action_count:result.units.filter(u=>u.action).length,public_research_completed:false};
}

function read(path){return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}
function save(path,value){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
export function createAnalysisDraft({input,out,asOf},projectRoot=root){
  instant(asOf);const inputPath=dataPath(input,projectRoot),outPath=dataPath(out,projectRoot),local=read(inputPath);
  check(local.schema_version===LOCAL_VERSION,'invalid_local_input');check(inputPath!==outPath,'source_overwrite_forbidden');
  const draft={schema_version:'lew.local-analysis.v2',input_sha256:createHash('sha256').update(readFileSync(inputPath)).digest('hex'),as_of:asOf,
    evidence:[],profiles:local.units.filter(u=>u.profile?.schema_version!==PROFILE_AXES_VERSION).map(u=>emptyAxesAssessment(u.unit_key,asOf)),
    opportunities:local.units.flatMap(u=>u.inquiry_refs.filter(r=>r.created_at&&(r.opportunity_review?.schema_version!==OPPORTUNITY_VERSION||!r.opportunity_review?.deep_communication)).map(r=>emptyOpportunityAssessment(u.unit_key,r,asOf))),
    actions:[],orders:[],confirmations:[],payment_reviews:[]};
  if(existsSync(outPath))check(fingerprint(read(outPath))===fingerprint(draft),'existing_analysis_conflict');else save(outPath,draft);
  return {out:outPath,status:'analysis_draft',pending_profile_count:draft.profiles.length,pending_opportunity_count:draft.opportunities.length,public_research_completed:false};
}
export function prepareLocal({source,scope,prior,companyLinks,memberSource,trackingTables,researchInput,out,historyDb=DEFAULT_DB,historyAsOf},projectRoot=root){
  const sourcePath=dataPath(source,projectRoot),scopePath=dataPath(scope,projectRoot),outPath=dataPath(out,projectRoot);
  const bundle=read(sourcePath);
  if(memberSource){
    const members=read(dataPath(memberSource,projectRoot));
    check(Array.isArray(members.inquiries)&&Array.isArray(members.buyer_member_links),'member_source_bundle_required');
    bundle.buyer_member_links=[...(bundle.buyer_member_links||[]),...members.buyer_member_links.filter(link=>
      bundle.inquiries.some(row=>key(row)===key(link))&&members.inquiries.some(row=>key(row)===key(link)))];
  }
  const result=selectCohort(bundle,read(scopePath),prior?read(dataPath(prior,projectRoot)):undefined,
    companyLinks?read(dataPath(companyLinks,projectRoot)):[]);
  result.source_sha256=createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  result.source_path=source;
  if(existsSync(dataPath(historyDb,projectRoot))){
    const db=openHistory(historyDb,projectRoot,{readOnly:true}),cache=new Map();
    try{
      const records=result.units.flatMap(u=>u.inquiry_refs.map(ref=>lookupHistory(db,ref,{
        asOf:historyAsOf||result.scope.as_of||result.scope.to_exclusive,from:result.scope.from_inclusive,root:projectRoot,cache})));
      check(!records.some(r=>r.decision==='needs_review'),'history_identity_or_evidence_conflict');
      const excluded=records.filter(r=>r.decision==='exclude_phishing'),excludedKeys=new Set(excluded.map(key));
      if(excluded.length){
        result.excluded_inquiries=excluded;
        result.units=result.units.map(u=>({...u,inquiry_refs:u.inquiry_refs.filter(ref=>!excludedKeys.has(key(ref)))})).filter(u=>u.inquiry_refs.length);
        result.counts.excluded_phishing_inquiries=excluded.length;
        result.counts.tracking_units=result.units.length;
        result.counts.known_member_accounts=new Set(result.units.flatMap(u=>u.inquiry_refs.map(r=>r.buyer_member_id)).filter(Boolean)).size;
        result.counts.company_customers=result.units.every(u=>u.company_identity_status==='confirmed')?result.units.length:null;
      }
      result.history_reuse={schema_version:'lew.local-history-reuse.v1',db:historyDb,as_of:historyAsOf||result.scope.as_of||result.scope.to_exclusive,records,
        research_queue:records.filter(r=>r.decision!=='exclude_phishing').map(r=>({store_key:r.store_key,inquiry_id:r.inquiry_id,buyer_member_id:r.buyer_member_id,
          action:r.research.some(s=>s.category==='public_background')?'review_existing_background_then_fill_gaps':'research_gap',
          sources:r.research,current_status_checks:'refresh_when_requested',formal_research_completed:false}))};
    }finally{db.close();}
  }
  if(trackingTables){
    const tablesPath=dataPath(trackingTables,projectRoot),tables=read(tablesPath),rows=new Map();
    check(tables.schema_version==='lew.tracking-tables.v1'&&Array.isArray(tables.inquiries)&&/^[a-f0-9]{64}$/.test(tables.workbook_sha256),'tracking_tables_required');
    for(const row of bundle.inquiries)rows.set(key(row),row);
    const seen=new Set();
    for(const row of tables.inquiries){
      const identity=key(row),original=rows.get(identity);
      check(original&&!seen.has(identity),'tracking_table_inquiry_outside_source');seen.add(identity);
      check(row.created_at==null||original.created_at!=null&&instant(row.created_at)===instant(original.created_at),'tracking_table_creation_conflict');
      const member=bundle.buyer_member_links?.find(link=>key(link)===identity)?.buyer_member_id;
      check(!row.buyer_member_id||row.buyer_member_id===member,'tracking_table_member_conflict');
    }
    result.tracking_tables={path:trackingTables,sha256:createHash('sha256').update(readFileSync(tablesPath)).digest('hex'),
      workbook_sha256:tables.workbook_sha256,mapped_inquiry_count:tables.inquiries.length,
      source_inquiries_without_table_row:bundle.inquiries.filter(row=>!seen.has(key(row))).map(row=>({store_key:row.store_key,inquiry_id:row.inquiry_id}))};
  }
  if(memberSource)result.member_source_sha256=createHash('sha256').update(readFileSync(dataPath(memberSource,projectRoot))).digest('hex');
  result.research_input_status='not_provided';
  if(researchInput){
    const path=dataPath(researchInput,projectRoot);
    check(path!==outPath,'research_input_overwrite_forbidden');
    const body=read(path);
    const inputSha=createHash('sha256').update(readFileSync(path)).digest('hex');
    const replay=spawnSync(process.env.PYTHON_EXECUTABLE||'python',['-B',fileURLToPath(new URL('./build_research_input.py',import.meta.url)),'--verify-input',path],{encoding:'utf8',windowsHide:true});
    check(replay.status===0,'research_input_source_projection_failed');
    check(inputSha===createHash('sha256').update(readFileSync(path)).digest('hex'),'research_input_changed_during_validation');
    check(body.schema_version==='lew.research-input.v1'&&body.population?.sha256===result.source_sha256&&
      body.research_status==='not_performed'&&body.contact_status==='not_contacted'&&Array.isArray(body.records),'research_input_binding_mismatch');
    check(Array.isArray(body.sources),'research_input_sources_required');
    const records=new Map(),fields=['name','email','website','phone','whatsapp'];
    for(const record of body.records){
      check(!records.has(key(record))&&record.clues?.schema_version==='lew.research-clues.v1'&&
        record.research_status==='not_performed'&&record.contact_status==='not_contacted'&&
        fields.every(f=>record.clues.fields?.[f]&&Array.isArray(record.clues.fields[f].items)), 'research_input_record_invalid');
      records.set(key(record),record);
    }
    for(const unit of result.units)for(const inquiry of unit.inquiry_refs){
      const record=records.get(key(inquiry));
      if(!record){inquiry.research_clues_status='not_provided_for_prior_inquiry';continue;}
      check(record.buyer_member_id===inquiry.buyer_member_id,'research_input_member_mismatch');
      inquiry.research_clues=structuredClone(record.clues);
      inquiry.research_source_issues=structuredClone(record.source_issues||[]);
      inquiry.research_clues_status='saved_input_only';
    }
    result.research_input={path:researchInput,sha256:inputSha,population:body.population};
    result.research_input_status='saved_input_only; public_research_not_performed';
  }
  result.scope_sha256=createHash('sha256').update(readFileSync(scopePath)).digest('hex');
  save(outPath,result);return {out:outPath,schema_version:LOCAL_VERSION,...result.counts,research_status:result.research_status};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [action,...args]=process.argv.slice(2),a={},allowed=action==='prepare'?['source','scope','prior','company-links','member-source','tracking-tables','research-input','out','history-db','history-as-of']:action==='review'?['input','analysis','out','chat-manifest']:action==='draft'?['input','out','as-of']:[];
    for(let i=0;i<args.length;i+=2){const name=args[i]?.slice(2);check(args[i]?.startsWith('--')&&allowed.includes(name)&&args[i+1]&&!args[i+1].startsWith('--')&&!Object.hasOwn(a,name),'invalid_arguments');a[name]=args[i+1];}
    let result;
    if(action==='prepare')result=prepareLocal({source:a.source,scope:a.scope,prior:a.prior,companyLinks:a['company-links'],memberSource:a['member-source'],trackingTables:a['tracking-tables'],researchInput:a['research-input'],out:a.out,historyDb:a['history-db'],historyAsOf:a['history-as-of']});
    else if(action==='review')result=reviewLocal({input:a.input,analysis:a.analysis,out:a.out,chatManifest:a['chat-manifest']});
    else if(action==='draft')result=createAnalysisDraft({input:a.input,out:a.out,asOf:a['as-of']});
    else throw Error('use_prepare_draft_or_review');
    console.log(JSON.stringify(result));
  }catch(e){console.error(JSON.stringify({error:/^[a-z_]+$/.test(e.message)?e.message:'local_adaptation_error'}));process.exitCode=1;}
}
