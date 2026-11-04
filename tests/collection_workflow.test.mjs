import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareWindow,nextWindow,acceptWindow,inspectWindow} from '../scripts/chat_window.mjs';
import {createWindowRunner} from '../scripts/chat_window_runner.mjs';
import {publishHandoff,mergeHandoffs} from '../scripts/collection_handoff.mjs';
import legacy from '../scripts/alibaba_chat_collector.js';
import {browserFixture,browserBinding,storeProof} from './store_binding_fixture.mjs';

const from=Date.parse('2026-10-01T00:00:00+08:00'),to=from+7*86400000;
const iso=n=>new Date(n).toISOString(),who={conversation_id:'conv001',buyer_account_id:'buyer001',owner_account_id:'seller001'};
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const write=(root,path,data)=>writeFileSync(join(root,path),JSON.stringify(data));
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'okki-workflow-test-'));
  t.after(()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^okki-workflow-test-/);rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'data'));mkdirSync(join(root,'scripts'));browserFixture(root);
  for(const name of ['alibaba_chat_collector.js','alibaba_chat_window.js','chat_window.mjs'])copyFileSync(resolve('scripts',name),join(root,'scripts',name));
  write(root,'data/source.json',{store_key:'demobeta',inquiries:[{store_key:'demobeta',inquiry_id:'101',created_at:iso(from+1000)}],
    buyer_member_links:[{store_key:'demobeta',inquiry_id:'101',buyer_member_id:'alibaba-visible-member:buyer001',source_system:'alibaba-message-querySummary-contact-loginId-v1'}]});
  prepareWindow({source:'data/source.json',store:'demobeta',browserMap:'data/browser-map.json',run:'data/run',from:iso(from),to:iso(to),asOf:iso(to+3600000),pageSize:2},root);
  return root;
}
function receipt(root,{rows=[],more=false,error=null}={}) {
  const ticket=json(join(root,'data/run/pending.json'));
  const proof=storeProof('demobeta',ticket.request_id);
  return {kind:ticket.task.kind,request_id:ticket.request_id,observed_at_ms:Date.now(),store_proof:proof,
    identity:who,session_member_id:'session001',rows,has_more:more,error};
}
function message(id,at=to-1000) {return legacy.normalizeMessage({messageId:id,sendTime:at,owner:{accountId:who.owner_account_id},
  contact:{accountId:who.buyer_account_id},type:1,subType:1,messageType:'rec',content:'Synthetic private message'},who);}
function connections(root,override={}) {
  const calls=[];let pages=0;
  return {calls,options:{run:'data/run',threadId:'thread-original',browserBinding:browserBinding('demobeta'),homePageId:'page1',messagePageId:'page2',
    homeCdp:{async send(method,p){calls.push('identity');assert.equal(method,'Runtime.evaluate');assert.equal(p.awaitPromise,true);assert.equal(p.returnByValue,true);
      const proof=storeProof('demobeta',json(join(root,'data/run/pending.json')).request_id);return {result:{value:override.proof?override.proof(proof):proof}};}},
    messageCdp:{async send(method,p){calls.push('message');assert.equal(method,'Runtime.evaluate');assert.ok(p.expression.includes(json(join(root,'data/run/pending.json')).request_id));
      if(override.throw)throw Error('transport_error');
      const page=json(join(root,'data/run/pending.json')).task.kind==='page';
      return {result:{value:receipt(root,{rows:page?(++pages===1?[message('1'),message('2',to-2000)]:[]):[],more:page&&pages===1})}};}}
  }};
}
function finish(root,old=false) {
  nextWindow('data/run',root);acceptWindow('data/run',receipt(root),root);
  nextWindow('data/run',root);acceptWindow('data/run',receipt(root,{rows:[message('1',old?from-1000:to-1000)]}),root);
}
function deliverySpec(root,overrides={}) {
  const spec={store_key:'demobeta',owner_thread_id:'thread-original',stage:'chat_ready',scope:{from:iso(from),to_exclusive:iso(to)},
    population_source:'data/source.json',chat_runs:['data/run'],reused_manifests:[],attachments:[],gaps:[],...overrides};
  write(root,'data/delivery-spec.json',spec);return spec;
}
function mergeSpec(root,result,overrides={}) {
  write(root,'data/merge-spec.json',{required_stores:['demobeta'],handoffs:[{path:result.path,sha256:result.sha256}],...overrides});
}

test('runner executes three serial verified steps with bodies absent from returned/logged summaries',async t=>{
  const root=fixture(t),{calls,options}=connections(root),runner=createWindowRunner(options,root);
  const result=await runner.batch();assert.equal(result.steps_completed,3);assert.equal(result.pages_read,2);
  assert.deepEqual(calls,['identity','message','identity','message','identity','message']);
  assert.ok(result.timing.elapsed_ms>=result.timing.identity_ms);
  const log=readFileSync(join(root,'data/run/runner-batches.jsonl'),'utf8');assert.doesNotMatch(log,/Synthetic|buyer001|source_content|store_proof|expression/);
  assert.doesNotMatch(JSON.stringify(result),/Synthetic/);assert.equal(inspectWindow('data/run',root).messages.size,2);
  await assert.rejects(()=>runner.batch({steps:6}),/batch_limit/);
  assert.equal(calls.length,6);
});

test('wrong owner/page/route is rejected before CDP, and owner remains stable on reconnect',t=>{
  const root=fixture(t),{calls,options}=connections(root);createWindowRunner(options,root);createWindowRunner(options,root);
  assert.throws(()=>createWindowRunner({...options,threadId:'thread-parent'},root),/owner_or_pages_changed/);
  assert.throws(()=>createWindowRunner({...options,messagePageId:'page3'},root),/owner_or_pages_changed/);
  assert.throws(()=>createWindowRunner({...options,browserBinding:browserBinding('demogamma')},root),/browser_binding_mismatch/);
  assert.deepEqual(calls,[]);
});

