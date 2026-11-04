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

window.__LEW_ORDER_EXPORT_PROMISE__ = (async () => {
  const CONFIG = {
    store: null,
    buyerMemberIds: [],
    pageSize: 50,
    maxPagesPerMember: 10,
    sampleLimit: null,
    returnBundleOnly: false,
    ...(window.__LEW_ORDER_EXPORT_CONFIG__ || {}),
  };
  requireExportStoreProof(CONFIG,CONFIG.store);
  if (location.hostname !== 'biz.alibaba.com' || location.pathname !== '/ta/list/scene/mainList.htm') {
    throw new Error('Open the verified store order list');
  }
  if (!/^[a-z0-9_-]+$/i.test(CONFIG.store) || !Array.isArray(CONFIG.buyerMemberIds) ||
      CONFIG.buyerMemberIds.length < 1 || CONFIG.buyerMemberIds.length > 3 ||
      CONFIG.buyerMemberIds.some((id) => !/^alibaba-visible-member:[a-z0-9]{3,64}$/i.test(id))) {
    throw new Error('Provide 1-3 sourced visible buyer membership IDs and a store key');
  }
  if (!Number.isInteger(CONFIG.pageSize) || CONFIG.pageSize < 1 || CONFIG.pageSize > 50 ||
      !Number.isInteger(CONFIG.maxPagesPerMember) || CONFIG.maxPagesPerMember < 1 || CONFIG.maxPagesPerMember > 20) {
    throw new Error('Invalid pagination limit');
  }
  if (CONFIG.sampleLimit !== null && (CONFIG.sampleLimit !== 1 || CONFIG.buyerMemberIds.length !== 1)) {
    throw new Error('Sample mode requires one member and sampleLimit=1');
  }
  if (typeof CONFIG.returnBundleOnly !== 'boolean') throw new Error('returnBundleOnly must be boolean');
  const cookie = (name) => document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const ctoken = cookie('xman_us_t')?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1];
  const tbToken = cookie('_tb_token_');
  if (!ctoken || !tbToken) throw new Error('Order page session parameters not found');
  const observedAt = new Date().toISOString();
  const searches = [];
  for (const buyerMemberId of CONFIG.buyerMemberIds) {
    const member = buyerMemberId.slice('alibaba-visible-member:'.length);
    const results = [];
    const seen = new Set();
    let totalRecord = null;
    let totalPage = null;
    let fetchedPages = 0;
    for (let page = 1; page <= CONFIG.maxPagesPerMember; page++) {
      const pagination = { currentPage: page, pageSize: CONFIG.pageSize };
      const requests = {
        simpleFilter: 'simpleFilter@all', orderStatus: null, tradeType: null,
        recentCreateTime: null, recentShipmentTime: null,
        createDateFilter: { from: null, to: null }, shipmentTimeFilter: { from: null, to: null },
        orderAmountFilter: { from: null, to: null }, operator: { loginId: null, accountId: null },
        currency: null, bizSource: null, buyerCountry: null, buyerShippingCountry: null,
        fulfillmentChannel: null, orderDraftRole: null, shippingMethod: null,
        fuzzySearchValue: member, orderBy: null, promotionFilter: null, orderServiceFilter: null,
        acceptPoFilter: null, orderFinancingFilter: null, productTypeFilter: null,
        searchAliCarrierCode: false, pagination,
      };
      const query = new URLSearchParams({ json: JSON.stringify({ requests, pagination,
        responseModel: 'V2', requestEnvironment: { operator: { role: 'seller' } } }),
      _tb_token_: tbToken, ctoken });
      const response = await fetch(`/list/ajax/ta/mainv2.json?${query}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Order search failed: HTTP ${response.status}; no file saved`);
      const payload = await response.json();
      const data = payload.data?.pageData;
      if (payload.code !== 200 || !Array.isArray(data?.data) ||
          !Number.isInteger(data.pagination?.totalPage) || !Number.isInteger(data.pagination?.totalRecord) ||
          data.pagination.currentPage !== page || data.pagination.pageSize !== CONFIG.pageSize) {
        throw new Error(`Unexpected order response on page ${page}; no file saved`);
      }
      if (totalPage !== null && (totalPage !== data.pagination.totalPage || totalRecord !== data.pagination.totalRecord)) {
        throw new Error('Order pagination changed during scan; no file saved');
      }
      totalPage = data.pagination.totalPage;
      totalRecord = data.pagination.totalRecord;
      fetchedPages++;
      for (const order of data.data) {
        if (CONFIG.sampleLimit !== null && results.length >= CONFIG.sampleLimit) break;
        const id = String(order.baseInfo?.id || '');
        if (!/^\d+$/.test(id) || seen.has(id)) throw new Error('Missing or repeated order ID; no file saved');
        seen.add(id);
        results.push({ order_id: id,
          created_at: Number.isFinite(order.baseInfo?.createTimestamp)
            ? new Date(order.baseInfo.createTimestamp).toISOString() : null,
          status_code: order.statusAction?.status?.name || null,
          currency: order.paymentInfo?.currency || null,
          gross_total_raw: Number.isFinite(order.paymentInfo?.totalAmount?.number)
            ? order.paymentInfo.totalAmount.number : null });
      }
      if (CONFIG.sampleLimit !== null && results.length >= CONFIG.sampleLimit) break;
      if (page >= totalPage) break;
    }
    const paginationComplete = totalPage <= CONFIG.maxPagesPerMember && results.length === totalRecord;
    if (CONFIG.sampleLimit === null && !paginationComplete) {
      throw new Error('Order history search did not cover every page; no file saved');
    }
    if (CONFIG.sampleLimit !== null && !paginationComplete && results.length !== CONFIG.sampleLimit) {
      throw new Error('Order sample did not reach its limit; no file saved');
    }
    searches.push({ buyer_member_id: buyerMemberId, search_field: 'fuzzySearchValue',
      identity_status: 'candidate_search_only', sample_only: CONFIG.sampleLimit !== null,
      pagination_complete: paginationComplete,
      truncation_reason: paginationComplete ? null : 'sample_limit',
      fetched_pages: fetchedPages,
      total_pages: totalPage, total_records: totalRecord, orders: results });
  }
  const filename = `order-member-candidates-${CONFIG.store}-${observedAt.slice(0, 10)}.json`;
  const bundle = { store_key: CONFIG.store, observed_at: observedAt,
    source_system: 'alibaba-order-mainv2-member-search-v1', searches };
  if (CONFIG.returnBundleOnly) return bundle;
  const blob = new Blob([JSON.stringify(bundle)],
  { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `下载会员 ID 订单搜索候选（${searches.reduce((n, s) => n + s.total_records, 0)} 条）`;
  Object.assign(button.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: '2147483647',
    padding: '12px 18px', background: '#1463d7', color: '#fff', borderRadius: '6px', cursor: 'pointer' });
  button.addEventListener('click', (event) => {
    event.preventDefault(); event.stopImmediatePropagation();
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.style.display = 'none';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => { button.remove(); URL.revokeObjectURL(url); }, 60000);
  }, { once: true, capture: true });
  document.body.appendChild(button);
  console.info({ store: CONFIG.store, members: searches.length,
    candidate_orders: searches.reduce((n, s) => n + s.orders.length, 0), filename,
    identity_status: 'candidate_search_only' });
  return bundle;
})();
window.__LEW_ORDER_EXPORT_PROMISE__.catch((error) => console.error('Order search export failed:', error.message));
