import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {openHistory,indexBundle,indexResearch,indexChat,indexExistingSqlite,indexPriorContactReview,indexExclusions,historySummary,planHistory,DEFAULT_DB,discoverHistory,digest} from '../scripts/history_index.mjs';
import {DatabaseSync} from 'node:sqlite';
import {prepareHistoryCollection,acceptHistoryWindow,registerHistoryRun} from '../scripts/history_collection.mjs';
import {prepareWindow,nextWindow,acceptWindow} from '../scripts/chat_window.mjs';
import {prepareLocal,createAnalysisDraft,reviewLocal} from '../scripts/buyer_due_diligence_local.mjs';
import legacy from '../scripts/alibaba_chat_collector.js';
import {semanticMessage,indexReviewedRepair} from '../scripts/history_reviewed_repair.mjs';
import {browserFixture,browserBinding,storeProof} from './store_binding_fixture.mjs';
import {createWindowRunner} from '../scripts/chat_window_runner.mjs';
import {replayHistoricalWindow} from '../scripts/history_replay.mjs';
const from='2026-10-01T00:00:00+08:00',to='2026-10-08T00:00:00+08:00',later='2026-10-15T00:00:00+08:00';
const member='alibaba-visible-member:buyer001';
const who={owner_account_id:'seller001',buyer_account_id:'buyer001',conversation_id:'conv001'};

test('semantic repair strips only transient workspace card transport differences',()=>{
 const a={...message('1'),source_content:'https://workspace.alibaba.com/card?type=2013&name=synthetic&ctime=1&sign=a'},b={...a,source_content:'https://workspace.alibaba.com/card?type=2013&name=synthetic&ctime=2&sign=b'};
 assert.deepEqual(semanticMessage(a),semanticMessage(b));
 assert.notDeepEqual(semanticMessage(a),semanticMessage({...b,buyer_account_id:'different-buyer'}));
 assert.notDeepEqual(semanticMessage(a),semanticMessage({...b,source_content:'https://workspace.alibaba.com/card?type=2013&name=changed&ctime=2&sign=b'}));
});

test('reviewed repair refuses changed receipts, a different account, and failed post-store proof',t=>{
 const f=fixture(t),m=message('1'),b={key:'demobeta|conv001|1',store_key:'demobeta',conversation_id:'conv001',message_id:'1',variants:[{message:m}]};
 f.save('data/repair-messages.jsonl',b);f.save('data/repair-analysis.json',{analysis_before_exclusive:to,rows:[]});
 const task={store_key:'demobeta',request_id:'repair-test',identity:who,cursor:null,page_size:2};
 const p={task,receipt:{identity:who,store_proof:storeProof('demobeta','repair-test',browserBinding),observed_at_ms:Date.now(),session_member_id:'synthetic',rows:[m],error:null},proof_after:{store_key:'demobeta'}};task.session_member_id='synthetic';
 const manifest={schema:'lew.scoped-gap-repair.v1',baseline:{path:'data/source.json',sha256:digest(readFileSync(join(f.root,'data/source.json')))},bound_messages_sha256:digest(readFileSync(join(f.root,'data/repair-messages.jsonl'))),resolutions:Array.from({length:9},(_,i)=>({store:'demobeta',id:String(i),closed:true,prior_reason:'message_version_difference'})),sources:[]};
 const args={manifest:'data/repair-manifest.json',analysis:'data/repair-analysis.json',messages:'data/repair-messages.jsonl'};
 const save=()=>{f.save('data/repair-page.json',p);manifest.sources=[{store:'demobeta',path:'data/repair-page.json',sha256:digest(readFileSync(join(f.root,'data/repair-page.json')))}];f.save(args.manifest,manifest);};
 save();f.save('data/repair-page.json',{changed:true});assert.throws(()=>indexReviewedRepair(f.db,args,f.root),/repair_receipt_changed/);
 p.receipt.identity={...who,buyer_account_id:'other'};save();assert.throws(()=>indexReviewedRepair(f.db,args,f.root),/repair_identity_changed/);
 p.receipt.identity=who;p.proof_after.store_key='demogamma';save();assert.throws(()=>indexReviewedRepair(f.db,args,f.root),/repair_receipt_failed/);
 assert.equal(historySummary(f.db).chat_observations,0);
});

