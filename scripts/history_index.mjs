// Private, rebuildable history index. Evidence bodies remain in their original files.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataPath} from './chat_collection.mjs';
import {inspectWindow} from './chat_window.mjs';
import {validateChatRun} from './chat_evidence_router.mjs';
import {replayHistoricalWindow,replayHistoricalLegacy} from './history_replay.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const DEFAULT_DB='data/global-history.sqlite';
const validStore=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(value);
const MEMBER=/^alibaba-visible-member:[a-z0-9]{3,64}$/i;
const LINK_SOURCES=['alibaba-message-querySummary-contact-loginId-v1','alibaba-buyer-profile-visible-member-id-v1'];
const check=(ok,code)=>{if(!ok)throw Error(code);};
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
const local=(p,root)=>relative(root,p).replaceAll('\\','/');
const time=v=>typeof v==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const safeCode=e=>/^[a-z_0-9]+$/.test(e.message)?e.message:'history_source_invalid';
const identity=r=>validStore(r.store_key)&&typeof r.inquiry_id==='string'&&/^\d{1,20}$/.test(r.inquiry_id);
const transaction=(db,fn)=>{db.exec('SAVEPOINT history_import');try{const r=fn();db.exec('RELEASE history_import');return r;}catch(e){db.exec('ROLLBACK TO history_import');db.exec('RELEASE history_import');throw e;}};

