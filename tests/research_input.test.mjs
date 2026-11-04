import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareLocal} from '../scripts/buyer_due_diligence_local.mjs';

const helper=fileURLToPath(new URL('../scripts/build_research_input.py',import.meta.url));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'research-input-'));mkdirSync(join(root,'data'));
 const put=(name,body)=>{const path=join(root,'data',name);writeFileSync(path,JSON.stringify(body));return {path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};};
 const population=put('source.json',{inquiries:[{store_key:'demobeta',inquiry_id:'101',buyer_name:'Synthetic Buyer',email:'synthetic@example.com',
  created_at:'2026-10-01T00:00:00+08:00'}],buyer_member_links:[{store_key:'demobeta',inquiry_id:'101',buyer_member_id:'alibaba-visible-member:synthetic001',source_system:'alibaba-message-querySummary-contact-loginId-v1'}]});
 put('scope.json',{stores:['demobeta'],from_inclusive:'2026-10-01T00:00:00+08:00',to_exclusive:'2026-10-02T00:00:00+08:00',time_zone:'Asia/Shanghai',batch_id:'synthetic-input'});
 const spec=put('spec.json',{schema_version:'lew.research-input-source-spec.v1',population,sources:[]});
 const clues=join(root,'data','research.json');
 const result=spawnSync(process.env.PYTHON_EXECUTABLE||'python',['-B',helper,'--spec',spec.path,'--out',clues],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
 return {root,clues,args:{source:'data/source.json',scope:'data/scope.json',researchInput:'data/research.json',out:'data/local.json',historyDb:'data/absent.sqlite'}};
}

test('daily prepare consumes pinned per-inquiry clues and leaves research unperformed',()=>{
 const f=fixture();
 try{
  prepareLocal(f.args,f.root);
  const local=JSON.parse(readFileSync(join(f.root,'data/local.json')));
  const inquiry=local.units[0].inquiry_refs[0];
  assert.equal(inquiry.research_clues.fields.email.items[0].value,'synthetic@example.com');
  assert.equal(inquiry.research_clues.fields.whatsapp.status,'not_collected');
  assert.equal(inquiry.research_clues.contact_status,'not_contacted');
  assert.match(local.research_input_status,/public_research_not_performed/);
  assert.ok(!existsSync(join(f.root,'data/absent.sqlite')));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('daily prepare rejects modified value or pointer even when pinned source SHA is retained',()=>{
 const f=fixture();
 try{
  const original=JSON.parse(readFileSync(f.clues));
  for(const field of ['value','pointer']){
   const body=structuredClone(original),item=body.records[0].clues.fields.email.items[0];
   if(field==='value')item.value='forged@example.com';else item.source.pointer='/inquiries/0/buyer_name';
   writeFileSync(f.clues,JSON.stringify(body));
   assert.throws(()=>prepareLocal(f.args,f.root),/research_input_source_projection_failed/);
   assert.ok(!existsSync(join(f.root,'data/local.json')));
  }
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('daily prepare cannot overwrite the newly supplied research input',()=>{
 const f=fixture();
 try{
  const original=readFileSync(f.clues);
  assert.throws(()=>prepareLocal({...f.args,out:f.args.researchInput},f.root),/research_input_overwrite_forbidden/);
  assert.deepEqual(readFileSync(f.clues),original);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