test('identity failure cannot reach message page; transport failure keeps pending without duplicate requests',async t=>{
  for(const override of [{proof:p=>({...p,store_key:'demogamma'})},{throw:true}]) {
    const root=fixture(t),{calls,options}=connections(root,override),runner=createWindowRunner(options,root);
    await assert.rejects(()=>runner.batch(),/store_identity_mismatch|transport_error/);
    assert.ok(existsSync(join(root,'data/run/pending.json')));const count=calls.length;
    await assert.rejects(()=>runner.batch(),/pending_requires_review/);assert.equal(calls.length,count);
    if(override.proof)assert.deepEqual(calls,['identity']);
  }
});

test('cancelled and overlapping batches cannot initiate another request',async t=>{
  const root=fixture(t),{calls,options}=connections(root),runner=createWindowRunner(options,root);
  const controller=new AbortController();controller.abort();
  const cancelled=await runner.batch({signal:controller.signal});assert.equal(cancelled.cancelled,true);assert.deepEqual(calls,[]);
  const active=runner.batch({steps:1});await assert.rejects(()=>runner.batch(),/already_running/);await active;assert.equal(calls.length,2);
});

test('handoff and parent merge are idempotent, preserve old-contact exclusion and never alter source ledgers',t=>{
  const root=fixture(t);finish(root,true);deliverySpec(root);
  const before=hash(join(root,'data/run/checkpoint.json')),result=publishHandoff({spec:'data/delivery-spec.json',out:'data/chat-ready.json'},root);
  assert.equal(result.inquiries,1);assert.equal(result.excluded,1);assert.deepEqual(publishHandoff({spec:'data/delivery-spec.json',out:'data/chat-ready.json'},root),result);
  assert.equal(hash(join(root,'data/run/checkpoint.json')),before);
  mergeSpec(root,result);const merged=mergeHandoffs({spec:'data/merge-spec.json',out:'data/analysis-input.json'},root);
  assert.equal(merged.excluded,1);assert.equal(merged.stores,1);
  assert.equal(json(join(root,'data/analysis-input.json')).analysis_status,'not_performed');
  assert.doesNotMatch(JSON.stringify(result),/buyer001|Synthetic/);
});

test('unfinished/pending collection cannot masquerade as a finished handoff',t=>{
  const root=fixture(t);deliverySpec(root);
  assert.throws(()=>publishHandoff({spec:'data/delivery-spec.json',out:'data/ready.json'},root),/run_not_stopped/);
  nextWindow('data/run',root);
  assert.throws(()=>publishHandoff({spec:'data/delivery-spec.json',out:'data/ready.json'},root),/run_not_stopped|pending/);
});

test('scope, malformed dates, identity changes and repeated runs are rejected',t=>{
  const root=fixture(t);finish(root);
  deliverySpec(root,{scope:{from:'2026-10-01',to_exclusive:iso(to)}});
  assert.throws(()=>publishHandoff({spec:'data/delivery-spec.json',out:'data/r.json'},root),/timezone/);
  deliverySpec(root,{scope:{from:'2026-09-31T00:00:00Z',to_exclusive:iso(to)}});
  assert.throws(()=>publishHandoff({spec:'data/delivery-spec.json',out:'data/r.json'},root),/timestamp/);
  deliverySpec(root,{chat_runs:['data/run','data/run']});
  assert.throws(()=>publishHandoff({spec:'data/delivery-spec.json',out:'data/r.json'},root),/duplicate_handoff_run/);
  const changed=json(join(root,'data/source.json'));changed.buyer_member_links[0].buyer_member_id='alibaba-visible-member:another';
  write(root,'data/wrong-population.json',changed);deliverySpec(root,{population_source:'data/wrong-population.json'});
  assert.throws(()=>publishHandoff({spec:'data/delivery-spec.json',out:'data/r.json'},root),/identity_changed/);
});

test('parent detects missing stores and changed evidence/attachments rather than silently merging',t=>{
  const root=fixture(t);finish(root);write(root,'data/facts.json',{facts:[]});
  deliverySpec(root,{attachments:[{role:'buyer_facts',path:'data/facts.json'}]});
  const result=publishHandoff({spec:'data/delivery-spec.json',out:'data/ready.json'},root);
  mergeSpec(root,result,{required_stores:['demobeta','demogamma']});
  assert.throws(()=>mergeHandoffs({spec:'data/merge-spec.json',out:'data/m.json'},root),/store_set_incomplete/);
  mergeSpec(root,result);write(root,'data/facts.json',{facts:['changed']});
  assert.throws(()=>mergeHandoffs({spec:'data/merge-spec.json',out:'data/m.json'},root),/artifact_hash_mismatch/);
});

test('a reused narrower-window exclusion never automatically excludes a current-window new lead',t=>{
  const root=fixture(t);finish(root,true);deliverySpec(root);
  publishHandoff({spec:'data/delivery-spec.json',out:'data/narrow.json'},root);
  const manifest='data/narrow-artifacts/run-1/manifest.json';
  deliverySpec(root,{scope:{from:iso(from-86400000),to_exclusive:iso(to)},chat_runs:[],reused_manifests:[manifest]});
  const result=publishHandoff({spec:'data/delivery-spec.json',out:'data/wide.json'},root);
  assert.equal(result.excluded,0);assert.equal(result.reused_inquiries,1);
  const row=json(join(root,'data/wide.json')).records[0];
  assert.equal(row.chat_sources[0].requires_window_review,true);assert.equal(row.chat_sources[0].status,'prior_window_exclusion');
});
