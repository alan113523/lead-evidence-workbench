import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import legacy from '../scripts/alibaba_chat_collector.js';
import worker from '../scripts/alibaba_chat_window.js';
import binding from '../lib/store_binding.js';
import {prepareWindow,inspectWindow} from '../scripts/chat_window.mjs';
import {createWindowRunner} from '../scripts/chat_window_runner.mjs';
import {publishHandoff} from '../scripts/collection_handoff.mjs';
import {validateChatRun} from '../scripts/chat_evidence_router.mjs';
import {prepare,prepareStep,acceptStep} from '../scripts/chat_collection.mjs';
import {emptyOpportunityAssessment,buildOpportunityReview} from '../scripts/deep_communication.mjs';
import {browserFixture,browserBinding,storeProof} from './store_binding_fixture.mjs';

const from=Date.parse('2026-10-01T00:00:00+08:00'),to=from+7*86400000;
const who={conversation_id:'synthetic-conversation',buyer_account_id:'11',owner_account_id:'22'};
const iso=value=>new Date(value).toISOString();
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:legacy.canonical(value)).digest('hex');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const write=(root,path,value)=>writeFileSync(join(root,path),JSON.stringify(value,null,2)+'\n');
const reverse=(extra={})=>({messageId:'synthetic-system',sendTime:from+6000,type:2,subType:10,messageType:'rec',viewType:1,
  owner:{accountId:11},contact:{accountId:22},content:'Synthetic system notice',...extra});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

test('verified reversed system event retains raw accounts and normalized buyer',()=>{
  const raw=freeze(reverse()),identity=freeze({...who}),before=hash(raw),m=legacy.normalizeMessage(raw,identity);
  assert.equal(m.owner_account_id,'11');assert.equal(m.buyer_account_id,'11');
  assert.deepEqual(m.account_mapping,{rule:'system_reverse_pair_v1',source_message_type:'rec',source_view_type:1,source_contact_account_id:'22'});
  assert.equal(m.direction,'system');assert.equal(m.sender_account_id,null);assert.equal(m.reply_source,'not_applicable');
  assert.equal(hash(raw),before);
});

test('normal system direction and historical owners retain their original fields',()=>{
  for(const owner of [22,'historical-owner']){
    const m=legacy.normalizeMessage(reverse({owner:{accountId:owner},contact:{accountId:11}}),who);
    assert.equal(m.owner_account_id,String(owner));assert.equal(m.buyer_account_id,'11');assert.equal(m.direction,'system');
    assert.equal(Object.hasOwn(m,'account_mapping'),false);
  }
  const m=legacy.normalizeMessage(reverse({type:1,subType:1,messageType:'send',owner:{accountId:'historical-owner'},contact:{accountId:11}}),who);
  assert.equal(m.sender_account_id,'historical-owner');assert.equal(m.direction,'seller');
});

test('reverse mapping requires both exact distinct endpoints',()=>{
  for(const [raw,identity] of [[reverse({owner:{accountId:33}}),who],[reverse({contact:{accountId:33}}),who],
    [reverse({contact:{accountId:11}}),who],[reverse({owner:{accountId:22}}),who],
    [reverse({owner:{accountId:11},contact:{accountId:11}}),{...who,owner_account_id:'11'}]])
    assert.throws(()=>legacy.normalizeMessage(raw,identity),/message_buyer_mismatch/);
});

test('missing and unsafe account IDs keep their original rejection',()=>{
  for(const account of [undefined,null,{},true,Number.MAX_SAFE_INTEGER+1,'','bad id']){
    assert.throws(()=>legacy.normalizeMessage(reverse({owner:{accountId:account}}),who),/invalid_or_unsafe_id/);
    assert.throws(()=>legacy.normalizeMessage(reverse({contact:{accountId:account}}),who),/invalid_or_unsafe_id/);
  }
});

test('ordinary, unknown system categories and hidden records receive no reverse exemption',()=>{
  for(const extra of [{type:1,subType:1,messageType:'send'},{type:1,subType:1,messageType:'rec'},
    {subType:11},{messageType:'send'},{messageType:'system'},{viewType:3},{viewType:undefined},{viewType:'1'}])
    assert.throws(()=>legacy.normalizeMessage(reverse(extra),who),/message_buyer_mismatch/);
  const hidden=legacy.normalizeMessage(reverse({owner:{accountId:22},contact:{accountId:11},viewType:3,content:'hidden fixture'}),who);
  assert.equal(hidden.source_content,null);assert.equal(hidden.text,'');assert.equal(Object.hasOwn(hidden,'account_mapping'),false);
});