export function openHistory(db=DEFAULT_DB,root=ROOT,{readOnly=false}={}){
  const path=dataPath(db,root);
  if(!readOnly)mkdirSync(dirname(path),{recursive:true});
  const conn=new DatabaseSync(path,{readOnly});
  conn.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if(!readOnly)conn.exec(`
    CREATE TABLE IF NOT EXISTS history_meta(version INTEGER PRIMARY KEY CHECK(version=1));
    INSERT OR IGNORE INTO history_meta VALUES(1);
    CREATE TABLE IF NOT EXISTS history_artifacts(
      path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(path,sha256));
    CREATE TABLE IF NOT EXISTS history_inquiries(
      store_key TEXT NOT NULL, inquiry_id TEXT NOT NULL, member_id TEXT NOT NULL,
      created_at_ms INTEGER, path TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY(store_key,inquiry_id,member_id,path,sha256),
      FOREIGN KEY(path,sha256) REFERENCES history_artifacts(path,sha256));
    CREATE INDEX IF NOT EXISTS history_member_idx ON history_inquiries(store_key,member_id);
    CREATE TABLE IF NOT EXISTS history_native_members(
      store_key TEXT NOT NULL, source_record_id TEXT NOT NULL, member_id TEXT NOT NULL,
      original_created_at TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY(store_key,source_record_id,path,sha256),
      FOREIGN KEY(path,sha256) REFERENCES history_artifacts(path,sha256));
    CREATE TABLE IF NOT EXISTS history_chats(
      id TEXT PRIMARY KEY, run TEXT NOT NULL, revision INTEGER NOT NULL, store_key TEXT NOT NULL,
      inquiry_id TEXT NOT NULL, member_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
      identity_json TEXT NOT NULL, from_ms INTEGER, after_ms INTEGER, snapshot_ms INTEGER NOT NULL,
      status TEXT NOT NULL, pages_read INTEGER NOT NULL, message_count INTEGER NOT NULL,
      verified INTEGER NOT NULL, error TEXT, dependencies_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_chat_member_idx ON history_chats(store_key,member_id,snapshot_ms);
    CREATE TABLE IF NOT EXISTS history_messages(
      store_key TEXT NOT NULL, conversation_key TEXT NOT NULL, message_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES history_chats(id),
      PRIMARY KEY(store_key,conversation_key,message_id,content_sha256,chat_id));
    CREATE TABLE IF NOT EXISTS history_contact_reviews(
      store_key TEXT NOT NULL,inquiry_id TEXT NOT NULL,from_ms INTEGER NOT NULL,
      message_id TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES history_chats(id),
      path TEXT NOT NULL,sha256 TEXT NOT NULL,
      PRIMARY KEY(store_key,inquiry_id,from_ms,message_id,chat_id,path,sha256),
      FOREIGN KEY(path,sha256) REFERENCES history_artifacts(path,sha256));
    CREATE TABLE IF NOT EXISTS history_exclusions(
      store_key TEXT NOT NULL,inquiry_id TEXT NOT NULL,reason TEXT NOT NULL,confirmed_at TEXT NOT NULL,
      path TEXT NOT NULL,sha256 TEXT NOT NULL,dependencies_json TEXT NOT NULL,
      PRIMARY KEY(store_key,inquiry_id,path,sha256),
      FOREIGN KEY(path,sha256) REFERENCES history_artifacts(path,sha256));
    CREATE TABLE IF NOT EXISTS history_research(
      id TEXT PRIMARY KEY, store_key TEXT NOT NULL, inquiry_id TEXT NOT NULL, member_id TEXT NOT NULL,
      category TEXT NOT NULL, observed_at_ms INTEGER, path TEXT NOT NULL, sha256 TEXT NOT NULL,
      locator TEXT NOT NULL, urls_json TEXT NOT NULL, status TEXT NOT NULL,
      dependencies_json TEXT NOT NULL, FOREIGN KEY(path,sha256) REFERENCES history_artifacts(path,sha256));
    CREATE INDEX IF NOT EXISTS history_research_member_idx ON history_research(store_key,member_id,category);
    CREATE TABLE IF NOT EXISTS history_message_resolutions(
      store_key TEXT NOT NULL,conversation_key TEXT NOT NULL,message_id TEXT NOT NULL,
      hashes_json TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,dependencies_json TEXT NOT NULL,
      PRIMARY KEY(store_key,conversation_key,message_id,path,sha256));
  `);
  if(!readOnly){
    const columns=new Set(conn.prepare('PRAGMA table_info(history_messages)').all().map(r=>r.name));
    if(!columns.has('sent_at_ms'))conn.exec('ALTER TABLE history_messages ADD COLUMN sent_at_ms INTEGER');
    if(!columns.has('ordinary_buyer'))conn.exec('ALTER TABLE history_messages ADD COLUMN ordinary_buyer INTEGER NOT NULL DEFAULT 0');
    const reviewColumns=new Set(conn.prepare('PRAGMA table_info(history_contact_reviews)').all().map(r=>r.name));
    if(!reviewColumns.has('basis'))conn.exec("ALTER TABLE history_contact_reviews ADD COLUMN basis TEXT NOT NULL DEFAULT 'pre_window_buyer_message'");
  }
  check(conn.prepare('SELECT version FROM history_meta').get()?.version===1,'history_schema_unsupported');
  return conn;
}
function pin(db,path,root,expected){
  const p=dataPath(path,root),sha=digest(readFileSync(p));
  check(!expected||sha===expected,'history_source_hash_changed');
  const ref={path:local(p,root),sha256:sha};
  db.prepare('INSERT OR IGNORE INTO history_artifacts VALUES(?,?)').run(ref.path,sha);return ref;
}
function validRefs(refs,root,cache=new Map()){
  return refs.every(ref=>{
    const key=JSON.stringify(ref);if(cache.has(key))return cache.get(key);
    let ok=false;try{ok=digest(readFileSync(dataPath(ref.path,root)))===ref.sha256;}catch{}
    cache.set(key,ok);return ok;
  });
}
function inquiry(db,row,member,ref){
  check(identity(row),'history_invalid_inquiry_identity');
  check(!member||MEMBER.test(member),'history_invalid_member');
  db.prepare('INSERT OR IGNORE INTO history_inquiries VALUES(?,?,?,?,?,?)').run(row.store_key,row.inquiry_id,member||'',time(row.created_at),ref.path,ref.sha256);
}
export function indexBundle(db,path,root=ROOT){return transaction(db,()=>{
  const v=read(dataPath(path,root)),ref=pin(db,path,root);
  check(Array.isArray(v.inquiries)&&Array.isArray(v.buyer_member_links),'history_bundle_required');
  for(const row of v.inquiries){
    const links=v.buyer_member_links.filter(l=>l.store_key===row.store_key&&l.inquiry_id===row.inquiry_id&&LINK_SOURCES.includes(l.source_system));
    const members=[...new Set(links.map(l=>l.buyer_member_id))];
    if(!members.length)inquiry(db,row,null,ref);else for(const member of members)inquiry(db,row,member,ref);
  }
  return {kind:'bundle',path:ref.path,inquiries:v.inquiries.length};
});}
export function indexExistingSqlite(db,path,root=ROOT){return transaction(db,()=>{
  check(dataPath(path,root)!==dataPath(DEFAULT_DB,root),'history_cannot_import_itself');
  const ref=pin(db,path,root),source=new DatabaseSync(dataPath(path,root),{readOnly:true});
  try{
    const tables=new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    let inquiries=0,native=0;
    if(tables.has('inquiries_current'))for(const r of source.prepare('SELECT * FROM inquiries_current').all()){
      const links=tables.has('inquiry_buyer_member_links')?source.prepare('SELECT * FROM inquiry_buyer_member_links WHERE store_key=? AND inquiry_id=?').all(r.store_key,r.inquiry_id).filter(l=>LINK_SOURCES.includes(l.source_system)):[];
      if(!links.length)inquiry(db,r,null,ref);else for(const l of links)inquiry(db,r,l.buyer_member_id,ref);inquiries++;
    }
    if(tables.has('native_inquiry_member_records'))for(const r of source.prepare('SELECT * FROM native_inquiry_member_records').all()){
      check(validStore(r.store_key)&&MEMBER.test(r.buyer_member_id)&&r.source_system==='alibaba-native-inquiry-xlsx-sender-member-id-v1','history_invalid_native_member');
      db.prepare('INSERT OR IGNORE INTO history_native_members VALUES(?,?,?,?,?,?)').run(r.store_key,r.source_record_id,r.buyer_member_id,r.gmt_create,ref.path,ref.sha256);native++;
    }
    check(digest(readFileSync(dataPath(path,root)))===ref.sha256,'history_source_changed_during_import');
    check(!existsSync(dataPath(path+'-wal',root)),'history_source_wal_requires_snapshot');
    return {kind:'sqlite',path:ref.path,inquiries,native_member_records:native};
  }finally{source.close();}
});}
export function indexChat(db,{run,source,allowUnverified=false},root=ROOT){return transaction(db,()=>{
  const dir=dataPath(run,root),c=read(join(dir,'config.json')),cp=read(join(dir,'checkpoint.json'));
  check(validStore(c.store_key)&&Array.isArray(cp.targets),'history_chat_config_required');
  let verified=false,error=null,artifacts={},messages=[],state=cp,pending=null;
  try{
    if(c.schema_version==='alibaba-chat-window-v2'){
      let v;
      if(existsSync(join(dir,'pending.json')))v=replayHistoricalWindow(run,root);
      else try{v=inspectWindow(run,root);}catch(e){if(e.message!=='workflow_version_changed')throw e;v=replayHistoricalWindow(run,root);}
      verified=true;state=v.state;artifacts=v.artifacts;pending=v.pending||null;
      messages=[...v.messages.values()].map(row=>({...row,identity:state.conversations.find(cv=>cv.key===row.conversation_key).identity}));
    }else{
      check(!existsSync(join(dir,'pending.json')),'pending_chat_step_must_be_resolved');
      let v;try{v=validateChatRun({chatRun:run,source},root);}catch(e){if(e.message!=='chat_collector_code_changed')throw e;v=replayHistoricalLegacy(run,source,root);}
      verified=true;state=v.checkpoint;artifacts=v.artifacts;
      messages=v.messages.map(row=>({...row,identity:state.targets.find(t=>t.inquiry_id===row.inquiry_ids[0])?.identity}));
    }
  }catch(e){if(!allowUnverified)throw e;error=safeCode(e);}
  const refs=[pin(db,join(dir,'config.json'),root),pin(db,join(dir,'checkpoint.json'),root)];
  for(const [path,sha] of Object.entries(artifacts))refs.push(pin(db,path,root,sha));
  const original=source||c.source;
  if(original&&existsSync(dataPath(original,root))){indexBundle(db,original,root);refs.push(pin(db,original,root));}
  const unique=[...new Map(refs.map(r=>[r.path,r])).values()];
  if(verified)db.prepare('DELETE FROM history_chats WHERE run=? AND revision=? AND verified=0').run(local(dir,root),state.revision);
  for(const t of state.targets){
    const cv=c.schema_version==='alibaba-chat-window-v2'?state.conversations.find(cv=>cv.key===t.conversation_key):t;
    const who=cv?.identity||null,key=who?digest([c.store_key,who.owner_account_id,who.buyer_account_id,who.conversation_id]):'';
    const id=digest([local(dir,root),state.revision,t.inquiry_id,digest(unique)]);
    check(MEMBER.test(t.buyer_member_id),'history_invalid_member');
    const status=cv?.status||t.status;
    const affected=pending?.status==='unknown_transport_result'&&(pending.ticket.task.target.inquiry_id===t.inquiry_id||
      pending.ticket.task.conversation_key&&pending.ticket.task.conversation_key===t.conversation_key);
    const targetError=affected?'pending_chat_step_must_be_resolved':error;
    db.prepare('INSERT OR IGNORE INTO history_chats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,local(dir,root),state.revision,c.store_key,t.inquiry_id,t.buyer_member_id,key,JSON.stringify(who),c.from_ms??null,c.messages_after_ms??null,c.snapshot_at_ms,status,cv?.pages_read??cv?.pages?.length??0,cv?.message_count??cv?.messages?.length??0,Number(verified),targetError,JSON.stringify(unique));
    if(verified&&who)for(const row of messages.filter(m=>m.identity&&digest(m.identity)===digest(who))){
      const m=row.message,ordinary=m.direction==='buyer'&&m.content_status!=='recalled_or_hidden'&&m.reply_source!=='ai'&&
        !Object.values(m.automation_flags||{}).some(v=>v===true)&&Boolean(m.text||m.source_content||m.attachments?.length);
      db.prepare(`INSERT INTO history_messages(store_key,conversation_key,message_id,content_sha256,chat_id,sent_at_ms,ordinary_buyer)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(store_key,conversation_key,message_id,content_sha256,chat_id)
        DO UPDATE SET sent_at_ms=excluded.sent_at_ms,ordinary_buyer=excluded.ordinary_buyer`).run(c.store_key,key,m.message_id,digest(m),id,m.send_time_ms,Number(ordinary));
    }
  }
  return {kind:'chat',run:local(dir,root),verified,error,targets:state.targets.length,...(pending?{pending:{status:pending.status,request_id:pending.ticket.request_id,inquiry_id:pending.ticket.task.target.inquiry_id,conversation_key:pending.ticket.task.conversation_key},committed_prefix_only:true}:{})};
});}
export function indexPriorContactReview(db,path,root=ROOT){return transaction(db,()=>{
  const v=read(dataPath(path,root));check(v.schema_version==='lew.prior-contact-review.v1'&&identity(v)&&MEMBER.test(v.buyer_member_id||'')&&time(v.window_from)!==null,'history_contact_review_required');
  const row=db.prepare(`SELECT m.*,c.dependencies_json,c.member_id,c.verified FROM history_messages m
    JOIN history_chats c ON c.id=m.chat_id WHERE m.chat_id=? AND m.message_id=? AND m.content_sha256=?
    AND c.store_key=? AND c.inquiry_id=?`).get(v.chat_id,v.message_id,v.message_sha256,v.store_key,v.inquiry_id);
  const basis=v.basis||'pre_window_buyer_message';
  check(row?.verified===1&&row.member_id===v.buyer_member_id&&row.ordinary_buyer===1&&validRefs(JSON.parse(row.dependencies_json),root),'history_contact_witness_not_verified');
  if(basis==='pre_window_buyer_message')check(row.sent_at_ms<time(v.window_from),'history_contact_witness_not_verified');
  else{
    check(basis==='reviewed_prior_relationship_statements'&&time(v.review_before_exclusive)!==null&&Array.isArray(v.statement_refs),'history_relationship_review_required');
    const speakers=new Set();
    for(const ref of v.statement_refs){
      check(ref.chat_id===v.chat_id,'history_relationship_same_run_required');
      const source=db.prepare(`SELECT m.content_sha256,c.member_id,c.verified,c.conversation_key,c.dependencies_json FROM history_messages m JOIN history_chats c ON c.id=m.chat_id
        WHERE m.chat_id=? AND m.message_id=? AND m.content_sha256=? AND c.store_key=? AND c.inquiry_id=?`).get(ref.chat_id,ref.message_id,ref.message_sha256,v.store_key,v.inquiry_id);
      check(source?.verified===1&&source.member_id===v.buyer_member_id&&source.conversation_key===row.conversation_key&&validRefs(JSON.parse(source.dependencies_json),root),'history_relationship_source_not_verified');
      const deps=JSON.parse(source.dependencies_json),path=local(dataPath(ref.source?.path,root),root);
      check(deps.some(p=>p.path===path)&&Number.isInteger(ref.source?.line)&&ref.source.line>0,'history_relationship_source_not_pinned');
      const raw=readFileSync(dataPath(path,root),'utf8').trim().split('\n')[ref.source.line-1],record=JSON.parse(raw),m=record.message||record;
      check(digest(m)===ref.message_sha256&&m.content_status==='read'&&typeof ref.quote==='string'&&ref.quote&&m.text?.includes(ref.quote),'history_relationship_quote_changed');
      check(['buyer','seller'].includes(m.direction)&&m.reply_source!=='ai'&&!Object.values(m.automation_flags||{}).some(x=>x===true)&&m.send_time_ms>=time(v.window_from)&&m.send_time_ms<time(v.review_before_exclusive),'history_relationship_statement_out_of_scope');
      speakers.add(m.direction);
    }
    check(speakers.has('buyer')&&speakers.has('seller')&&v.statement_refs.some(r=>r.chat_id===v.chat_id&&r.message_id===v.message_id&&r.message_sha256===v.message_sha256),'history_relationship_two_sided_review_required');
  }
  const ref=pin(db,path,root);
  db.prepare('INSERT OR IGNORE INTO history_contact_reviews(store_key,inquiry_id,from_ms,message_id,chat_id,path,sha256,basis) VALUES(?,?,?,?,?,?,?,?)').run(v.store_key,v.inquiry_id,time(v.window_from),v.message_id,v.chat_id,ref.path,ref.sha256,basis);
  return {kind:'prior_contact',path:ref.path,inquiry_id:v.inquiry_id,message_id:v.message_id};
});}
export function indexExclusions(db,path,root=ROOT){return transaction(db,()=>{
  const v=read(dataPath(path,root));
  check(v.schema_version==='lew.inquiry-exclusions.v1'&&v.authority==='user_confirmed'&&v.reason==='phishing'&&
    time(v.confirmed_at)!==null&&typeof v.user_instruction==='string'&&v.user_instruction.trim()&&Array.isArray(v.records)&&v.records.length>0&&Array.isArray(v.evidence),'history_user_exclusion_required');
  const refs=[pin(db,path,root),...v.evidence.map(ref=>pin(db,ref.path,root,ref.sha256))],seen=new Set();
  for(const row of v.records){
    const key=JSON.stringify([row.store_key,row.inquiry_id]);
    check(identity(row)&&!seen.has(key),'history_exclusion_identity_required');seen.add(key);
    check(db.prepare('SELECT 1 FROM history_inquiries WHERE store_key=? AND inquiry_id=?').get(row.store_key,row.inquiry_id),'history_exclusion_inquiry_not_indexed');
    db.prepare('INSERT OR IGNORE INTO history_exclusions VALUES(?,?,?,?,?,?,?)').run(row.store_key,row.inquiry_id,'user_confirmed_phishing',v.confirmed_at,refs[0].path,refs[0].sha256,JSON.stringify(refs));
  }
  return {kind:'exclusions',path:refs[0].path,excluded_inquiries:v.records.length};
});}

const RESEARCH_SCHEMAS=new Set(['lew.public-fact-evidence.v1','lew.public-operating-background-supplement.v1','lew.background-gap-audit.v1','lew.background-local-audit.v1','lew.background-audit.v1','lew.visible-factual-review.v1','lew.visible-evidence-review.v1','lew.private-fact-cards.v1','lew.opportunity-fact-cards.v1','lew.gap-followup-facts.v1','local.public-evidence-index.v1','lew.public-company-facts.v1']);
function unversionedResearch(v){
  if(v.schema_version||!validStore(v.store_key)||!Array.isArray(v.records)||!v.generated_at)return null;
  if(Array.isArray(v.source_receipts)&&v.records.every(r=>r.inquiry_id&&r.buyer_member_id&&Object.hasOwn(r,'public_sources')))return 'background-gap-records-v1';
  if(Array.isArray(v.source_files)&&v.records.every(r=>Array.isArray(r.associations)&&Object.hasOwn(r,'sources')))return 'background-associated-records-v1';
  return null;
}
function publicUrls(v){
  const found=new Set();
  function walk(x){if(typeof x==='string'&&/^https?:\/\//.test(x)){try{const u=new URL(x);if(!/(^|\.)alibaba\.com$|alicdn\.com$/.test(u.hostname)&&!u.searchParams.has('token'))found.add(x);}catch{}}
    else if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object')Object.values(x).forEach(walk);}
  walk(v);return [...found];
}
export function indexResearch(db,path,root=ROOT,format){return transaction(db,()=>{
  const v=read(dataPath(path,root)),ref=pin(db,path,root),schema=v.schema_version;
  const rows=[];const dependencies=[ref];
  if(schema==='lew.buyer-due-diligence-local.v1'){
    check(Array.isArray(v.units),'history_local_units_required');
    if(v.source_path&&v.source_sha256)dependencies.push(pin(db,v.source_path,root,v.source_sha256));
    if(v.chat_manifest?.path&&v.chat_manifest.sha256)dependencies.push(pin(db,v.chat_manifest.path,root,v.chat_manifest.sha256));
    for(const [i,u] of v.units.entries())for(const r of u.inquiry_refs||[]){
      inquiry(db,r,MEMBER.test(r.buyer_member_id||'')?r.buyer_member_id:null,ref);
      if(u.profile||r.opportunity_review)rows.push({...r,category:'assessment',observed_at:v.analysis_as_of||u.profile?.assessed_at,locator:`units[${i}]`,urls:[],status:'historical_assessment'});
    }
  }else{
    check(RESEARCH_SCHEMAS.has(schema)||format&&format===unversionedResearch(v),'history_research_schema_unsupported');
    for(const [i,r] of (v.records||[]).entries()){
      const refs=r.associations||((r.inquiry_ids||(r.inquiry_id?[r.inquiry_id]:[])).map(id=>({store_key:r.store_key||v.store_key,inquiry_id:id,buyer_member_id:r.buyer_member_id})));
      const urls=publicUrls(r.public_sources||r.sources||r.public_research||[]);
      for(const assoc of refs)rows.push({...assoc,exact_account_binding:r.exact_account_binding,
        category:urls.length?'public_background':'assessment',observed_at:r.observed_at||v.observed_at||v.generated_at,
        locator:`records[${i}]`,urls,status:r.match_status||r.final_category||r.status||r.search_status||'historical_candidate'});
    }
  }
  for(const row of rows){
    if(!identity(row))continue;
    const member=MEMBER.test(row.buyer_member_id||'')?row.buyer_member_id:'';
    if(!member){
      const exact=row.exact_account_binding;
      const chats=exact?db.prepare('SELECT identity_json,dependencies_json FROM history_chats WHERE store_key=? AND inquiry_id=? AND member_id=\'\' AND verified=1').all(row.store_key,row.inquiry_id):[];
      const verified=chats.some(c=>digest(JSON.parse(c.identity_json))===digest(exact)&&validRefs(JSON.parse(c.dependencies_json),root));
      const excluded=db.prepare('SELECT dependencies_json FROM history_exclusions WHERE store_key=? AND inquiry_id=?').all(row.store_key,row.inquiry_id).some(e=>validRefs(JSON.parse(e.dependencies_json),root));
      if(!verified&&!excluded)continue;
    }
    const id=digest([ref,row.store_key,row.inquiry_id,row.locator,row.category]);
    db.prepare('INSERT OR IGNORE INTO history_research VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,row.store_key,row.inquiry_id,member,row.category,time(row.observed_at),ref.path,ref.sha256,row.locator,JSON.stringify(row.urls),String(row.status),JSON.stringify(dependencies));
  }
  return {kind:'research',path:ref.path,records:rows.length};
});}

export function historySummary(db){
  const count=t=>db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return {schema_version:'lew.history-summary.v1',inquiries:db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT store_key,inquiry_id FROM history_inquiries)').get().n,
    by_store:db.prepare('SELECT store_key,COUNT(DISTINCT inquiry_id) inquiries,COUNT(DISTINCT NULLIF(member_id,\'\')) members FROM history_inquiries GROUP BY store_key').all(),
    artifacts:count('history_artifacts'),excluded_phishing_inquiries:db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT store_key,inquiry_id FROM history_exclusions)').get().n,
    native_member_records:count('history_native_members'),chat_observations:count('history_chats'),verified_chat_observations:db.prepare('SELECT COUNT(*) n FROM history_chats WHERE verified=1').get().n,
    unique_messages:db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT store_key,conversation_key,message_id FROM history_messages)').get().n,
    conflicting_messages:db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM history_messages GROUP BY store_key,conversation_key,message_id HAVING COUNT(DISTINCT content_sha256)>1)').get().n,
    research_observations:count('history_research'),integrity:db.prepare('PRAGMA integrity_check').get().integrity_check};
}
export function lookupHistory(db,target,{asOf,from,root=ROOT,cache=new Map()}={}){
  check(identity(target),'history_invalid_inquiry_identity');
  const cutoff=time(asOf),fromMs=time(from);check(cutoff!==null,'history_as_of_required');
  const exclusions=db.prepare('SELECT * FROM history_exclusions WHERE store_key=? AND inquiry_id=? ORDER BY confirmed_at DESC,path').all(target.store_key,target.inquiry_id);
  const exclusion=exclusions.find(r=>validRefs(JSON.parse(r.dependencies_json),root,cache));
  if(exclusion)return {...target,decision:'exclude_phishing',reason:exclusion.reason,excluded_from_collection:true,excluded_from_research:true,
    excluded_from_new_customer_review:true,exclusion:{authority:'user_confirmed',confirmed_at:exclusion.confirmed_at,path:exclusion.path,sha256:exclusion.sha256,dependencies:JSON.parse(exclusion.dependencies_json)},chat:[],research:[]};
  if(exclusions.length)return {...target,decision:'needs_review',reason:'history_exclusion_evidence_changed',chat:[],research:[]};
  const known=db.prepare('SELECT * FROM history_inquiries WHERE store_key=? AND inquiry_id=?').all(target.store_key,target.inquiry_id);
  const live=known.filter(r=>validRefs([{path:r.path,sha256:r.sha256}],root,cache));
  const members=[...new Set(live.map(r=>r.member_id).filter(Boolean))];
  const conflict=members.length>1||members.length===1&&target.buyer_member_id&&members[0]!==target.buyer_member_id;
  const created=[...new Set(live.map(r=>r.created_at_ms).filter(x=>x!==null))];
  const creationConflict=created.length>1||created.length===1&&target.created_at&&created[0]!==time(target.created_at);
  if(conflict||creationConflict)return {...target,decision:'needs_review',reason:conflict?'history_member_conflict':'history_creation_conflict',chat:[],research:[]};
  const member=target.buyer_member_id;
  if(!MEMBER.test(member||'')){
    // A reviewed exact inquiry/account repair may be reused for its proven
    // cutoff. It never invents a member ID or authorizes a later live increment.
    const exact=db.prepare('SELECT * FROM history_chats WHERE store_key=? AND inquiry_id=? AND member_id=\'\' AND verified=1 AND snapshot_ms=? AND from_ms=?').all(target.store_key,target.inquiry_id,cutoff,fromMs)
      .filter(r=>['window_complete','endpoint_exhausted'].includes(r.status)&&validRefs(JSON.parse(r.dependencies_json),root,cache));
    const keys=new Set(exact.map(r=>r.conversation_key));
    if(exact.length&&keys.size===1){const selected=exact.at(-1);const research=db.prepare('SELECT * FROM history_research WHERE store_key=? AND inquiry_id=? AND member_id=\'\' AND (observed_at_ms IS NULL OR observed_at_ms<=?) ORDER BY observed_at_ms DESC,id').all(target.store_key,target.inquiry_id,cutoff)
      .filter(r=>validRefs(JSON.parse(r.dependencies_json),root,cache)).map(r=>({path:r.path,sha256:r.sha256,locator:r.locator,category:r.category,status:r.status,observed_at:r.observed_at_ms===null?null:new Date(r.observed_at_ms).toISOString(),public_urls:JSON.parse(r.urls_json),use:'historical_candidate_requires_applicability_review'}));
      return {...target,decision:'reuse',reason:'verified_exact_inquiry_account_repair',association_basis:'exact_inquiry_account_conversation',messages_after:asOf,identity:JSON.parse(selected.identity_json),chat:exact.map(chatRef),research};}
    return {...target,decision:'needs_review',reason:'precise_member_required',chat:[],research:[]};
  }
  const all=db.prepare('SELECT * FROM history_chats WHERE store_key=? AND member_id=? AND snapshot_ms<=? ORDER BY snapshot_ms,id').all(target.store_key,member,cutoff);
  const validChat=all.filter(r=>r.verified&&r.conversation_key&&validRefs(JSON.parse(r.dependencies_json),root,cache));
  // A member can have separately verified inquiries owned by different sellers.
  // Prefer the exact inquiry binding; a new inquiry with multiple candidate sessions still stops.
  const exactChat=validChat.filter(r=>r.inquiry_id===target.inquiry_id);
  const exactKeys=new Set(exactChat.map(r=>r.conversation_key));
  const chat=exactKeys.size===1?validChat.filter(r=>exactKeys.has(r.conversation_key)):exactKeys.size>1?exactChat:validChat;
  const convs=[...new Set(chat.map(r=>r.conversation_key))];
  // Do not silently transfer a cutoff to a different conversation/seller account.
  if(convs.length>1)return {...target,decision:'needs_review',reason:'history_conversation_conflict',chat:chat.map(chatRef),research:[]};
  const usable=chat.filter(r=>r.pages_read>0&&['window_complete','endpoint_exhausted','incremental_complete'].includes(r.status));
  const base=usable.filter(r=>r.after_ms===null&&(r.from_ms===null||fromMs!==null&&r.from_ms<=fromMs));
  let boundary=null;const chain=[];
  for(const r of usable){
    if(base.includes(r)||boundary!==null&&r.after_ms!==null&&r.after_ms<=boundary){
      if(boundary===null||r.snapshot_ms>=boundary){boundary=r.snapshot_ms;chain.push(r);}
    }
  }
  const validIds=new Set(chat.map(r=>r.id));
  const basisSql=db.prepare('PRAGMA table_info(history_contact_reviews)').all().some(r=>r.name==='basis')?'r.basis':"'pre_window_buyer_message'";
  const witness=fromMs===null?null:db.prepare(`SELECT m.chat_id,m.message_id,m.content_sha256,m.sent_at_ms,r.path,r.sha256,${basisSql} AS basis FROM history_messages m
    JOIN history_contact_reviews r ON r.chat_id=m.chat_id AND r.message_id=m.message_id
    WHERE r.store_key=? AND r.inquiry_id=? AND r.from_ms=? AND m.ordinary_buyer=1 AND
      ((${basisSql}='pre_window_buyer_message' AND m.sent_at_ms<?) OR (${basisSql}='reviewed_prior_relationship_statements' AND m.sent_at_ms<?))
    ORDER BY m.sent_at_ms DESC,m.message_id`).all(target.store_key,target.inquiry_id,fromMs,fromMs,cutoff)
    .find(r=>validIds.has(r.chat_id)&&validRefs([{path:r.path,sha256:r.sha256}],root,cache));
  const old=witness?chat.find(r=>r.id===witness.chat_id):chat.find(r=>r.status==='old_contact_detected'&&r.from_ms===fromMs);
  const researchRows=db.prepare('SELECT * FROM history_research WHERE store_key=? AND member_id=? AND (observed_at_ms IS NULL OR observed_at_ms<=?) ORDER BY observed_at_ms DESC,id').all(target.store_key,member,cutoff)
    .filter(r=>(r.category!=='assessment'||r.inquiry_id===target.inquiry_id)&&validRefs(JSON.parse(r.dependencies_json),root,cache));
  const research=[...new Map(researchRows.map(r=>[JSON.stringify([r.path,r.sha256,r.locator,r.category]),r])).values()].map(r=>({path:r.path,sha256:r.sha256,locator:r.locator,category:r.category,inquiry_id:r.inquiry_id,
      observed_at:r.observed_at_ms===null?null:new Date(r.observed_at_ms).toISOString(),status:r.status,public_urls:JSON.parse(r.urls_json),use:'historical_candidate_requires_applicability_review'}));
  const variants=new Map();
  for(const row of db.prepare('SELECT message_id,content_sha256,chat_id FROM history_messages WHERE store_key=? AND conversation_key=?').all(target.store_key,convs[0]||''))if(validIds.has(row.chat_id)){
    if(!variants.has(row.message_id))variants.set(row.message_id,new Set());variants.get(row.message_id).add(row.content_sha256);
  }
  const resolutionTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_message_resolutions'").get();
  const resolutions=resolutionTable?db.prepare('SELECT * FROM history_message_resolutions WHERE store_key=? AND conversation_key=?').all(target.store_key,convs[0]||'')
    .filter(r=>validRefs(JSON.parse(r.dependencies_json),root,cache)):[];
  const hasConflict=[...variants.entries()].some(([id,v])=>v.size>1&&!resolutions.some(r=>r.message_id===id&&[...v].every(h=>JSON.parse(r.hashes_json).includes(h))));
  if(hasConflict)return {...target,decision:'needs_review',reason:'history_message_content_conflict',chat:chat.map(chatRef),research};
  if(boundary===null&&!old&&all.some(r=>r.error==='pending_chat_step_must_be_resolved'&&
    (r.inquiry_id===target.inquiry_id||convs.includes(r.conversation_key))))return {...target,decision:'needs_review',reason:'history_pending_requires_reconciliation',chat:[],research};
  return {...target,decision:old?'exclude_prior_contact':boundary===cutoff?'reuse':boundary!==null?'incremental':'collect',
    reason:old?(witness?(witness.basis==='reviewed_prior_relationship_statements'?'verified_prior_relationship_statements':'verified_pre_window_buyer_message'):'same_window_prior_contact'):boundary!==null?'verified_contiguous_history':all.length?'history_gap_or_unverified':'no_usable_history',
    messages_after:boundary===null?null:new Date(boundary).toISOString(),identity:chain.length?JSON.parse(chain.at(-1).identity_json):null,
    chat:(old?[old]:chain).map(chatRef),...(witness?{history_evidence:{message_id:witness.message_id,sent_at:new Date(witness.sent_at_ms).toISOString(),sha256:witness.content_sha256,run:old.run,revision:old.revision,review:{path:witness.path,sha256:witness.sha256},basis:witness.basis==='reviewed_prior_relationship_statements'?'reviewed_two_sided_prior_relationship_statements':'verified_ordinary_buyer_before_requested_window'}}:{}),
    historical_gaps:all.filter(r=>!usable.includes(r)).map(r=>({run:r.run,status:r.status,verified:Boolean(r.verified),error:r.error})),research};
}
function chatRef(r){return {run:r.run,revision:r.revision,status:r.status,inquiry_id:r.inquiry_id,snapshot_at:new Date(r.snapshot_ms).toISOString(),dependencies:JSON.parse(r.dependencies_json)};}
export function planHistory({source,asOf,from,db=DEFAULT_DB},root=ROOT){
  const bundle=read(dataPath(source,root));check(Array.isArray(bundle.inquiries)&&Array.isArray(bundle.buyer_member_links),'history_bundle_required');
  const conn=openHistory(db,root,{readOnly:true}),cache=new Map();
  try{
    const records=bundle.inquiries.map(r=>{
      const members=[...new Set(bundle.buyer_member_links.filter(l=>l.store_key===r.store_key&&l.inquiry_id===r.inquiry_id&&LINK_SOURCES.includes(l.source_system)).map(l=>l.buyer_member_id))];
      check(members.length<=1,'history_source_member_conflict');
      return lookupHistory(conn,{store_key:r.store_key,inquiry_id:r.inquiry_id,buyer_member_id:members[0]||null,created_at:r.created_at},{asOf,from,root,cache});
    });
    const counts={};for(const r of records)counts[r.decision]=(counts[r.decision]||0)+1;
    return {schema_version:'lew.history-plan.v1',source:local(dataPath(source,root),root),source_sha256:digest(readFileSync(dataPath(source,root))),as_of:asOf,from,counts,records,
      limitations:['History is store-scoped; names never identify or merge customers.','Historical research requires applicability review; current legal/compliance/payment/reputation checks must be refreshed.','Incremental boundaries require a verified contiguous baseline; earlier gaps remain visible.']};
  }finally{conn.close();}
}

