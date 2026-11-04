import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrackingPatch,prepareTrackingPatch} from '../scripts/tracking_review_patch.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {LOCAL_VERSION} from '../scripts/buyer_due_diligence_local.mjs';
import {OPPORTUNITY_VERSION,DEPTH_FIELDS} from '../scripts/deep_communication.mjs';

const h='a'.repeat(64);
function fixture(existing,status='Y') {
  const ref={store_key:'demobeta',inquiry_id:'synthetic-inquiry'};
  const depth={status,stage:status==='未核实'?'未核实':'方案实谈',reason:'Buyer negotiated the specific quote',evidence_refs:['e']};
  if(status==='未核实'){depth.reason='Review incomplete';depth.gap='Missing preceding pages';depth.evidence_refs=[];}
  const row={...ref,source_sheet:'商机录入',source_row:6,field_provenance:{}};
  Object.entries(DEPTH_FIELDS).forEach(([field,header],i)=>{
    row.field_provenance[field]={sheet:'商机录入',cell:String.fromCharCode(65+i)+'6',header,
      value:existing[i]??null,formula:null,status:'workbook_value'};
  });
  const opportunity={schema_version:OPPORTUNITY_VERSION,unit_key:'unit',...ref,review_state:'reviewed',
    product:'Synthetic model',quality:'中',summary:'Synthetic reviewed context',next_action:'Confirm quotation',
    evidence_refs:['e'],deep_communication:depth};
  return {row,tables:{schema_version:'lew.tracking-tables.v1',workbook_sha256:h,inquiries:[row]},
    review:{schema_version:LOCAL_VERSION,units:[{unit_key:'unit',inquiry_refs:[{...ref,opportunity_review:opportunity}]}]}};
}

test('protected N with blank stage and basis cannot receive parts of a new Y judgment',()=>{
  const f=fixture(['N',null,null]);
  const result=buildTrackingPatch(f.tables,f.review,h,{fillMissingOnly:true});
  assert.deepEqual(result.patch.changes,[]);
  assert.equal(result.preserved_nonempty_cell_count,1);
  assert.equal(result.depth_group_conflict_count,1);
  assert.deepEqual(result.depth_group_conflicts[0].protected_fields,[{field:'deep_communication',cell:'A6'}]);
});

test('protected Y with blank stage and basis cannot receive parts of an unknown judgment',()=>{
  const f=fixture(['Y',null,null],'未核实');
  const result=buildTrackingPatch(f.tables,f.review,h);
  assert.deepEqual(result.patch.changes,[]);
  assert.equal(result.depth_group_conflict_count,1);
});

test('blank status cannot pair a new assessment with a protected conflicting stage or basis',()=>{
  for(const [existing,status,options] of [
    [[null,'需求澄清',null],'Y',{fillMissingOnly:true}],
    [[null,null,'Original independently reviewed basis'],'Y',{fillMissingOnly:true}],
    [[null,'方案实谈',null],'未核实',{}],
    [[null,null,'Original independently reviewed basis'],'未核实',{}]
  ]){
    const f=fixture(existing,status),before=structuredClone(f.tables);
    const result=buildTrackingPatch(f.tables,f.review,h,options);
    assert.deepEqual(result.patch.changes,[]);assert.equal(result.depth_group_conflict_count,1);
    assert.deepEqual(f.tables,before);
  }
});

test('consistent existing parts allow blank parts to be filled without changing the template',()=>{
  const f=fixture(['Y',null,null]);
  const result=buildTrackingPatch(f.tables,f.review,h,{fillMissingOnly:true});
  assert.deepEqual(result.patch.changes.map(c=>c.cell),['B6','C6']);
  assert.equal(result.depth_group_conflict_count,0);
  delete f.row.field_provenance.deep_communication_basis;
  const missing=buildTrackingPatch(f.tables,f.review,h,{fillMissingOnly:true});
  assert.deepEqual(missing.patch.changes.map(c=>c.cell),['B6']);
  assert.equal(Object.keys(f.row.field_provenance).length,2);
  assert.equal(missing.missing_field_count,result.missing_field_count+1);
});

test('all-blank groups accept Y or unknown as one assessment and remain idempotent',()=>{
  for(const status of ['Y','未核实']){
    const f=fixture([null,null,null],status);
    const result=buildTrackingPatch(f.tables,f.review,h,{fillMissingOnly:true});
    assert.equal(result.changed_cell_count,3);assert.equal(result.depth_group_conflict_count,0);
    for(const change of result.patch.changes)Object.values(f.row.field_provenance).find(p=>p.cell===change.cell).value=change.value;
    const repeated=buildTrackingPatch(f.tables,f.review,h,{fillMissingOnly:true});
    assert.equal(repeated.changed_cell_count,0);assert.equal(repeated.depth_group_conflict_count,0);
  }
});

test('authorized overwrite replaces all available parts with exact original-value expectations',()=>{
  const f=fixture(['N','需求澄清','Original N basis']);
  const result=buildTrackingPatch(f.tables,f.review,h);
  assert.deepEqual(result.patch.changes.map(c=>c.expected),['N','需求澄清','Original N basis']);
  assert.deepEqual(result.patch.changes.map(c=>c.value),['Y','方案实谈','Buyer negotiated the specific quote〔e〕']);
  assert.equal(result.depth_group_conflict_count,0);
});

test('group protection still rejects unsafe original coordinates or formulas',()=>{
  const f=fixture(['N',null,null]);f.row.field_provenance.deep_communication_stage.formula='=A1';
  assert.throws(()=>buildTrackingPatch(f.tables,f.review,h,{fillMissingOnly:true}),/unsafe_field_provenance/);
});

test('file entry reports group conflict even when no patch file is created',t=>{
  const root=mkdtempSync(join(tmpdir(),'okki-depth-group-'));
  t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^okki-depth-group-/);rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'data'));
  const f=fixture(['N',null,null]);
  writeFileSync(join(root,'data/tables.json'),JSON.stringify(f.tables));
  f.review.source_sha256=createHash('sha256').update(readFileSync(join(root,'data/tables.json'))).digest('hex');
  f.review.analysis_source_sha256=h;
  writeFileSync(join(root,'data/review.json'),JSON.stringify(f.review));
  const result=prepareTrackingPatch({tables:'data/tables.json',review:'data/review.json',out:'data/patch.json',fillMissingOnly:true},root);
  assert.equal(result.status,'no_changes');assert.equal(result.depth_group_conflict_count,1);
  assert.equal(result.preserved_nonempty_cell_count,1);assert.equal(result.depth_group_conflicts[0].reason,'protected_depth_group_conflict');
  assert.equal(existsSync(join(root,'data/patch.json')),false);
});
