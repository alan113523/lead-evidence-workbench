import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import vm from 'node:vm';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import legacy from '../scripts/alibaba_chat_collector.js';
import {prepareWindow,nextWindow,acceptWindow,windowStatus,inspectWindow,runWindowBatch,resumeWindow,exportWindow,exportReviewCohort} from '../scripts/chat_window.mjs';
import {bindWindowEvidence,validateChatEvidence,validateChatRun} from '../scripts/chat_evidence_router.mjs';
import {prepareLocal,createAnalysisDraft,reviewLocal} from '../scripts/buyer_due_diligence_local.mjs';
import {browserFixture,storeProof} from './store_binding_fixture.mjs';
const start=Date.parse('2026-10-06T00:00:00+08:00'),end=start+2*86400000,asOf=end+3600000;
const iso=n=>new Date(n).toISOString();
function fixture(t,{ids=['101','102'],members=['buyer001','buyer002'],created=[start+1000,start+2000],store='demobeta',...options}={}) {
  const root=mkdtempSync(join(tmpdir(),'okki-window-test-'));t.after(()=>{
    assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^okki-window-test-/);rmSync(root,{recursive:true,force:true});
  });
  mkdirSync(join(root,'data'));mkdirSync(join(root,'scripts'));browserFixture(root);
  for(const name of ['alibaba_chat_collector.js','alibaba_chat_window.js','chat_window.mjs'])copyFileSync(resolve('scripts',name),join(root,'scripts',name));
  const source={store_key:store,inquiries:ids.map((id,i)=>({store_key:store,inquiry_id:id,created_at:iso(created[i])})),
    buyer_member_links:ids.map((id,i)=>({store_key:store,inquiry_id:id,buyer_member_id:`alibaba-visible-member:${members[i]}`,source_system:'alibaba-message-querySummary-contact-loginId-v1'}))};
  writeFileSync(join(root,'data/source.json'),JSON.stringify(source));
  const opts={source:'data/source.json',store,browserMap:'data/browser-map.json',run:'data/run',from:iso(start),to:iso(end),asOf:iso(asOf),pageSize:2,...options};
  prepareWindow(opts,root);return {root,opts};
}
const identity=(buyer='buyer001',conv='conv001')=>({conversation_id:conv,buyer_account_id:buyer,owner_account_id:'seller001'});
const msg=(id,time,who=identity(),extra={})=>legacy.normalizeMessage({messageId:String(id),sendTime:time,owner:{accountId:who.owner_account_id},contact:{accountId:who.buyer_account_id},
  type:1,subType:1,messageType:'rec',content:`Synthetic ${id}`, ...extra},who);
function receipt(step,{rows=[],who=identity(),error=null,more=null}={}) {
  const proof=storeProof(step.ticket.task.store_key,step.ticket.request_id,step.browser_binding);
  return {kind:step.kind,request_id:step.ticket.request_id,observed_at_ms:Date.now(),store_proof:proof,
    identity:who,session_member_id:'session001',rows,has_more:more,error};
}
function resolveAll(root,identities=[identity(),identity('buyer002','conv002')]) {
  for(const who of identities){const step=nextWindow('data/run',root);assert.equal(step.kind,'resolve');acceptWindow('data/run',receipt(step,{who}),root);}
}
test('explicit timezone, creation-date bounds and complete source links are enforced',t=>{
  const {root,opts}=fixture(t);
  assert.throws(()=>prepareWindow({...opts,run:'data/nozone',from:'2026-10-06'},root),/timezone/);
  assert.throws(()=>prepareWindow({...opts,run:'data/baddate',from:'2026-09-31T00:00:00+08:00'},root),/invalid_timestamp/);
  assert.throws(()=>prepareWindow({...opts,run:'data/outside',from:iso(start+10000)},root),/outside_window/);
  assert.throws(()=>prepareWindow({...opts,run:'data/bad',inquiryIds:['999']},root),/verified_buyer/);
});

