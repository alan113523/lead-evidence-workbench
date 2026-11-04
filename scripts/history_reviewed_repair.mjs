// Index an already reviewed scoped repair without changing its frozen runs.
import fs from 'node:fs';
import {resolve,relative} from 'node:path';
import legacy from './alibaba_chat_collector.js';
import {digest} from './history_index.mjs';
const check=(x,c)=>{if(!x)throw Error(c)},read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function semanticMessage(message){
 const m=structuredClone(message);
 if(m.source_content){m.source_content=legacy.parseWorkspaceCard(m.source_content)?legacy.safeUrl(m.source_content):legacy.cleanText(m.source_content);const card=legacy.parseWorkspaceCard(m.source_content);if(card)Object.assign(m,card);}
 delete m.content_redacted;return m;
}
export function indexReviewedRepair(db,{manifest,analysis,messages},root=process.cwd()){
 const local=p=>relative(root,resolve(root,p)).replaceAll('\\','/');
 const ref=p=>{const path=local(p);check(path.startsWith('data/')&&!path.includes('../'),'repair_private_source_required');return{path,sha256:digest(fs.readFileSync(resolve(root,path)))}};
 const mr=ref(manifest),ar=ref(analysis),br=ref(messages),m=read(resolve(root,manifest)),a=read(resolve(root,analysis));
 check(m.schema==='lew.scoped-gap-repair.v1'&&m.resolutions.length===9&&m.resolutions.every(r=>r.closed),'repair_closed_manifest_required');
 check(ref(m.baseline.path).sha256===m.baseline.sha256,'repair_baseline_changed');
 const bounds=fs.readFileSync(resolve(root,messages),'utf8').trim().split('\n').map(JSON.parse),byKey=new Map(bounds.map(b=>[b.key,b]));
 check(byKey.size===bounds.length&&br.sha256===m.bound_messages_sha256,'repair_bound_messages_changed');
 const dependencies=[mr,ar,br,ref(m.baseline.path)],observations=[];
 for(const s of m.sources){const sr=ref(s.path);check(sr.sha256===s.sha256,'repair_receipt_changed');dependencies.push(sr);const p=read(resolve(root,s.path));const task=p.task,r=p.receipt||p;
  check(task.store_key===s.store&&digest(r.identity)===digest(task.identity),'repair_identity_changed');
  const proof=r.store_proof||p.original_receipt?.store_proof;
  check(proof?.store_key===s.store&&proof.store_host===`${s.store}.en.alibaba.com`&&proof.request_id===task.request_id,'repair_store_proof_changed');
  const at=r.observed_at_ms||p.original_receipt?.observed_at_ms;
  check(at>=proof.observed_at_ms&&at-proof.observed_at_ms<300000,'repair_stale_store_proof');
  check(r.rows.length<=task.page_size,'repair_page_size');
  if(p.receipt){check(!r.error&&!r.boundary_error&&r.session_member_id===task.session_member_id&&p.proof_after.store_key===task.store_key,'repair_receipt_failed');check(r.rows.every((v,i)=>!i||r.rows[i-1].send_time_ms>=v.send_time_ms),'repair_page_order');}
  else {const rawRef=ref(p.source);dependencies.push(rawRef);const raw=JSON.parse(read(resolve(root,p.source)).raw_response).data.list;
   const regular=raw.filter(v=>String(v.messageId)!=='-997');const n=raw.filter(v=>String(v.messageId)==='-997');
   check(n.length===1&&raw.at(-1)===n[0]&&n[0].content==='以下询盘分配给您，请及时跟进。'&&n[0].type===2&&n[0].subType===10,'repair_auxiliary_notice_changed');
   check(regular.length===r.rows.length&&regular.every((v,i)=>!i||regular[i-1].sendTime>=v.sendTime),'repair_original_page_changed');
   for(const v of regular){const row=r.rows.find(x=>x.message_id===String(v.messageId));check(row?.send_time_ms===v.sendTime&&row.buyer_account_id===r.identity.buyer_account_id,'repair_original_message_changed');const pair=[String(v.owner?.accountId),String(v.contact?.accountId)].sort();check(digest(pair)===digest([r.identity.owner_account_id,r.identity.buyer_account_id].sort()),'repair_original_account_changed');}
  }
  for(const row of r.rows){check(task.cursor===null||row.send_time_ms<=task.cursor,'repair_cursor_out_of_range');const b=byKey.get(`${s.store}|${r.identity.conversation_id}|${row.message_id}`);check(b?.variants.some(v=>digest(semanticMessage(v.message))===digest(semanticMessage(row))),'repair_message_not_bound');}
  observations.push({s,task,r,path:s.path});
 }
 const frozen=read(resolve(root,m.baseline.path)),fromMs=Date.parse('2026-10-01T00:00:00+08:00'),snapshot=Date.parse(a.analysis_before_exclusive);
 const unique=[...new Map(dependencies.map(r=>[r.path,r])).values()];
 db.exec('SAVEPOINT reviewed_repair');let chats=0,resolutions=0;
 try{
  for(const d of unique)db.prepare('INSERT OR IGNORE INTO history_artifacts VALUES(?,?)').run(d.path,d.sha256);
  for(const r of m.resolutions.filter(r=>r.prior_reason!=='message_version_difference')){
   const row=a.rows.find(x=>x.store_key===r.store&&x.inquiry_id===r.id);check(row?.collection_continuation?.gap_closed,'repair_target_not_closed');
   const sample=observations.find(o=>o.s.store===r.store&&(o.task.target.inquiry_id===r.id||row.buyer_member_id&&o.task.target.buyer_member_id===row.buyer_member_id&&row.reviewed_message_binding.messages.some(ref=>ref.message_key.startsWith(`${r.store}|${o.r.identity.conversation_id}|`))));
   check(sample,'repair_target_sources_missing');const identity=sample.r.identity,key=digest([r.store,identity.owner_account_id,identity.buyer_account_id,identity.conversation_id]);
   const pages=observations.filter(o=>o.s.store===r.store&&digest(o.r.identity)===digest(identity));
   const oldest=Math.min(...pages.flatMap(p=>p.r.rows.map(x=>x.send_time_ms)));
   const endpoint=pages.some(p=>p.s.kind==='fresh_exact_scope_api'&&p.r.rows.length===0);
   check(endpoint||oldest<fromMs,'repair_missing_terminal_boundary');
   if(sample.task.cursor!==null){const previous=frozen.rows.find(x=>x.store_key===r.store&&x.inquiry_id===r.id);const prior=read(resolve(root,previous.collection_continuation.manifest));const cp=read(resolve(root,prior.chatRun,'checkpoint.json'));const cv=cp.conversations.find(c=>digest(c.identity)===digest(identity));check(cv&&pages.some(p=>p.task.cursor===cv.cursor),'repair_prefix_cursor_not_linked');}
   const refs=row.reviewed_message_binding.messages;check(refs.every(x=>byKey.has(x.message_key)),'repair_binding_missing');
   const id=digest([mr,ar,r.store,r.id]),member=row.buyer_member_id||'';
   db.prepare('INSERT OR IGNORE INTO history_inquiries VALUES(?,?,?,?,?,?)').run(r.store,r.id,member,Date.parse(row.created_at),ar.path,ar.sha256);
   db.prepare('INSERT OR IGNORE INTO history_chats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,mr.path,1,r.store,r.id,member,key,JSON.stringify(identity),fromMs,null,snapshot,endpoint?'endpoint_exhausted':'window_complete',pages.length,refs.length,1,null,JSON.stringify(unique));
   for(const p of refs){const b=byKey.get(p.message_key),v=b.variants[0].message;if(b.conversation_id!==identity.conversation_id)continue;check(v.send_time_ms<snapshot,'repair_snapshot_out_of_range');const ordinary=v.direction==='buyer'&&v.content_status!=='recalled_or_hidden'&&v.reply_source!=='ai'&&!Object.values(v.automation_flags||{}).some(x=>x===true);db.prepare('INSERT OR IGNORE INTO history_messages(store_key,conversation_key,message_id,content_sha256,chat_id,sent_at_ms,ordinary_buyer) VALUES(?,?,?,?,?,?,?)').run(r.store,key,v.message_id,digest(v),id,v.send_time_ms,Number(ordinary));}
   chats++;
  }
  for(const b of bounds.filter(b=>b.variants.length>1)){
   const normalized=b.variants.map(v=>semanticMessage(v.message));check(normalized.every(v=>digest(v)===digest(normalized[0])),'repair_substantive_message_conflict');
   const v=b.variants[0].message,key=digest([b.store_key,v.owner_account_id,v.buyer_account_id,b.conversation_id]);
   db.prepare('INSERT OR IGNORE INTO history_message_resolutions VALUES(?,?,?,?,?,?,?)').run(b.store_key,key,b.message_id,JSON.stringify(b.variants.map(v=>digest(v.message))),br.path,br.sha256,JSON.stringify([br]));resolutions++;
  }
  db.exec('RELEASE reviewed_repair');
 }catch(e){db.exec('ROLLBACK TO reviewed_repair');db.exec('RELEASE reviewed_repair');throw e;}
 return {schema_version:'lew.reviewed-repair-index-receipt.v1',chats,semantic_resolutions:resolutions,dependencies:unique,source:mr};
}
