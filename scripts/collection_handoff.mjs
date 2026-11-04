// Fixed offline delivery/merge entry point. All private bodies remain in existing ledgers.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname,relative,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataPath,assertNoPrivateTransport} from './chat_collection.mjs';
import {inspectWindow,exportWindow,exportReviewCohort} from './chat_window.mjs';
import {bindWindowEvidence,validateChatEvidence} from './chat_evidence_router.mjs';
import binding from '../lib/store_binding.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SCHEMA='lew.collection-handoff.v1';
const check=(ok,code)=>{if(!ok)throw Error(code);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const local=(p,root)=>relative(root,dataPath(p,root)).replaceAll('\\','/');
function ref(p,root){const path=local(p,root);return {path,sha256:hash(readFileSync(dataPath(path,root)))};}
function checkedRef(r,root){check(r&&ref(r.path,root).sha256===r.sha256,'handoff_artifact_hash_mismatch');return read(dataPath(r.path,root));}
function exact(out,value,root) {
  const path=dataPath(out,root),text=JSON.stringify(value,null,2)+'\n';
  if(existsSync(path))check(readFileSync(path,'utf8')===text,'existing_handoff_conflict');
  else{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text,{flag:'wx',mode:0o600});}
  return ref(path,root);
}
function time(v){
  check(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v),'handoff_timezone_required');
  const day=new Date(v.slice(0,10)+'T00:00:00Z');
  check(Number.isFinite(Date.parse(v))&&Number.isFinite(day.getTime())&&day.toISOString().slice(0,10)===v.slice(0,10),'invalid_handoff_timestamp');
  return Date.parse(v);
}
function scopeOf(s){const from=time(s?.from),to=time(s?.to_exclusive);check(from<to,'invalid_handoff_window');
  return {from:new Date(from).toISOString(),to_exclusive:new Date(to).toISOString(),time_zone:'Asia/Shanghai'};}
const statusSummary=records=>({inquiries:records.length,excluded:records.filter(r=>r.excluded_from_new_customer_review).length,
  without_chat_source:records.filter(r=>!r.chat_sources.length).length,
  without_chat_messages:records.filter(r=>!r.excluded_from_new_customer_review&&!r.chat_sources.some(s=>s.message_count>0)).length,
  incomplete_inquiries:records.filter(r=>!r.excluded_from_new_customer_review&&!r.chat_sources.some(s=>['endpoint_exhausted','window_complete'].includes(s.status))).length,
  reused_inquiries:records.filter(r=>r.chat_sources.some(s=>s.reused)).length});