test('two-sided prior-relationship review preserves actual statement dates and rejects one-sided or changed quotes',t=>{
 const f=fixture(t),run='data/relation';prepareWindow({...opts,run},f.root);let step=nextWindow(run,f.root);acceptWindow(run,receipt(step),f.root);step=nextWindow(run,f.root);
 const buyer=message('1',Date.parse(from)+1000,'I already ordered last time.'),seller={...message('2',Date.parse(from)+2000,'Your order was placed last March.'),direction:'seller',sender_account_id:who.owner_account_id};
 acceptWindow(run,receipt(step,[seller,buyer]),f.root);indexChat(f.db,{run},f.root);
 const lines=readFileSync(join(f.root,run,'page-2.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const refs=[buyer,seller].map(m=>{const r=f.db.prepare('SELECT * FROM history_messages WHERE message_id=?').get(m.message_id);return{chat_id:r.chat_id,message_id:m.message_id,message_sha256:r.content_sha256,source:{path:run+'/page-2.jsonl',line:lines.findIndex(x=>(x.message||x).message_id===m.message_id)+1},quote:m.text}});
 const proof={schema_version:'lew.prior-contact-review.v1',basis:'reviewed_prior_relationship_statements',store_key:'demobeta',inquiry_id:'101',buyer_member_id:member,window_from:from,review_before_exclusive:to,chat_id:refs[0].chat_id,message_id:'1',message_sha256:refs[0].message_sha256,statement_refs:[refs[0]]};
 f.save('data/relation-review.json',proof);assert.throws(()=>indexPriorContactReview(f.db,'data/relation-review.json',f.root),/two_sided_review_required/);
 proof.statement_refs=[refs[0],{...refs[1],quote:'different quote'}];f.save('data/relation-review.json',proof);assert.throws(()=>indexPriorContactReview(f.db,'data/relation-review.json',f.root),/quote_changed/);
 const other='data/relation-other';prepareWindow({...opts,run:other},f.root);step=nextWindow(other,f.root);acceptWindow(other,receipt(step),f.root);step=nextWindow(other,f.root);acceptWindow(other,receipt(step,[seller,buyer]),f.root);indexChat(f.db,{run:other},f.root);
 const otherSeller=f.db.prepare('SELECT m.* FROM history_messages m JOIN history_chats c ON c.id=m.chat_id WHERE c.run=? AND m.message_id=?').get(other,'2');
 proof.statement_refs=[refs[0],{...refs[1],chat_id:otherSeller.chat_id,source:{...refs[1].source,path:other+'/page-2.jsonl'}}];f.save('data/relation-review.json',proof);assert.throws(()=>indexPriorContactReview(f.db,'data/relation-review.json',f.root),/same_run_required/);
 proof.statement_refs=refs;f.save('data/relation-review.json',proof);indexPriorContactReview(f.db,'data/relation-review.json',f.root);
 const result=planHistory({source:'data/source.json',asOf:to,from},f.root).records[0];assert.equal(result.decision,'exclude_prior_contact');assert.equal(result.reason,'verified_prior_relationship_statements');assert.equal(Date.parse(result.history_evidence.sent_at),buyer.send_time_ms);assert.ok(Date.parse(result.history_evidence.sent_at)>=Date.parse(from));
});

test('memberless exact-account repair is reused only at its pinned cutoff and stops on changed evidence',t=>{
 const f=fixture(t);f.source.buyer_member_links=[];f.save('data/source.json',f.source);
 assert.equal(planHistory({source:'data/source.json',asOf:to,from},f.root).records[0].decision,'needs_review');
 f.save('data/proof.json',{kind:'synthetic reviewed account repair'});const sha=digest(readFileSync(join(f.root,'data/proof.json'))),deps=JSON.stringify([{path:'data/proof.json',sha256:sha}]);
 f.db.prepare('INSERT INTO history_chats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-repair','data/proof.json',1,'demobeta','101','',digest(['demobeta',who.owner_account_id,who.buyer_account_id,who.conversation_id]),JSON.stringify(who),Date.parse(from),null,Date.parse(to),'endpoint_exhausted',1,1,1,null,deps);
 const p=planHistory({source:'data/source.json',asOf:to,from},f.root);assert.equal(p.records[0].decision,'reuse');assert.equal(p.records[0].buyer_member_id,null);
 assert.equal(prepareHistoryCollection({...opts,run:'data/reused-null'},f.root).runs.length,0);
 assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].decision,'needs_review');
 f.save('data/proof.json',{kind:'changed synthetic source'});assert.equal(planHistory({source:'data/source.json',asOf:to,from},f.root).records[0].decision,'needs_review');
});

