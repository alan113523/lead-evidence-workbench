// Host-supplied CDP handles only. No browser connection, tab creation or retry logic.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {dataPath} from './chat_collection.mjs';
import {inspectWindow,runWindowBatch} from './chat_window.mjs';
import {checkHistoryResolution,registerHistoryRun} from './history_collection.mjs';
import binding from '../lib/store_binding.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const check=(ok,code)=>{if(!ok)throw Error(code);};
const token=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:/-]{1,180}$/.test(v);
const digest=x=>createHash('sha256').update(x).digest('hex');
const safeError=e=>/^[a-z_0-9]{1,100}$/.test(e?.message)?e.message:'runner_execution_failed';

/** Ownership is workflow bookkeeping, never proof of the signed-in seller. */
export function createWindowRunner({run,threadId,browserBinding,homePageId,messagePageId,homeCdp,messageCdp},root=ROOT) {
  check(token(threadId)&&token(homePageId)&&token(messagePageId)&&homePageId!==messagePageId,'runner_owner_and_pages_required');
  check(typeof homeCdp?.send==='function'&&typeof messageCdp?.send==='function','host_cdp_handles_required');
  binding.binding(browserBinding);
  const {dir,config}=inspectWindow(run,root);
  check(binding.same(config.browser_binding,browserBinding),'browser_binding_mismatch');
  const route=Object.freeze({...browserBinding});
  const owner={schema_version:'lew.chat-runner-owner.v1',thread_id:threadId,store_key:config.store_key,
    browser_binding:route,home_page_id:homePageId,message_page_id:messagePageId,
    config_sha256:digest(readFileSync(join(dir,'config.json')))};
  const ownerPath=dataPath(join(dir,'runner-owner.json'),root),ownerText=JSON.stringify(owner,null,2)+'\n';
  if(!existsSync(ownerPath))writeFileSync(ownerPath,ownerText,{flag:'wx',mode:0o600});
  check(readFileSync(ownerPath,'utf8')===ownerText,'runner_owner_or_pages_changed');
  let running=false;
  return Object.freeze({
    async batch({steps=3,signal}={}) {
      check(!running,'runner_batch_already_running');
      check(readFileSync(ownerPath,'utf8')===ownerText,'runner_owner_or_pages_changed');
      check(digest(readFileSync(join(dir,'config.json')))===owner.config_sha256,'runner_config_changed');
      running=true;
      const started=performance.now(),timing={identity_ms:0,page_ms:0},at=new Date().toISOString();
      let summary,error;
      const evaluate=async(cdp,expression,field)=>{
        const begin=performance.now();
        try{return await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});}
        finally{timing[field]+=performance.now()-begin;}
      };
      const adapter={existingPagesOnly:true,backgroundOnly:true,async execute(step) {
        check(binding.same(route,step.browser_binding),'browser_binding_mismatch');
        const identity=await evaluate(homeCdp,readFileSync(step.identity_script,'utf8'),'identity_ms');
        check(!identity.exceptionDetails&&identity.result?.value,'live_identity_failed');
        // Reject bad identity before even requesting the message-page evaluation.
        binding.proof(identity.result.value,config.store_key,route,step.ticket.request_id);
        const code=readFileSync(step.script,'utf8');
        const page=await evaluate(messageCdp,`(${code})(${JSON.stringify(identity.result.value)})`,'page_ms');
        check(!page.exceptionDetails&&page.result?.value,'collector_receipt_missing');
        checkHistoryResolution(run,page.result.value,root);
        return page.result.value; // Kept in process memory, accepted directly into the private ledger.
      }};
      try{summary=await runWindowBatch(run,adapter,{steps,signal},root);registerHistoryRun(run,root);}
      catch(e){error=safeError(e);}
      finally{running=false;}
      const elapsed=performance.now()-started;
      const metrics={elapsed_ms:Math.round(elapsed),identity_ms:Math.round(timing.identity_ms),page_ms:Math.round(timing.page_ms),
        local_ms:Math.round(Math.max(0,elapsed-timing.identity_ms-timing.page_ms))};
      const result={...(summary??{}),timing:metrics,...(error?{error}:{})};
      // One small record per batch; no identities, page bodies, scripts or accumulated state.
      appendFileSync(dataPath(join(dir,'runner-batches.jsonl'),root),JSON.stringify({started_at:at,...result})+'\n',{mode:0o600});
      if(error)throw Error(error); // Pending is retained. A failed request is never retried here.
      return result;
    }
  });
}
