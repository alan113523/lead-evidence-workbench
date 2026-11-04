import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAxesAssessment, buildAxesProfile, AXIS_FIELDS, profileAxisColumns} from '../scripts/buyer_profile_axes.mjs';
import {buildTrackingPatch} from '../scripts/tracking_review_patch.mjs';
import {LOCAL_VERSION} from '../scripts/buyer_due_diligence_local.mjs';

const at='2026-10-08T00:00:00Z', hash='a'.repeat(64);
function fixture({mixed=false, unbound=false}={}) {
  const inquiry_refs=['101','102'].map(inquiry_id=>({store_key:'demobeta',inquiry_id}));
  const a=emptyAxesAssessment('unit',at), evidence=[{id:'company',kind:'buyer_profile',unit_key:'unit',locator:'synthetic:company',observed_at:at,raw_value:'Manufacturer'}];
  a.business_model={review_state:'reviewed',claims:[{label:'平台自报制造商',disposition:'supported',confidence:'medium',inferred:false,reason:'Profile self-report',uncertainty:'Unverified',evidence_refs:['company']}],conflicts:[],summary:'Manufacturer',uncertainty:'Unverified',question:null};
  a.purchase_purpose={review_state:'reviewed',claims:[],conflicts:[],summary:'Buyer statement',uncertainty:'Current purchase only',question:null};
  for(const ref of inquiry_refs.slice(0,mixed?2:1)) {
    const id='m'+ref.inquiry_id;
    evidence.push({id,kind:'chat_message',unit_key:'unit',...(unbound?{}:ref),locator:'chat-message:'+id,observed_at:at,scope:'current_purchase',direction:'buyer',quote:'For our own office',chat_bound:true});
    // A single label supported by two inquiries must also remain scoped, not broadcast.
    if(a.purchase_purpose.claims.length)a.purchase_purpose.claims[0].evidence_refs.push(id);
    else a.purchase_purpose.claims.push({label:'商业自用',disposition:'supported',confidence:'medium',inferred:false,reason:'For their office',uncertainty:'Buyer statement',evidence_refs:[id]});
  }
  a.purchase_purpose.inquiry_scope={store_key:'demobeta',inquiry_id:'102'}; // A caller cannot select the destination.
  const profile=buildAxesProfile(a,evidence), unit={unit_key:'unit',profile,inquiry_refs};
  const tables={schema_version:'lew.tracking-tables.v1',workbook_sha256:hash,inquiries:inquiry_refs.map((ref,i)=>({...ref,source_sheet:'商机录入',source_row:i+6,
    field_provenance:Object.fromEntries(Object.entries(AXIS_FIELDS).map(([field,header],c)=>[field,{sheet:'商机录入',cell:String.fromCharCode(65+c)+(i+6),header,value:null,formula:null,status:'workbook_value'}]))}))};
  return {a,evidence,profile,tables,review:{schema_version:LOCAL_VERSION,units:[unit]}};
}
test('purchase purpose follows its cited inquiry while business facts can serve both inquiries',()=>{
  const f=fixture(), result=buildTrackingPatch(f.tables,f.review,hash);
  assert.deepEqual(f.profile.purchase_purpose.inquiry_scope,{store_key:'demobeta',inquiry_id:'101'});
  assert.equal(result.patch.changes.filter(c=>/^[DEF]/.test(c.cell)).length,3);
  assert.ok(result.patch.changes.filter(c=>/^[DEF]/.test(c.cell)).every(c=>c.cell.endsWith('6')));
  assert.equal(result.patch.changes.filter(c=>/^[ABC]/.test(c.cell)).length,6);
  assert.equal(result.purchase_purpose_scope_gap_count,1);
});
test('mixed, missing and legacy purpose scopes stay in sidecars instead of filling unrelated cells',()=>{
  for(const options of [{mixed:true},{unbound:true},{}]) {
    const f=fixture(options);if(!options.mixed&&!options.unbound)delete f.profile.purchase_purpose.inquiry_scope;
    const result=buildTrackingPatch(f.tables,f.review,hash);
    assert.equal(result.patch.changes.filter(c=>/^[DEF]/.test(c.cell)).length,0);
    assert.equal(result.purchase_purpose_scope_gap_count,2);
  }
});
test('conflict-only findings keep evidence references in their displayed uncertainty',()=>{
  const f=fixture();f.a.purchase_purpose.claims=[];
  f.a.purchase_purpose.conflicts=[{reason:'Unresolved intended use',evidence_refs:['m101']}];
  const value=profileAxisColumns(buildAxesProfile(f.a,f.evidence));
  assert.match(value.purchase_purpose_uncertainty,/m101/);
});