test('incremental collection keeps business creation dates and stops at the prior snapshot',t=>{
  const cutoff=end-10000;
  const {root}=fixture(t,{ids:['101','102'],members:['buyer001','buyer001'],messagesAfter:iso(cutoff)});
  resolveAll(root,[identity(),identity()]);
  const before=inspectWindow('data/run',root);
  assert.equal(before.config.targets[0].created_at_ms,start+1000);
  assert.equal(before.state.conversations[0].from_ms,cutoff+1);
  const step=nextWindow('data/run',root);
  acceptWindow('data/run',receipt(step,{rows:[msg(1,cutoff+1),msg(2,cutoff)],more:true}),root);
  const after=inspectWindow('data/run',root);
  assert.equal(after.state.conversations[0].status,'incremental_complete');
  assert.equal(after.state.status,'completed');
  assert.deepEqual([...after.messages.values()].map(x=>x.message.message_id),['1']);
  assert.equal(after.state.conversations[0].history_evidence,null);
  exportWindow('data/run','data/incremental.json',root);
  assert.equal(JSON.parse(readFileSync(join(root,'data/incremental.json'))).scope.messages_after_exclusive,iso(cutoff));
  bindWindowEvidence({chatRun:'data/run',source:'data/source.json',out:'data/incremental-manifest.json'},root);
  assert.equal(validateChatEvidence({manifest:'data/incremental-manifest.json'},root).message_count,1);
});

test('incremental overlap does not reclassify old contacts or retain old messages',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],messagesAfter:iso(end-10000)});
  resolveAll(root,[identity()]);const step=nextWindow('data/run',root);
  acceptWindow('data/run',receipt(step,{rows:[msg(1,start-1)],more:true}),root);
  const result=windowStatus('data/run',root);
  assert.equal(result.conversation_statuses.incremental_complete,1);
  assert.equal(result.excluded_inquiries,0);assert.equal(result.current_message_count,0);
});