test('credential cleanup and immutable input survive the narrow mapping',()=>{
  const secret='SYNTHETIC_MAPPING_SECRET';const raw=freeze(reverse({content:'System notice token='+secret}));
  const before=hash(raw),m=legacy.normalizeMessage(raw,freeze({...who}),{},[secret]);
  assert.equal(hash(raw),before);assert.equal(JSON.stringify(m).includes(secret),false);assert.equal(m.content_redacted,true);
});

function fixture(t,name) {
  const output=process.env.OKKI_SYSTEM_MAPPING_ARTIFACT_DIR?resolve(process.env.OKKI_SYSTEM_MAPPING_ARTIFACT_DIR):null;
  const base=output??resolve(tmpdir());mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'system-mapping-'+name+'-'));
  if(!output)t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.match(basename(root),/^system-mapping-/);rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'data'));mkdirSync(join(root,'scripts'));browserFixture(root);
  for(const name of ['alibaba_chat_collector.js','alibaba_chat_window.js','chat_window.mjs'])copyFileSync(resolve('scripts',name),join(root,'scripts',name));
  write(root,'data/source.json',{store_key:'demobeta',inquiries:[{store_key:'demobeta',inquiry_id:'101',created_at:iso(from+1000)}],
    buyer_member_links:[{store_key:'demobeta',inquiry_id:'101',buyer_member_id:'alibaba-visible-member:synthetic001',source_system:'alibaba-message-querySummary-contact-loginId-v1'}]});
  return root;
}

function environment(payload,overrides={}) {
  const requests=[];
  const env={location:{origin:'https://message.alibaba.com',pathname:'/message/default.htm'},
    GDATA:{user:{memberId:'synthetic-session'},system:{csrfTokenKey:'_csrf_token_',csrfTokenVal:'synthetic-csrf'}},
    document:{cookie:'xman_us_t=fixture&ctoken=synthetic-cookie'},AbortSignal,
    async fetch(url,options){
      const endpoint=url.split('?')[0];const body=Object.fromEntries(options.body);
      requests.push({endpoint,method:options.method,params:body.params??null});let data;
      if(overrides.failEndpoint===endpoint)return{ok:false,status:403,redirected:false,text:async()=>''};
      if(endpoint===legacy.ENDPOINTS.inquiry)data={code:200,data:{list:[[{id:101,createTime:from+1000,secTradeId:'synthetic-private-trade',...overrides.inquiry}]]}};
      else if(endpoint===legacy.ENDPOINTS.summary)data={code:200,data:{tradeId:101,cid:who.conversation_id,
        contact:{accountId:11,loginId:'synthetic001',accountIdEncrypt:'synthetic-encrypted-buyer',secAccountId:'synthetic-sec-buyer',...overrides.contact},
        owner:{accountId:22,accountIdEncrypt:'synthetic-encrypted-seller',...overrides.owner},...overrides.summary}};
      else if(endpoint===legacy.ENDPOINTS.session)data={token:'synthetic-session-token'};
      else if(endpoint===legacy.ENDPOINTS.messages)data=payload;
      else throw Error('unexpected_fixture_endpoint');
      return{ok:true,status:200,redirected:false,text:async()=>JSON.stringify(data)};
    }};
  return{env,requests};
}

async function windowRun(t,name,raw=reverse()) {
  const root=fixture(t,name),payload={code:'200',data:{list:[raw]}};
  prepareWindow({source:'data/source.json',store:'demobeta',browserMap:'data/browser-map.json',run:'data/run',
    from:iso(from),to:iso(to),asOf:iso(to+3600000),pageSize:20,maxPages:1,perConversationPages:1},root);
  const calls=[],requests=[];let proof;
  const runner=createWindowRunner({run:'data/run',threadId:'synthetic-owner',browserBinding:browserBinding('demobeta'),homePageId:'synthetic-home',messagePageId:'synthetic-message',
    homeCdp:{async send(method){assert.equal(method,'Runtime.evaluate');calls.push('identity');proof=storeProof('demobeta',read(join(root,'data/run/pending.json')).request_id);return{result:{value:proof}};}},
    messageCdp:{async send(method){assert.equal(method,'Runtime.evaluate');calls.push('message');const task=read(join(root,'data/run/pending.json')).task;
      const fixture=environment(payload);const value=await worker.observe(task,proof,legacy,binding,fixture.env);requests.push(...fixture.requests);return{result:{value}};}}
  },root);
  const summary=await runner.batch({steps:2});return{root,summary,calls,requests};
}

