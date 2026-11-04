// Shared, read-only seller identity probe. Browser IDs come from host discovery,
// not from page content; the caller must execute on that exact connection.
(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
})(function () {
  const STORES = ['demoalpha', 'demobeta', 'demogamma']; // Synthetic examples only.
  const isStore = value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(value);
  const ENDPOINT = 'https://i.alibaba.com/ajax/sellerProfileAjax.do';
  const check = (ok, code) => { if (!ok) throw new Error(code); };
  function binding(value) {
    check(value && Object.keys(value).sort().join(',') === 'browser_id,channel' &&
      ['chrome-devtools', 'cua-cdp'].includes(value.channel) &&
      typeof value.browser_id === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value.browser_id), 'invalid_browser_binding');
    return value;
  }
  const same = (a, b) => a?.channel === b?.channel && a?.browser_id === b?.browser_id;
  function proof(value, store, route, requestId, fresh = true) {
    binding(route);
    check(value && Object.keys(value).sort().join(',') ===
      'browser_binding,observed_at_ms,request_id,schema_version,source_url,store_host,store_key', 'invalid_store_proof');
    binding(value.browser_binding);
    check(value.schema_version === 'alibaba-store-proof-v1' && isStore(value.store_key) &&
      value.store_key === store && value.store_host === `${store}.en.alibaba.com` && value.source_url === ENDPOINT,
      'store_identity_mismatch');
    check(same(value.browser_binding, route), 'browser_binding_mismatch');
    check(typeof value.request_id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value.request_id) &&
      value.request_id === requestId, 'identity_request_mismatch');
    check(Number.isSafeInteger(value.observed_at_ms) && value.observed_at_ms > 0 &&
      (!fresh || Date.now() - value.observed_at_ms >= 0 && Date.now() - value.observed_at_ms < 300000), 'fresh_store_verification_required');
    return value;
  }
  async function probe(route, requestId, expectedStore = null, env = globalThis) {
    binding(route);
    check(env.location?.origin === 'https://i.alibaba.com', 'wrong_identity_page');
    let response, data;
    try {
      response = await env.fetch(ENDPOINT, {method: 'GET', credentials: 'same-origin', redirect: 'error', signal: env.AbortSignal.timeout(15000)});
    } catch { throw new Error('identity_request_failed'); }
    check(response.ok && !response.redirected, 'identity_http_error');
    try { data = await response.json(); } catch { throw new Error('identity_not_json'); }
    check(typeof data?.minisite === 'string' && typeof data.componyName === 'string' && data.componyName.trim(), 'identity_fields_missing');
    let site;
    try { site = new URL(data.minisite.startsWith('//') ? `https:${data.minisite}` : data.minisite); }
    catch { throw new Error('invalid_store_identity'); }
    const store = site.hostname.endsWith('.en.alibaba.com') ? site.hostname.slice(0, -15) : null;
    check(isStore(store) && ['http:', 'https:'].includes(site.protocol) && !site.username && !site.password && !site.port &&
      (!expectedStore || store === expectedStore), 'store_identity_mismatch');
    return proof({schema_version: 'alibaba-store-proof-v1', store_key: store, store_host: site.hostname,
      source_url: ENDPOINT, browser_binding: {...route}, request_id: requestId, observed_at_ms: Date.now()}, store, route, requestId);
  }
  function routes(map) {
    check(map?.schema_version === 'alibaba-store-browser-map-v1' && Array.isArray(map.bindings) &&
      Object.keys(map).sort().join(',') === 'bindings,schema_version', 'invalid_browser_map');
    const stores = new Set(), browsers = new Set();
    for (const row of map.bindings) {
      proof(row, row.store_key, row.browser_binding, row.request_id, false);
      const store = `${row.browser_binding.channel}:${row.store_key}`;
      const browser = `${row.browser_binding.channel}:${row.browser_binding.browser_id}`;
      check(!stores.has(store) && !browsers.has(browser), 'ambiguous_browser_map');
      stores.add(store); browsers.add(browser);
    }
    return map;
  }
  function resolve(map, store, channel) {
    check(isStore(store), 'invalid_store');
    const found = routes(map).bindings.filter(row => row.store_key === store && (!channel || row.browser_binding.channel === channel));
    check(found.length === 1, 'missing_or_ambiguous_store_route');
    return {...found[0].browser_binding}; // A routing hint; every collection needs a fresh proof.
  }
  return {STORES, isStore, ENDPOINT, binding, same, proof, probe, routes, resolve};
});