test('incremental boundaries cannot erase the creation scope or exceed the snapshot',t=>{
  const {root,opts}=fixture(t);
  for(const value of [iso(start-1),iso(asOf),iso(asOf+1)]){
    assert.throws(()=>prepareWindow({...opts,run:'data/invalid-incremental',messagesAfter:value},root),/invalid_incremental_boundary/);
  }
  assert.throws(()=>prepareWindow({...opts,run:'data/nozone-incremental',messagesAfter:'2026-10-07'},root),/explicit_timezone_required/);
});
test('resolve all aliases before reading; same conversation fetched once and fairly round-robin',t=>{
  const {root}=fixture(t,{ids:['101','102','103'],members:['buyer001','buyer001','buyer002'],created:[start+1000,start+2000,start+3000]});
  resolveAll(root,[identity(),identity(),identity('buyer002','conv002')]);
  let step=nextWindow('data/run',root);assert.equal(step.ticket.task.target.inquiry_id,'101');
  acceptWindow('data/run',receipt(step,{rows:[msg(1,end-1000),msg(2,end-2000)],more:true}),root);
  step=nextWindow('data/run',root);assert.equal(step.ticket.task.target.inquiry_id,'103');
  acceptWindow('data/run',receipt(step,{who:identity('buyer002','conv002'),more:false}),root);
  const state=inspectWindow('data/run',root).state;assert.equal(state.conversations.length,2);assert.deepEqual(state.conversations[0].inquiry_ids,['101','102']);
});
test('first valid pre-window buyer message excludes aliases; same-window earlier inquiry is not old',t=>{
  const {root}=fixture(t,{ids:['101','102'],members:['buyer001','buyer001'],created:[start+10000,start+20000]});resolveAll(root,[identity(),identity()]);
  let step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(1,start+21000),msg(2,start+15000)],more:true}),root);
  assert.equal(windowStatus('data/run',root).excluded_inquiries,0);
  step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(3,start-1),msg(4,start-2000)],more:true}),root);
  const ctx=inspectWindow('data/run',root);assert.equal(ctx.state.conversations[0].status,'old_contact_detected');
  assert.equal(ctx.messages.size,3);assert.equal(windowStatus('data/run',root).excluded_inquiries,2);
  exportWindow('data/run','data/view.json',root);const view=JSON.parse(readFileSync(join(root,'data/view.json')));
  assert.deepEqual(view.messages.find(r=>r.message.message_id==='2').inquiry_ids,['101']);
  assert.equal(view.messages.filter(r=>r.supplemental_history).length,1);
  assert.equal(view.coverage.formal_due_diligence,'not_performed');
});
test('system, hidden and automated history do not prove an old customer; boundary completes window',t=>{
  for(const extra of [{type:2},{viewType:3},{autoReply:1}]){
    const f=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(f.root,[identity()]);
    const step=nextWindow('data/run',f.root);acceptWindow('data/run',receipt(step,{rows:[msg(1,start-1,identity(),extra)],more:true}),f.root);
    assert.equal(windowStatus('data/run',f.root).excluded_inquiries,0);assert.equal(windowStatus('data/run',f.root).conversation_statuses.window_complete,1);
  }
});
test('page deltas deduplicate overlap, enforce snapshot and do not embed bodies in checkpoints/events',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(root,[identity()]);
  let step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(9,asOf+1000),msg(1,end-1000)],more:true}),root);
  step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(1,end-1000),msg(2,end-2000)],more:true}),root);
  const ctx=inspectWindow('data/run',root);assert.equal(ctx.messages.size,2);
  const delta=readFileSync(join(root,'data/run/page-3.jsonl'),'utf8');assert.equal(delta.trim().split('\n').length,1);
  assert.equal(JSON.parse(delta).message_id,'2');
  assert.ok(!readFileSync(join(root,'data/run/checkpoint.json'),'utf8').includes('Synthetic'));
  assert.ok(!readFileSync(join(root,'data/run/event-3.json'),'utf8').includes('Synthetic'));
  step=nextWindow('data/run',root);assert.ok(!readFileSync(step.script,'utf8').includes('Synthetic 1'));
});
test('tampered identity cannot advance; conflicting overlap is recorded without replacing accepted content',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(root,[identity()]);
  let step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(1,end-1000)],more:true}),root);
  step=nextWindow('data/run',root);const before=readFileSync(join(root,'data/run/checkpoint.json'),'utf8');
  const bad=receipt(step,{rows:[msg(1,end-1000,identity(),{content:'changed'})]});
  const wrong=structuredClone(bad);wrong.store_proof.browser_binding.browser_id='wrong';assert.throws(()=>acceptWindow('data/run',wrong,root),/browser_binding/);
  assert.equal(readFileSync(join(root,'data/run/checkpoint.json'),'utf8'),before);
  assert.equal(acceptWindow('data/run',bad,root).last_step_error,'conflicting_duplicate');
  const ctx=inspectWindow('data/run',root);assert.equal(ctx.state.conversations[0].status,'needs_review');
  assert.equal(ctx.messages.size,1);assert.equal([...ctx.messages.values()][0].message.text,'Synthetic 1');
  assert.equal(readFileSync(join(root,'data/run/page-3.jsonl'),'utf8'),'');
});
test('single-conversation error is isolated; login/risk/session errors stop the store',t=>{
  const {root}=fixture(t);resolveAll(root);let step=nextWindow('data/run',root);
  acceptWindow('data/run',receipt(step,{error:'message_buyer_mismatch'}),root);
  step=nextWindow('data/run',root);assert.equal(step.ticket.task.target.inquiry_id,'102');
  acceptWindow('data/run',receipt(step,{error:'http_403'}),root);assert.equal(windowStatus('data/run',root).status,'blocked');
  assert.throws(()=>nextWindow('data/run',root),/store_review/);
  assert.throws(()=>resumeWindow('data/run',{reason:'review'},root),/review_required/);
  resumeWindow('data/run',{reason:'Synthetic session reviewed',reviewed:true},root);
  assert.equal(nextWindow('data/run',root).ticket.task.target.inquiry_id,'102');
});
test('budget stops remain partial and can resume without new runs or altered scope',t=>{
  const {root}=fixture(t,{perConversationPages:1});resolveAll(root);
  for(const who of [identity(),identity('buyer002','conv002')]){const step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{who,rows:[msg(1,end-1000,who)],more:true}),root);}
  assert.equal(windowStatus('data/run',root).status,'partial');assert.equal(windowStatus('data/run',root).conversation_statuses.page_budget_reached,2);
  resumeWindow('data/run',{reason:'Approved bounded continuation',reviewed:true,perConversationPages:2},root);
  assert.equal(windowStatus('data/run',root).status,'ready');assert.equal(nextWindow('data/run',root).ticket.task.cursor,end-1000);
});
test('small batches are serial, proof is fresh per step, summaries exclude bodies and errors end a batch',async t=>{
  const {root}=fixture(t);let active=0,maxActive=0,calls=0;const tickets=new Set();
  const adapter={existingPagesOnly:true,backgroundOnly:true,async execute(step){active++;maxActive=Math.max(maxActive,active);calls++;tickets.add(step.ticket.request_id);
    await Promise.resolve();active--;return receipt(step,{who:step.ticket.task.target.inquiry_id==='101'?identity():identity('buyer002','conv002')});}};
  const result=await runWindowBatch('data/run',adapter,{steps:3},root);
  assert.equal(calls,3);assert.equal(tickets.size,3);assert.equal(maxActive,1);assert.ok(!JSON.stringify(result).includes('buyer001'));
  await assert.rejects(runWindowBatch('data/run',adapter,{steps:6},root),/batch_limit/);
  const stopped=await runWindowBatch('data/run',{...adapter,execute:async step=>receipt(step,{error:'message_buyer_mismatch'})},{steps:3},root);
  assert.equal(stopped.steps_completed,1);
});

