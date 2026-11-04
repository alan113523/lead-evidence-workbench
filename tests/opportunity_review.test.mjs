import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpportunityReview,emptyOpportunityAssessment,opportunitySummary} from '../scripts/opportunity_review.mjs';
import {selectCohort,updateLocal,checkLocalChatBindings} from '../scripts/buyer_due_diligence_local.mjs';
import {buildTrackingPatch} from '../scripts/tracking_review_patch.mjs';
const at='2026-10-08T00:00:00Z',created='2026-10-06T00:00:00Z';
const ref={store_key:'demobeta',inquiry_id:'101',created_at:created,buyer_member_id:'alibaba-visible-member:synthetic001'};
function fixture(){
  const a=emptyOpportunityAssessment('unit',ref,at);a.review_state='reviewed';a.summary='Synthetic current purchase';a.next_action='Confirm sample delivery';
  const e={id:'m',kind:'chat_message',chat_bound:true,unit_key:'unit',...ref,message_id:'m1',locator:'chat-message:m1',scope:'current_purchase',quote:'Please quote 2 DEMO-101 samples',
    sent_at:'2026-10-07T00:00:00Z',observed_at:at,direction:'buyer',reply_source:'unknown',automatic:false,content_status:'read'};
  a.products=[{label:'DEMO-101',source_label:'DEMO-101',kind:'model',status:'requested',evidence_refs:['m']}];
  for(const [key,value] of [['need','clear'],['fit','supported'],['progress','concrete']])a.signals[key]={value,reason:'Synthetic cited fact',evidence_refs:['m']};
  return {a,e};
}
test('four grades derive from cited need, fit and progress without score or buyer-tier shortcuts',()=>{
  const {a,e}=fixture();assert.equal(buildOpportunityReview(a,[e],ref).quality,'好');
  a.signals.fit={value:'unresolved',reason:'Need a compatibility answer',evidence_refs:[]};assert.equal(buildOpportunityReview(a,[e],ref).quality,'中');
  a.signals.fit={value:'mismatch',reason:'Confirmed incompatibility',evidence_refs:['m']};assert.equal(buildOpportunityReview(a,[e],ref).quality,'差');
  const empty=emptyOpportunityAssessment('unit',ref,at);empty.review_state='reviewed';assert.equal(buildOpportunityReview(empty,[],ref).quality,'待判断');
  assert.equal(opportunitySummary([{inquiry_refs:[{opportunity_review:buildOpportunityReview(empty,[],ref)}]}]).quality['待判断'],1);
});
test('explicit decline is low quality; uncertainty, seller-only proposals and conflicts are distinct',()=>{
  const {a,e}=fixture();a.signals.progress.value='declined';assert.equal(buildOpportunityReview(a,[e],ref).quality,'差');
  a.conflicts=[{reason:'Another current reply contradicts this decline',evidence_refs:['m']}];assert.equal(buildOpportunityReview(a,[e],ref).quality,'待判断');
  assert.equal(buildOpportunityReview(a,[e],ref).needs_exception_review,true);
  const proposal=emptyOpportunityAssessment('unit',ref,at);proposal.review_state='reviewed';proposal.products=[{...a.products[0],status:'proposed'}];
  const result=buildOpportunityReview(proposal,[{...e,direction:'seller'}],ref);assert.equal(result.product,'DEMO-101（卖方推荐，待确认）');assert.equal(result.quality,'待判断');
});

