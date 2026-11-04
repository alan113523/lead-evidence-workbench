// Low-level read-only browser adapter. See docs/collectors.md for the verified-host contract.
// A verified host must provide a fresh proof for this exact browser route.
function requireExportStoreProof(config, store) {
  const proof=config?.storeProof,route=config?.browserBinding;
  if(typeof store!=='string'||!/^[a-z][a-z0-9-]{0,62}$/.test(store)||
      proof?.schema_version!=='alibaba-store-proof-v1'||proof.store_key!==store||proof.store_host!==`${store}.en.alibaba.com`||
      proof.source_url!=='https://i.alibaba.com/ajax/sellerProfileAjax.do'||
      typeof config.requestId!=='string'||!config.requestId||proof.request_id!==config.requestId||
      !['chrome-devtools','cua-cdp'].includes(route?.channel)||typeof route.browser_id!=='string'||!route.browser_id||
      proof.browser_binding?.channel!==route.channel||proof.browser_binding?.browser_id!==route.browser_id||
      !Number.isSafeInteger(proof.observed_at_ms)||Date.now()-proof.observed_at_ms<0||Date.now()-proof.observed_at_ms>=300000)
    throw Error('fresh_store_proof_required');
}

(async () => {
  const CONFIG = {
    store: null,
    storeDomain: null,
    campaignId: null,
    campaignName: null,
    from: null,
    to: null,
    productPageSize: 5,
    maxProductRows: 30,
    ...(window.__LEW_ADS_EXPORT_CONFIG__ || {}),
  };
  requireExportStoreProof(CONFIG,CONFIG.store);
  if(CONFIG.storeDomain!==CONFIG.store+'.en.alibaba.com')throw Error('store_domain_mismatch');
  const checkDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (location.origin !== 'https://i.alibaba.com' || location.pathname !== '/') throw Error('Open the verified Alibaba store homepage');
  if (![...document.querySelectorAll('a[href]')].some((link) => new URL(link.href).hostname === CONFIG.storeDomain && link.innerText.trim())) {
    throw Error('Store link is not visible on this page; stop and verify the account');
  }
  if (!checkDate(CONFIG.from) || !checkDate(CONFIG.to) || CONFIG.from > CONFIG.to) throw Error('Invalid date range');
  const days = Math.round((Date.parse(`${CONFIG.to}T00:00:00Z`) - Date.parse(`${CONFIG.from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 2) throw Error('This exporter is limited to one or two days');
  if (!Number.isSafeInteger(CONFIG.campaignId) || CONFIG.campaignId <= 0 || !CONFIG.campaignName) throw Error('Verify the campaign ID and name');
  if (!Number.isInteger(CONFIG.productPageSize) || CONFIG.productPageSize < 1 || CONFIG.productPageSize > 10) throw Error('productPageSize must be 1-10');
  const base = 'https://www2.alibaba.com';
  const csrfResponse = await fetch(`${base}/api/csrf?type=normal&ads=%7B%22productLineId%22%3A110101%7D&data=%7B%7D`, { credentials: 'include' });
  if (!csrfResponse.ok) throw Error(`CSRF request failed: HTTP ${csrfResponse.status}`);
  const csrf = await csrfResponse.json();
  if (typeof csrf.token !== 'string' || !csrf.token) throw Error('Alibaba CSRF token missing');
  const campaignBody = new URLSearchParams({
    ads: JSON.stringify({ productLineId: 110106 }), type: 'normal',
    data: JSON.stringify({ tableName: 'filter_campaign', filters: [{ field: 'summaryTypes', value: ['wholeSite'] }] }),
    _csrf: csrf.token,
  });
  const campaignResponse = await fetch(`${base}/api/data/dynamic/filter/data`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: campaignBody,
  });
  if (!campaignResponse.ok) throw Error(`Campaign lookup failed: HTTP ${campaignResponse.status}`);
  const campaignPayload = await campaignResponse.json();
  if (campaignPayload.status !== 1000 || !Array.isArray(campaignPayload.data?.queryResult)) {
    throw Error('Unexpected Alibaba campaign list response');
  }
  const matchingCampaigns = campaignPayload.data.queryResult.filter((item) => String(item.idValue) === String(CONFIG.campaignId));
  if (matchingCampaigns.length !== 1 || matchingCampaigns[0].idLabel !== CONFIG.campaignName) {
    throw Error('Campaign ID and name do not match the current store session');
  }
  const context = {
    summaryTypes: 'wholeSite', campaignId: CONFIG.campaignId, campaignType: 47,
    optimizeTarget: 'whole_site_fb', subType: 'whole_store_hot_product',
    optimize_target: 'whole_site_fb', setL3Premium: null,
  };
  async function report(sceneName, subSceneName, granularity, pageIndex, pageSize) {
    const query = {
      sceneName, subSceneName,
      rawFilters: [{ field: 'summaryTypes', value: 'wholeSite' }, { field: 'campaignId', value: CONFIG.campaignId }],
      orders: [], derives: [], pageIndex, pageSize,
      beginDateTime: `${CONFIG.from} 00:00:00`, endDateTime: `${CONFIG.to} 23:59:59`,
      granularity, extendParams: { context },
    };
    const body = new URLSearchParams({
      ads: JSON.stringify({ productLineId: 110106 }), type: 'normal',
      data: JSON.stringify(query), _csrf: csrf.token,
    });
    const response = await fetch(`${base}/api/data/dynamic/scene/data`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!response.ok) throw Error(`Report request failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.status !== 1000 || !Array.isArray(payload.data?.detailList)) throw Error('Unexpected Alibaba report response');
    return payload.data;
  }
  function cell(row, key) { return row?.[key]?.main; }
  function count(row, key) {
    const raw = cell(row, key);
    if (!/^(0|[1-9]\d*)$/.test(String(raw))) throw Error(`Invalid ${key}: ${raw}`);
    return Number(raw);
  }
  function money(row, key) {
    const raw = cell(row, key);
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(raw))) throw Error(`Invalid ${key}: ${raw}`);
    return Number(raw);
  }
  const plan = await report('scene_whole_site_account_report_bp5', 'list', 'day', 1, 2);
  if (plan.totalRows !== days || plan.detailList.length !== days) throw Error('Plan day count differs from requested range');
  const planDays = plan.detailList.map((row) => ({
    date: String(cell(row, 'timeUs')),
    spend_cny: money(row, 'cost'), impressions: count(row, 'impsCnt'),
    clicks: count(row, 'clickCnt'), whole_site_leads: count(row, 'cvr3'),
  }));
  const expectedDates = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${CONFIG.from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  if (planDays.map((row) => row.date).join(',') !== expectedDates.join(',')) throw Error('Plan dates differ from requested range');
  const summary = {
    spend_cny: money(plan.totalSummary, 'cost'), impressions: count(plan.totalSummary, 'impsCnt'),
    clicks: count(plan.totalSummary, 'clickCnt'), whole_site_leads: count(plan.totalSummary, 'cvr3'),
  };
  for (const [field, value] of Object.entries(summary)) {
    const sum = planDays.reduce((n, row) => n + Math.round(row[field] * (field === 'spend_cny' ? 100 : 1)), 0);
    if (sum !== Math.round(value * (field === 'spend_cny' ? 100 : 1))) throw Error(`Plan ${field} does not reconcile`);
  }
  const first = await report('scene_whole_site_product_report_bp5', 'product_dimension', 'all', 1, CONFIG.productPageSize);
  const total = first.totalRows;
  if (!Number.isInteger(total) || total < 0 || total > CONFIG.maxProductRows) throw Error(`Product row count ${total} exceeds configured limit`);
  const allRows = [...first.detailList];
  for (let page = 2; allRows.length < total; page++) {
    const next = await report('scene_whole_site_product_report_bp5', 'product_dimension', 'all', page, CONFIG.productPageSize);
    if (next.totalRows !== total || !next.detailList.length) throw Error('Product pages changed during export');
    allRows.push(...next.detailList);
  }
  if (allRows.length !== total) throw Error('Product rows incomplete');
  const productIds = new Set();
  const products = allRows.map((row) => {
    const productId = String(cell(row, 'productId'));
    if (!/^\d+$/.test(productId) || productIds.has(productId)) throw Error(`Invalid or repeated product ID: ${productId}`);
    productIds.add(productId);
    return { product_id: productId, impressions: count(row, 'impsCnt'), clicks: count(row, 'clickCnt'),
      whole_site_leads: count(row, 'cvr3'), spend_cny: null };
  });
  for (const [productField, summaryField] of [['impressions', 'impsCnt'], ['clicks', 'clickCnt'], ['whole_site_leads', 'cvr3']]) {
    const productTotal = products.reduce((n, row) => n + row[productField], 0);
    if (productTotal !== count(first.totalSummary, summaryField) || productTotal !== summary[productField]) {
      throw Error(`Product ${productField} does not reconcile with plan`);
    }
  }
  const output = {
    schema: 'alibaba_whole_site_plan_product_v1', store_key: CONFIG.store, store_domain: CONFIG.storeDomain,
    campaign_id: String(CONFIG.campaignId), campaign_name: CONFIG.campaignName,
    from: CONFIG.from, to: CONFIG.to, observed_at: new Date().toISOString(),
    report_timezone: 'unverified', attribution_scope: 'platform_whole_site_leads', currency: 'CNY',
    plan_days: planDays, plan_summary: summary, products,
    notes: ['Product spend is unavailable in this report; no plan spend was allocated to products.',
      'The report timezone and lead attribution window have not been verified.'],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `alibaba-ads-${CONFIG.store}-${CONFIG.from}-${CONFIG.to}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  console.log(`Exported ${planDays.length} plan days and ${products.length} products for ${CONFIG.store}; no customer details or product spend.`);
})().catch((error) => console.error('Ads export stopped; no file saved:', error));