test('each delta, event and checkpoint is read back before another browser page can start',async t=>{
  for(const [file,reason] of [['page-3.jsonl','delta_write_not_verified'],['event-3.json','event_write_not_verified'],['checkpoint.json','checkpoint_write_not_verified']]){
    const {root}=fixture(t);resolveAll(root);let calls=0,injected=false;
    const originalRename=fs.renameSync;
    fs.renameSync=function(from,to){originalRename(from,to);if(!injected&&resolve(to)===resolve(root,'data/run',file)){
      injected=true;if(file.endsWith('.jsonl'))fs.appendFileSync(to,'corrupt');
      else{const value=JSON.parse(fs.readFileSync(to,'utf8'));value.synthetic_corruption=true;fs.writeFileSync(to,JSON.stringify(value));}
    }};
    syncBuiltinESMExports();
    try {
      await assert.rejects(runWindowBatch('data/run',{existingPagesOnly:true,backgroundOnly:true,execute:async step=>{
        calls++;const who=step.ticket.task.target.inquiry_id==='101'?identity():identity('buyer002','conv002');
        return receipt(step,{who,rows:[msg(1,end-1000,who)],more:true});
      }},{steps:2},root),new RegExp(reason));
    } finally {fs.renameSync=originalRename;syncBuiltinESMExports();}
    assert.equal(calls,1);assert.ok(injected);assert.ok(existsSync(join(root,'data/run/pending.json')));
    assert.ok(existsSync(join(root,'data/run/pending.response.json')));assert.ok(!existsSync(join(root,'data/run/event-4.json')));
  }
});
test('transport failures preserve the pending ticket, cancellation does not start another observation',async t=>{
  const {root}=fixture(t);const adapter={existingPagesOnly:true,backgroundOnly:true,execute:async()=>{throw Error('synthetic transport');}};
  await assert.rejects(runWindowBatch('data/run',adapter,{},root),/synthetic transport/);
  const step=nextWindow('data/run',root);assert.equal(nextWindow('data/run',root).ticket.request_id,step.ticket.request_id);
  await assert.rejects(runWindowBatch('data/run',adapter,{},root),/pending_requires_review/);
  acceptWindow('data/run',receipt(step),root);
  const controller=new AbortController();controller.abort();
  const result=await runWindowBatch('data/run',adapter,{signal:controller.signal},root);assert.equal(result.steps_completed,0);
});
test('committed event recovery repairs a lagging checkpoint and rejects corrupted deltas',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});const checkpoint=readFileSync(join(root,'data/run/checkpoint.json'));
  resolveAll(root,[identity()]);writeFileSync(join(root,'data/run/checkpoint.json'),checkpoint);
  assert.equal(windowStatus('data/run',root).revision,1);const step=nextWindow('data/run',root);
  assert.equal(JSON.parse(readFileSync(join(root,'data/run/checkpoint.json'))).revision,1);
  acceptWindow('data/run',receipt(step,{rows:[msg(1,end-1)],more:false}),root);
  writeFileSync(join(root,'data/run/page-2.jsonl'),'{}\n');assert.throws(()=>windowStatus('data/run',root),/delta_changed/);
});