test('memberless research needs the exact verified account proof and never merges another inquiry',t=>{
 const f=fixture(t);f.save('data/proof.json',{kind:'synthetic exact source'});const deps=JSON.stringify([{path:'data/proof.json',sha256:digest(readFileSync(join(f.root,'data/proof.json')))}]);
 f.db.prepare('INSERT INTO history_chats VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-repair','data/proof.json',1,'demobeta','101','',digest(who),JSON.stringify(who),Date.parse(from),null,Date.parse(to),'endpoint_exhausted',1,1,1,null,deps);
 f.save('data/null-research.json',{schema_version:'local.public-evidence-index.v1',records:[{store_key:'demobeta',inquiry_id:'101',buyer_member_id:null,exact_account_binding:who,status:'synthetic assessment',observed_at:to},{store_key:'demobeta',inquiry_id:'102',buyer_member_id:null,exact_account_binding:who,status:'unbound other inquiry',observed_at:to}]});
 indexResearch(f.db,'data/null-research.json',f.root);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM history_research').get().n,1);assert.equal(f.db.prepare('SELECT member_id FROM history_research').get().member_id,'');
});

test('a reviewed message resolution is limited to pinned known hashes and cannot hide a third version',t=>{
 const f=fixture(t);completed(f);const row=f.db.prepare('SELECT * FROM history_messages LIMIT 1').get();
 f.db.prepare('INSERT INTO history_messages(store_key,conversation_key,message_id,content_sha256,chat_id) VALUES(?,?,?,?,?)').run(row.store_key,row.conversation_key,row.message_id,'synthetic-second-hash',row.chat_id);
 assert.equal(planHistory({source:'data/source.json',asOf:to,from},f.root).records[0].reason,'history_message_content_conflict');
 f.save('data/resolution.json',{kind:'synthetic validated transport equivalence'});const sha=digest(readFileSync(join(f.root,'data/resolution.json')));
 f.db.prepare('INSERT INTO history_message_resolutions VALUES(?,?,?,?,?,?,?)').run(row.store_key,row.conversation_key,row.message_id,JSON.stringify([row.content_sha256,'synthetic-second-hash']),'data/resolution.json',sha,JSON.stringify([{path:'data/resolution.json',sha256:sha}]));
 assert.equal(planHistory({source:'data/source.json',asOf:to,from},f.root).records[0].decision,'reuse');
 f.db.prepare('INSERT INTO history_messages(store_key,conversation_key,message_id,content_sha256,chat_id) VALUES(?,?,?,?,?)').run(row.store_key,row.conversation_key,row.message_id,'synthetic-third-hash',row.chat_id);
 assert.equal(planHistory({source:'data/source.json',asOf:to,from},f.root).records[0].reason,'history_message_content_conflict');
});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'okki-history-test-'));let db;t.after(()=>{db?.close();assert.equal(dirname(root),resolve(tmpdir()));assert.match(basename(root),/^okki-history-test-/);rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'data'));mkdirSync(join(root,'scripts'));browserFixture(root);
  for(const name of ['alibaba_chat_collector.js','alibaba_chat_window.js','chat_window.mjs'])copyFileSync(resolve('scripts',name),join(root,'scripts',name));
  const source={store_key:'demobeta',inquiries:[{store_key:'demobeta',inquiry_id:'101',created_at:from,buyer_name:'Same Name'}],
    buyer_member_links:[{store_key:'demobeta',inquiry_id:'101',buyer_member_id:member,source_system:'alibaba-message-querySummary-contact-loginId-v1'}]};
  const save=(path,v)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),JSON.stringify(v));};
  save('data/source.json',source);db=openHistory(DEFAULT_DB,root);
  return {root,db,source,save};
}
const opts={source:'data/source.json',store:'demobeta',browserMap:'data/browser-map.json',from,to,asOf:to,pageSize:2,maxPages:5};
function receipt(step,rows=[],identity=who,more=false){const proof=storeProof('demobeta',step.ticket.request_id,step.browser_binding);return {kind:step.kind,request_id:step.ticket.request_id,observed_at_ms:Date.now(),store_proof:proof,identity,session_member_id:'session001',rows,has_more:more,error:null};}
function message(id,time=Date.parse(from)+1000,text='synthetic'){return legacy.normalizeMessage({messageId:id,sendTime:time,owner:{accountId:who.owner_account_id},contact:{accountId:who.buyer_account_id},type:1,subType:1,messageType:'rec',content:text},who);}
function completed(f,run='data/old',extra={}){
  prepareWindow({...opts,run,...extra},f.root);
  let step=nextWindow(run,f.root);acceptWindow(run,receipt(step),f.root);
  step=nextWindow(run,f.root);acceptWindow(run,receipt(step,[message('1')]),f.root);
  return indexChat(f.db,{run},f.root);
}
test('idempotent three-store identity index never merges same names or cross-store members',t=>{
  const f=fixture(t);indexBundle(f.db,'data/source.json',f.root);indexBundle(f.db,'data/source.json',f.root);
  f.save('data/other.json',{inquiries:[{store_key:'demogamma',inquiry_id:'101',created_at:from,buyer_name:'Same Name'}],buyer_member_links:[{...f.source.buyer_member_links[0],store_key:'demogamma'}]});
  indexBundle(f.db,'data/other.json',f.root);assert.equal(historySummary(f.db).inquiries,2);
  f.save('data/research.json',{schema_version:'lew.public-fact-evidence.v1',store_key:'demobeta',records:[{buyer_member_id:member,inquiry_ids:['101'],observed_at:to,sources:[{url:'https://example.org/company'}]}]});
  indexResearch(f.db,'data/research.json',f.root);const p=planHistory({source:'data/other.json',asOf:later,from},f.root);assert.equal(p.records[0].research.length,0);
});
test('inquiry identity conflicts are retained for review and invalid imports roll back',t=>{
  const f=fixture(t);indexBundle(f.db,'data/source.json',f.root);
  f.source.buyer_member_links[0].buyer_member_id='alibaba-visible-member:buyer002';f.save('data/conflict.json',f.source);indexBundle(f.db,'data/conflict.json',f.root);
  assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].reason,'history_member_conflict');
  f.source.inquiries.push({store_key:'invalid/store',inquiry_id:'102'});f.save('data/invalid.json',f.source);
  const before=historySummary(f.db).artifacts;assert.throws(()=>indexBundle(f.db,'data/invalid.json',f.root),/invalid_inquiry/);assert.equal(historySummary(f.db).artifacts,before);
});
test('verified baseline is reused, later snapshots become incremental, and evidence bytes stay unchanged',t=>{
  const f=fixture(t);indexBundle(f.db,'data/source.json',f.root);completed(f);
  const before=readFileSync(join(f.root,'data/old/checkpoint.json'));
  assert.equal(planHistory({source:'data/source.json',asOf:to,from},f.root).records[0].decision,'reuse');
  const p=planHistory({source:'data/source.json',asOf:later,from},f.root);assert.equal(p.records[0].decision,'incremental');assert.equal(Date.parse(p.records[0].messages_after),Date.parse(to));
  indexChat(f.db,{run:'data/old'},f.root);assert.equal(historySummary(f.db).unique_messages,1);assert.deepEqual(readFileSync(join(f.root,'data/old/checkpoint.json')),before);
  assert.equal(JSON.stringify(p).includes('synthetic'),false);
});
test('only published frozen sources replay; unknown and tampered sources fail',t=>{
  const f=fixture(t),collectorPath=join(f.root,'scripts/alibaba_chat_collector.js');
  const current=readFileSync(collectorPath,'utf8');
  completed(f,'data/published');
  const checkpoint=readFileSync(join(f.root,'data/published/checkpoint.json'));
  assert.equal(replayHistoricalWindow('data/published',f.root).messages.length,1);
  assert.deepEqual(readFileSync(join(f.root,'data/published/checkpoint.json')),checkpoint);
  writeFileSync(collectorPath,current+'\n/* unreviewed source variant */\n');completed(f,'data/unreviewed');
  writeFileSync(collectorPath,current);
  assert.throws(()=>replayHistoricalWindow('data/unreviewed',f.root),/history_frozen_version_not_reviewed/);
  writeFileSync(join(f.root,'data/published/runtime/legacy.txt'),current+'\n/* tampered */\n');
  assert.throws(()=>replayHistoricalWindow('data/published',f.root),/history_frozen_source_changed/);
});
test('changing browser or binding source and its self-reported pin cannot authorize replay',t=>{
  for(const name of ['browser','binding']){
    const f=fixture(t);completed(f,'data/published');
    const runtime=join(f.root,`data/published/runtime/${name}.txt`);
    writeFileSync(runtime,readFileSync(runtime,'utf8')+'\n/* unknown public source variant */\n');
    const configPath=join(f.root,'data/published/config.json');
    const config=JSON.parse(readFileSync(configPath,'utf8'));
    config.pins[name]=digest(readFileSync(runtime));
    writeFileSync(configPath,JSON.stringify(config));
    assert.throws(()=>replayHistoricalWindow('data/published',f.root),/history_frozen_version_not_reviewed/);
  }
});