// Deliberately exclude package caches, synthetic runs and copied validation roots.
const SKIP=/^(?:\.|node_modules$|runtime$|__pycache__$)|synthetic|validation-root|verification-root|frozen-v1|v1-validation|original-run-snapshot/;
function walk(dir,root){const paths=[];for(const e of readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink()||SKIP.test(e.name))continue;const p=join(dir,e.name);if(e.isDirectory())paths.push(...walk(p,root));else if(e.name.endsWith('.json')&&!/^(?:event-|page-|response-|accepted-|request-|pending)/.test(e.name))paths.push(local(p,root));}return paths;}
export function discoverHistory({roots},root=ROOT){
  check(Array.isArray(roots)&&roots.length,'history_roots_required');
  const files=[...new Set(roots.flatMap(p=>walk(dataPath(p,root),root)))].sort();
  const entries=[],manifests=new Map(),configs=[],ignored={};
  for(const path of files){
    let v;try{v=read(dataPath(path,root));}catch{continue;}
    if(!v||typeof v!=='object'||Array.isArray(v))continue;
    if(v.chatRun&&v.source&&/^alibaba\.chat-evidence-manifest/.test(v.schemaVersion||''))manifests.set(v.chatRun,{source:v.source});
    if(Array.isArray(v.inquiries)&&Array.isArray(v.buyer_member_links))entries.push({kind:'bundle',path});
    else if(path.endsWith('/config.json')&&['alibaba-chat-api-v1','alibaba-chat-window-v2'].includes(v.schema_version))configs.push({path,v});
    else if(v.schema_version==='lew.buyer-due-diligence-local.v1'||RESEARCH_SCHEMAS.has(v.schema_version)||unversionedResearch(v))entries.push({kind:'research',path,...(unversionedResearch(v)?{format:unversionedResearch(v)}:{})});
    else if(typeof v.schema_version==='string')ignored[v.schema_version]=(ignored[v.schema_version]||0)+1;
  }
  const bundleHashes=new Map(entries.filter(e=>e.kind==='bundle').map(e=>[digest(readFileSync(dataPath(e.path,root))),e.path]));
  for(const {path,v} of configs){const run=local(dirname(dataPath(path,root)),root);let source=v.source||manifests.get(run)?.source;
    const proof=join(dirname(dataPath(path,root)),'source-proof.json');if(!source&&existsSync(proof))source=bundleHashes.get(read(proof).source_sha256);
    entries.push({kind:'chat',run,source});}
  return {schema_version:'lew.history-import-spec.v1',roots,entries,ignored_schemas:ignored};
}
export function importHistory({spec,db=DEFAULT_DB},root=ROOT){
  const plan=typeof spec==='string'?read(dataPath(spec,root)):spec;check(plan.schema_version==='lew.history-import-spec.v1'&&Array.isArray(plan.entries),'history_import_spec_required');
  const conn=openHistory(db,root),results=[];
  try{for(const e of plan.entries){try{
    const r=e.kind==='bundle'?indexBundle(conn,e.path,root):e.kind==='sqlite'?indexExistingSqlite(conn,e.path,root):e.kind==='chat'?indexChat(conn,{...e,allowUnverified:true},root):e.kind==='research'?indexResearch(conn,e.path,root,e.format):e.kind==='prior_contact'?indexPriorContactReview(conn,e.path,root):e.kind==='exclusions'?indexExclusions(conn,e.path,root):null;
    check(r,'history_unknown_import_kind');results.push({...r,status:r.error?'catalogued_unverified':'indexed'});
  }catch(error){results.push({kind:e.kind,path:e.path||e.run,status:'rejected',error:safeCode(error)});}}
    return {schema_version:'lew.history-import-report.v1',summary:historySummary(conn),results};
  }finally{conn.close();}
}
export function saveHistoryJson(path,value,root=ROOT){const p=dataPath(path,root);mkdirSync(dirname(p),{recursive:true});const text=JSON.stringify(value,null,2)+'\n';if(existsSync(p)){check(readFileSync(p,'utf8')===text,'history_output_exists');return;}writeFileSync(p,text,{flag:'wx',mode:0o600});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [action,...args]=process.argv.slice(2),a={};for(let i=0;i<args.length;i+=2){check(args[i].startsWith('--')&&args[i+1]&&!Object.hasOwn(a,args[i]),'invalid_arguments');a[args[i]]=args[i+1];}
    let result;
    if(action==='discover')result=discoverHistory({roots:a['--roots']?.split(',')});
    else if(action==='import')result=importHistory({spec:a['--spec'],db:a['--db']});
    else if(action==='plan')result=planHistory({source:a['--source'],asOf:a['--as-of'],from:a['--from'],db:a['--db']});
    else if(action==='status'){const db=openHistory(a['--db'],ROOT,{readOnly:true});try{result=historySummary(db);}finally{db.close();}}
    else throw Error('history_unknown_action');
    if(a['--out']){saveHistoryJson(a['--out'],result);console.log(JSON.stringify({out:a['--out'],summary:result.summary||result.counts||{entries:result.entries?.length}}));}else console.log(JSON.stringify(result));
  }catch(e){console.error(JSON.stringify({error:safeCode(e)}));process.exitCode=1;}
}