test('a committed page with stale pending files recovers once and duplicate acceptance is idempotent',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(root,[identity()]);
  const step=nextWindow('data/run',root),before=readFileSync(join(root,'data/run/checkpoint.json'));
  const observed=receipt(step,{rows:[msg(1,end-1000)],more:false});acceptWindow('data/run',observed,root);
  writeFileSync(join(root,'data/run/checkpoint.json'),before);writeFileSync(join(root,'data/run/pending.json'),JSON.stringify(step.ticket));
  writeFileSync(join(root,'data/run/pending.response.json'),JSON.stringify(observed));
  assert.equal(acceptWindow('data/run',observed,root).revision,2);
  assert.equal(acceptWindow('data/run',observed,root).current_message_count,1);
  assert.ok(!existsSync(join(root,'data/run/pending.json')));assert.ok(!existsSync(join(root,'data/run/pending.response.json')));
  assert.equal(readdirSync(join(root,'data/run')).filter(n=>/^event-/.test(n)).length,2);
});

test('pinned source, browser worker and workflow changes cannot silently resume a run',t=>{
  for(const [path,reason] of [['data/source.json','source_changed'],['data/run/runtime/browser.txt','runtime_changed'],['scripts/chat_window.mjs','workflow_version_changed']]){
    const {root}=fixture(t);writeFileSync(join(root,path),readFileSync(join(root,path),'utf8')+'\n');
    assert.throws(()=>windowStatus('data/run',root),new RegExp(reason));
  }
});

test('the store budget labels unfinished conversations partial and preserves fair continuation',t=>{
  const {root}=fixture(t,{maxPages:1});resolveAll(root);const step=nextWindow('data/run',root);
  acceptWindow('data/run',receipt(step,{rows:[msg(1,end-1000)],more:true}),root);
  const status=windowStatus('data/run',root);assert.equal(status.status,'partial');assert.equal(status.conversation_statuses.page_budget_reached,2);
  resumeWindow('data/run',{reviewed:true,reason:'Approved second page',maxPages:2},root);
  assert.equal(nextWindow('data/run',root).ticket.task.target.inquiry_id,'102');
});

test('checkpoint stays small as large page bodies accumulate and request scripts never embed them',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(root,[identity()]);
  let baselineSize;
  for(let i=0;i<3;i++){
    const step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(i+1,end-1000*(i+1),identity(),{content:'body'.repeat(4000)})],more:true}),root);
    const checkpoint=readFileSync(join(root,'data/run/checkpoint.json'));
    if(i===0)baselineSize=checkpoint.length;assert.ok(checkpoint.length<baselineSize+100);
    assert.ok(readFileSync(join(root,`data/run/page-${i+2}.jsonl`)).length>16000);
    assert.ok(!readFileSync(step.script,'utf8').includes('body'.repeat(100)));
  }
});

test('old contact evidence propagates only to the same verified buyer within the same store',t=>{
  const {root}=fixture(t,{members:['buyer001','buyer001']});resolveAll(root,[identity(),identity('buyer001','conv002')]);
  const step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(1,start-1)],more:true}),root);
  assert.equal(windowStatus('data/run',root).excluded_inquiries,2);
  const other=fixture(t,{store:'demogamma',ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(other.root,[identity()]);
  assert.equal(windowStatus('data/run',other.root).excluded_inquiries,0);assert.equal(nextWindow('data/run',other.root).kind,'page');
  assert.notEqual(inspectWindow('data/run',root).state.conversations[0].key,inspectWindow('data/run',other.root).state.conversations[0].key);
});