function noReplyFixture(code='no_reply'){
  const a=emptyOpportunityAssessment('unit',ref,at);a.review_state='reviewed';
  a.summary='Seller is waiting for a response';a.next_action='Follow up on the sample quote';
  a.low_quality_reason={code,reason:code==='quote_no_reply'?'报价后未回':'未回复（已读状态未核实）',evidence_refs:['seller']};
  a.products=[{label:'DEMO-101',source_label:'DEMO-101',kind:'model',status:'proposed',evidence_refs:['seller']}];
  const {e}=fixture();const source={...e,id:'seller',direction:'seller',message_id:'s1',locator:'chat-message:s1',quote:'DEMO-101 samples are USD 17 each. Please confirm.',chat_bound:false,no_buyer_reply_after:true};
  const local={units:[{unit_key:'unit',inquiry_refs:[ref]}]},analysis={as_of:at,evidence:[source],opportunities:[a]};
  const manifest={associations:[{...ref,identity:{conversation_id:'c'},pages_read:1,message_indexes:[0]}]};
  const messages=[{buyer_member_id:ref.buyer_member_id,conversation_id:'c',message:{message_id:'s1',sent_at:e.sent_at,text:source.quote,direction:'seller',reply_source:'unknown',content_status:'read',automation_flags:{}}}];
  return {a,source,local,analysis,manifest,messages};
}

test('verified no reply and an unanswered quote now grade low without claiming a read receipt',()=>{
  for(const code of ['no_reply','quote_no_reply']){
    const f=noReplyFixture(code);checkLocalChatBindings(f.local,f.analysis,f.manifest,f.messages);
    const result=buildOpportunityReview(f.a,f.analysis.evidence,ref);
    assert.equal(result.quality,'差');assert.equal(result.low_quality_reason.code,code);
    assert.ok(result.summary.includes(f.a.low_quality_reason.reason));
    assert.equal(result.excluded_from_new_customer_review,false);
    assert.equal(f.source.no_buyer_reply_after,true);assert.equal(f.source.reply_checked_until,at.replace('Z','.000Z'));
    assert.ok(result.product.includes('卖方推荐'));assert.equal(f.source.read_receipt_status,undefined);
  }
});

test('later buyer messages, missing collection coverage and unsupported reasons cannot become no reply',()=>{
  const f=noReplyFixture('quote_no_reply');
  f.messages.push({buyer_member_id:ref.buyer_member_id,conversation_id:'c',message:{message_id:'b2',sent_at:'2026-10-07T01:00:00Z',direction:'buyer',reply_source:'unknown',content_status:'recalled_or_hidden',automation_flags:{},text:''}});
  f.manifest.associations[0].message_indexes.push(1);
  checkLocalChatBindings(f.local,f.analysis,f.manifest,f.messages);
  assert.equal(f.source.no_buyer_reply_after,false);
  assert.throws(()=>buildOpportunityReview(f.a,f.analysis.evidence,ref),/verified_no_reply_required/);
  f.manifest.associations[0].message_indexes=[0];f.manifest.associations[0].pages_read=0;
  checkLocalChatBindings(f.local,f.analysis,f.manifest,f.messages);
  assert.throws(()=>buildOpportunityReview(f.a,f.analysis.evidence,ref),/verified_no_reply_required/);
  f.a.low_quality_reason.code='low_buyer_level';assert.throws(()=>buildOpportunityReview(f.a,f.analysis.evidence,ref),/invalid_low_quality_reason/);
  f.a.low_quality_reason.code='existing_customer';f.a.low_quality_reason.evidence_refs=[];
  assert.throws(()=>buildOpportunityReview(f.a,f.analysis.evidence,ref),/low_quality_evidence_required/);
});

test('mismatch and decline reason codes grade low only with a cited buyer statement',()=>{
  for(const code of ['product_mismatch','buyer_declined']){
    const {a,e}=fixture();a.low_quality_reason={code,reason:'买家确认需要的功能本店没有',evidence_refs:['m']};
    const result=buildOpportunityReview(a,[e],ref);
    assert.equal(result.quality,'差');assert.equal(result.low_quality_reason.code,code);assert.equal(result.excluded_from_new_customer_review,false);
    const seller={...e,id:'s',direction:'seller'};a.low_quality_reason.evidence_refs=['s'];
    assert.throws(()=>buildOpportunityReview(a,[e,seller],ref),/opportunity_requires_buyer_statement/);
  }
});