test('worker to event chain and handoff retains system-only partial coverage',async t=>{
  const {root,summary,calls,requests}=await windowRun(t,'v2');
  assert.deepEqual(calls,['identity','message','identity','message']);
  assert.deepEqual(requests.map(r=>r.endpoint),[legacy.ENDPOINTS.inquiry,legacy.ENDPOINTS.summary,worker.EXTRA_INFO,
    legacy.ENDPOINTS.inquiry,legacy.ENDPOINTS.summary,legacy.ENDPOINTS.session,legacy.ENDPOINTS.messages]);
  assert.ok(requests.every(r=>r.method==='POST'));assert.equal(requests.length,7);
  assert.equal(summary.pages_read,1);assert.equal(summary.status,'partial');assert.equal(summary.conversation_statuses.page_budget_reached,1);
  assert.equal(summary.history_complete,false);assert.equal(summary.excluded_inquiries,0);
  const inspected=inspectWindow('data/run',root);assert.equal(inspected.events.length,2);assert.equal(inspected.messages.size,1);
  assert.equal(inspected.events[1].observation.has_more,null);assert.equal(inspected.events[1].observation.row_meta[0].old_contact,false);
  assert.equal(inspected.state.conversations[0].history_evidence,null);assert.equal(existsSync(join(root,'data/run/pending.json')),false);
  const stored=[...inspected.messages.values()][0].message;assert.equal(stored.account_mapping.source_contact_account_id,'22');
  write(root,'data/spec.json',{store_key:'demobeta',owner_thread_id:'synthetic-owner',stage:'chat_ready',scope:{from:iso(from),to_exclusive:iso(to)},
    population_source:'data/source.json',chat_runs:['data/run'],reused_manifests:[],attachments:[],gaps:['Synthetic system-only page; buyer/seller dialogue is unverified; page budget reached.']});
  const delivered=publishHandoff({spec:'data/spec.json',out:'data/chat-ready.json'},root);
  assert.equal(delivered.inquiries,1);assert.equal(delivered.incomplete_inquiries,1);assert.equal(delivered.excluded,0);
  const handoff=read(join(root,'data/chat-ready.json'));assert.equal(handoff.analysis_status,'not_performed');assert.equal(handoff.formal_research_validation,'not_performed');
  assert.ok(handoff.evidence.every(e=>e.history_complete===false));
  const validated=validateChatRun({chatRun:'data/run',source:'data/source.json'},root);
  assert.equal(validated.messages.filter(r=>r.message.direction==='buyer'||r.message.direction==='seller').length,0);
  write(root,'data/regression-summary.json',{synthetic_only:true,real_platform_requests:0,status:summary.status,pages:1,events:2,
    raw_record_count:1,buyer_seller_dialogue_count:0,old_customer_exclusions:0,incomplete_inquiries:delivered.incomplete_inquiries,history_complete:false});
});

test('a system event before the window never becomes old-buyer contact evidence',async t=>{
  const {root,summary}=await windowRun(t,'pre-window',reverse({sendTime:from-1000}));
  assert.equal(summary.excluded_inquiries,0);assert.equal(summary.conversation_statuses.old_contact_detected,undefined);
  assert.equal(inspectWindow('data/run',root).events[1].observation.row_meta[0].old_contact,false);
  assert.equal(summary.history_complete,false);
});

test('system-only citation cannot establish buyer intent or deep communication',()=>{
  const ref={store_key:'demobeta',inquiry_id:'101',created_at:iso(from+1000)};
  const assessment=emptyOpportunityAssessment('synthetic-unit',ref,iso(to));assessment.review_state='reviewed';
  assessment.products=[{kind:'model',status:'requested',label:'MODEL-X',source_label:'MODEL-X',evidence_refs:['system']}];
  assessment.deep_communication={status:'Y',stage:'样品/订单推进',reason:'Synthetic attempt',evidence_refs:['system'],
    qualification:{path:'concrete_progress',product_evidence_refs:['system'],buyer_evidence_refs:['system'],proposal_evidence_refs:[]}};
  const m=legacy.normalizeMessage(reverse({content:'MODEL-X sample order'}),who);
  const evidence=[{id:'system',kind:'chat_message',chat_bound:true,unit_key:'synthetic-unit',...ref,scope:'current_purchase',
    quote:'MODEL-X sample order',sent_at:m.sent_at,observed_at:iso(to),direction:m.direction,reply_source:m.reply_source,automatic:false,content_status:m.content_status}];
  assert.throws(()=>buildOpportunityReview(assessment,evidence,ref),/opportunity_content_required/);
});