export function publishHandoff({spec:specPath,out},root=ROOT) {
  const spec=read(dataPath(specPath,root));assertNoPrivateTransport(spec);
  check(binding.isStore(spec.store_key),'invalid_store');
  check(typeof spec.owner_thread_id==='string'&&/^[a-zA-Z0-9_.:/-]{1,180}$/.test(spec.owner_thread_id),'handoff_owner_required');
  check(['chat_ready','facts_ready'].includes(spec.stage),'invalid_handoff_stage');
  const scope=scopeOf(spec.scope),from=time(scope.from),to=time(scope.to_exclusive);
  const sourcePath=dataPath(spec.population_source,root),population=read(sourcePath);
  check(population.store_key===spec.store_key&&Array.isArray(population.inquiries)&&Array.isArray(population.buyer_member_links),'invalid_handoff_population');
  const records=new Map();
  for(const row of population.inquiries) {
    const created=time(row.created_at),links=population.buyer_member_links.filter(x=>x.store_key===spec.store_key&&x.inquiry_id===row.inquiry_id);
    check(row.store_key===spec.store_key&&typeof row.inquiry_id==='string'&&/^\d{1,20}$/.test(row.inquiry_id)&&!records.has(row.inquiry_id),'invalid_handoff_inquiry');
    check(created>=from&&created<to,'handoff_inquiry_outside_window');
    check(links.length<=1,'ambiguous_handoff_member');
    if(links.length)check(links[0].source_system==='alibaba-message-querySummary-contact-loginId-v1'&&
      /^alibaba-visible-member:.+/.test(links[0].buyer_member_id),'unverified_handoff_member');
    records.set(row.inquiry_id,{store_key:spec.store_key,inquiry_id:row.inquiry_id,buyer_member_id:links[0]?.buyer_member_id??null,
      created_at:new Date(created).toISOString(),chat_sources:[],excluded_from_new_customer_review:false,exclusion_sources:[]});
  }
  const evidence=[],seen=new Set();
  const addEvidence=(manifestPath,{reused,ledger=null,cohort=null})=>{
    const manifestRef=ref(manifestPath,root),m=read(dataPath(manifestPath,root));
    check(!seen.has(manifestRef.path),'duplicate_handoff_manifest');seen.add(manifestRef.path);
    validateChatEvidence({manifest:manifestRef.path,expectedSha256:manifestRef.sha256},root);
    // The validator has already replayed the chain. Read its hash-bound metadata, not the full chain again.
    const pinned=p=>{const name=local(p,root);return checkedRef({path:name,sha256:m.artifactsSha256[name]},root);};
    const config=pinned(join(m.chatRun,'config.json')),checkpoint=pinned(join(m.chatRun,'checkpoint.json'));
    check(config.store_key===spec.store_key,'handoff_store_mismatch');
    const source=pinned(m.source),targets=config.targets;
    const index=evidence.length;
    evidence.push({manifest:manifestRef,ledger,cohort,reused,snapshot_at:new Date(config.snapshot_at_ms).toISOString(),
      status:m.chatStatus,history_complete:false});
    const oldRecords=ledger?read(dataPath(ledger.path,root)).records.filter(r=>r.excluded_from_new_customer_review):
      (checkpoint.conversations??[]).filter(c=>c.status==='old_contact_detected').flatMap(c=>c.inquiry_ids.map(id=>({inquiry_id:id,history_evidence:c.history_evidence})));
    for(const target of targets) {
      const record=records.get(target.inquiry_id),sourceRow=source.inquiries.find(r=>r.store_key===spec.store_key&&r.inquiry_id===target.inquiry_id);
      // Old batches can contain additional targets; only the fixed current population is delivered.
      if(!record){check(reused,'handoff_run_outside_population');continue;}
      check(record.buyer_member_id===target.buyer_member_id&&sourceRow&&time(sourceRow.created_at)===time(record.created_at),'handoff_inquiry_identity_changed');
      const association=m.associations.find(a=>a.inquiry_id===target.inquiry_id),old=oldRecords.find(r=>r.inquiry_id===target.inquiry_id);
      check(association||old,'handoff_association_missing');
      const excluded=old&&time(old.history_evidence.sent_at)<from;
      record.chat_sources.push({evidence_index:index,reused,status:old?(excluded?'old_contact_detected':'prior_window_exclusion'):association.status,
        snapshot_at:new Date(config.snapshot_at_ms).toISOString(),message_count:association?.message_indexes.length??0,
        requires_window_review:reused});
      if(excluded){record.excluded_from_new_customer_review=true;record.exclusion_sources.push({evidence_index:index,history_evidence:old.history_evidence});}
    }
  };
  check(Array.isArray(spec.chat_runs)&&Array.isArray(spec.reused_manifests)&&Array.isArray(spec.attachments)&&Array.isArray(spec.gaps),'invalid_handoff_lists');
  check(new Set(spec.chat_runs.map(r=>local(r,root))).size===spec.chat_runs.length,'duplicate_handoff_run');
  const outputDir=dataPath(join(dirname(dataPath(out,root)),basename(out,'.json')+'-artifacts'),root);
  for(const [i,run] of spec.chat_runs.entries()) {
    const {config,state,dir}=inspectWindow(run,root);
    check(config.store_key===spec.store_key&&config.from_ms===from&&config.to_ms===to,'handoff_run_scope_mismatch');
    check(!['ready','resolving'].includes(state.status),'handoff_run_not_stopped');
    if(existsSync(join(dir,'runner-owner.json')))check(read(join(dir,'runner-owner.json')).thread_id===spec.owner_thread_id,'handoff_owner_mismatch');
    const folder=join(outputDir,`run-${i+1}`),ledger=join(folder,'ledger.json'),cohort=join(folder,'cohort.json'),manifest=join(folder,'manifest.json');
    exportWindow(run,ledger,root);exportReviewCohort(run,cohort,root);
    bindWindowEvidence({chatRun:run,source:config.source,out:manifest},root);
    addEvidence(manifest,{reused:false,ledger:ref(ledger,root),cohort:ref(cohort,root)});
  }
  for(const manifest of spec.reused_manifests)addEvidence(manifest,{reused:true});
  const attachments=spec.attachments.map(a=>{
    check(['buyer_facts','public_evidence','prior_review','collection_validation'].includes(a.role),'invalid_handoff_attachment_role');
    return {role:a.role,...ref(a.path,root)};
  });
  const rows=[...records.values()];
  // An older-window proof applies to this exact buyer throughout this store's population.
  const oldBuyers=new Map();
  for(const r of rows)if(r.excluded_from_new_customer_review)oldBuyers.set(r.buyer_member_id,[...(oldBuyers.get(r.buyer_member_id)??[]),...r.exclusion_sources]);
  for(const r of rows)if(oldBuyers.has(r.buyer_member_id)){r.excluded_from_new_customer_review=true;r.exclusion_sources=oldBuyers.get(r.buyer_member_id);}
  const delivery={schema_version:SCHEMA,stage:spec.stage,store_key:spec.store_key,owner_thread_id:spec.owner_thread_id,scope,
    spec:ref(specPath,root),population:ref(sourcePath,root),evidence,attachments,records:rows,gaps:spec.gaps,summary:statusSummary(rows),
    analysis_status:'not_performed',formal_research_validation:'not_performed'};
  const result=exact(out,delivery,root);
  return {...result,stage:delivery.stage,store_key:spec.store_key,...delivery.summary};
}