test('existing and duplicate contacts are low quality in the ledger and excluded from new-customer totals',()=>{
  for(const code of ['existing_customer','duplicate_customer']){
    const f=noReplyFixture(code);f.a.low_quality_reason.reason='已有客户，已由同事接待';
    f.source.quote=f.messages[0].message.text='Our colleague is already handling your previous inquiry.';
    f.a.products=[];f.a.conflicts=[{reason:'The previous inquiry still needs to be linked',evidence_refs:['seller']}];
    checkLocalChatBindings(f.local,f.analysis,f.manifest,f.messages);
    const result=buildOpportunityReview(f.a,f.analysis.evidence,ref);
    assert.equal(result.quality,'差');assert.equal(result.excluded_from_new_customer_review,true);assert.equal(result.needs_exception_review,true);
    const {a,e}=fixture(),newInquiry=buildOpportunityReview(a,[e],ref);
    const counts=opportunitySummary([{inquiry_refs:[{opportunity_review:result},{opportunity_review:newInquiry}]}]);
    assert.equal(counts.inquiries,1);assert.equal(counts.excluded_inquiries,1);assert.equal(counts.quality['差'],0);assert.equal(counts.quality['好'],1);
  }
});

test('a new effective reply can upgrade the inquiry while retaining the earlier low rating',()=>{
  const f=noReplyFixture();checkLocalChatBindings(f.local,f.analysis,f.manifest,f.messages);
  const prior=buildOpportunityReview(f.a,f.analysis.evidence,ref);
  const {a,e}=fixture();a.assessed_at='2026-10-09T00:00:00Z';e.sent_at=e.observed_at='2026-10-08T08:00:00Z';
  const next=buildOpportunityReview(a,[e],ref,prior);
  assert.equal(next.quality,'好');assert.equal(next.revision,2);assert.equal(next.history[0].quality,'差');
  assert.equal(next.history[0].low_quality_reason.code,'no_reply');assert.equal(next.low_quality_reason,undefined);
});
test('product names must appear in chat and a seller offer needs buyer confirmation before becoming requested',()=>{
  const {a,e}=fixture();a.products[0].source_label='DEMO-104';assert.throws(()=>buildOpportunityReview(a,[e],ref),/not_in_chat/);
  a.products[0].source_label='DEMO-101';a.products[0].label='DEMO-103';assert.throws(()=>buildOpportunityReview(a,[e],ref),/preserve_chat_spelling/);
  a.products[0].label='DEMO-101';assert.throws(()=>buildOpportunityReview(a,[{...e,direction:'seller'}],ref),/buyer_statement/);
  a.products[0].kind='category';a.products[0].label='香薰机';assert.equal(buildOpportunityReview(a,[e],ref).product,'香薰机');
});
test('history, other inquiries, automated replies and unbound evidence cannot support current quality',()=>{
  const {a,e}=fixture();
  for(const change of [{inquiry_id:'102'},{store_key:'demogamma'},{unit_key:'other'},{sent_at:'2026-10-05T00:00:00Z'},{automatic:true},{reply_source:'ai'},{chat_bound:false},{kind:'public_source'},{scope:'historical_purchase'}])
    assert.throws(()=>buildOpportunityReview(a,[{...e,...change}],ref));
});
test('the same facts retain their original assessment; changed facts preserve a dated revision',()=>{
  const {a,e}=fixture(),first=buildOpportunityReview(a,[e],ref);
  const same=buildOpportunityReview({...a,assessed_at:'2026-10-09T00:00:00Z'},[e],ref,first);assert.equal(same.revision,1);assert.equal(same.assessed_at,at);
  a.signals.fit={value:'unresolved',reason:'A new compatibility question',evidence_refs:[]};const next=buildOpportunityReview(a,[e],ref,first);
  assert.equal(next.revision,2);assert.equal(next.history[0].quality,'好');assert.equal(next.quality,'中');
});
test('validated chat overrides sent time, automation and direction, and rejects invented quotes',()=>{
  const {a,e}=fixture();const local={units:[{unit_key:'unit',inquiry_refs:[ref]}]},analysis={as_of:at,evidence:[{...e,chat_bound:false,sent_at:created}],opportunities:[a]};
  const manifest={associations:[{...ref,identity:{conversation_id:'c'},message_indexes:[0]}]};
  const messages=[{buyer_member_id:ref.buyer_member_id,conversation_id:'c',message:{message_id:'m1',sent_at:e.sent_at,text:e.quote,source_content:null,direction:'buyer',reply_source:'unknown',content_status:'read',automation_flags:{auto_reply:true}}}];
  checkLocalChatBindings(local,analysis,manifest,messages);assert.equal(analysis.evidence[0].sent_at,e.sent_at);assert.equal(analysis.evidence[0].automatic,true);
  assert.throws(()=>buildOpportunityReview(a,analysis.evidence,ref),/buyer_statement/);
  analysis.evidence[0].quote='A fabricated order';assert.throws(()=>checkLocalChatBindings(local,analysis,manifest,messages),/quote_not_in_message/);
});
test('same-buyer opportunities keep separate products and grades through local review and workbook patches',()=>{
  const refs=[ref,{...ref,inquiry_id:'102'}],bundle={inquiries:refs,buyer_member_links:refs.map(r=>({...r,source_system:'alibaba-message-querySummary-contact-loginId-v1'}))};
  const local=selectCohort(bundle,{stores:['demobeta'],from_inclusive:created,to_exclusive:at,time_zone:'Asia/Shanghai',batch_id:'synthetic'}),unit=local.units[0];
  const {a,e}=fixture();a.unit_key=unit.unit_key;e.unit_key=unit.unit_key;
  const b=structuredClone(a);b.inquiry_id='102';b.products[0].label=b.products[0].source_label='DEMO-102';b.products[0].evidence_refs=['n'];
  b.next_action='Confirm a compatible DEMO-102 alternative';
  for(const s of Object.values(b.signals))s.evidence_refs=['n'];b.signals.fit.value='mismatch';
  const n={...e,id:'n',inquiry_id:'102',message_id:'m2',quote:'DEMO-102 does not meet our requirement'};
  const review=updateLocal(local,{schema_version:'lew.local-analysis.v2',as_of:at,evidence:[e,n],opportunities:[a,b]});
  review.units[0].action={status:'ai_proposed',executed:false,next_action:'A buyer-wide task',owner:'Someone',due_date:'2026-10-09',evidence_refs:['m']};
  assert.deepEqual(review.units[0].inquiry_refs.map(r=>r.opportunity_review.quality),['好','差']);
  const tables={schema_version:'lew.tracking-tables.v1',workbook_sha256:'a'.repeat(64),inquiries:refs.map((r,i)=>({...r,source_sheet:'商机录入',source_row:i+6,field_provenance:Object.fromEntries(
    [['product','A','产品'],['opportunity_quality','B','质量'],['opportunity_quality_basis','C','质量依据'],['next_action','D','下一步']].map(([field,col,header])=>[field,{sheet:'商机录入',cell:col+(i+6),header,value:null,formula:null,status:'workbook_value'}]))}))};
  const patch=buildTrackingPatch(tables,review,'b'.repeat(64));
  assert.deepEqual(patch.patch.changes.filter(c=>c.cell.startsWith('A')).map(c=>c.value),['DEMO-101','DEMO-102']);
  assert.deepEqual(patch.patch.changes.filter(c=>c.cell.startsWith('B')).map(c=>c.value),['好','差']);
  assert.deepEqual(patch.patch.changes.filter(c=>c.cell.startsWith('D')).map(c=>c.value),['[AI草稿] Confirm sample delivery','[AI草稿] Confirm a compatible DEMO-102 alternative']);
  assert.ok(patch.patch.changes.find(c=>c.cell==='D7').evidence_ref.endsWith(':demobeta:102'));
  assert.ok(patch.patch.changes.find(c=>c.cell==='B7').evidence_ref.endsWith(':demobeta:102'));
  tables.inquiries[0].field_provenance.product.value='Preserved manual model';assert.equal(buildTrackingPatch(tables,review,'b'.repeat(64),{fillMissingOnly:true}).preserved_nonempty_cell_count,1);
});
