import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCAL_VERSION,selectCohort,instant,buildProfile,businessTypeClue,evaluateCompanyTransactions,conversionSummary,updateLocal,checkLocalChatBindings,prepareLocal,reviewLocal,createAnalysisDraft} from '../scripts/buyer_due_diligence_local.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const scope={stores:['demobeta'],from_inclusive:'2026-08-31T00:00:00+08:00',to_exclusive:'2026-09-07T00:00:00+08:00',time_zone:'Asia/Shanghai',batch_id:'batch-a'};
const inquiry=(id,created_at='2026-08-31T00:00:00+08:00')=>({store_key:'demobeta',inquiry_id:id,created_at,buyer_name:'Same Synthetic Name',customer_id:null});
const link=id=>({store_key:'demobeta',inquiry_id:id,buyer_member_id:'alibaba-visible-member:synthetic001',source_system:'alibaba-message-querySummary-contact-loginId-v1'});
test('creation boundary selects unregistered buyers; first message and latest update do not change membership',()=>{
  const b={inquiries:[inquiry('1'),inquiry('2','2026-09-07T00:00:00+08:00'),{...inquiry('3','2026-08-30T23:59:59+08:00'),first_sent_at:'2026-09-02T12:00:00+08:00',latest_contact_time:'2026-09-05T12:00:00+08:00'}]};
  const r=selectCohort(b,scope);assert.equal(r.counts.new_inquiries,1);assert.equal(r.units[0].inquiry_refs[0].crm_customer_id,null);assert.equal(r.counts.company_customers,null);
});
test('same names remain distinct; account count and confirmed company count are separate',()=>{
  const b={inquiries:[inquiry('1'),inquiry('2')],buyer_member_links:[link('1'),link('2')]};
  assert.equal(selectCohort({inquiries:b.inquiries},scope).units.length,2);
  assert.equal(selectCohort(b,scope).units.length,1);
  const confirmed=b.inquiries.map(r=>({...r,company_customer_id:'verified-organisation',review_status:'confirmed',evidence_ref:'local-review:1'}));
  assert.equal(selectCohort(b,scope,undefined,confirmed).counts.company_customers,1);
  assert.throws(()=>selectCohort(b,scope,undefined,[{...confirmed[0],review_status:'pending'}]),/merge_evidence/);
});