/** Parent-side read-only evidence validation plus a private index; no browser access. */
export function mergeHandoffs({spec:specPath,out},root=ROOT) {
  const spec=read(dataPath(specPath,root)),required=spec.required_stores??binding.STORES;
  check(Array.isArray(required)&&required.length>0&&new Set(required).size===required.length&&required.every(s=>binding.isStore(s)),'invalid_required_stores');
  check(Array.isArray(spec.handoffs)&&spec.handoffs.length===required.length,'handoff_store_set_incomplete');
  const stores=new Set(),handoffs=[],records=[];let scope;
  for(const item of spec.handoffs) {
    const d=checkedRef(item,root);
    check(d.schema_version===SCHEMA&&required.includes(d.store_key)&&!stores.has(d.store_key),'duplicate_or_wrong_handoff_store');stores.add(d.store_key);
    const window=scopeOf(d.scope);scope??=window;
    check(JSON.stringify(window)===JSON.stringify(scope),'handoff_windows_differ');
    checkedRef(d.spec,root);checkedRef(d.population,root);
    for(const e of d.evidence) {
      checkedRef(e.manifest,root);if(e.ledger)checkedRef(e.ledger,root);if(e.cohort)checkedRef(e.cohort,root);
      validateChatEvidence({manifest:e.manifest.path,expectedSha256:e.manifest.sha256},root);
    }
    for(const a of d.attachments)check(ref(a.path,root).sha256===a.sha256,'handoff_artifact_hash_mismatch');
    handoffs.push({store_key:d.store_key,stage:d.stage,...item});
    records.push(...d.records.map(r=>({...r,handoff_path:item.path})));
  }
  check(new Set(records.map(r=>`${r.store_key}:${r.inquiry_id}`)).size===records.length,'duplicate_handoff_inquiry');
  const merged={schema_version:'lew.collection-analysis-input.v1',scope,handoffs,records,summary:statusSummary(records),
    analysis_status:'not_performed',formal_research_validation:'not_performed'};
  return {...exact(out,merged,root),stores:stores.size,...merged.summary};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const [action,...args]=process.argv.slice(2),o={};
    for(let i=0;i<args.length;i+=2){check(['--spec','--out'].includes(args[i])&&args[i+1]&&!o[args[i].slice(2)],'invalid_argument');o[args[i].slice(2)]=args[i+1];}
    check(['publish','merge'].includes(action),'invalid_action');
    console.log(JSON.stringify(action==='publish'?publishHandoff(o):mergeHandoffs(o)));
  }catch(e){console.error(JSON.stringify({error:/^[a-z_0-9]+$/.test(e.message)?e.message:'local_handoff_error'}));process.exitCode=1;}
}