test('cohort and v2 evidence feed local review without old contacts or history; tampering is rejected',t=>{
  const {root}=fixture(t,{ids:['101','102','103'],members:['buyer001','buyer001','buyer002'],created:[start+1000,start+3000,start+1000]});
  resolveAll(root,[identity(),identity(),identity('buyer002','conv002')]);
  let step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(1,start+4000),msg(2,start+2000)],more:false}),root);
  step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{who:identity('buyer002','conv002'),rows:[msg(3,start-1,identity('buyer002','conv002'))],more:true}),root);
  exportReviewCohort('data/run','data/eligible.json',root);
  const bundle=JSON.parse(readFileSync(join(root,'data/eligible.json')));assert.deepEqual(bundle.inquiries.map(t=>t.inquiry_id),['101','102']);
  assert.equal(bundle.window_collection.excluded_inquiries.length,1);
  const bound=bindWindowEvidence({chatRun:'data/run',source:'data/source.json',out:'data/manifest.json'},root);
  assert.equal(bound.eligible_inquiries,2);assert.equal(bound.message_count,2);assert.equal(bound.excluded_inquiries,1);
  assert.equal(validateChatEvidence({manifest:'data/manifest.json'},root).formal_research_validation,'not_performed');
  const verified=validateChatRun({chatRun:'data/run',source:'data/source.json'},root);
  assert.equal(verified.associations.find(a=>a.inquiry_id==='102').message_indexes.length,1);
  assert.throws(()=>exportWindow('data/run','data/run/overwrite.json',root),/outside_run/);
  assert.throws(()=>bindWindowEvidence({chatRun:'data/run',source:'data/source.json',out:'data/run/manifest.json'},root),/outside_run/);
  writeFileSync(join(root,'data/scope.json'),JSON.stringify({stores:['demobeta'],from_inclusive:iso(start),to_exclusive:iso(end),time_zone:'Asia/Shanghai',batch_id:'synthetic-window'}));
  assert.equal(prepareLocal({source:'data/eligible.json',scope:'data/scope.json',out:'data/local.json'},root).tracking_units,1);
  createAnalysisDraft({input:'data/local.json',out:'data/analysis.json',asOf:iso(asOf)},root);
  assert.equal(reviewLocal({input:'data/local.json',analysis:'data/analysis.json',out:'data/review.json',chatManifest:'data/manifest.json'},root).units,1);
  const manifest=JSON.parse(readFileSync(join(root,'data/manifest.json')));manifest.historyComplete=true;
  writeFileSync(join(root,'data/manifest.json'),JSON.stringify(manifest));assert.throws(()=>validateChatEvidence({manifest:'data/manifest.json'},root),/manifest_changed/);
});

