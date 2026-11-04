import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {resolve, dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import legacy from './alibaba_chat_collector.js';
import {dataPath, assertNoPrivateTransport} from './chat_collection.mjs';
import {pickCountry} from './country.mjs';
import binding from '../lib/store_binding.js';

export const VERSION = 'alibaba-chat-window-v2';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = {legacy:'scripts/alibaba_chat_collector.js', browser:'scripts/alibaba_chat_window.js',
  binding:'lib/store_binding.js', workflow:'scripts/chat_window.mjs'};
// Public distributions accept only their published current source pins.
const check = (ok, code) => { if (!ok) throw new Error(code); };
const hash = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : legacy.canonical(x)).digest('hex');
const same = (a,b) => legacy.canonical(a) === legacy.canonical(b);
const json = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/,''));
const local = (p,root) => relative(root,p).replaceAll('\\','/');
const stamp = value => {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value), 'explicit_timezone_required');
  const day=new Date(value.slice(0,10)+'T00:00:00Z');
  check(Number.isFinite(Date.parse(value))&&Number.isFinite(day.getTime())&&day.toISOString().slice(0,10)===value.slice(0,10),'invalid_timestamp');
  return Date.parse(value);
};
const count = (value,min,max) => Number.isInteger(value) && value >= min && value <= max;
const BUYER_FACT_KEYS = 'buyer_level buyer_level_legacy company_name extra_error high_quality join_year list_country_code list_country_name list_name summary_country_code summary_name';
function atomic(p, text) { const tmp = `${p}.${randomUUID()}.tmp`; writeFileSync(tmp,text,{flag:'wx',mode:0o600}); renameSync(tmp,p); }
function writeJson(p, value) { atomic(p,JSON.stringify(value,null,2)+'\n'); }
function exact(p,text) {
  if (existsSync(p)) {
    const old=readFileSync(p), next=Buffer.from(text);
    if (old.equals(next)) return;
    check(old.length < next.length && next.subarray(0,old.length).equals(old),'existing_artifact_conflict');
  }
  atomic(p,text);
}
function locked(run, root, action) {
  const dir=dataPath(run,root), path=dataPath(join(dir,'.write.lock'),root);
  const fd=openSync(path,'wx');
  try { return action(dir); } finally { closeSync(fd); unlinkSync(path); }
}
function initial(c) {
  return {schema_version:VERSION,revision:0,chain:null,status:'resolving',store_error:null,session_member_id:null,pages_read:0,
    max_pages:c.max_pages,per_conversation_pages:c.per_conversation_pages,
    targets:c.targets.map(t=>({...t,status:'pending',conversation_key:null,error:null})),conversations:[]};
}
const terminal = status => ['old_contact_detected','window_complete','endpoint_exhausted','incremental_complete'].includes(status);
function refresh(s) {
  for(const c of s.conversations) if(c.status==='ready'&&(s.pages_read>=s.max_pages||c.pages_read>=s.per_conversation_pages))c.status='page_budget_reached';
  if(s.store_error) s.status='blocked';
  else if(s.targets.some(t=>t.status==='pending')) s.status='resolving';
  else if(s.pages_read < s.max_pages && s.conversations.some(c=>c.status==='ready' && c.pages_read<s.per_conversation_pages)) s.status='ready';
  else if(s.targets.some(t=>t.status==='needs_review') || s.conversations.some(c=>!terminal(c.status))) s.status='partial';
  else s.status='completed';
  return s;
}
export function summarize(s) {
  const counts={}; for(const c of s.conversations) counts[c.status]=(counts[c.status]||0)+1;
  return {schema_version:VERSION,status:s.status,revision:s.revision,pages_read:s.pages_read,targets:s.targets.length,
    resolved_targets:s.targets.filter(t=>t.status==='resolved').length,unresolved_targets:s.targets.filter(t=>t.status!=='resolved').length,
    conversations:s.conversations.length,conversation_statuses:counts,store_error:s.store_error,
    current_message_count:s.conversations.reduce((n,c)=>n+c.message_count,0),
    excluded_inquiries:s.targets.filter(t=>s.conversations.find(c=>c.key===t.conversation_key)?.status==='old_contact_detected').length,
    history_complete:false,company_new_customer_confirmed:false};
}
export function prepareWindow({source,store,run,browserMap,channel='cua-cdp',from,to,asOf=new Date().toISOString(),messagesAfter,inquiryIds,
  pageSize=20,maxPages=200,perConversationPages=5},root=ROOT) {
  const dir=dataPath(run,root), sourcePath=dataPath(source,root), bundle=json(sourcePath);
  check(!existsSync(dir),'run_already_exists');
  const start=stamp(from),end=stamp(to),snapshot=stamp(asOf);
  check(start<end && end<=snapshot && snapshot<=Date.now()+1000,'invalid_window');
  const after=messagesAfter===undefined?undefined:stamp(messagesAfter);
  check(after===undefined||(after>=start&&after<snapshot),'invalid_incremental_boundary');
  check(count(pageSize,1,100)&&count(maxPages,1,10000)&&count(perConversationPages,1,1000),'invalid_page_budget');
  check(bundle.store_key===store && Array.isArray(bundle.inquiries) && Array.isArray(bundle.buyer_member_links),'invalid_source_bundle');
  const ids=inquiryIds ?? bundle.inquiries.map(t=>t.inquiry_id);
  check(Array.isArray(ids)&&ids.length>0&&ids.length<=500&&new Set(ids).size===ids.length,'explicit_unique_inquiry_ids_required');
  const targets=ids.map(id=>{
    check(typeof id==='string'&&/^\d{1,20}$/.test(id),'invalid_inquiry_id');
    const rows=bundle.inquiries.filter(t=>t.inquiry_id===id&&t.store_key===store);
    const links=bundle.buyer_member_links.filter(t=>t.inquiry_id===id&&t.store_key===store);
    check(rows.length===1&&links.length===1&&links[0].source_system==='alibaba-message-querySummary-contact-loginId-v1','verified_buyer_link_required');
    check(/^alibaba-visible-member:[a-z0-9]{3,64}$/i.test(links[0].buyer_member_id),'buyer_link_required');
    const created=stamp(rows[0].created_at); check(created>=start&&created<end,'inquiry_outside_window');
    return {inquiry_id:id,buyer_member_id:links[0].buyer_member_id,created_at_ms:created};
  });
  const route=binding.resolve(json(dataPath(browserMap,root)),store,channel);
  const pins=Object.fromEntries(Object.entries(CODE).map(([k,p])=>[k,hash(readFileSync(join(root,p)))]));
  const c={schema_version:VERSION,store_key:store,browser_binding:route,source:local(sourcePath,root),source_sha256:hash(readFileSync(sourcePath)),
    from_ms:start,to_ms:end,snapshot_at_ms:snapshot,time_zone:'Asia/Shanghai',targets,page_size:pageSize,max_pages:maxPages,
    per_conversation_pages:perConversationPages,pins};
  if(after!==undefined)c.messages_after_ms=after;
  mkdirSync(join(dir,'runtime'),{recursive:true});
  for(const [k,p] of Object.entries(CODE)) writeFileSync(join(dir,'runtime',`${k}.txt`),readFileSync(join(root,p)),{flag:'wx',mode:0o600});
  writeJson(join(dir,'config.json'),c);writeJson(join(dir,'checkpoint.json'),initial(c));
  return {run:dir,...summarize(initial(c))};
}
function taskFor(c,s,requestId) {
  check(!s.store_error,'store_review_required');
  const target=s.targets.find(t=>t.status==='pending');
  let conversation;
  if(!target) {
    check(s.pages_read<s.max_pages,'page_budget_reached');
    conversation=s.conversations.filter(v=>v.status==='ready'&&v.pages_read<s.per_conversation_pages)
      .sort((a,b)=>a.pages_read-b.pages_read||a.order-b.order)[0];
    check(conversation,'no_ready_conversations');
  }
  const selected=target ?? s.targets.find(t=>t.inquiry_id===conversation.representative);
  return {kind:target?'resolve':'page',request_id:requestId,store_key:c.store_key,browser_binding:c.browser_binding,
    target:{inquiry_id:selected.inquiry_id,buyer_member_id:selected.buyer_member_id,created_at_ms:selected.created_at_ms},
    identity:conversation?.identity??null,conversation_key:conversation?.key??null,cursor:conversation?.cursor??null,
    page_size:c.page_size,session_member_id:s.session_member_id};
}
const targetErrors=new Set(['inquiry_not_uniquely_resolved','inquiry_creation_changed','inquiry_buyer_mismatch','message_buyer_mismatch',
  'conversation_identity_changed','missing_conversation_locator','invalid_conversation_identity','invalid_message_response',
  'invalid_message','invalid_message_time','invalid_message_type','unknown_direction','page_size_exceeded','invalid_has_more',
  'unordered_page','cursor_out_of_range','duplicate_within_page','empty_page_with_more','conflicting_duplicate']);
