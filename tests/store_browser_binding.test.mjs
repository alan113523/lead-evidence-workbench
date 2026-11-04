import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import binding from '../lib/store_binding.js';
import {browserModule, bindingSource} from '../lib/store_browser.mjs';
import {browserBinding, storeProof} from './store_binding_fixture.mjs';

test('discovers each of three stores from the seller response, independent of browser labels',async()=>{
  for (const store of binding.STORES) {
    let requests=0;
    const env={location:{origin:'https://i.alibaba.com'},AbortSignal,fetch:async(url,options)=>{
      requests++;assert.equal(url,binding.ENDPOINT);assert.equal(options.credentials,'same-origin');
      return {ok:true,redirected:false,json:async()=>({minisite:`//${store}.en.alibaba.com/`,componyName:'Synthetic private name',cookie:'never return'})};
    }};
    const observed=await binding.probe(browserBinding(store),'probe-one',null,env);
    assert.equal(observed.store_key,store);assert.equal(requests,1);
    assert.ok(!JSON.stringify(observed).includes('private name'));assert.ok(!JSON.stringify(observed).includes('cookie'));
    await assert.rejects(()=>binding.probe(browserBinding(store),'probe-two',binding.STORES.find(s=>s!==store),env),/store_identity_mismatch/);
  }
});
test('rejects wrong browser, wrong request, expired and future proofs before collection',()=>{
  const route=browserBinding('demobeta'), p=storeProof('demobeta','request-one');
  for(const [bad, code] of [[{...p,browser_binding:browserBinding('demogamma')},/browser_binding_mismatch/],
    [{...p,request_id:'another-run'},/identity_request_mismatch/],
    [{...p,observed_at_ms:Date.now()-301000},/fresh_store/],[{...p,observed_at_ms:Date.now()+60000},/fresh_store/]])
    assert.throws(()=>binding.proof(bad,'demobeta',route,'request-one'),code);
  assert.doesNotThrow(()=>binding.proof({...p,observed_at_ms:1},'demobeta',route,'request-one',false));
});
test('three routes stay separate and ambiguous or missing mappings stop',()=>{
  const map={schema_version:'alibaba-store-browser-map-v1',bindings:binding.STORES.map(s=>storeProof(s))};
  for(const store of binding.STORES)assert.deepEqual(binding.resolve(map,store),browserBinding(store));
  assert.throws(()=>binding.routes({...map,bindings:[...map.bindings,map.bindings[0]]}),/ambiguous/);
  assert.throws(()=>binding.routes({...map,bindings:[map.bindings[0],{...map.bindings[1],browser_binding:map.bindings[0].browser_binding}]}),/ambiguous/);
  assert.throws(()=>binding.resolve({...map,bindings:[]},'demogamma'),/missing/);
  const native=storeProof('demobeta','probe-two',{channel:'chrome-devtools',browser_id:'native-connection'});
  const twoChannels={...map,bindings:[...map.bindings,native]};
  assert.throws(()=>binding.resolve(twoChannels,'demobeta'),/ambiguous/);
  assert.deepEqual(binding.resolve(twoChannels,'demobeta','chrome-devtools'),native.browser_binding);
});
test('generated page module performs only the same-origin seller probe',async()=>{
  const code=`(async()=>{${browserModule(bindingSource())}return storeBinding.probe({channel:'cua-cdp',browser_id:'observed-1'},'issued-request');})()`;
  const result=await vm.runInNewContext(code,{URL,Date,AbortSignal,location:{origin:'https://i.alibaba.com'},fetch:async()=>({ok:true,json:async()=>({minisite:'https://demogamma.en.alibaba.com',componyName:'Synthetic'})})});
  assert.equal(result.store_key,'demogamma');assert.equal(result.browser_binding.browser_id,'observed-1');
});