test('an entirely excluded cohort is a valid empty research queue, while the source ledger remains intact',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});resolveAll(root,[identity()]);
  const step=nextWindow('data/run',root);acceptWindow('data/run',receipt(step,{rows:[msg(1,start-1)],more:true}),root);
  assert.equal(exportReviewCohort('data/run','data/eligible.json',root).eligible_inquiries,0);
  assert.equal(JSON.parse(readFileSync(join(root,'data/source.json'))).inquiries.length,1);
  assert.equal(bindWindowEvidence({chatRun:'data/run',source:'data/source.json',out:'data/manifest.json'},root).message_count,0);
});
test('generated browser code only resolves before message collection; wrong proof makes zero requests',async t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});let requests=0;
  const env={URL,URLSearchParams,Date,AbortSignal,location:{origin:'https://message.alibaba.com',pathname:'/message/default.htm'},
    GDATA:{user:{memberId:'session001'},system:{csrfTokenKey:'_csrf_token_',csrfTokenVal:'synthetic-csrf'}},document:{cookie:'xman_us_t=x&ctoken=synthetic-cookie'},
    fetch:async url=>{requests++;let data;
      if(url.startsWith(legacy.ENDPOINTS.inquiry))data={code:200,data:{list:[[{id:101,createTime:start+1000,secTradeId:'synthetic-trade',sender:{countryCode:'us',countryName:'United States',name:'Synthetic Buyer'}}]]}};
      else if(url===legacy.ENDPOINTS.summary)data={code:200,data:{}};
      else if(url.startsWith(legacy.ENDPOINTS.summary))data={code:200,data:{tradeId:101,cid:'conv001',contact:{loginId:'buyer001',accountId:'buyer001',accountIdEncrypt:'synthetic-buyer'},owner:{accountId:'seller001',accountIdEncrypt:'synthetic-owner'}}};
      else if(url.startsWith('https://message.alibaba.com/message/ajax/feedback/subjectListExtraInfo.htm'))data={code:200,data:{list:{101:{sender:{userNewLevel:'L2',userLevel:'B',joinYear:'2019',companyName:'Synthetic Trading LLC',highQuality:true}}}}};
      else if(url===legacy.ENDPOINTS.session)data={token:'synthetic-token'};
      else if(url===legacy.ENDPOINTS.messages)data={code:200,data:{list:[],hasMore:false}};
      else throw Error('unexpected_endpoint');
      return {ok:true,status:200,redirected:false,text:async()=>JSON.stringify(data)};}};
  let step=nextWindow('data/run',root),fn=vm.runInNewContext(`(${readFileSync(step.script,'utf8')})`,env);
  let proof=storeProof('demobeta',step.ticket.request_id,step.browser_binding);
  const bad=await fn({...proof,request_id:'wrong'});assert.ok(bad.error);assert.equal(requests,0);
  const observed=await fn(proof);assert.equal(observed.error,null);assert.equal(requests,3);
  assert.deepEqual(JSON.parse(JSON.stringify(observed.buyer_facts)),{list_country_code:'us',list_country_name:'United States',list_name:'Synthetic Buyer',summary_country_code:null,summary_name:null,
    buyer_level:'L2',buyer_level_legacy:'B',join_year:'2019',company_name:'Synthetic Trading LLC',high_quality:true,extra_error:null});acceptWindow('data/run',JSON.parse(JSON.stringify(observed)),root);
  step=nextWindow('data/run',root);fn=vm.runInNewContext(`(${readFileSync(step.script,'utf8')})`,env);proof=storeProof('demobeta',step.ticket.request_id,step.browser_binding);
  acceptWindow('data/run',JSON.parse(JSON.stringify(await fn(proof))),root);assert.equal(requests,7);assert.equal(windowStatus('data/run',root).status,'completed');
  exportWindow('data/run','data/ledger.json',root);
  const facts=JSON.parse(readFileSync(join(root,'data/ledger.json'),'utf8')).records[0].platform_facts;
  assert.equal(facts.country_code,'US');assert.equal(facts.country,'美国');assert.equal(facts.buyer_level,'L2');
  assert.equal(facts.platform_company_name,'Synthetic Trading LLC');assert.equal(facts.extra_error,null);
});

test('buyer facts are optional, whitelisted and rejected on page steps',t=>{
  const {root}=fixture(t,{ids:['101'],members:['buyer001'],created:[start+1000]});
  let step=nextWindow('data/run',root);const bad=receipt(step);bad.buyer_facts={list_country_code:'US'};
  assert.throws(()=>acceptWindow('data/run',bad,root),/invalid_buyer_facts/);
  const facts={list_country_code:null,list_country_name:'墨西哥',list_name:null,summary_country_code:null,summary_name:null,buyer_level:'0',
    buyer_level_legacy:null,join_year:null,company_name:null,high_quality:null,extra_error:'extra_row_missing'};
  acceptWindow('data/run',{...receipt(step),buyer_facts:facts},root);
  step=nextWindow('data/run',root);assert.equal(step.kind,'page');
  assert.throws(()=>acceptWindow('data/run',{...receipt(step,{more:false}),buyer_facts:facts},root),/invalid_buyer_facts/);
  acceptWindow('data/run',receipt(step,{more:false}),root);
  exportWindow('data/run','data/ledger.json',root);
  const out=JSON.parse(readFileSync(join(root,'data/ledger.json'),'utf8')).records[0].platform_facts;
  assert.equal(out.country_code,'MX');assert.equal(out.buyer_level,null);assert.equal(out.buyer_level_raw,'0');assert.equal(out.extra_error,'extra_row_missing');
});