test('v1 evidence consumer accepts the explicit mapping without accepting buyer dialogue',async t=>{
  const root=fixture(t,'v1');prepare({source:'data/source.json',store:'demobeta',inquiryIds:['101'],run:'data/v1',browserMap:'data/browser-map.json',channel:'cua-cdp',pageSize:20,maxPages:1},root);
  const step=prepareStep('data/v1',{},root),ticket=read(join(root,'data/v1/pending.json')),previous=read(join(root,'data/v1/checkpoint.json'));
  const fixtureEnv=environment({code:'200',data:{list:[reverse()]}}),proof=storeProof('demobeta',step.request_id);
  const state=await legacy.step(ticket.config,previous,proof,fixtureEnv.env);
  assert.equal(state.targets[0].messages.length,1);assert.equal(state.targets[0].messages[0].direction,'system');
  write(root,'data/v1/fixture-response.json',{request_id:step.request_id,previous_sha256:ticket.previous_sha256,store_proof:proof,state});
  acceptStep('data/v1','data/v1/fixture-response.json',root);
  const result=validateChatRun({chatRun:'data/v1',source:'data/source.json'},root);
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].message.direction,'system');
  assert.equal(result.messages.filter(r=>r.message.direction==='buyer'||r.message.direction==='seller').length,0);
});

test('mapping metadata remains strict in state and observation validation',async t=>{
  const c={schema_version:legacy.VERSION,store_key:'demobeta',targets:[{inquiry_id:'101',buyer_member_id:'alibaba-visible-member:synthetic001'}],page_size:20,max_pages:1,snapshot_at_ms:to};
  const s=legacy.newState(c);s.targets[0].identity=who;s.targets[0].messages=[legacy.normalizeMessage(reverse(),who)];
  legacy.validateState(c,s);
  for(const altered of [{rule:'unknown'},{source_contact_account_id:'33'},{source_message_type:'send'},{source_view_type:3}]){
    const bad=structuredClone(s);Object.assign(bad.targets[0].messages[0].account_mapping,altered);
    assert.throws(()=>legacy.validateState(c,bad),/invalid_account_mapping/);
  }
  const {root}=await windowRun(t,'tamper');const manifest=read(join(root,'data/run/config.json'));
  assert.ok(manifest.pins.legacy);const event=read(join(root,'data/run/event-2.json'));
  const page=readFileSync(join(root,'data/run/page-2.jsonl'),'utf8');writeFileSync(join(root,'data/run/page-2.jsonl'),page.replace('system_reverse_pair_v1','unverified'));
  assert.throws(()=>inspectWindow('data/run',root),/delta_changed/);writeFileSync(join(root,'data/run/page-2.jsonl'),page);
  assert.equal(inspectWindow('data/run',root).events[1].state_sha256,event.state_sha256);
});

test('worker source gates precede mapping and keep their bounded request counts',async()=>{
  const task={kind:'page',store_key:'demobeta',request_id:'synthetic-gates',browser_binding:browserBinding('demobeta'),
    target:{inquiry_id:'101',buyer_member_id:'alibaba-visible-member:synthetic001',created_at_ms:from+1000},identity:who,cursor:null,page_size:20,session_member_id:'synthetic-session'};
  for(const [override,error,count] of [[{inquiry:{createTime:from}},'inquiry_creation_changed',1],[{contact:{loginId:'other001'}},'inquiry_buyer_mismatch',2],
    [{summary:{cid:'other-conversation'}},'conversation_identity_changed',2],[{owner:{accountIdEncrypt:null}},'missing_conversation_locator',2],
    [{failEndpoint:legacy.ENDPOINTS.messages},'http_403',4]]){
    const f=environment({code:200,data:{list:[reverse()]}},override);const result=await worker.observe(task,storeProof('demobeta',task.request_id),legacy,binding,f.env);
    assert.equal(result.error,error);assert.equal(result.rows.length,0);assert.equal(f.requests.length,count);
  }
});
