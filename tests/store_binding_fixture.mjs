import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

export const browserBinding = store => ({channel:'cua-cdp', browser_id:`synthetic-${store}`});
export function storeProof(store = 'demobeta', requestId = 'synthetic-probe', route = browserBinding(store)) {
  return {schema_version:'alibaba-store-proof-v1', store_key:store, store_host:`${store}.en.alibaba.com`,
    source_url:'https://i.alibaba.com/ajax/sellerProfileAjax.do', browser_binding:route, request_id:requestId, observed_at_ms:Date.now()};
}
export function browserFixture(root) {
  for (const name of ['collection/store_binding.js','store_browser.mjs']) {
    const path = `lib/${name.replace('collection/', '')}`;
    mkdirSync(dirname(join(root,path)),{recursive:true}); copyFileSync(resolve(path),join(root,path));
  }
  writeFileSync(join(root,'data/browser-map.json'),JSON.stringify({schema_version:'alibaba-store-browser-map-v1',
    bindings:['demoalpha','demobeta','demogamma'].map(store=>storeProof(store))}));
}