function descriptor(m) {
  return {id:m.message_id,time:m.send_time_ms,sha256:hash(m),old_contact:m.direction==='buyer'&&m.content_status!=='recalled_or_hidden'&&
    m.reply_source!=='ai'&&!Object.values(m.automation_flags).some(v=>v===true)&&Boolean(m.text||m.source_content||m.attachments.length)};
}
function validateObservation(c,s,task,o) {
  assertNoPrivateTransport(o);
  check(o.request_id===task.request_id&&o.kind===task.kind&&Array.isArray(o.rows),'invalid_observation');
  binding.proof(o.store_proof,c.store_key,c.browser_binding,task.request_id,false);
  check(Number.isSafeInteger(o.observed_at_ms)&&o.observed_at_ms>=o.store_proof.observed_at_ms&&
    o.observed_at_ms-o.store_proof.observed_at_ms<300000,'expired_observation');
  check(o.error===null||typeof o.error==='string'&&/^[a-z0-9_]+$/.test(o.error),'invalid_error');
  if(o.error) {check(o.rows.length===0,'failed_page_has_rows');return;}
  check(typeof o.session_member_id==='string'&&o.session_member_id&&(!s.session_member_id||s.session_member_id===o.session_member_id),'session_changed');
  check(o.identity&&Object.keys(o.identity).sort().join(' ')==='buyer_account_id conversation_id owner_account_id'&&
    Object.values(o.identity).every(v=>typeof v==='string'&&v&&!/[\s<>]/.test(v)),'invalid_conversation_identity');
  check(!task.identity||same(task.identity,o.identity),'conversation_identity_changed');
  check(o.has_more===null||typeof o.has_more==='boolean','invalid_has_more');
  check(o.rows.length<=c.page_size&&new Set(o.rows.map(m=>m.message_id)).size===o.rows.length,'invalid_page_rows');
  check(!(task.kind==='page'&&o.rows.length===0&&o.has_more===true),'empty_page_with_more');
  if(task.kind==='resolve') check(o.rows.length===0,'resolve_contains_messages');
  if(o.buyer_facts!==undefined) {
    check(task.kind==='resolve'&&o.buyer_facts&&typeof o.buyer_facts==='object'&&Object.keys(o.buyer_facts).sort().join(' ')===BUYER_FACT_KEYS,'invalid_buyer_facts');
    for(const [k,v] of Object.entries(o.buyer_facts)) check(v===null||(k==='high_quality'?typeof v==='boolean':typeof v==='string'&&v.length<=200&&!/[<>]/.test(v)),'invalid_buyer_facts');
  }
  const lc={schema_version:legacy.VERSION,store_key:c.store_key,targets:[{inquiry_id:task.target.inquiry_id,buyer_member_id:task.target.buyer_member_id}],
    page_size:c.page_size,max_pages:1,snapshot_at_ms:8640000000000000};
  const ls=legacy.newState(lc);ls.targets[0].identity=o.identity;ls.targets[0].messages=o.rows;
  legacy.validateState(lc,ls);
  for(const [i,m] of o.rows.entries()) {
    check(m.buyer_account_id===o.identity.buyer_account_id,'message_buyer_mismatch');
    check(m.sent_at===new Date(m.send_time_ms).toISOString()&&(!i||o.rows[i-1].send_time_ms>=m.send_time_ms),'unordered_page');
    check(task.cursor===null||m.send_time_ms<=task.cursor,'cursor_out_of_range');
    check(legacy.cleanText(m.text)===m.text&&(m.source_content===null||legacy.sourceContent(m.source_content).source_content===m.source_content),'unsanitized_message');
    check(['buyer','seller','system'].includes(m.direction)&&m.direction===(m.type===2?'system':m.sender_account_id===m.buyer_account_id?'buyer':'seller'),'invalid_message_direction');
    check(m.content_status!=='recalled_or_hidden'||(m.text===''&&m.source_content===null&&m.source_content_format==='withheld'&&m.attachments.length===0),'hidden_message_body_present');
  }
}
function apply(c,previous,task,meta,seen) {
  const s=structuredClone(previous);const t=s.targets.find(v=>v.inquiry_id===task.target.inquiry_id);
  let conv=s.conversations.find(v=>v.key===task.conversation_key);
  if(meta.error) {
    if(targetErrors.has(meta.error)) {if(conv){conv.status='needs_review';conv.error=meta.error;}else{t.status='needs_review';t.error=meta.error;}}
    else s.store_error=meta.error;
    s.revision++;refresh(s);return {state:s,keep:[]};
  }
  check(!s.session_member_id||s.session_member_id===meta.session_member_id,'session_changed');s.session_member_id=meta.session_member_id;
  if(task.kind==='resolve') {
    const key=hash([c.store_key,meta.identity.owner_account_id,meta.identity.buyer_account_id,meta.identity.conversation_id]);
    conv=s.conversations.find(v=>v.key===key);
    if(!conv) {conv={key,identity:meta.identity,buyer_member_id:t.buyer_member_id,representative:t.inquiry_id,order:s.conversations.length,
      inquiry_ids:[],from_ms:Math.max(t.created_at_ms,c.messages_after_ms===undefined?0:c.messages_after_ms+1),cursor:null,pages_read:0,message_count:0,status:'ready',error:null,history_evidence:null};s.conversations.push(conv);}
    check(conv.buyer_member_id===t.buyer_member_id,'conversation_member_conflict');
    conv.inquiry_ids.push(t.inquiry_id);conv.from_ms=Math.min(conv.from_ms,Math.max(t.created_at_ms,c.messages_after_ms===undefined?0:c.messages_after_ms+1));t.conversation_key=key;t.status='resolved';
    if(meta.buyer_facts)t.buyer_facts={...meta.buyer_facts,observed_at:new Date(meta.observed_at_ms).toISOString()};
    s.revision++;refresh(s);return {state:s,keep:[]};
  }
  check(conv&&same(conv.identity,meta.identity),'conversation_identity_changed');
  const rows=meta.row_meta;
  const old=c.messages_after_ms===undefined?rows.find(r=>r.time<c.from_ms&&r.old_contact):undefined;
  const keep=[];
  for(const r of rows) {
    const key=`${conv.key}:${r.id}`,before=seen.get(key);
    check(!before||before===r.sha256,'conflicting_duplicate');
    if(!before && ((r.time>=conv.from_ms&&r.time<=c.snapshot_at_ms)||r===old)) keep.push(r.id);
    seen.set(key,r.sha256);
  }
  conv.message_count+=rows.filter(r=>keep.includes(r.id)&&r.time>=conv.from_ms&&r.time<=c.snapshot_at_ms).length;
  conv.pages_read++;s.pages_read++;
  const next=rows.length?rows.at(-1).time:conv.cursor;
  const boundary=rows.length&&task.cursor!==null&&next>=task.cursor?'cursor_stalled':
    rows.length===c.page_size&&rows.filter(r=>r.time===next).length>1?'timestamp_boundary_ambiguous':null;
  conv.cursor=next;
  if(old) {
    const evidence={conversation_key:conv.key,message_id:old.id,sent_at:new Date(old.time).toISOString(),sha256:old.sha256};
    for(const v of s.conversations) if(v.buyer_member_id===conv.buyer_member_id&&v.identity.buyer_account_id===conv.identity.buyer_account_id) {
      v.status='old_contact_detected';v.history_evidence=evidence;
    }
  }
  else if(c.messages_after_ms!==undefined&&rows.some(r=>r.time<=c.messages_after_ms)) conv.status='incremental_complete';
  else if(boundary) {conv.status='needs_review';conv.error=boundary;}
  else if(rows.some(r=>r.time<c.from_ms)) conv.status='window_complete';
  else if(rows.length===0||meta.has_more===false) conv.status='endpoint_exhausted';
  else if(conv.pages_read>=s.per_conversation_pages) conv.status='page_budget_reached';
  s.revision++;refresh(s);return {state:s,keep};
}
function transition(c,s,task,meta,seen) {
  const nextSeen=new Map(seen);
  try {return {...apply(c,s,task,meta,nextSeen),seen:nextSeen,local_error:null};}
  catch(error) {
    if(error.message!=='conflicting_duplicate')throw error;
    // The earlier accepted message wins. Record the conflict and isolate this conversation.
    return {...apply(c,s,task,{...meta,error:error.message},seen),seen,local_error:error.message};
  }
}
function files(dir) { return readdirSync(dir).filter(n=>/^event-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])); }
function load(run,root,repair=false) {
  const dir=dataPath(run,root),c=json(dataPath(join(dir,'config.json'),root));check(c.schema_version===VERSION,'not_window_v2');
  check(hash(readFileSync(dataPath(c.source,root)))===c.source_sha256,'source_changed');
  const artifacts={};
  for(const k of Object.keys(CODE)) {
    const p=dataPath(join(dir,'runtime',`${k}.txt`),root);check(hash(readFileSync(p))===c.pins[k],'runtime_changed');
    const current=hash(readFileSync(join(root,CODE[k])));
    const replayOnly=false;
    check(current===c.pins[k]||replayOnly,'workflow_version_changed');artifacts[local(p,root)]=hash(readFileSync(p));
  }
  let s=initial(c),seen=new Map();const messages=new Map(),events=[];const cp=json(dataPath(join(dir,'checkpoint.json'),root));let cpVerified=cp.revision===0&&same(cp,s);
  for(const name of files(dir)) {
    const p=dataPath(join(dir,name),root),event=json(p);check(event.revision===s.revision+1&&name===`event-${event.revision}.json`,'event_chain_gap');
    check(event.previous_hash===s.chain&&event.ticket.previous_sha256===hash(s)&&event.ticket.config_sha256===hash(c),'event_chain_changed');
    if(event.control) {
      check(event.control.reviewed===true&&typeof event.control.reason==='string'&&event.control.reason.trim(),'review_required');
      check(count(event.control.max_pages,s.max_pages,10000)&&count(event.control.per_conversation_pages,s.per_conversation_pages,1000),'invalid_page_budget');
      s.max_pages=event.control.max_pages;s.per_conversation_pages=event.control.per_conversation_pages;
      s.store_error=null;
      for(const v of s.conversations) if(v.status==='page_budget_reached')v.status='ready';
      if(event.control.inquiry_id) {
        const t=s.targets.find(t=>t.inquiry_id===event.control.inquiry_id);check(t,'unknown_target');
        if(t.status==='needs_review'){t.status='pending';t.error=null;}
        const v=s.conversations.find(v=>v.key===t.conversation_key);if(v?.status==='needs_review'){v.status='ready';v.error=null;}
      }
      s.revision++;refresh(s);
    } else {
      const expected=taskFor(c,s,event.ticket.request_id);check(same(expected,event.ticket.task),'task_changed');
      const obs=event.observation;
      binding.proof(obs.store_proof,c.store_key,c.browser_binding,event.ticket.request_id,false);
      check(obs.observed_at_ms>=obs.store_proof.observed_at_ms&&obs.observed_at_ms-obs.store_proof.observed_at_ms<300000,'expired_observation');
      const deltaPath=dataPath(join(dir,`page-${event.revision}.jsonl`),root),text=readFileSync(deltaPath,'utf8');
      check(hash(text)===event.delta_sha256,'delta_changed');
      const delta=text.trim()?text.trim().split('\n').map(JSON.parse):[];
      for(const m of delta) {const d=obs.row_meta.find(r=>r.id===m.message_id);check(d&&same(d,descriptor(m)),'delta_content_changed');}
      const result=transition(c,s,expected,obs,seen);
      check(event.local_error===result.local_error,'local_error_changed');
      check(same(delta.map(m=>m.message_id),result.keep),'delta_selection_changed');s=result.state;seen=result.seen;
      for(const m of delta)messages.set(`${expected.conversation_key}:${m.message_id}`,{conversation_key:expected.conversation_key,message:m});
      artifacts[local(deltaPath,root)]=hash(text);
    }
    s.chain=hash(event);check(event.state_sha256===hash({...s,chain:null}),'state_changed');
    events.push(event);artifacts[local(p,root)]=hash(readFileSync(p));
    if(cp.revision===s.revision)cpVerified=same(cp,s);
  }
  check(cpVerified,'checkpoint_changed');
  if(repair&&cp.revision<s.revision)writeJson(join(dir,'checkpoint.json'),s);
  if(repair&&existsSync(join(dir,'pending.json'))) {
    const pending=json(join(dir,'pending.json'));
    // A durable event is the commit point. A crash may leave its checkpoint/pending cleanup unfinished.
    if(events.some(e=>same(e.ticket,pending))) {
      unlinkSync(join(dir,'pending.json'));
      const response=join(dir,'pending.response.json');
      if(existsSync(response)&&json(response).request_id===pending.request_id)unlinkSync(response);
    }
  }
  artifacts[local(join(dir,'config.json'),root)]=hash(readFileSync(join(dir,'config.json')));
  artifacts[c.source]=c.source_sha256;
  return {dir,config:c,state:s,seen,messages,events,artifacts};
}
function next(ctx) {
  const {dir,config:c,state:s}=ctx;const path=join(dir,'pending.json');let ticket;
  if(existsSync(path)) {ticket=json(path);check(ticket.previous_sha256===hash(s)&&ticket.config_sha256===hash(c),'pending_changed');check(same(taskFor(c,s,ticket.request_id),ticket.task),'pending_task_changed');}
  else {const id=randomUUID();ticket={request_id:id,previous_sha256:hash(s),config_sha256:hash(c),task:taskFor(c,s,id)};writeJson(path,ticket);}
  const source=k=>readFileSync(join(dir,'runtime',`${k}.txt`),'utf8');
  const mod=(name,text)=>`const ${name}=(()=>{const module={exports:{}};${text}\nreturn module.exports;})();\n`;
  const identity=`(async()=>{${mod('binding',source('binding'))}return binding.probe(${JSON.stringify(c.browser_binding)},${JSON.stringify(ticket.request_id)},${JSON.stringify(c.store_key)});})()`;
  const script=`async function(proof){${mod('legacy',source('legacy'))}${mod('binding',source('binding'))}${mod('worker',source('browser'))}return worker.observe(${JSON.stringify(ticket.task)},proof,legacy,binding);}`;
  writeJson(join(dir,'pending.json'),ticket);
  atomic(join(dir,'pending.identity.js'),identity);atomic(join(dir,'pending.browser.js'),script);
  const response=join(dir,'pending.response.json');
  return {ticket,script:join(dir,'pending.browser.js'),identity_script:join(dir,'pending.identity.js'),browser_binding:c.browser_binding,kind:ticket.task.kind,
    response:existsSync(response)?response:null};
}
function accept(ctx,observation) {
  const {dir,config:c,state:s}=ctx;
  if(!existsSync(join(dir,'pending.json'))) {
    const prior=ctx.events.find(e=>e.ticket.request_id===observation.request_id);
    const meta={...observation,row_meta:observation.rows.map(descriptor)};delete meta.rows;
    check(prior&&same(prior.observation,meta),'no_matching_pending');return summarize(s);
  }
  const ticket=json(join(dir,'pending.json'));
  check(ticket.previous_sha256===hash(s)&&ticket.config_sha256===hash(c)&&same(ticket.task,taskFor(c,s,ticket.request_id)),'pending_changed');
  validateObservation(c,s,ticket.task,observation);
  // Keep only the current page until its event is durable, so a local failure needs no browser reread.
  exact(join(dir,'pending.response.json'),legacy.canonical(observation)+'\n');
  const meta={...observation,row_meta:observation.rows.map(descriptor)};delete meta.rows;
  const result=transition(c,s,ticket.task,meta,ctx.seen),delta=observation.rows.filter(m=>result.keep.includes(m.message_id));
  const text=delta.map(m=>legacy.canonical(m)).join('\n')+(delta.length?'\n':'');
  const event={revision:result.state.revision,previous_hash:s.chain,ticket,observation:meta,local_error:result.local_error,delta_sha256:hash(text),state_sha256:hash({...result.state,chain:null})};
  exact(join(dir,`page-${event.revision}.jsonl`),text);exact(join(dir,`event-${event.revision}.json`),JSON.stringify(event,null,2)+'\n');
  result.state.chain=hash(event);writeJson(join(dir,'checkpoint.json'),result.state);
  // A successful write call is not sufficient: verify this page before the next browser request.
  check(hash(readFileSync(join(dir,`page-${event.revision}.jsonl`)))===event.delta_sha256,'delta_write_not_verified');
  check(same(json(join(dir,`event-${event.revision}.json`)),event),'event_write_not_verified');
  check(same(json(join(dir,'checkpoint.json')),result.state),'checkpoint_write_not_verified');
  unlinkSync(join(dir,'pending.response.json'));unlinkSync(join(dir,'pending.json'));
  ctx.state=result.state;ctx.seen=result.seen;ctx.events.push(event);
  for(const m of delta)ctx.messages.set(`${ticket.task.conversation_key}:${m.message_id}`,{conversation_key:ticket.task.conversation_key,message:m});
  return {...summarize(ctx.state),last_step_error:meta.error||result.local_error||ctx.state.conversations.find(v=>v.key===ticket.task.conversation_key)?.error||null};
}
export function nextWindow(run,root=ROOT) {return locked(run,root,()=>{const ctx=load(run,root,true);return next(ctx);});}
export function acceptWindow(run,observation,root=ROOT) {return locked(run,root,()=>accept(load(run,root,true),observation));}
export function windowStatus(run,root=ROOT) {return summarize(load(run,root).state);}
export function resumeWindow(run,{reason,inquiryId,maxPages,perConversationPages,reviewed=false},root=ROOT) {
  return locked(run,root,()=>{
    const ctx=load(run,root,true),{dir,config:c,state:s}=ctx;check(!existsSync(join(dir,'pending.json')),'resolve_pending_first');
    check(reviewed&&typeof reason==='string'&&reason.trim(),'review_required');
    const control={reviewed,reason,inquiry_id:inquiryId??null,max_pages:maxPages??s.max_pages,per_conversation_pages:perConversationPages??s.per_conversation_pages};
    check(count(control.max_pages,s.max_pages,10000)&&count(control.per_conversation_pages,s.per_conversation_pages,1000),'invalid_page_budget');
    const after=structuredClone(s);after.store_error=null;after.max_pages=control.max_pages;after.per_conversation_pages=control.per_conversation_pages;
    for(const v of after.conversations)if(v.status==='page_budget_reached')v.status='ready';
    if(inquiryId){const t=after.targets.find(t=>t.inquiry_id===inquiryId);check(t,'unknown_target');if(t.status==='needs_review'){t.status='pending';t.error=null;}
      const v=after.conversations.find(v=>v.key===t.conversation_key);if(v?.status==='needs_review'){v.status='ready';v.error=null;}}
    after.revision++;refresh(after);
    const event={revision:after.revision,previous_hash:s.chain,ticket:{previous_sha256:hash(s),config_sha256:hash(c)},control,state_sha256:hash({...after,chain:null})};
    exact(join(dir,`event-${event.revision}.json`),JSON.stringify(event,null,2)+'\n');after.chain=hash(event);writeJson(join(dir,'checkpoint.json'),after);return summarize(after);
  });
}
/** Adapter must use the already bound authorized pages; never print its private return. */
export async function runWindowBatch(run,adapter,{steps=3,signal}={},root=ROOT) {
  check(count(steps,1,5),'batch_limit_1_to_5');
  check(adapter?.existingPagesOnly===true&&adapter.backgroundOnly===true&&typeof adapter.execute==='function','background_adapter_required');
  const dir=dataPath(run,root),path=join(dir,'.write.lock'),fd=openSync(path,'wx');
  try {
    const ctx=load(run,root,true);check(!existsSync(join(dir,'pending.json')),'pending_requires_review');let completed=0;const deadline=Date.now()+45000;
    while(completed<steps&&Date.now()<deadline&&!signal?.aborted&&['ready','resolving'].includes(ctx.state.status)) {
      const step=next(ctx);
      // execute freshly probes seller identity, executes one observation and returns in memory.
      // Transport failure deliberately leaves the same ticket pending; no automatic retry.
      const observation=await adapter.execute(step);
      const accepted=accept(ctx,observation);completed++;
      if(accepted.last_step_error||observation.boundary_error)break;
    }
    return {...summarize(ctx.state),steps_completed:completed,cancelled:Boolean(signal?.aborted)};
  } finally {closeSync(fd);unlinkSync(path);}
}
/** Replays hashes/transitions read-only. No browser calls and no changes to old v1 runs. */
export function inspectWindow(run,root=ROOT) {return load(run,root);}
function reviewRecords(ctx) {
  return ctx.state.targets.map(t=>{
    const conv=ctx.state.conversations.find(v=>v.key===t.conversation_key);
    return {...t,platform_facts:platformFacts(t.buyer_facts),chat_status:conv?.status??t.status,excluded_from_new_customer_review:conv?.status==='old_contact_detected',
      exclusion_reason:conv?.status==='old_contact_detected'?'老客户／窗口前已有沟通':null,history_evidence:conv?.history_evidence??null};
  });
}
/** 采集时取得的平台资料 → 统一口径；没取到的保持 null，不当成“没有”。 */
function platformFacts(f) {
  if(!f)return null;
  const picked=pickCountry([['subjectList.sender.countryCode',f.list_country_code],['querySummary.contact.countryCode',f.summary_country_code],['subjectList.sender.countryName',f.list_country_name]]);
  return {country_code:picked.country?.code??null,country:picked.country?.zh??null,country_en:picked.country?.en??null,country_source:picked.source,
    country_conflict:picked.conflict,country_unrecognized:picked.unrecognized.length?picked.unrecognized:null,
    buyer_level:/^L\d+$/.test(f.buyer_level||'')?f.buyer_level:null,buyer_level_raw:f.buyer_level,join_year:f.join_year,
    platform_company_name:f.company_name,high_quality_buyer:f.high_quality,extra_error:f.extra_error,observed_at:f.observed_at};
}
function exportPath(ctx,out,root) {
  const path=dataPath(out,root),inside=relative(ctx.dir,path);
  check(inside&& (inside==='..'||inside.startsWith('../')||inside.startsWith('..\\')),'export_outside_run_required');
  mkdirSync(dirname(path),{recursive:true});return path;
}
/** A new research queue; the immutable source and complete ledger retain all excluded inquiries. */
export function exportReviewCohort(run,out,root=ROOT) {
  const ctx=load(run,root),{config:c,state:s}=ctx;
  check(!existsSync(join(ctx.dir,'pending.json')),'resolve_pending_first');
  const records=reviewRecords(ctx),ids=new Set(records.filter(t=>!t.excluded_from_new_customer_review).map(t=>t.inquiry_id)),source=json(dataPath(c.source,root));
  const cohort={schema_version:'lew.window-review-bundle.v1',store_key:c.store_key,
    inquiries:source.inquiries.filter(t=>t.store_key===c.store_key&&ids.has(t.inquiry_id)),
    buyer_member_links:source.buyer_member_links.filter(t=>t.store_key===c.store_key&&ids.has(t.inquiry_id)),
    coverage:{status:s.status,chat:summarize(s),public_research:'not_performed'},
    window_collection:{run:local(ctx.dir,root),revision:s.revision,source:c.source,source_sha256:c.source_sha256,
      from_inclusive:new Date(c.from_ms).toISOString(),to_exclusive:new Date(c.to_ms).toISOString(),time_zone:c.time_zone,
      excluded_inquiries:records.filter(t=>t.excluded_from_new_customer_review)}};
  const path=exportPath(ctx,out,root);exact(path,JSON.stringify(cohort,null,2)+'\n');
  return {out:path,eligible_inquiries:ids.size,excluded_inquiries:records.length-ids.size,chat_status:s.status};
}
export function exportWindow(run,out,root=ROOT) {
  const ctx=load(run,root),{config:c,state:s}=ctx;
  check(!existsSync(join(ctx.dir,'pending.json')),'resolve_pending_first');
  const records=reviewRecords(ctx);
  const messages=[...ctx.messages.values()].map(r=>{
    const conv=s.conversations.find(v=>v.key===r.conversation_key);
    return {store_key:c.store_key,conversation_id:conv.identity.conversation_id,buyer_member_id:conv.buyer_member_id,
      inquiry_ids:records.filter(t=>t.conversation_key===conv.key&&r.message.send_time_ms>=t.created_at_ms&&r.message.send_time_ms<=c.snapshot_at_ms).map(t=>t.inquiry_id),
      supplemental_history:r.message.send_time_ms<c.from_ms,excluded_from_new_customer_review:conv.status==='old_contact_detected',message:r.message};
  });
  const view={schema_version:VERSION,scope:{from:new Date(c.from_ms).toISOString(),to_exclusive:new Date(c.to_ms).toISOString(),as_of:new Date(c.snapshot_at_ms).toISOString(),time_zone:c.time_zone},
    summary:summarize(s),records,messages,artifacts_sha256:ctx.artifacts,
    coverage:{chat:summarize(s),public_research:'not_performed',profile_review:'not_performed',formal_due_diligence:'not_performed'}};
  if(c.messages_after_ms!==undefined)view.scope.messages_after_exclusive=new Date(c.messages_after_ms).toISOString();
  const path=exportPath(ctx,out,root);exact(path,JSON.stringify(view,null,2)+'\n');return {out:path,...view.summary};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,...args]=process.argv.slice(2),a={};
    for(let i=0;i<args.length;i+=2){check(args[i].startsWith('--')&&args[i+1]&&!args[i+1].startsWith('--'),'invalid_argument');check(!Object.hasOwn(a,args[i]),'duplicate_argument');a[args[i]]=args[i+1];}
    const allowed=['--source','--store','--run','--browser-map','--channel','--from','--to','--as-of','--messages-after','--inquiry','--page-size','--max-pages','--per-conversation-pages','--response','--out','--reason','--reviewed'];
    check(Object.keys(a).every(k=>allowed.includes(k)),'unknown_argument');let result;
    if(action==='prepare')result=prepareWindow({source:a['--source'],store:a['--store'],run:a['--run'],browserMap:a['--browser-map'],channel:a['--channel'],from:a['--from'],to:a['--to'],asOf:a['--as-of'],messagesAfter:a['--messages-after'],inquiryIds:a['--inquiry']?.split(','),pageSize:Number(a['--page-size']??20),maxPages:Number(a['--max-pages']??200),perConversationPages:Number(a['--per-conversation-pages']??5)});
    else if(action==='next'){const step=nextWindow(a['--run']);result={script:step.script,identity_script:step.identity_script,browser_binding:step.browser_binding,kind:step.kind,response:step.response};}
    else if(action==='accept')result=acceptWindow(a['--run'],json(dataPath(a['--response'])));
    else if(action==='status'||action==='validate')result=windowStatus(a['--run']);
    else if(action==='export')result=exportWindow(a['--run'],a['--out']);
    else if(action==='cohort')result=exportReviewCohort(a['--run'],a['--out']);
    else if(action==='resume')result=resumeWindow(a['--run'],{reason:a['--reason'],reviewed:a['--reviewed']==='true',inquiryId:a['--inquiry'],maxPages:a['--max-pages']?Number(a['--max-pages']):undefined,perConversationPages:a['--per-conversation-pages']?Number(a['--per-conversation-pages']):undefined});
    else throw new Error('unknown_action');
    console.log(JSON.stringify(result));
  }catch(error){console.error(JSON.stringify({error:/^[a-z_0-9]+$/.test(error.message)?error.message:'local_window_error'}));process.exitCode=1;}
}
