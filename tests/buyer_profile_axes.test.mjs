import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_AXES_VERSION,emptyAxesAssessment,buildAxesProfile,axisSummary,profileAxisColumns,sameAxisChanges} from '../scripts/buyer_profile_axes.mjs';
import {buildProfile,updateLocal,LOCAL_VERSION,checkLocalChatBindings} from '../scripts/buyer_due_diligence_local.mjs';
const unit='account:synthetic',at='2026-01-03T00:00:00Z';
const source=(id,extra={})=>({id,unit_key:unit,kind:'buyer_profile',locator:`synthetic:${id}`,observed_at:'2026-01-02T00:00:00Z',raw_value:'Synthetic wholesaler',...extra});
const claim=(label,id,extra={})=>({label,disposition:'supported',confidence:'medium',inferred:false,reason:'Reviewed synthetic statement',uncertainty:'Not independently verified',evidence_refs:[id],...extra});
function fixture(){
  const a=emptyAxesAssessment(unit,at);
  for(const k of ['business_model','purchase_purpose'])Object.assign(a[k],{review_state:'reviewed',summary:'No applicable statement',uncertainty:'Context incomplete'});
  a.entity_assessment.status='unconfirmed';a.entity_assessment.strength='low';
  return a;
}
test('platform-reported manufacturing and wholesale coexist without a purpose or matched entity',()=>{
  const a=fixture();a.business_model.claims=[claim('Manufacturer / Factory','p'),claim('Wholesaler','p',{disposition:'candidate',confidence:'low'})];
  const p=buildProfile(a,[source('p')]);
  assert.equal(p.schema_version,PROFILE_AXES_VERSION);assert.equal(p.business_model.status,'initial');
  assert.deepEqual(p.business_model.claims.map(c=>c.label),['Manufacturer / Factory','Wholesaler']);
  assert.deepEqual(p.business_model.source_natures,['platform_self_report']);
  assert.equal(p.purchase_purpose.status,'insufficient');assert.equal(p.entity_assessment.status,'unconfirmed');
  assert.ok(!Object.hasOwn(p,'role'));assert.equal(p.large_volume_intent,'unconfirmed');
});
test('a direct buyer purpose survives unknown business and entity without double public sources',()=>{
  const a=fixture();a.purchase_purpose.claims=[claim('商业自用','m',{confidence:'high'})];
  const p=buildAxesProfile(a,[source('m',{kind:'chat_message',direction:'buyer',scope:'current_purchase',content_status:'readable'})]);
  assert.equal(p.purchase_purpose.status,'initial');assert.equal(p.purchase_purpose.confidence,'high');
  assert.equal(p.business_model.status,'insufficient');assert.equal(p.formal_complete,false);
});
test('general resale self-report cannot silently establish this purchase purpose',()=>{
  const a=fixture();a.purchase_purpose.claims=[claim('转售','p')];
  assert.throws(()=>buildAxesProfile(a,[source('p',{scope:'general_business'})]),/current_purchase_evidence/);
});
test('seller, AI, system, hidden and empty statements cannot establish either axis',()=>{
  for(const axis of ['business_model','purchase_purpose'])for(const extra of [
    {direction:'seller'},{direction:'unknown'},{reply_source:'ai'},{reply_source:'system'},
    {automatic:true},{content_status:'recalled_or_hidden'},{state:'missing'},{raw_value:null},{raw_value:''},{raw_value:[]},{raw_value:{}},
  ]){
    const a=fixture();a[axis].claims=[claim(axis==='business_model'?'Hotel operator':'商业自用','m')];
    assert.throws(()=>buildAxesProfile(a,[source('m',{kind:'chat_message',direction:'buyer',scope:'current_purchase',...extra})]));
  }
});
test('reviewed saved DOM statements retain their manual provenance and buyer-direction boundary',()=>{
  const a=fixture();a.purchase_purpose.claims=[claim('客户项目采购','m')];
  const e=source('m',{kind:'manual_record',record_kind:'saved_buyer_statement',direction:'buyer',scope:'current_purchase',locator:'saved-observation:synthetic'});
  assert.deepEqual(buildAxesProfile(a,[e]).purchase_purpose.source_natures,['buyer_statement']);
  assert.throws(()=>buildAxesProfile(a,[{...e,direction:'seller'}]),/requires_buyer/);
});
test('positive and negative evidence stays visible as conflict rather than a forced single label',()=>{
  const a=fixture();a.purchase_purpose.claims=[claim('转售','a'),claim('转售','b',{disposition:'denied'})];
  const p=buildAxesProfile(a,[source('a',{scope:'current_purchase'}),source('b',{scope:'current_purchase'})]);
  assert.equal(p.purchase_purpose.status,'conflicted');assert.equal(p.purchase_purpose.claims.length,2);
  assert.equal(axisSummary([p]).purchase_purpose_initial,0);assert.equal(axisSummary([p]).purchase_conflicted,1);
  assert.match(profileAxisColumns(p).purchase_purpose,/否定/);
});
test('source attribution and private URL protections stay separate from initial confidence',()=>{
  const a=fixture();a.business_model.claims=[claim('Retail','p')];
  const e=source('p',{kind:'public_source',locator:'https://example.invalid/company',attribution:'account_business'});
  assert.equal(buildAxesProfile(a,[e]).business_model.status,'initial');
  for(const extra of [{attribution:'namesake'},{locator:'https://profile.alibaba.com/private'},{locator:'https://example.invalid/?token=synthetic'}])
    assert.throws(()=>buildAxesProfile(a,[{...e,...extra}]));
  assert.throws(()=>buildAxesProfile({...a,formal_complete:true},[e]),/formal_completion/);
});
test('empty, unassessed and legacy samples have distinct summary states; no fabricated ratios',()=>{
  const empty=axisSummary([]);assert.equal(empty.total,0);assert.equal(empty.business_model_initial,0);
  const insufficient=buildAxesProfile(fixture());const unassessed=buildAxesProfile(emptyAxesAssessment(unit,at));
  const summary=axisSummary([insufficient,unassessed,{role:'渠道商'},null]);
  assert.equal(summary.both_insufficient,1);assert.equal(summary.unassessed,1);assert.equal(summary.legacy_or_missing,2);
  const invalid=fixture();invalid.business_model=null;assert.throws(()=>buildAxesProfile(invalid),/invalid_axis/);
});
test('insufficient judgments cite reviewed empty fields without promoting them to positive evidence',()=>{
  const a=fixture();a.business_model.reviewed_evidence_refs=['empty'];
  const p=buildAxesProfile(a,[source('empty',{raw_value:null,state:'missing'})]);
  assert.equal(p.business_model.status,'insufficient');assert.deepEqual(p.business_model.evidence_refs,['empty']);
  assert.match(profileAxisColumns(p).business_model_basis,/empty/);
  assert.throws(()=>buildAxesProfile(a,[source('empty',{unit_key:'other'})]),/unit_mismatch/);
});
test('duplicate references, duplicate labels, cross-unit and future sources fail without mutating inputs',()=>{
  const a=fixture();a.business_model.claims=[claim('Retail','p')];const e=source('p'),before=structuredClone(a);
  for(const evidence of [[e,e],[{...e,unit_key:'account:other'}],[{...e,observed_at:'2026-02-01T00:00:00Z'}]])assert.throws(()=>buildAxesProfile(a,evidence));
  assert.deepEqual(a,before);
  a.business_model.claims.push(structuredClone(a.business_model.claims[0]));assert.throws(()=>buildAxesProfile(a,[e]),/duplicate_axis_claim/);
  a.business_model.claims.pop();a.business_model.claims[0].evidence_refs.push('p');assert.throws(()=>buildAxesProfile(a,[e]),/invalid_axis_evidence_refs/);
});
test('new axes retain legacy history but never infer either axis from the old mixed role',()=>{
  const old={role:'品牌方',confidence:'high',revision:2,assessed_at:'2026-01-01T00:00:00Z'};
  const p=buildAxesProfile(fixture(),[],old);assert.equal(p.history[0].role,'品牌方');assert.equal(p.revision,3);
  assert.equal(sameAxisChanges(old,p).business_model.status,'not_comparable');
  assert.equal(sameAxisChanges(p,p).purchase_purpose.status,'unchanged');
  assert.throws(()=>buildAxesProfile({...fixture(),role:'品牌方'}),/mixed_role/);
});
test('rolling update fingerprints all nested evidence and rejects duplicate units',()=>{
  const a=fixture();a.business_model.claims=[claim('Wholesale','p')];
  const local={schema_version:LOCAL_VERSION,units:[{unit_key:unit,original_batch:'synthetic',enrolled_at:null,company_identity_status:'unconfirmed',inquiry_refs:[]}]};
  const analysis={schema_version:'lew.local-analysis.v2',as_of:at,evidence:[source('p')],profiles:[a]};
  const first=updateLocal(local,analysis),same=updateLocal(first,analysis);assert.equal(same.units[0].profile.revision,1);
  analysis.evidence[0].raw_value='Updated synthetic statement';const changed=updateLocal(first,analysis);
  assert.equal(changed.units[0].profile.revision,2);assert.equal(changed.profile_axes_summary.business_model_initial,1);
  assert.throws(()=>updateLocal({...local,units:[...local.units,...local.units]},analysis),/duplicate_tracking/);
});
test('chat manifest direction overrides supplied direction and duplicate bindings are rejected',()=>{
  const ref={store_key:'demobeta',inquiry_id:'synthetic-inquiry',buyer_member_id:'synthetic-member'};
  const local={units:[{unit_key:unit,inquiry_refs:[ref]}]};
  const manifest={associations:[{...ref,identity:{conversation_id:'synthetic-conversation'},message_indexes:[0]}]};
  const messages=[{...ref,conversation_id:'synthetic-conversation',message:{message_id:'m',direction:'seller',reply_source:'unknown',sent_at:'2026-01-01T00:00:00Z',content_status:'readable'}}];
  const a=fixture();a.purchase_purpose.claims=[claim('商业自用','m')];
  const analysis={as_of:at,profiles:[a],evidence:[source('m',{...ref,kind:'chat_message',direction:'buyer',scope:'current_purchase',message_id:'m',locator:'chat-message:m'})]};
  checkLocalChatBindings(local,analysis,manifest,messages);assert.equal(analysis.evidence[0].direction,'seller');
  assert.throws(()=>buildAxesProfile(a,analysis.evidence),/requires_buyer/);
  assert.throws(()=>checkLocalChatBindings(local,analysis,{associations:[...manifest.associations,...manifest.associations]},messages),/duplicate_chat_association/);
});
