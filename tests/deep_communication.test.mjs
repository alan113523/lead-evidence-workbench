import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpportunityReview,emptyOpportunityAssessment,opportunitySummary,depthColumns,DEPTH_FIELDS} from '../scripts/deep_communication.mjs';
import {checkLocalChatBindings,selectCohort,updateLocal,createAnalysisDraft} from '../scripts/buyer_due_diligence_local.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {buildTrackingPatch} from '../scripts/tracking_review_patch.mjs';
const created='2026-10-01T00:00:00Z',at='2026-10-08T00:00:00Z';
const ref={store_key:'demobeta',inquiry_id:'101',created_at:created,buyer_member_id:'alibaba-visible-member:synthetic001'};
function fixture() {
  const a=emptyOpportunityAssessment('unit',ref,at);
  a.review_state='reviewed';a.summary='Sample requirements';a.next_action='Confirm delivery';
  a.products=[{label:'SAMPLE-100',source_label:'SAMPLE-100',kind:'model',status:'requested',evidence_refs:['b']}];
  a.signals.need={value:'clear',reason:'Specific product',evidence_refs:['b']};
  const e=[['s','seller','2026-10-02T00:00:00Z','2 SAMPLE-100 samples cost USD 80 shipped.'],
    ['b','buyer','2026-10-03T00:00:00Z','Please make the total USD 70 for the 2 SAMPLE-100 samples.']].map(([id,direction,sent_at,quote])=>({
      id,kind:'chat_message',chat_bound:true,unit_key:'unit',...ref,message_id:id,locator:'chat-message:'+id,
      scope:'current_purchase',quote,sent_at,observed_at:at,direction,reply_source:'unknown',automatic:false,content_status:'read'}));
  a.deep_communication={status:'Y',stage:'方案实谈',reason:'Buyer negotiated the specific sample quote',evidence_refs:['s','b'],
    qualification:{path:'substantive_feedback',product_evidence_refs:['b'],proposal_evidence_refs:['s'],buyer_evidence_refs:['b']}};
  const local={units:[{unit_key:'unit',inquiry_refs:[ref]}]},analysis={as_of:at,evidence:e,opportunities:[a]};
  const manifest={associations:[{...ref,identity:{conversation_id:'c'},pages_read:1,status:'endpoint_exhausted',message_indexes:[0,1]}]};
  const messages=e.map(s=>({buyer_member_id:ref.buyer_member_id,conversation_id:'c',message:{message_id:s.id,sent_at:s.sent_at,text:s.quote,direction:s.direction,reply_source:s.reply_source,content_status:s.content_status,automation_flags:{}}}));
  const bind=(snapshot=at,from=Date.parse(created))=>checkLocalChatBindings(local,analysis,manifest,messages,snapshot,from);
  return {a,e,local,analysis,manifest,messages,bind};
}
test('specific proposal and real buyer feedback support Y even when another page is missing',()=>{
  const f=fixture();f.manifest.associations[0].status='page_budget_reached';f.bind();
  const result=buildOpportunityReview(f.a,f.e,ref);
  assert.equal(result.deep_communication.status,'Y');assert.equal(result.quality,'中');
  assert.equal(result.deep_communication.coverage.sufficient,false);
  assert.equal(result.deep_communication.reached_at,'2026-10-03T00:00:00.000Z');
});
test('concrete sample advancement is distinct from seller-only proposal and basic fields',()=>{
  const f=fixture();f.a.deep_communication.stage='样品/订单推进';f.a.deep_communication.qualification.path='concrete_progress';
  f.a.deep_communication.qualification.proposal_evidence_refs=[];
  f.e[1].quote=f.messages[1].message.text='Please issue a PI for 2 SAMPLE-100 samples at the agreed USD 80 total.';f.bind();
  assert.equal(buildOpportunityReview(f.a,f.e,ref).deep_communication.status,'Y');
  f.a.deep_communication.qualification.buyer_evidence_refs=['s'];
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/real_buyer/);
  f.a.deep_communication.qualification.buyer_evidence_refs=['b'];f.a.deep_communication.qualification.product_evidence_refs=[];
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/depth_product/);
});
test('wrong inquiry, history, automation and feedback preceding its proposal are rejected',()=>{
  for(const change of [{inquiry_id:'other'},{scope:'historical_purchase'},{automatic:true},{sent_at:'2026-09-30T00:00:00Z'}]) {
    const f=fixture();Object.assign(f.e[1],change);assert.throws(()=>buildOpportunityReview(f.a,f.e,ref));
  }
  const f=fixture();f.e[1].sent_at='2026-10-01T01:00:00Z';assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/feedback_must_follow/);
});
function negative(f) {
  f.e[0].quote=f.messages[0].message.text='How many units do you need and where should we ship?';
  f.e[1].quote=f.messages[1].message.text='I need 2 SAMPLE-100 units for the office. Shipping destination is France.';
  f.a.deep_communication={status:'N',stage:'需求澄清',reason:'Reviewed conversation only clarified basic fields',evidence_refs:['b']};
}
test('N needs manifest-derived current-window coverage, not a caller-supplied flag',()=>{
  const f=fixture();negative(f);f.a.deep_communication.coverage={sufficient:true};
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/window_coverage/);
  f.bind();assert.equal(buildOpportunityReview(f.a,f.e,ref).deep_communication.status,'N');
  for(const mutate of [g=>g.manifest.associations[0].status='page_budget_reached',g=>g.manifest.associations[0].pages_read=0,
    g=>g.messages.push({message:{sent_at:at,direction:'buyer',content_status:'recalled_or_hidden',text:''}}),
    g=>g.messages.push({message:{sent_at:at,direction:'buyer',content_status:'metadata_only',text:'catalog.pdf'}})]) {
    const g=fixture();negative(g);mutate(g);
    if(g.messages.length===3)g.manifest.associations[0].message_indexes.push(2);
    g.bind();assert.throws(()=>buildOpportunityReview(g.a,g.e,ref),/window_coverage/);
  }
  for(const [snapshot,from] of [['2026-10-07T00:00:00Z',Date.parse(created)],[at,Date.parse(created)+1],[at,null]]) {
    const g=fixture();negative(g);g.bind(snapshot,from);assert.throws(()=>buildOpportunityReview(g.a,g.e,ref),/window_coverage/);
  }
});
test('gaps are distinct from unassessed work and are never counted as N',()=>{
  const f=fixture();f.a.deep_communication={status:'未核实',stage:'未核实',reason:'Review completed with a gap',gap:'Missing preceding quote context',evidence_refs:['b']};f.bind();
  const result=buildOpportunityReview(f.a,f.e,ref);
  const summary=opportunitySummary([{inquiry_refs:[{opportunity_review:result},{opportunity_review:{...result,excluded_from_new_customer_review:true}},{}]}]);
  assert.deepEqual(summary.deep_communication,{Y:0,N:0,'未核实':1,'待评估':1});
  delete f.a.deep_communication.gap;assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/depth_gap/);
});