test('missing or changed dependencies and future snapshots cannot authorize skipping',t=>{
  const f=fixture(t);completed(f);
  assert.equal(planHistory({source:'data/source.json',asOf:from,from},f.root).records[0].decision,'collect');
  writeFileSync(join(f.root,'data/old/page-2.jsonl'),'tampered');
  assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].decision,'collect');
});
test('an incremental-only run cannot hide a missing baseline; partial pages cannot move cutoff',t=>{
  const f=fixture(t);completed(f,'data/increment',{messagesAfter:'2026-10-02T00:00:00+08:00'});
  assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].decision,'collect');
});
test('message content conflicts across runs stop reuse without replacing either source',t=>{
  const f=fixture(t);completed(f);
  prepareWindow({...opts,run:'data/conflict'},f.root);let s=nextWindow('data/conflict',f.root);acceptWindow('data/conflict',receipt(s),f.root);
  s=nextWindow('data/conflict',f.root);acceptWindow('data/conflict',receipt(s,[message('1',Date.parse(from)+1000,'changed')]),f.root);indexChat(f.db,{run:'data/conflict'},f.root);
  assert.equal(historySummary(f.db).conflicting_messages,1);assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].reason,'history_message_content_conflict');
});
test('history preparation splits fresh and incremental targets and checks live conversation before accepting',t=>{
  const f=fixture(t);completed(f);f.source.inquiries.push({store_key:'demobeta',inquiry_id:'102',created_at:from});f.source.buyer_member_links.push({...f.source.buyer_member_links[0],inquiry_id:'102',buyer_member_id:'alibaba-visible-member:buyer002'});f.save('data/new.json',f.source);
  const p=prepareHistoryCollection({...opts,source:'data/new.json',asOf:later,run:'data/new-runs'},f.root);assert.equal(p.runs.length,2);
  const run=p.runs.find(r=>r.messages_after).run,s=nextWindow(run,f.root);
  assert.throws(()=>acceptHistoryWindow(run,receipt(s,[],{...who,conversation_id:'wrong'}),f.root),/history_live_conversation_changed/);
  assert.equal(JSON.parse(readFileSync(join(f.root,run,'checkpoint.json'))).revision,0);
  acceptHistoryWindow(run,receipt(s),f.root);assert.ok(registerHistoryRun(run,f.root).verified);
});
test('research preserves original observation and candidate status; lookup does not imply formal completion',t=>{
  const f=fixture(t);f.save('data/research.json',{schema_version:'lew.public-fact-evidence.v1',store_key:'demobeta',records:[{buyer_member_id:member,inquiry_ids:['101'],observed_at:to,status:'candidate',sources:[{url:'https://example.org/company'}]}]});
  indexResearch(f.db,'data/research.json',f.root);indexResearch(f.db,'data/research.json',f.root);
  const p=planHistory({source:'data/source.json',asOf:later,from},f.root);assert.equal(p.records[0].research.length,1);assert.equal(p.records[0].research[0].status,'candidate');
  assert.equal(historySummary(f.db).research_observations,1);
  f.save('data/scope.json',{stores:['demobeta'],from_inclusive:from,to_exclusive:later,time_zone:'Asia/Shanghai',batch_id:'next'});
  prepareLocal({source:'data/source.json',scope:'data/scope.json',out:'data/input.json'},f.root);
  const local=JSON.parse(readFileSync(join(f.root,'data/input.json')));assert.equal(local.history_reuse.research_queue[0].action,'review_existing_background_then_fill_gaps');assert.equal(local.units[0].profile,null);
  createAnalysisDraft({input:'data/input.json',out:'data/analysis.json',asOf:later},f.root);
  reviewLocal({input:'data/input.json',analysis:'data/analysis.json',out:'data/review.json'},f.root);assert.ok(existsSync(join(f.root,'data/review.json')));
});
test('discovery excludes synthetic and frozen verification copies',t=>{
  const f=fixture(t);f.save('data/research-root/source.json',f.source);f.save('data/research-root/synthetic/source.json',f.source);f.save('data/research-root/v1-validation-root/source.json',f.source);
  const p=discoverHistory({roots:['data/research-root']},f.root);
  assert.equal(p.entries.length,1);
});
test('a pending run is catalogued without resolving or retrying it',t=>{
  const f=fixture(t);prepareWindow({...opts,run:'data/pending'},f.root);nextWindow('data/pending',f.root);
  const before=readFileSync(join(f.root,'data/pending/pending.json'));
  const r=indexChat(f.db,{run:'data/pending',allowUnverified:true},f.root);assert.equal(r.verified,true);assert.equal(r.pending.status,'unknown_transport_result');
  assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].reason,'history_pending_requires_reconciliation');
  assert.deepEqual(readFileSync(join(f.root,'data/pending/pending.json')),before);
});
test('a gap between a baseline and an incremental run cannot advance the boundary',t=>{
  const f=fixture(t);completed(f);completed(f,'data/gapped',{asOf:later,messagesAfter:'2026-10-09T00:00:00+08:00'});
  const r=planHistory({source:'data/source.json',asOf:later,from},f.root).records[0];assert.equal(Date.parse(r.messages_after),Date.parse(to));
});
test('page-budget exhaustion is not a complete historical baseline',t=>{
  const f=fixture(t);prepareWindow({...opts,run:'data/partial',maxPages:1},f.root);
  let s=nextWindow('data/partial',f.root);acceptWindow('data/partial',receipt(s),f.root);
  s=nextWindow('data/partial',f.root);acceptWindow('data/partial',receipt(s,[message('1')],who,true),f.root);indexChat(f.db,{run:'data/partial'},f.root);
  const p=planHistory({source:'data/source.json',asOf:later,from},f.root);assert.equal(p.records[0].decision,'collect');assert.equal(p.records[0].historical_gaps[0].status,'page_budget_reached');
});
test('unversioned backgrounds use explicit exact associations and never the displayed anchor',t=>{
  const f=fixture(t);f.save('data/background/source.json',{store_key:'demobeta',generated_at:to,source_files:[],records:[{anchor:'Same Name',sources:[{url:'https://example.org/company'}],associations:[{store_key:'demobeta',inquiry_id:'101',buyer_member_id:member}]}]});
  const spec=discoverHistory({roots:['data/background']},f.root);assert.equal(spec.entries[0].format,'background-associated-records-v1');
  indexResearch(f.db,spec.entries[0].path,f.root,spec.entries[0].format);assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].research[0].category,'public_background');
});
test('existing SQLite is read-only and native member records are not fabricated inquiries',t=>{
  const f=fixture(t),p=join(f.root,'data/old.sqlite'),old=new DatabaseSync(p);
  old.exec(`CREATE TABLE inquiries_current(store_key,inquiry_id,created_at);
    INSERT INTO inquiries_current VALUES('demobeta','101','${from}');
    CREATE TABLE native_inquiry_member_records(store_key,source_record_id,buyer_member_id,gmt_create,source_system);
    INSERT INTO native_inquiry_member_records VALUES('demoalpha','original:1','${member}','2026-07-01 06:00:43','alibaba-native-inquiry-xlsx-sender-member-id-v1');`);old.close();
  const before=readFileSync(p);indexExistingSqlite(f.db,'data/old.sqlite',f.root);indexExistingSqlite(f.db,'data/old.sqlite',f.root);
  const sum=historySummary(f.db);assert.equal(sum.inquiries,1);assert.equal(sum.native_member_records,1);assert.deepEqual(readFileSync(p),before);
});
test('the existing runner checks live historical identity and registers new accepted sources',async t=>{
  const f=fixture(t);completed(f);assert.equal(historySummary(f.db).inquiries,1);
  const p=prepareHistoryCollection({...opts,asOf:later,run:'data/runner'},f.root),run=p.runs[0].run;
  const pending=()=>JSON.parse(readFileSync(join(f.root,run,'pending.json')));
  const route=browserBinding('demobeta');
  const runner=createWindowRunner({run,threadId:'test-owner',browserBinding:route,homePageId:'home',messagePageId:'messages',
    homeCdp:{async send(){return {result:{value:storeProof('demobeta',pending().request_id,route)}};}},
    messageCdp:{async send(){return {result:{value:{kind:pending().task.kind,request_id:pending().request_id,observed_at_ms:Date.now(),store_proof:storeProof('demobeta',pending().request_id,route),identity:{...who,conversation_id:'wrong'},session_member_id:'session001',rows:[],has_more:false,error:null}}};}}},f.root);
  await assert.rejects(()=>runner.batch({steps:1}),/history_live_conversation_changed/);
  assert.equal(JSON.parse(readFileSync(join(f.root,run,'checkpoint.json'))).revision,0);
});
test('same-member inquiries retain their independently verified seller conversations',t=>{
  const f=fixture(t);completed(f);
  f.source.inquiries=[{...f.source.inquiries[0],inquiry_id:'102'}];f.source.buyer_member_links=[{...f.source.buyer_member_links[0],inquiry_id:'102'}];f.save('data/second-source.json',f.source);
  const other={...who,owner_account_id:'seller002',conversation_id:'conv002'};
  prepareWindow({...opts,source:'data/second-source.json',run:'data/second'},f.root);
  let s=nextWindow('data/second',f.root);acceptWindow('data/second',receipt(s,[],other),f.root);
  s=nextWindow('data/second',f.root);acceptWindow('data/second',receipt(s,[],other),f.root);indexChat(f.db,{run:'data/second'},f.root);
  const a=planHistory({source:'data/source.json',asOf:later,from},f.root).records[0],b=planHistory({source:'data/second-source.json',asOf:later,from},f.root).records[0];
  assert.equal(a.decision,'incremental');assert.deepEqual(a.identity,who);assert.equal(b.decision,'incremental');assert.deepEqual(b.identity,other);
  f.source.inquiries[0].inquiry_id='103';f.source.buyer_member_links[0].inquiry_id='103';f.save('data/new-third.json',f.source);
  assert.equal(planHistory({source:'data/new-third.json',asOf:later,from},f.root).records[0].reason,'history_conversation_conflict');
});
test('an unresolved ticket blocks its conversation while other committed conversations stay reusable',t=>{
  const f=fixture(t),other={...who,buyer_account_id:'buyer002',conversation_id:'conv002'};
  f.source.inquiries.push({...f.source.inquiries[0],inquiry_id:'102'});f.source.buyer_member_links.push({...f.source.buyer_member_links[0],inquiry_id:'102',buyer_member_id:'alibaba-visible-member:buyer002'});f.save('data/source.json',f.source);
  prepareWindow({...opts,run:'data/mixed'},f.root);let s=nextWindow('data/mixed',f.root);acceptWindow('data/mixed',receipt(s),f.root);
  s=nextWindow('data/mixed',f.root);acceptWindow('data/mixed',receipt(s,[],other),f.root);
  s=nextWindow('data/mixed',f.root);acceptWindow('data/mixed',receipt(s,[message('1')]),f.root);nextWindow('data/mixed',f.root);
  const before=readFileSync(join(f.root,'data/mixed/pending.json')),cp=readFileSync(join(f.root,'data/mixed/checkpoint.json'));
  const indexed=indexChat(f.db,{run:'data/mixed'},f.root);assert.equal(indexed.pending.inquiry_id,'102');
  const plan=planHistory({source:'data/source.json',asOf:later,from},f.root);assert.equal(plan.records[0].decision,'incremental');assert.equal(plan.records[1].reason,'history_pending_requires_reconciliation');
  assert.deepEqual(readFileSync(join(f.root,'data/mixed/pending.json')),before);assert.deepEqual(readFileSync(join(f.root,'data/mixed/checkpoint.json')),cp);
});
test('a changed pending ticket cannot be used to certify a committed prefix',t=>{
  const f=fixture(t);prepareWindow({...opts,run:'data/bad-ticket'},f.root);const step=nextWindow('data/bad-ticket',f.root);
  f.save('data/bad-ticket/pending.json',{...step.ticket,previous_sha256:'0'.repeat(64)});
  assert.throws(()=>indexChat(f.db,{run:'data/bad-ticket'},f.root),/pending_changed/);
});
test('an already committed pending ticket is audited without deleting original files',t=>{
  const f=fixture(t);completed(f);const events=JSON.parse(readFileSync(join(f.root,'data/old/event-2.json')));f.save('data/old/pending.json',events.ticket);
  const before=readFileSync(join(f.root,'data/old/pending.json'));const result=indexChat(f.db,{run:'data/old'},f.root);
  assert.equal(result.pending.status,'committed_cleanup_pending');assert.deepEqual(readFileSync(join(f.root,'data/old/pending.json')),before);
  assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].decision,'incremental');
});
test('a reviewed prior-contact message uses its exact hash and requested window without certifying history completeness',t=>{
  const f=fixture(t);prepareWindow({...opts,run:'data/prior'},f.root);let s=nextWindow('data/prior',f.root);acceptWindow('data/prior',receipt(s),f.root);
  s=nextWindow('data/prior',f.root);acceptWindow('data/prior',receipt(s,[message('old',Date.parse(from)-1000)]),f.root);indexChat(f.db,{run:'data/prior'},f.root);
  const window='2026-10-02T00:00:00+08:00';assert.equal(planHistory({source:'data/source.json',asOf:later,from:window},f.root).records[0].decision,'collect');
  const m=f.db.prepare("SELECT * FROM history_messages WHERE message_id='old'").get();
  const proof={schema_version:'lew.prior-contact-review.v1',store_key:'demobeta',inquiry_id:'101',buyer_member_id:member,window_from:window,chat_id:m.chat_id,message_id:m.message_id,message_sha256:m.content_sha256};
  f.save('data/contact-review.json',{...proof,message_sha256:'0'.repeat(64)});assert.throws(()=>indexPriorContactReview(f.db,'data/contact-review.json',f.root),/witness_not_verified/);
  f.save('data/contact-review.json',proof);indexPriorContactReview(f.db,'data/contact-review.json',f.root);
  const result=planHistory({source:'data/source.json',asOf:later,from:window},f.root).records[0];assert.equal(result.decision,'exclude_prior_contact');assert.equal(result.history_evidence.message_id,'old');assert.equal(result.messages_after,null);
  assert.equal(planHistory({source:'data/source.json',asOf:later,from:'2026-10-03T00:00:00+08:00'},f.root).records[0].decision,'collect');
});
function excludeFixture(f){
  f.source.buyer_member_links=[];f.save('data/source.json',f.source);indexBundle(f.db,'data/source.json',f.root);
  f.save('data/exclusions.json',{schema_version:'lew.inquiry-exclusions.v1',authority:'user_confirmed',reason:'phishing',confirmed_at:later,user_instruction:'Exclude this exact inquiry as confirmed phishing.',evidence:[],records:[{store_key:'demobeta',inquiry_id:'101'}]});
  indexExclusions(f.db,'data/exclusions.json',f.root);
}
test('user-confirmed phishing overrides missing membership only for the exact store and inquiry',t=>{
  const f=fixture(t);excludeFixture(f);indexExclusions(f.db,'data/exclusions.json',f.root);
  const r=planHistory({source:'data/source.json',asOf:later,from},f.root).records[0];assert.equal(r.decision,'exclude_phishing');assert.equal(r.buyer_member_id,null);assert.equal(r.excluded_from_research,true);
  assert.equal(historySummary(f.db).excluded_phishing_inquiries,1);
  f.source.store_key='demogamma';f.source.inquiries[0].store_key='demogamma';f.save('data/other-store.json',f.source);
  assert.equal(planHistory({source:'data/other-store.json',asOf:later,from},f.root).records[0].decision,'needs_review');
});
test('phishing inquiries create neither collection runs nor local research targets',t=>{
  const f=fixture(t);excludeFixture(f);const before=readFileSync(join(f.root,'data/source.json'));
  const p=prepareHistoryCollection({...opts,asOf:later,run:'data/excluded-runs'},f.root);assert.equal(p.runs.length,0);assert.equal(p.counts.exclude_phishing,1);
  f.save('data/scope.json',{stores:['demobeta'],from_inclusive:from,to_exclusive:to,as_of:later,time_zone:'Asia/Shanghai',batch_id:'phishing-filter'});
  prepareLocal({source:'data/source.json',scope:'data/scope.json',out:'data/filtered.json'},f.root);
  const local=JSON.parse(readFileSync(join(f.root,'data/filtered.json')));assert.equal(local.units.length,0);assert.equal(local.history_reuse.research_queue.length,0);assert.equal(local.excluded_inquiries.length,1);
  assert.deepEqual(readFileSync(join(f.root,'data/source.json')),before);
});
test('changed exclusion evidence stops processing instead of silently reactivating phishing',t=>{
  const f=fixture(t);excludeFixture(f);writeFileSync(join(f.root,'data/exclusions.json'),'{}');
  assert.equal(planHistory({source:'data/source.json',asOf:later,from},f.root).records[0].reason,'history_exclusion_evidence_changed');
});
