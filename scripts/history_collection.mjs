// History-aware preparation around the unchanged, hash-pinned collector.
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataPath} from './chat_collection.mjs';
import {prepareWindow,acceptWindow} from './chat_window.mjs';
import {DEFAULT_DB,planHistory,saveHistoryJson,openHistory,indexChat,digest} from './history_index.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const check=(ok,code)=>{if(!ok)throw Error(code);};

export function prepareHistoryCollection(options,root=ROOT){
  const {source,store,run,from,asOf,historyDb=DEFAULT_DB,inquiryIds,messagesAfter,...rest}=options;
  check(messagesAfter===undefined,'history_boundary_must_come_from_index');
  check(!existsSync(dataPath(run,root)),'run_already_exists');
  const plan=planHistory({source,asOf,from,db:historyDb},root);
  const selected=plan.records.filter(r=>r.store_key===store&&(!inquiryIds||inquiryIds.includes(r.inquiry_id)));
  check(selected.length>0&&(!inquiryIds||selected.length===inquiryIds.length),'history_collection_scope_mismatch');
  check(!selected.some(r=>r.decision==='needs_review'),'history_conflict_requires_review');
  check(selected.every(r=>r.buyer_member_id||r.decision==='exclude_phishing'||r.decision==='reuse'&&r.association_basis==='exact_inquiry_account_conversation'),'history_precise_member_required');
  const groups=new Map();
  for(const r of selected){
    if(['reuse','exclude_prior_contact','exclude_phishing'].includes(r.decision))continue;
    const after=r.messages_after&&Date.parse(r.messages_after)>=Date.parse(from)?r.messages_after:null;
    const key=after||'collect';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  // Validate the entire source/window before making any child run.
  const bundle=JSON.parse(readFileSync(dataPath(source,root),'utf8').replace(/^\uFEFF/,''));
  check(digest(readFileSync(dataPath(source,root)))===plan.source_sha256,'history_source_changed');
  check(Date.parse(from)<Date.parse(rest.to)&&Date.parse(rest.to)<=Date.parse(asOf),'invalid_window');
  for(const r of selected)check(Date.parse(r.created_at)>=Date.parse(from)&&Date.parse(r.created_at)<Date.parse(rest.to),'inquiry_outside_window');
  check(bundle.store_key===store,'history_collection_store_mismatch');
  const runs=[];
  for(const [key,records] of groups){
    const child=join(run,`group-${String(runs.length+1).padStart(3,'0')}`);
    const result=prepareWindow({...rest,source,store,run:child,from,asOf,inquiryIds:records.map(r=>r.inquiry_id),...(key==='collect'?{}:{messagesAfter:key})},root);
    saveHistoryJson(join(child,'history-links.json'),{schema_version:'lew.history-collection-links.v1',db:historyDb,source_sha256:plan.source_sha256,records},root);
    runs.push({run:child,messages_after:key==='collect'?null:key,targets:result.targets});
  }
  mkdirSync(dataPath(run,root),{recursive:true});
  const output={...plan,records:selected,runs,counts:Object.fromEntries([...new Set(selected.map(r=>r.decision))].map(k=>[k,selected.filter(r=>r.decision===k).length])),
    scope:{store,from,to:rest.to,as_of:asOf},history_db:historyDb};
  saveHistoryJson(join(run,'history-plan.json'),output,root);
  return {run,runs,counts:output.counts,history_plan:join(run,'history-plan.json')};
}
export function checkHistoryResolution(run,observation,root=ROOT){
  const path=dataPath(join(run,'history-links.json'),root);if(!existsSync(path)||observation.error)return;
  const links=JSON.parse(readFileSync(path,'utf8')),r=links.records.find(r=>r.inquiry_id===observation.target?.inquiry_id);
  // Receipts do not carry a target: match using the pending ticket instead.
  const pending=JSON.parse(readFileSync(dataPath(join(run,'pending.json'),root),'utf8'));
  const expected=r||links.records.find(r=>r.inquiry_id===pending.task.target.inquiry_id);
  check(expected,'history_resolution_target_missing');
  if(expected.identity)check(digest(expected.identity)===digest(observation.identity),'history_live_conversation_changed');
  for(const row of expected.chat||[])for(const ref of row.dependencies){
    check(digest(readFileSync(dataPath(ref.path,root)))===ref.sha256,'history_evidence_changed');
  }
}
export function registerHistoryRun(run,root=ROOT){
  const path=dataPath(join(run,'history-links.json'),root);if(!existsSync(path))return null;
  const links=JSON.parse(readFileSync(path,'utf8')),db=openHistory(links.db,root);
  try{return indexChat(db,{run},root);}finally{db.close();}
}
export function acceptHistoryWindow(run,observation,root=ROOT){
  checkHistoryResolution(run,observation,root);const result=acceptWindow(run,observation,root);
  const history=registerHistoryRun(run,root);return {...result,history_indexed:Boolean(history)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [action,...args]=process.argv.slice(2),a={},names={'--source':'source','--store':'store','--run':'run','--browser-map':'browserMap','--channel':'channel','--from':'from','--to':'to','--as-of':'asOf','--history-db':'historyDb','--inquiry':'inquiryIds','--page-size':'pageSize','--max-pages':'maxPages','--per-conversation-pages':'perConversationPages','--response':'response'};
    for(let i=0;i<args.length;i+=2){check(names[args[i]]&&args[i+1]&&!Object.hasOwn(a,names[args[i]]),'invalid_arguments');a[names[args[i]]]=args[i+1];}
    if(a.inquiryIds)a.inquiryIds=a.inquiryIds.split(',');for(const key of ['pageSize','maxPages','perConversationPages'])if(a[key])a[key]=Number(a[key]);
    const result=action==='prepare'?prepareHistoryCollection(a):action==='accept'?acceptHistoryWindow(a.run,JSON.parse(readFileSync(dataPath(a.response),'utf8'))):action==='register'?registerHistoryRun(a.run):null;
    check(result,'history_unknown_action');console.log(JSON.stringify(result));
  }catch(e){console.error(JSON.stringify({error:/^[a-z_0-9]+$/.test(e.message)?e.message:'history_collection_error'}));process.exitCode=1;}
}
