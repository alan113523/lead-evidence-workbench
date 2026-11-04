import test from 'node:test';
import assert from 'node:assert/strict';
import binding from '../lib/store_binding.js';

test('a caller-owned store is discovered from the verified seller response',async()=>{
  const route={channel:'cua-cdp',browser_id:'synthetic-custom-browser'};
  const env={location:{origin:'https://i.alibaba.com'},AbortSignal,
    fetch:async()=>({ok:true,redirected:false,json:async()=>({minisite:'https://example-seller.en.alibaba.com/',componyName:'Invented example'})})};
  const proof=await binding.probe(route,'public-test','example-seller',env);
  assert.equal(proof.store_key,'example-seller');
  await assert.rejects(()=>binding.probe(route,'public-test','another-seller',env),/store_identity_mismatch/);
  env.fetch=async()=>({ok:true,redirected:false,json:async()=>({minisite:'https://example-seller.en.alibaba.com.evil.invalid/',componyName:'Invented example'})});
  await assert.rejects(()=>binding.probe(route,'public-test','example-seller',env),/store_identity_mismatch/);
});

test('store keys reject path syntax while example names have no privileged status',()=>{
  assert.equal(binding.isStore('example-seller'),true);
  assert.equal(binding.isStore('demoalpha'),true);
  for(const key of ['../store','store/name','',null,{},'store.name'])assert.equal(binding.isStore(key),false);
});