test('explicit visible-evidence N retains coverage limits without requiring every attachment',()=>{
  const f=fixture();negative(f);f.a.deep_communication.assessment_scope='visible_evidence';
  f.manifest.associations[0].status='page_budget_reached';
  f.messages.push({message:{sent_at:at,direction:'buyer',content_status:'metadata_only',text:'design.zip'}});
  f.manifest.associations[0].message_indexes.push(2);
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/bound_readable_context/);
  f.bind();const result=buildOpportunityReview(f.a,f.e,ref);
  assert.equal(result.deep_communication.status,'N');
  assert.equal(result.deep_communication.coverage.sufficient,false);
  assert.equal(result.deep_communication.assessment_scope,'visible_evidence');
  assert.match(depthColumns(result).deep_communication_basis,/按可见快照与聊天判断/);
  f.a.deep_communication.evidence_refs=[];
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/bound_readable_context/);
});

test('visible-evidence mode does not bypass identity or achieved-depth protections',()=>{
  const f=fixture();f.bind();const prior=buildOpportunityReview(f.a,f.e,ref);
  negative(f);f.a.deep_communication.assessment_scope='visible_evidence';f.bind();
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref,prior),/evidence_correction/);
  f.e[1].inquiry_id='other';assert.throws(()=>buildOpportunityReview(f.a,f.e,ref));
  f.e[1].inquiry_id=ref.inquiry_id;f.a.deep_communication.assessment_scope='all_history';
  assert.throws(()=>buildOpportunityReview(f.a,f.e,ref),/invalid_depth_assessment_scope/);
});
test('a reviewed opportunity cannot silently retain the unassessed depth placeholder',()=>{
  const a=emptyOpportunityAssessment('unit',ref,at);a.review_state='reviewed';
  assert.throws(()=>buildOpportunityReview(a,[],ref),/depth_review_state_mismatch/);
});
test('draft includes legacy opportunities missing depth without treating the placeholder as reviewed',t=>{
  const root=mkdtempSync(join(tmpdir(),'okki-depth-draft-'));
  t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^okki-depth-draft-/);rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'data'));
  const bundle={inquiries:[ref],buyer_member_links:[{...ref,source_system:'alibaba-message-querySummary-contact-loginId-v1'}]};
  const local=selectCohort(bundle,{stores:['demobeta'],from_inclusive:created,to_exclusive:at,time_zone:'Asia/Shanghai',batch_id:'synthetic'});
  local.units[0].inquiry_refs[0].opportunity_review={schema_version:'lew.opportunity-review.v1',review_state:'reviewed',quality:'中'};
  writeFileSync(join(root,'data/input.json'),JSON.stringify(local));
  assert.equal(createAnalysisDraft({input:'data/input.json',out:'data/draft.json',asOf:at},root).pending_opportunity_count,1);
  const draft=JSON.parse(readFileSync(join(root,'data/draft.json'),'utf8'));
  assert.equal(draft.opportunities[0].review_state,'unassessed');assert.equal(draft.opportunities[0].deep_communication.status,'待评估');
});
test('silence cannot erase achieved depth; corrections preserve a dated revision',()=>{
  const f=fixture();f.bind();const first=buildOpportunityReview(f.a,f.e,ref);
  assert.deepEqual(buildOpportunityReview(f.a,f.e,ref,first),first);
  negative(f);f.bind();assert.throws(()=>buildOpportunityReview(f.a,f.e,ref,first),/evidence_correction/);
  f.a.deep_communication.correction_reason='The cited feedback belonged to a mistaken interpretation; corrected after rereading.';
  const revised=buildOpportunityReview(f.a,f.e,ref,first);
  assert.equal(revised.revision,2);assert.equal(revised.history[0].deep_communication.status,'Y');
  delete f.a.deep_communication;assert.throws(()=>buildOpportunityReview(f.a,f.e,ref,first),/must_be_retained/);
});
test('quality can fall to poor while the cited achieved depth remains Y',()=>{
  const f=fixture();const source={...f.e[0],id:'follow',message_id:'follow',locator:'chat-message:follow',sent_at:'2026-10-04T00:00:00Z',quote:'Please confirm the revised quote.'};
  f.e.push(source);f.messages.push({buyer_member_id:ref.buyer_member_id,conversation_id:'c',message:{...f.messages[0].message,message_id:'follow',sent_at:source.sent_at,text:source.quote}});
  f.manifest.associations[0].message_indexes.push(2);
  f.a.low_quality_reason={code:'quote_no_reply',reason:'No reply after the revised quote',evidence_refs:['follow']};f.bind();
  const result=buildOpportunityReview(f.a,f.e,ref);assert.equal(result.quality,'差');assert.equal(result.deep_communication.status,'Y');
});
test('local review maps depth only to existing exact cells and preserves nonempty values',()=>{
  const f=fixture(),bundle={inquiries:[ref],buyer_member_links:[{...ref,source_system:'alibaba-message-querySummary-contact-loginId-v1'}]};
  const local=selectCohort(bundle,{stores:['demobeta'],from_inclusive:created,to_exclusive:at,time_zone:'Asia/Shanghai',batch_id:'synthetic'});
  f.a.unit_key=local.units[0].unit_key;for(const e of f.e)e.unit_key=f.a.unit_key;
  f.analysis.schema_version='lew.local-analysis.v2';checkLocalChatBindings(local,f.analysis,f.manifest,f.messages,at,Date.parse(created));
  const review=updateLocal(local,f.analysis),h='a'.repeat(64);
  const row={...ref,source_sheet:'商机录入',source_row:6,field_provenance:Object.fromEntries(Object.entries(DEPTH_FIELDS).map(([field,header],i)=>[field,{sheet:'商机录入',cell:String.fromCharCode(65+i)+'6',header,value:null,formula:null,status:'workbook_value'}]))};
  const tables={schema_version:'lew.tracking-tables.v1',workbook_sha256:h,inquiries:[row]};
  const first=buildTrackingPatch(tables,review,h,{fillMissingOnly:true});assert.equal(first.changed_cell_count,3);
  assert.ok(first.patch.changes.every(c=>c.evidence_ref.endsWith(':opportunity:demobeta:101')));
  for(const change of first.patch.changes)Object.values(row.field_provenance).find(p=>p.cell===change.cell).value=change.value;
  assert.equal(buildTrackingPatch(tables,review,h,{fillMissingOnly:true}).changed_cell_count,0);
  row.field_provenance.deep_communication.value='N';assert.equal(buildTrackingPatch(tables,review,h,{fillMissingOnly:true}).preserved_nonempty_cell_count,1);
  const depth=review.units[0].inquiry_refs[0].opportunity_review.deep_communication;
  Object.assign(depth,{status:'未核实',stage:'未核实',reason:'Reviewed but incomplete',gap:'Missing earlier context',evidence_refs:[]});
  assert.equal(buildTrackingPatch(tables,review,h).changed_cell_count,0);
  for(const p of Object.values(row.field_provenance))p.value=null;
  const gap=buildTrackingPatch(tables,review,h);assert.equal(gap.changed_cell_count,3);
  assert.equal(gap.patch.changes[0].value,'未核实');assert.match(gap.patch.changes[2].value,/Missing earlier context/);
  row.field_provenance={};assert.equal(buildTrackingPatch(tables,review,h).changed_cell_count,0);
});
