// Run known historical validators from exact frozen files in a private copy.
// No eval/vm, browser calls, changes to original runs, or continuation of old jobs.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {dataPath} from './chat_collection.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,code)=>{if(!ok)throw Error(code);};
export function replayHistoricalWindow(run,root){
  const dir=dataPath(run,root),config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));
  const code={legacy:'scripts/alibaba_chat_collector.js',workflow:'scripts/chat_window.mjs',browser:'scripts/alibaba_chat_window.js',binding:'lib/store_binding.js'};
  check(Object.entries(code).every(([key,name])=>config.pins?.[key]===sha(readFileSync(join(root,name)))),'history_frozen_version_not_reviewed');
  const replay=dataPath(join('data/history-index-replay',sha(JSON.stringify(config.pins))),root);
  const inputs=new Map(),copy=(source,name)=>{
    const bytes=readFileSync(source);inputs.set(relative(root,source).replaceAll('\\','/'),sha(bytes));
    const out=join(replay,name);mkdirSync(dirname(out),{recursive:true});
    if(!existsSync(out)||!readFileSync(out).equals(bytes))writeFileSync(out,bytes,{mode:0o600});
  };
  for(const [key,name] of Object.entries(code)){
    const source=join(dir,'runtime',key+'.txt');check(sha(readFileSync(source))===config.pins[key],'history_frozen_source_changed');copy(source,name);
  }
  const packageRoot=dirname(dirname(fileURLToPath(import.meta.url)));
  for(const name of ['scripts/chat_collection.mjs','scripts/country.mjs','scripts/country_names.json','lib/store_browser.mjs'])copy(existsSync(join(root,name))?join(root,name):join(packageRoot,name),name);
  const relRun=relative(root,dir).replaceAll('\\','/');
  for(const e of readdirSync(dir,{withFileTypes:true}))if(e.isFile()&&/^(?:config\.json|checkpoint\.json|event-\d+\.json|page-\d+\.jsonl)$/.test(e.name))copy(join(dir,e.name),join(relRun,e.name));
  for(const key of Object.keys(code))copy(join(dir,'runtime',key+'.txt'),join(relRun,'runtime',key+'.txt'));
  copy(dataPath(config.source,root),config.source);
  const pendingPath=join(dir,'pending.json'),hasPending=existsSync(pendingPath);
  if(hasPending)copy(pendingPath,join(relRun,'pending.json'));
  // A previous replay's mutable ticket is never reused for a different source state.
  const program=`import {pathToFileURL} from 'node:url';import {readFileSync,existsSync} from 'node:fs';import {isDeepStrictEqual} from 'node:util';
    const [base,run]=process.argv.slice(1);
    const {inspectWindow,nextWindow}=await import(pathToFileURL(base+'/scripts/chat_window.mjs'));
    try {const v=inspectWindow(run,base);let pending=null;
      if(process.argv[3]==='true'){
        const ticket=JSON.parse(readFileSync(base+'/'+run+'/pending.json','utf8'));
        const committed=v.events.find(e=>e.ticket.request_id===ticket.request_id);
        if(committed){if(!isDeepStrictEqual(committed.ticket,ticket))throw Error('pending_changed');}
        else {const validated=nextWindow(run,base);if(!isDeepStrictEqual(validated.ticket,ticket))throw Error('pending_changed');}
        pending={status:committed?'committed_cleanup_pending':'unknown_transport_result',ticket};
      }
      process.stdout.write(JSON.stringify({state:v.state,artifacts:v.artifacts,messages:[...v.messages.values()],pending}));}
    catch(e){process.stderr.write(/^[a-z_0-9]+$/.test(e.message)?e.message:'history_replay_failed');process.exitCode=1;}`;
  let output;
  try{output=execFileSync(process.execPath,['--input-type=module','-e',program,replay,relRun,String(hasPending)],{encoding:'utf8',maxBuffer:128*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch(e){throw Error(/^[a-z_0-9]+$/.test(e.stderr?.trim())?e.stderr.trim():'history_replay_failed');}
  // Validate the copies against the originals again; an edit during replay cannot be accepted.
  for(const [path,hash] of inputs)if(path.startsWith('data/'))check(sha(readFileSync(dataPath(path,root)))===hash,'history_source_changed_during_replay');
  const result=JSON.parse(output);return {...result,artifacts:{...result.artifacts,...Object.fromEntries([...inputs].filter(([path])=>path.startsWith('data/')))}};
}
export function replayHistoricalLegacy(){ throw Error('legacy_private_history_not_supported'); }
