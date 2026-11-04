import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {storeProof,browserBinding} from './store_binding_fixture.mjs';
const require=createRequire(import.meta.url);
const keys=['__LEW_INQUIRY_LIST_CONFIG__','__LEW_INQUIRY_EXPORT_CONFIG__','__LEW_BUYER_LEVEL_CONFIG__','__LEW_CUSTOMER_LINK_CONFIG__','__LEW_ORDER_EXPORT_CONFIG__','__LEW_OWNERSHIP_EXPORT_CONFIG__','__LEW_VISITOR_EXPORT_CONFIG__','__LEW_ADS_EXPORT_CONFIG__'];
const names=['inquiries','inquiries_member_bundle','buyer_levels','customer_link','member_order_candidates','ownership','visitors','ads'];
function config(){const store='example-seller',route=browserBinding(store);return {store,store_key:store,storeKey:store,storeDomain:store+'.en.alibaba.com',confirmedSellerDomain:store+'.en.alibaba.com',requestId:'export-test',browserBinding:route,storeProof:storeProof(store,'export-test',route),from:'2026-01-05',to:'2026-01-05'};}
async function execute(name,key,cfg,overrides={}){
  let calls=0;const errors=[],context={window:{[key]:cfg},location:{origin:'https://i.alibaba.com',hostname:'message.alibaba.com',pathname:'/message/default.htm'},
    fetch:async()=>{calls++;throw Error('unexpected_live_request');},document:{},URL,URLSearchParams,Date,Blob,console:{info(){},error:(...values)=>errors.push(...values)},...overrides};
  const result=runInNewContext(readFileSync(`scripts/export_${name}_browser.js`,'utf8'),context);
  if(result?.then)await result;
  for(const value of Object.values(context.window))if(value?.then)await value;
  if(errors.length)throw Error(errors.map(value=>value?.message||String(value)).join(' '));
  return calls;
}

test('all browser adapters refuse to collect without a fresh bound store proof',async()=>{
  for(let i=0;i<names.length;i++)await assert.rejects(()=>execute(names[i],keys[i],{store:'example-seller'}),/fresh_store_proof_required/);
});

test('stale proof, changed request and changed browser route fail before network reads',async()=>{
  for(const modify of [c=>{c.storeProof.observed_at_ms=Date.now()-310000;},c=>{c.requestId='other';},c=>{c.browserBinding={...c.browserBinding,browser_id:'other'};}]){
    const cfg=config();modify(cfg);await assert.rejects(()=>execute('inquiries_member_bundle',keys[1],cfg),/fresh_store_proof_required/);
  }
});

test('advertising export has no default campaign and stops before a report request',async()=>{
  const cfg=config();
  await assert.rejects(()=>execute('ads',keys[7],cfg,{location:{origin:'https://i.alibaba.com',pathname:'/'},document:{querySelectorAll:()=>[{href:'https://example-seller.en.alibaba.com/',innerText:'Synthetic store'}]}}),/campaign ID/);
});

test('buyer-level helper preserves missing and unexpected states rather than inventing L0',()=>{
  const {classifyBuyerLevel,matchBuyerLevelRows}=require('../scripts/export_buyer_levels_browser.js');
  assert.equal(classifyBuyerLevel({sender:{}}).status,'field_missing');
  assert.equal(classifyBuyerLevel({sender:{userNewLevel:0}}).status,'unexpected_value');
  assert.equal(classifyBuyerLevel({sender:{userNewLevel:'L3'}}).buyer_level,'L3');
  const rows=matchBuyerLevelRows([{id:101},{id:102}],{'101':{sender:{userNewLevel:'L1'}}});
  assert.equal(rows[1].status,'extra_row_missing');assert.equal(rows[1].buyer_level,null);
});
