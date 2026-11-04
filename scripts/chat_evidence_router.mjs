// Route bounded v2 runs separately; v1 permits only the validated optional account mapping.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as original from '../lib/chat_evidence.mjs';
import {dataPath} from './chat_collection.mjs';
import {inspectWindow,VERSION} from './chat_window.mjs';
import legacy from './alibaba_chat_collector.js';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SCHEMA='alibaba.chat-evidence-manifest.v2';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:legacy.canonical(x)).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const check=(ok,code)=>{if(!ok)throw Error(code);};
export function validateChatRun(options,root=ROOT) {
  const dir=dataPath(options.chatRun,root),config=read(dataPath(join(dir,'config.json'),root));
  if(config.schema_version!==VERSION)return original.validateChatRun(options,root);
  check(!existsSync(join(dir,'pending.json')),'pending_chat_step_must_be_resolved');
  const verified=inspectWindow(options.chatRun,root),{state:s,config:c}=verified;
  check(dataPath(options.source,root)===dataPath(c.source,root),'chat_source_scope_mismatch');
  const messages=[...verified.messages.values()].flatMap(r=>{
    const cv=s.conversations.find(v=>v.key===r.conversation_key);
    // Old contacts and history remain in the collection ledger, never in the new-customer evidence cohort.
    if(cv.status==='old_contact_detected'||r.message.send_time_ms<c.from_ms)return [];
    const ids=s.targets.filter(t=>t.conversation_key===cv.key&&r.message.send_time_ms>=t.created_at_ms&&r.message.send_time_ms<=c.snapshot_at_ms).map(t=>t.inquiry_id);
    return ids.length?[{store_key:c.store_key,conversation_id:cv.identity.conversation_id,buyer_member_id:cv.buyer_member_id,inquiry_ids:ids,message:r.message}]:[];
  }).sort((a,b)=>a.message.send_time_ms-b.message.send_time_ms||a.message.message_id.localeCompare(b.message.message_id));
  const associations=s.targets.filter(t=>s.conversations.find(v=>v.key===t.conversation_key)?.status!=='old_contact_detected').map(t=>{
    const cv=s.conversations.find(v=>v.key===t.conversation_key);
    return {store_key:c.store_key,inquiry_id:t.inquiry_id,buyer_member_id:t.buyer_member_id,sourceRecordIndex:null,identity:cv?.identity??null,
      status:cv?.status??t.status,stop_reason:cv?.error??t.error,pages_read:cv?.pages_read??0,
      message_indexes:messages.flatMap((m,i)=>m.inquiry_ids.includes(t.inquiry_id)?[i]:[])};
  });
  const artifacts={...verified.artifacts};
  artifacts[relative(root,join(dir,'checkpoint.json')).replaceAll('\\','/')]=hash(readFileSync(join(dir,'checkpoint.json')));
  return {run:relative(root,dir).replaceAll('\\','/'),source:c.source,config:c,checkpoint:s,messages,associations,artifacts};
}
function manifestFor(options,root) {
  const v=validateChatRun(options,root);check(v.config.schema_version===VERSION,'window_v2_required');
  return {schemaVersion:SCHEMA,mode:'local',chatRun:v.run,source:v.source,revision:v.checkpoint.revision,
    chatStatus:v.checkpoint.status,pagesRead:v.checkpoint.pages_read,associations:v.associations,messageCount:v.messages.length,
    excludedInquiryCount:v.checkpoint.targets.length-v.associations.length,artifactsSha256:v.artifacts,
    historyComplete:false,publicEvidence:false,formalResearchValidation:'not_performed'};
}
export function bindWindowEvidence(options,root=ROOT) {
  const path=dataPath(options.out,root),manifest=manifestFor(options,root),text=JSON.stringify(manifest,null,2)+'\n';
  const inside=relative(dataPath(manifest.chatRun,root),path);
  check(inside&&(inside==='..'||inside.startsWith('../')||inside.startsWith('..\\')),'manifest_outside_run_required');
  check(!Object.hasOwn(manifest.artifactsSha256,relative(root,path).replaceAll('\\','/')),'manifest_would_overwrite_evidence');
  if(existsSync(path))check(readFileSync(path,'utf8')===text,'existing_manifest_conflict');
  else{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text,{flag:'wx',mode:0o600});}
  return {out:path,eligible_inquiries:manifest.associations.length,excluded_inquiries:manifest.excludedInquiryCount,message_count:manifest.messageCount};
}
export function validateChatEvidence(options,root=ROOT) {
  const path=dataPath(options.manifest,root),manifest=read(path);
  if(manifest.schemaVersion!==SCHEMA)return original.validateChatEvidence(options,root);
  if(options.expectedSha256)check(hash(readFileSync(path))===options.expectedSha256,'chat_manifest_hash_mismatch');
  check(legacy.canonical(manifest)===legacy.canonical(manifestFor({chatRun:manifest.chatRun,source:manifest.source},root)),'chat_manifest_changed');
  return {status:'chat_evidence_bound',message_count:manifest.messageCount,formal_research_validation:'not_performed'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const [action,...args]=process.argv.slice(2),o={},names={'--chat-run':'chatRun','--source':'source','--out':'out','--manifest':'manifest'};
    for(let i=0;i<args.length;i+=2){check(names[args[i]]&&args[i+1]&&!Object.hasOwn(o,names[args[i]]),'invalid_argument');o[names[args[i]]]=args[i+1];}
    check(['bind','validate'].includes(action),'invalid_action');console.log(JSON.stringify(action==='bind'?bindWindowEvidence(o):validateChatEvidence(o)));
  }catch(e){console.error(JSON.stringify({error:/^[a-z0-9_]+$/.test(e.message)?e.message:'local_evidence_error'}));process.exitCode=1;}
}
