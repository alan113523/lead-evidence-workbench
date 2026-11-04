import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import collector from '../scripts/alibaba_chat_collector.js';
import vm from 'node:vm';
import { prepare as prepareBound, prepareStep, acceptStep, dataPath, assertNoPrivateTransport, exportedMessages } from '../scripts/chat_collection.mjs';
import {browserFixture, storeProof} from './store_binding_fixture.mjs';
const prepare = (options, root) => prepareBound({...options,browserMap:'data/browser-map.json'},root);
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'okki-chat-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'data'));mkdirSync(join(root,'scripts'));
  browserFixture(root);
  copyFileSync(resolve('scripts/alibaba_chat_collector.js'),join(root,'scripts/alibaba_chat_collector.js'));
  const source={store_key:'demobeta',inquiries:[{inquiry_id:'101',store_key:'demobeta'}],buyer_member_links:[{store_key:'demobeta',inquiry_id:'101',
    buyer_member_id:'alibaba-visible-member:buyer001',source_system:'alibaba-message-querySummary-contact-loginId-v1'}]};
  writeFileSync(join(root,'data/source.json'),JSON.stringify(source));return root;
}
test('workflow prepares explicit scope and refuses overwrite, path escape and unlinked IDs', t=>{
  const root=fixture(t),opts={source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'};
  assert.throws(()=>dataPath('../outside.json',root),/ignored_data/);
  assert.throws(()=>prepare({...opts,inquiryIds:['999']},root),/not_in_source/);
  prepare(opts,root);assert.throws(()=>prepare(opts,root),/already_exists/);
  const next = prepareStep('data/run',{},root);
  assert.equal(prepareStep('data/run',{},root).request_id,next.request_id);
  assert.throws(()=>prepareStep('data/run',{maxPages:10},root),/pending_step_exists/);
});

test('generated collectors route three separate runs and refuse swapped proofs before any business request',async t=>{
  const root=fixture(t);
  for(const store of ['demoalpha','demobeta','demogamma']){
    const source=JSON.parse(readFileSync(join(root,'data/source.json')));
    source.store_key=store;source.inquiries[0].store_key=store;source.buyer_member_links[0].store_key=store;
    writeFileSync(join(root,`data/${store}-source.json`),JSON.stringify(source));
    const run=`data/${store}-run`;
    prepare({source:`data/${store}-source.json`,store,inquiryIds:['101'],run},root);
    const step=prepareStep(run,{},root);
    assert.equal(step.browser_binding.browser_id,`synthetic-${store}`);
    const base={URL,URLSearchParams,Date,AbortSignal};
    const proof=await vm.runInNewContext(readFileSync(step.identity_script,'utf8'),{...base,
      location:{origin:'https://i.alibaba.com'},fetch:async()=>({ok:true,json:async()=>({minisite:`//${store}.en.alibaba.com`,componyName:'Synthetic'})})});
    let requests=0;
    const environment={...base,location:{origin:'https://message.alibaba.com',pathname:'/message/default.htm'},
      GDATA:{user:{memberId:`synthetic-${store}`},system:{csrfTokenKey:'_csrf_token_',csrfTokenVal:'synthetic-csrf'}},
      document:{cookie:'xman_us_t=x&ctoken=synthetic-cookie'},fetch:async(url)=>{
        requests++;let body;
        if(url.startsWith(collector.ENDPOINTS.inquiry))body={code:200,data:{list:[[{id:101,secTradeId:'synthetic-trade'}]]}};
        else if(url.startsWith(collector.ENDPOINTS.summary))body={code:200,data:{tradeId:101,cid:'synthetic-conversation',
          contact:{loginId:'buyer001',accountId:'buyer001',accountIdEncrypt:'synthetic-buyer'},owner:{accountId:'seller001',accountIdEncrypt:'synthetic-owner'}}};
        else if(url===collector.ENDPOINTS.session)body={token:'synthetic-token'};
        else if(url===collector.ENDPOINTS.messages)body={code:200,data:{list:[],hasMore:false}};
        else throw Error('unexpected_endpoint');
        return {ok:true,status:200,redirected:false,text:async()=>JSON.stringify(body)};
      }};
    const collect=vm.runInNewContext(readFileSync(step.script,'utf8'),environment);
    await assert.rejects(()=>collect({...proof,browser_binding:{channel:'cua-cdp',browser_id:'wrong-browser'}}),/browser_binding_mismatch/);
    await assert.rejects(()=>collect({...proof,request_id:'wrong-request'}),/identity_request_mismatch/);
    assert.equal(requests,0);
    const receipt=await collect(proof);assert.equal(requests,4);
    const response=`${run}/response-1.json`;writeFileSync(join(root,response),JSON.stringify(receipt));
    const changed=structuredClone(receipt);changed.store_proof.store_key='wrong-store';
    writeFileSync(join(root,response),JSON.stringify(changed));
    assert.throws(()=>acceptStep(run,response,root),/store_identity_mismatch/);
    writeFileSync(join(root,response),JSON.stringify(receipt));
    const accepted=acceptStep(run,response,root);assert.equal(accepted.store_key,store);assert.equal(accepted.status,'endpoint_exhausted');
  }
});

test('unbound legacy runs remain readable but cannot start a new collection step',t=>{
  const root=fixture(t);prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'},root);
  const configPath=join(root,'data/run/config.json'),config=JSON.parse(readFileSync(configPath));
  delete config.browser_binding;writeFileSync(configPath,JSON.stringify(config));
  assert.throws(()=>prepareStep('data/run',{},root),/legacy_run_unbound/);
});
test('accept checks append-only state, writes local JSONL/coverage and preserves source', t=>{
  const root=fixture(t);prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'},root);
  const before=readFileSync(join(root,'data/source.json'),'utf8');prepareStep('data/run',{},root);
  const ticket=JSON.parse(readFileSync(join(root,'data/run/pending.json'))),state=JSON.parse(readFileSync(join(root,'data/run/checkpoint.json')));
  state.revision++;state.status='paused';state.stop_reason='http_403';state.targets[0].status='paused';state.targets[0].stop_reason='http_403';
  const receipt={request_id:ticket.request_id,previous_sha256:ticket.previous_sha256,store_proof:storeProof('demobeta',ticket.request_id),state};
  writeFileSync(join(root,'data/response.json'),JSON.stringify({...receipt,chatToken:'synthetic-token'}));
  assert.throws(()=>acceptStep('data/run','data/response.json',root),/unexpected_receipt_fields/);
  writeFileSync(join(root,'data/response.json'),JSON.stringify(receipt));
  const result=acceptStep('data/run','data/response.json',root);assert.equal(result.status,'paused');assert.equal(result.unique_message_count,0);
  assert.equal(acceptStep('data/run','data/response.json',root).already_accepted,true);
  // Simulate a process stopping after checkpoint replacement but before pending rename.
  renameSync(join(root,'data/run/request-1.json'),join(root,'data/run/pending.json'));
  assert.equal(acceptStep('data/run','data/response.json',root).status,'paused');
  assert.equal(readFileSync(join(root,'data/source.json'),'utf8'),before);
  assert.throws(()=>prepareStep('data/run',{},root),/review_required/);
  const next=prepareStep('data/run',{resumeAfterReview:true},root);assert.equal(next.next_revision,2);
});
test('mismatched receipts and raw transport fields are rejected', t=>{
  const root=fixture(t);prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'},root);prepareStep('data/run',{},root);
  writeFileSync(join(root,'data/response.json'),JSON.stringify({request_id:'wrong',previous_sha256:'wrong'}));
  assert.throws(()=>acceptStep('data/run','data/response.json',root),/mismatched_receipt/);
  for(const key of ['chatToken','cookie','authorization','secTradeId','extInfo'])assert.throws(()=>assertNoPrivateTransport({nested:{[key]:'bad'}}),/transport/);
});
test('exports deduplicate same conversation across inquiry associations; conflicts stop',()=>{
  const m={message_id:'m1',send_time_ms:1,text:'synthetic'};
  const s={store_key:'demobeta',targets:['101','102'].map(inquiry_id=>({inquiry_id,buyer_member_id:'alibaba-visible-member:buyer001',identity:{conversation_id:'c1'},messages:[{...m}]}))};
  assert.deepEqual(exportedMessages(s)[0].inquiry_ids,['101','102']);assert.equal(exportedMessages(s).length,1);
  s.targets[1].messages[0].text='changed';assert.throws(()=>exportedMessages(s),/conflict/);
});
test('pending preparation repairs missing and truncated generated scripts with the same ticket',t=>{
  const root=fixture(t);prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'},root);
  const first=prepareStep('data/run',{},root), full=readFileSync(first.script,'utf8');
  writeFileSync(first.script,full.slice(0,77));rmSync(first.identity_script);
  const next=prepareStep('data/run',{},root);
  assert.equal(next.request_id,first.request_id);assert.equal(next.reused_pending,true);
  assert.equal(readFileSync(next.script,'utf8'),full);assert.ok(readFileSync(next.identity_script,'utf8').length>100);
  writeFileSync(next.script,'unrelated change');
  assert.throws(()=>prepareStep('data/run',{},root),/existing_artifact_conflict/);
});
test('accept repairs only truncated exports from a valid receipt and rejects conflicting complete artifacts',t=>{
  const root=fixture(t);prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'},root);prepareStep('data/run',{},root);
  const ticket=JSON.parse(readFileSync(join(root,'data/run/pending.json'))),state=JSON.parse(readFileSync(join(root,'data/run/checkpoint.json')));
  state.revision++;state.status='paused';state.stop_reason='http_403';state.targets[0].status='paused';state.targets[0].stop_reason='http_403';
  const receipt={request_id:ticket.request_id,previous_sha256:ticket.previous_sha256,store_proof:storeProof('demobeta',ticket.request_id),state};
  writeFileSync(join(root,'data/response.json'),JSON.stringify(receipt));
  writeFileSync(join(root,'data/run/accepted-1.json'),JSON.stringify(receipt,null,2).slice(0,31));
  writeFileSync(join(root,'data/run/coverage-1.json'),'{');
  assert.equal(acceptStep('data/run','data/response.json',root).revision,1);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'data/run/accepted-1.json'))),receipt);
});
test('recovery recognises a byte prefix cut inside a Chinese UTF-8 character',t=>{
  const root=fixture(t);prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/run'},root);prepareStep('data/run',{},root);
  const ticket=JSON.parse(readFileSync(join(root,'data/run/pending.json'))),state=JSON.parse(readFileSync(join(root,'data/run/checkpoint.json')));
  state.targets[0].identity={conversation_id:'c1',buyer_account_id:'b1',owner_account_id:'s1'};
  collector.consumePage(state.targets[0],{code:200,data:{list:[{messageId:1,sendTime:state.snapshot_at_ms-1000,
    owner:{accountId:'s1'},contact:{accountId:'b1'},type:1,subType:1,messageType:'rec',content:'合成中文消息'}]}},ticket.config);
  state.revision=1;state.pages_read=1;
  const receipt={request_id:ticket.request_id,previous_sha256:ticket.previous_sha256,store_proof:storeProof('demobeta',ticket.request_id),state};
  writeFileSync(join(root,'data/response.json'),JSON.stringify(receipt));
  const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n'),first=bytes.indexOf(Buffer.from('合'));
  writeFileSync(join(root,'data/run/accepted-1.json'),bytes.subarray(0,first+1));
  assert.equal(acceptStep('data/run','data/response.json',root).unique_message_count,1);
});