test('partial native table binding preserves all source inquiries and rejects identity or time drift',()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-full-cohort-'));mkdirSync(join(dir,'data'));
  const put=(name,value)=>writeFileSync(join(dir,'data',name),JSON.stringify(value));
  const bundle={inquiries:[inquiry('1'),inquiry('2'),inquiry('3')],buyer_member_links:[link('1'),link('2'),{...link('3'),buyer_member_id:'alibaba-visible-member:synthetic002'}]};
  const tables={schema_version:'lew.tracking-tables.v1',workbook_sha256:'a'.repeat(64),inquiries:[inquiry('1'),inquiry('2')]};
  try{
    put('source.json',bundle);put('scope.json',scope);put('tables.json',tables);
    const args={source:'data/source.json',scope:'data/scope.json',trackingTables:'data/tables.json',out:'data/input.json'};
    const result=prepareLocal(args,dir),input=JSON.parse(readFileSync(join(dir,args.out)));
    assert.equal(result.new_inquiries,3);assert.equal(result.tracking_units,2);
    assert.equal(input.tracking_tables.mapped_inquiry_count,2);
    assert.equal(input.tracking_tables.source_inquiries_without_table_row[0].inquiry_id,'3');
    assert.notEqual(input.source_sha256,input.tracking_tables.sha256);
    for(const mutate of [t=>t.inquiries[0].inquiry_id='outside',t=>t.inquiries[0].created_at='2026-09-01T00:00:00+08:00',t=>t.inquiries[0].buyer_member_id='alibaba-visible-member:synthetic002',t=>t.inquiries.push({...t.inquiries[0]})]){
      const changed=structuredClone(tables);mutate(changed);put('tables.json',changed);
      assert.throws(()=>prepareLocal({...args,out:'data/rejected.json'},dir),/tracking_table/);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('manual rolling update retains original batch, enrolment and unfinished units',()=>{
  const b={inquiries:[inquiry('1')],buyer_member_links:[link('1')]},first=selectCohort(b,scope);
  first.units[0].profile={role:'待确认',checked_at:'2026-09-01'};
  const next={...scope,batch_id:'batch-b',from_inclusive:scope.to_exclusive,to_exclusive:'2026-09-14T00:00:00+08:00'};
  const r=selectCohort({inquiries:[inquiry('2','2026-09-08T00:00:00+08:00')],buyer_member_links:[link('2')]},next,first);
  assert.equal(r.units.length,1);assert.equal(r.units[0].original_batch,'batch-a');assert.equal(r.units[0].enrolled_at,first.units[0].enrolled_at);assert.equal(r.units[0].inquiry_refs.length,2);assert.deepEqual(r.units[0].profile,first.units[0].profile);
  assert.equal(selectCohort({inquiries:[]},next,r).units.length,1);
});
test('unknown creation time remains visible and missing timezone cannot invent cohort date',()=>{
  const r=selectCohort({inquiries:[inquiry('1',null)]},scope);assert.equal(r.counts.creation_time_unknown,1);assert.equal(r.counts.new_inquiries,0);assert.equal(r.units[0].enrolled_at,null);
  assert.throws(()=>instant('2026-09-01 12:00:00'),/timezone/);assert.throws(()=>instant('2026-09-31T00:00:00Z'),/invalid_timestamp/);
});
test('unsorted same-account inquiries use earliest enrolment and identity changes cannot reset prior batch silently',()=>{
  const b={inquiries:[inquiry('1','2026-09-02T00:00:00+08:00'),inquiry('2')],buyer_member_links:[link('1'),link('2')]};
  const r=selectCohort(b,scope);assert.equal(r.units[0].enrolled_at,b.inquiries[1].created_at);
  const merge=b.inquiries.map(row=>({...row,company_customer_id:'confirmed-company',review_status:'confirmed',evidence_ref:'review:merge'}));
  assert.throws(()=>selectCohort(b,scope,r,merge),/reconciliation/);
});
const evidence=[{id:'p1',kind:'public_source',observed_at:'2026-09-01T00:00:00Z',locator:'https://example.invalid/about'},
  {id:'m1',kind:'chat_message',observed_at:'2026-09-02T00:00:00Z',locator:'local-chat:message-1'}];
const assessment=(extra={})=>({role:'商业自用',confidence:'medium',evidence_refs:['p1'],assessed_at:'2026-09-03T00:00:00Z',...extra});
test('business type and absence of website cannot automatically establish role; evidence is required',()=>{
  assert.equal(businessTypeClue(2001).role,'待确认');assert.equal(businessTypeClue(2007).role,'待确认');
  assert.throws(()=>buildProfile(assessment({role:'个人自用',evidence_refs:[]})),/role_evidence/);
  assert.equal(buildProfile(assessment({role:'待确认',confidence:'unknown',evidence_refs:[]})).role,'待确认');
  assert.throws(()=>buildProfile(assessment({evidence_refs:['missing']}),evidence),/missing_evidence/);
});
test('role revisions preserve dated evidence and do not imply procurement volume',()=>{
  const first=buildProfile(assessment(),evidence),next=buildProfile(assessment({role:'渠道商',evidence_refs:['m1'],revision_reason:'buyer explained resale'}),evidence,first);
  assert.equal(first.large_volume_intent,'unconfirmed');assert.equal(next.history[0].role,'商业自用');assert.equal(next.history[0].assessed_at,first.assessed_at);assert.equal(next.revision,2);
});
test('explicit unit quantities enforce 1000 or annual 3000 with each order 500; USD and profile size are insufficient',()=>{
  const run=intent=>buildProfile(assessment({procurement_intent:{buyer_confirmed:true,quantity_unit:'台',evidence_refs:['m1'],...intent}}),evidence).large_volume_intent;
  assert.equal(run({single_order_quantity:999}),'below_threshold');assert.equal(run({single_order_quantity:1000}),'supported');
  assert.equal(run({annual_quantity:3000,min_per_order_quantity:499}),'below_threshold');assert.equal(run({annual_quantity:3000,min_per_order_quantity:500}),'supported');
  assert.equal(run({annual_quantity:3000}),'unconfirmed');assert.equal(run({single_order_quantity:1000,quantity_unit:'USD'}),'unconfirmed');
  assert.equal(run({single_order_quantity:1000,evidence_refs:['p1']}),'unconfirmed');
});
const company={unit_key:'company:synthetic-company',company_customer_id:'synthetic-company',company_identity_status:'confirmed',original_batch:'batch-a',enrolled_at:'2026-08-31T00:00:00+08:00'};
const order=(id,extra={})=>({store_key:'demobeta',order_id:id,company_customer_id:company.company_customer_id,
  association_status:'verified_id',association_evidence:'local:exact-association',total_amount:2000,currency:'USD',first_payment_amount:100,
  first_payment_at:'2026-09-02T00:00:00+08:00',payment_status:'verified',payment_evidence:'local:receipt',...extra});
const options={as_of:'2026-09-10T00:00:00+08:00'};
const confirmedNew={value:'new',review_status:'confirmed',evidence_ref:'local:company-history-review',enrolled_at:company.enrolled_at};
test('platform trade, order creation and payment promises are not company receipt evidence',()=>{
  const r=evaluateCompanyTransactions({...company,online_trade_volume:999999},[order('1',{payment_status:'unverified'}),order('2',{payment_evidence:null}),order('3',{association_status:'candidate'})],options);
  assert.equal(r.ai_enrolment_status,'new');assert.equal(r.first_known_payment_after_enrolment,null);assert.equal(r.order_candidates,1);
  assert.equal(conversionSummary([r]).final_conversion_rate,null);
});

test('a sourced old company order date supports preliminary identity without inventing receipt time',()=>{
  const signal={kind:'company_purchase_history',evidence_ref:'local:reviewed-own-company-order-panel',purchased_on:'2026-06-01'};
  const older=evaluateCompanyTransactions(company,[],{...options,historical_purchase_signals:[signal]});
  assert.equal(older.ai_enrolment_status,'old');assert.equal(older.first_known_payment_after_enrolment,null);
  assert.equal(older.historical_purchase_signals[0].purchased_at,undefined);
  const ambiguous=evaluateCompanyTransactions(company,[],{...options,historical_purchase_signals:[{...signal,purchased_on:'2026-08-30'}]});
  assert.equal(ambiguous.ai_enrolment_status,'new');
  assert.throws(()=>evaluateCompanyTransactions(company,[],{...options,historical_purchase_signals:[{...signal,purchased_on:'2026-06-31'}]}),/invalid_history_date/);
});
test('deposit does not classify order; cross-store prior payment establishes old preliminary status and later payment preserves enrolment',()=>{
  const r=evaluateCompanyTransactions(company,[order('1'),order('2',{store_key:'demogamma',first_payment_at:'2026-08-01T00:00:00+08:00',total_amount:100})],options);
  assert.equal(r.ai_enrolment_status,'old');assert.equal(r.linked_orders[0].order_kind,'bulk');
  const later=evaluateCompanyTransactions(company,[order('1')],{...options,confirmation:confirmedNew});
  assert.equal(later.ai_enrolment_status,'new');assert.equal(later.enrolled_at,company.enrolled_at);assert.equal(later.confirmation_status,'new');
  assert.throws(()=>evaluateCompanyTransactions(company,[order('1',{first_payment_at:'2026-08-01T00:00:00+08:00'})],{...options,confirmation:confirmedNew}),/confirmation_conflict/);
});
test('confirmed rates deduplicate customers and keep sample/bulk milestones separate; unknown currency and future receipts remain bounded',()=>{
  const r=evaluateCompanyTransactions(company,[order('1',{total_amount:499}),order('2',{total_amount:500}),order('3',{first_payment_at:'2026-09-11T00:00:00+08:00'})],{...options,confirmation:confirmedNew});
  const summary=conversionSummary([r]);assert.equal(summary.confirmed_new_customers,1);assert.equal(summary.confirmed_first_paid_customers,1);
  assert.equal(summary.sample_paid_customers,1);assert.equal(summary.bulk_paid_customers,1);assert.equal(summary.final_conversion_rate,1);
  assert.equal(r.linked_orders[2].receipt_verified,false);
  assert.equal(evaluateCompanyTransactions(company,[order('1',{currency:'EUR'})],options).linked_orders[0].order_kind,'unknown');
  assert.throws(()=>evaluateCompanyTransactions(company,[order('1'),order('1')],options),/duplicate_order/);
  assert.throws(()=>conversionSummary([r,r]),/duplicate_tracking_unit/);
});
test('profile reuse is idempotent; new evidence records a revision and proposed actions do not claim execution',()=>{
  const local=selectCohort({inquiries:[inquiry('1')],buyer_member_links:[link('1')]},scope),unitKey=local.units[0].unit_key;
  const analysis={schema_version:'lew.local-analysis.v1',as_of:'2026-09-04T00:00:00Z',evidence,profiles:[{...assessment(),unit_key:unitKey}],actions:[{unit_key:unitKey,next_action:'Ask for intended use',evidence_refs:['p1']}]};
  const first=updateLocal(local,analysis),again=updateLocal(first,analysis);
  assert.equal(again.units[0].profile.revision,1);assert.equal(again.units[0].profile.assessed_at,first.units[0].profile.assessed_at);
  assert.equal(again.units[0].action.executed,false);assert.deepEqual(again.units[0].action.missing,['owner','due_date']);
  const changed=structuredClone(analysis);changed.profiles[0].role='渠道商';changed.profiles[0].evidence_refs=['m1'];
  assert.equal(updateLocal(again,changed).units[0].profile.revision,2);
});
test('name/owner crosscheck requires both sourced fields to match, and duplicate confirmed company cannot inflate denominator',()=>{
  const u={...company,inquiry_refs:[{buyer_name:'Synthetic Buyer',owner:'Synthetic Seller'}]};
  const cross=order('1',{company_customer_id:null,unit_key:u.unit_key,association_status:'manual_crosscheck',review_status:'confirmed',buyer_name:'Synthetic Buyer',owner:'Wrong Seller'});
  assert.equal(evaluateCompanyTransactions(u,[cross],options).order_candidates,1);
  assert.equal(evaluateCompanyTransactions(u,[{...cross,owner:'Synthetic Seller'}],options).order_candidates,0);
  const r=evaluateCompanyTransactions(company,[order('1')],{...options,confirmation:confirmedNew});
  assert.throws(()=>conversionSummary([r,{...r,unit_key:'other-unit'}]),/duplicate_confirmed_company/);
});

function chatFixture(){
  const local=selectCohort({inquiries:[inquiry('1')],buyer_member_links:[link('1')]},scope),unit=local.units[0];
  const source={id:'chat-1',kind:'chat_message',unit_key:unit.unit_key,store_key:'demobeta',inquiry_id:'1',
    buyer_member_id:link('1').buyer_member_id,message_id:'synthetic-message',locator:'chat-message:synthetic-message',observed_at:'2026-09-02T00:00:00Z'};
  const manifest={associations:[{store_key:source.store_key,inquiry_id:source.inquiry_id,buyer_member_id:source.buyer_member_id,
    identity:{conversation_id:'synthetic-conversation'},message_indexes:[0]}]};
  const messages=[{buyer_member_id:source.buyer_member_id,conversation_id:'synthetic-conversation',message:{
    message_id:source.message_id,sent_at:'2026-09-01T00:00:00Z',content_status:'read',direction:'buyer',reply_source:'unknown'}}];
  const analysis={schema_version:'lew.local-analysis.v1',as_of:'2026-09-03T00:00:00Z',evidence:[source],profiles:[{
    unit_key:unit.unit_key,...assessment({evidence_refs:[source.id],procurement_intent:{buyer_confirmed:true,quantity_unit:'台',single_order_quantity:1000,evidence_refs:[source.id]}})}]};
  return {local,analysis,manifest,messages};
}
test('chat evidence binds exact store inquiry member conversation and message, not a valid but unrelated manifest',()=>{
  const f=chatFixture();checkLocalChatBindings(f.local,f.analysis,f.manifest,f.messages);assert.equal(f.analysis.evidence[0].direction,'buyer');
  for(const field of ['store_key','inquiry_id','buyer_member_id','unit_key','message_id','locator']){
    const broken=chatFixture();broken.analysis.evidence[0][field]='wrong';
    assert.throws(()=>checkLocalChatBindings(broken.local,broken.analysis,broken.manifest,broken.messages),/chat_evidence_/);
  }
  const unrelated=chatFixture();unrelated.manifest.associations[0].inquiry_id='other';
  assert.throws(()=>checkLocalChatBindings(unrelated.local,unrelated.analysis,unrelated.manifest,unrelated.messages),/outside_local_scope/);
});
test('hidden chat, seller intent, wrong-unit reuse and impossible observation dates are rejected',()=>{
  const hidden=chatFixture();hidden.messages[0].message.content_status='recalled_or_hidden';
  assert.throws(()=>checkLocalChatBindings(hidden.local,hidden.analysis,hidden.manifest,hidden.messages),/hidden_message/);
  const seller=chatFixture();seller.messages[0].message.direction='seller';
  assert.throws(()=>checkLocalChatBindings(seller.local,seller.analysis,seller.manifest,seller.messages),/requires_buyer_message/);
  const wrong=chatFixture();wrong.analysis.profiles[0].unit_key='other-unit';
  assert.throws(()=>checkLocalChatBindings(wrong.local,wrong.analysis,wrong.manifest,wrong.messages),/wrong_unit/);
  const future=chatFixture();future.analysis.evidence[0].observed_at='2026-09-04T00:00:00Z';
  assert.throws(()=>checkLocalChatBindings(future.local,future.analysis,future.manifest,future.messages),/invalid_chat_evidence_observation/);
});
test('private locators and research-completed claims cannot enter public profile evidence',()=>{
  assert.throws(()=>buildProfile(assessment(),[{...evidence[0],locator:'https://message.alibaba.com/message/default.htm'}]),/not_public/);
  assert.throws(()=>buildProfile(assessment(),[{...evidence[0],locator:'https://example.invalid/?token=private'}]),/not_public/);
  assert.throws(()=>buildProfile(assessment({public_research_status:'completed'}),evidence),/validation_separate/);
  assert.throws(()=>buildProfile(assessment({evidence_refs:['m1'],public_research_status:'sources_reviewed'}),evidence),/public_source_review/);
});
test('review requires a validated manifest for chat sources and binds the raw analysis to exact input bytes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-review-'));mkdirSync(join(dir,'data'));const f=chatFixture();
  const put=(name,value)=>writeFileSync(join(dir,'data',name),JSON.stringify(value));
  try{
    put('input.json',f.local);f.analysis.input_sha256=createHash('sha256').update(readFileSync(join(dir,'data/input.json'))).digest('hex');put('analysis.json',f.analysis);
    assert.throws(()=>reviewLocal({input:'data/input.json',analysis:'data/analysis.json',out:'data/review.json'},dir),/chat_manifest_required/);
    f.analysis.input_sha256='changed';put('analysis.json',f.analysis);
    assert.throws(()=>reviewLocal({input:'data/input.json',analysis:'data/analysis.json',out:'data/review.json'},dir),/analysis_input_changed/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('workbook input uses only member links whose exact inquiry exists in both authorized inputs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-prepare-'));mkdirSync(join(dir,'data'));
  const put=(name,value)=>writeFileSync(join(dir,'data',name),JSON.stringify(value));
  try{
    put('tables.json',{inquiries:[inquiry('1'),inquiry('2')]});put('scope.json',scope);
    put('members.json',{inquiries:[inquiry('1')],buyer_member_links:[link('1'),link('2')]});
    prepareLocal({source:'data/tables.json',scope:'data/scope.json',memberSource:'data/members.json',out:'data/local.json'},dir);
    const prepared=JSON.parse(readFileSync(join(dir,'data/local.json')));
    assert.equal(prepared.counts.known_member_accounts,1);assert.equal(prepared.units.length,2);assert.equal(prepared.member_source_sha256.length,64);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('confirmed member company is reused in later and closed batches; conflicting reassignment cannot inflate companies',()=>{
  const b={inquiries:[inquiry('1')],buyer_member_links:[link('1')]},merge=[{...inquiry('1'),company_customer_id:'synthetic-company',review_status:'confirmed',evidence_ref:'local:merge'}];
  const first=selectCohort(b,scope,undefined,merge);first.units[0].lifecycle='closed';
  const nextScope={...scope,batch_id:'batch-b',from_inclusive:scope.to_exclusive,to_exclusive:'2026-09-14T00:00:00+08:00'};
  const next={inquiries:[inquiry('2','2026-09-08T00:00:00+08:00')],buyer_member_links:[link('2')]};
  const rolled=selectCohort(next,nextScope,first);
  assert.equal(rolled.units.length,1);assert.equal(rolled.units[0].unit_key,'company:synthetic-company');assert.equal(rolled.units[0].original_batch,'batch-a');
  assert.throws(()=>selectCohort(next,nextScope,first,[{...merge[0],inquiry_id:'2',company_customer_id:'different-company'}]),/reconciliation/);
});
test('one receipt cannot count for two company units and conflicting or duplicate confirmations are rejected',()=>{
  const other={...company,unit_key:'company:other',company_customer_id:'other'};
  const local={schema_version:'lew.buyer-due-diligence-local.v1',units:[company,other]},analysis={schema_version:'lew.local-analysis.v1',as_of:options.as_of,orders:[order('1',{unit_key:other.unit_key})]};
  assert.throws(()=>updateLocal(local,analysis),/order_company_unit_conflict/);
  assert.throws(()=>evaluateCompanyTransactions(company,[order('1')],{...options,confirmation:confirmedNew,historical_purchase_signals:[{kind:'company_purchase_history',purchased_at:'2026-08-01T00:00:00Z',evidence_ref:'history:1'}]}),/confirmation_conflict/);
  analysis.orders=[];analysis.confirmations=[{...confirmedNew,unit_key:company.unit_key},{...confirmedNew,value:'old',unit_key:company.unit_key}];
  assert.throws(()=>updateLocal(local,analysis),/duplicate_or_unknown_unit_review/);
});
test('payment pending cannot be zero conversion; explicit dated no-receipt review is required and cannot erase candidates',()=>{
  const pending=evaluateCompanyTransactions(company,[order('1',{payment_status:'unverified'})],{...options,confirmation:confirmedNew});
  assert.equal(conversionSummary([pending]).final_conversion_rate,null);assert.equal(pending.payment_review_status,'pending');
  const payment_review={status:'complete',as_of:options.as_of,evidence_ref:'manual:complete-payment-review'};
  assert.throws(()=>evaluateCompanyTransactions(company,[order('1',{payment_status:'unverified'})],{...options,confirmation:confirmedNew,payment_review}),/invalid_payment_review/);
  const verifiedNone=evaluateCompanyTransactions(company,[],{...options,confirmation:confirmedNew,payment_review});
  assert.equal(conversionSummary([verifiedNone]).final_conversion_rate,0);
  const conflicted=evaluateCompanyTransactions(company,[order('1')],{...options,confirmation:confirmedNew,conflicts:[{kind:'company_association_conflict'}]});
  assert.equal(conversionSummary([conflicted]).confirmed_new_customers,0);assert.equal(conversionSummary([conflicted]).confirmed_first_paid_customers,0);
});
test('rolling incremental review preserves dated receipt and confirmation instead of clearing prior milestones',()=>{
  const source={inquiries:[inquiry('1')],buyer_member_links:[link('1')]},merge=[{...inquiry('1'),company_customer_id:company.company_customer_id,review_status:'confirmed',evidence_ref:'merge:1'}];
  const prepared=selectCohort(source,scope,undefined,merge),first=updateLocal(prepared,{schema_version:'lew.local-analysis.v1',as_of:options.as_of,orders:[order('1')],confirmations:[{...confirmedNew,unit_key:company.unit_key}]});
  const nextScope={...scope,batch_id:'batch-b',from_inclusive:scope.to_exclusive,to_exclusive:'2026-09-14T00:00:00+08:00'};
  const next=selectCohort({inquiries:[]},nextScope,first),review=updateLocal(next,{schema_version:'lew.local-analysis.v1',as_of:'2026-09-11T00:00:00+08:00'});
  assert.equal(review.transactions[0].first_known_payment_after_enrolment.order_id,'1');assert.equal(review.transactions[0].confirmation_status,'new');
  assert.equal(review.units[0].original_batch,'batch-a');assert.equal(review.batch_summaries[0].final_conversion_rate,1);
});
test('unknown enrolment may be filled from sourced creation time; quantity revision retains complete dated previous profile',()=>{
  const first=selectCohort({inquiries:[inquiry('1',null)]},scope),filled=selectCohort({inquiries:[inquiry('1')]},scope,first);
  assert.equal(filled.units[0].enrolled_at,inquiry('1').created_at);assert.equal(filled.units[0].inquiry_refs[0].created_at,inquiry('1').created_at);
  const large=buildProfile(assessment({procurement_intent:{buyer_confirmed:true,quantity_unit:'台',single_order_quantity:1000,evidence_refs:['m1']}}),evidence);
  const small=buildProfile(assessment({procurement_intent:{buyer_confirmed:true,quantity_unit:'台',single_order_quantity:10,evidence_refs:['m1']}}),evidence,large);
  assert.equal(small.history[0].procurement_intent.single_order_quantity,1000);assert.equal(small.history[0].large_volume_intent,'supported');
  assert.deepEqual(small.history[0].source_observed_at,large.source_observed_at);
});
test('prior receipt cannot move to another company or be erased by an incomplete next snapshot',()=>{
  const other={...company,unit_key:'company:other',company_customer_id:'other'},local={schema_version:LOCAL_VERSION,units:[company,other]};
  const first=updateLocal(local,{schema_version:'lew.local-analysis.v1',as_of:options.as_of,orders:[order('1')],confirmations:[{...confirmedNew,unit_key:company.unit_key},{...confirmedNew,unit_key:other.unit_key}]});
  assert.throws(()=>updateLocal(first,{schema_version:'lew.local-analysis.v1',as_of:options.as_of,orders:[order('1',{company_customer_id:other.company_customer_id,unit_key:other.unit_key})]}),/prior_order_association_reconciliation/);
  const partial=order('1',{payment_status:'unverified',payment_evidence:null,first_payment_at:null,first_payment_amount:null,total_amount:null,association_status:'candidate'});
  const again=updateLocal(first,{schema_version:'lew.local-analysis.v1',as_of:options.as_of,orders:[partial]});
  assert.equal(again.transactions[0].first_known_payment_after_enrolment.order_id,'1');assert.equal(again.transactions[0].bulk_payment.order_id,'1');
  assert.throws(()=>updateLocal(first,{schema_version:'lew.local-analysis.v1',as_of:options.as_of,orders:[order('1',{first_payment_amount:200})]}),/verified_payment_correction/);
});
test('draft and empty review retain uncertainty and imported order candidates without pretending to perform research',()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-draft-'));mkdirSync(join(dir,'data'));
  try{
    const local=selectCohort({inquiries:[inquiry('1')],orders:[{order_id:'candidate-only',payment_status:'unverified'}]},scope);
    writeFileSync(join(dir,'data/input.json'),JSON.stringify(local));
    const args={input:'data/input.json',out:'data/analysis.json',asOf:options.as_of};
    assert.equal(createAnalysisDraft(args,dir).pending_profile_count,1);assert.equal(createAnalysisDraft(args,dir).public_research_completed,false);
    const review=reviewLocal({input:'data/input.json',analysis:'data/analysis.json',out:'data/review.json'},dir);
    assert.equal(review.public_research_completed,false);
    const saved=JSON.parse(readFileSync(join(dir,'data/review.json')));
    assert.equal(saved.units[0].profile.schema_version,'lew.buyer-profile.v2');
    assert.equal(saved.units[0].profile.business_model.status,'unassessed');assert.equal(saved.units[0].profile.purchase_purpose.status,'unassessed');
    assert.ok(!Object.hasOwn(saved.units[0].profile,'role'));assert.equal(saved.profile_axes_summary.unassessed,1);
    assert.equal(saved.source_order_candidates.length,1);assert.equal(saved.batch_summaries[0].final_conversion_rate,null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
