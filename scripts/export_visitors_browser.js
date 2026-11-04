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
  const CONFIG = Object.freeze({
    storeKey: null, confirmedSellerDomain: null,
    from: null, to: null, inquiryOnly: true,
    pageSize: 5, maxPages: 1, maxRecords: 5,
    detailRecordLimit: 1, detailPageLimit: 2, detailEventLimit: 30,
    ...(window.__LEW_VISITOR_EXPORT_CONFIG__ || {}),
  });
  requireExportStoreProof(CONFIG,CONFIG.storeKey);
  const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const limits={pageSize:5,maxPages:1,maxRecords:5,detailRecordLimit:1,detailPageLimit:2,detailEventLimit:30};
  if(location.origin!=='https://hz-mydata.alibaba.com'||CONFIG.confirmedSellerDomain!==CONFIG.storeKey+'.en.alibaba.com'||
      !day(CONFIG.from)||!day(CONFIG.to)||CONFIG.from>CONFIG.to||(Date.parse(CONFIG.to)-Date.parse(CONFIG.from))/86400000>1||CONFIG.inquiryOnly!==true||
      Object.entries(limits).some(([key,max])=>!Number.isInteger(CONFIG[key])||CONFIG[key]<1||CONFIG[key]>max))throw Error('invalid_visitor_sample_scope');

  const cookie = document.cookie.split('; ').find((part) => part.startsWith('xman_us_t='));
  const ctoken = cookie?.match(/(?:^|[=&])ctoken=([^&]+)/)?.[1];
  if (!ctoken) throw new Error('Current Alibaba session has no ctoken');
  const params = new URLSearchParams({
    orderBy: '', orderModel: '', pageSize: String(CONFIG.pageSize), pageNO: '1',
    statisticsType: 'day', selected: '0', startDate: CONFIG.from, endDate: CONFIG.to,
    searchKeyword: '', buyerRegion: '', buyerCountry: '', subMemberSeq: '',
    isMcFb: 'true', isAtmFb: 'false', mailable: 'false', mailed: 'false',
    hasRemarks: 'false', statisticType: 'os',
    desTime: String(Date.now()),
  });
  const response = await fetch(
    `/self/.json?action=CommonAction&iName=getVisitors&ctoken=${encodeURIComponent(ctoken)}&_bx-v=1.1.21`,
    { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: params.toString() },
  );
  if (!response.ok) throw new Error(`Visitor request HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.successed !== true || !Array.isArray(payload.value?.data) ||
      !Number.isInteger(payload.value.total) || payload.value.total < 0) {
    throw new Error('Unexpected visitor response');
  }
  const { total, data } = payload.value;
  if (total > CONFIG.maxRecords || data.length > CONFIG.maxRecords || data.length !== total) {
    throw new Error(`Sample exceeds cap or one-page coverage: total=${total}, page=${data.length}`);
  }
  const cleanText = (value) => {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text && text.length <= 120 && !/@|\b\d[\d\s()+-]{7,}\d\b/.test(text) ? text : null;
  };
  // The page's getVisitorAnalysisParams uses statDate + buyerCookieId.
  // It requests pageSize 100, but the observed endpoint returns 15 events per page.
  async function viewedProducts(visitor) {
    const allEvents = [];
    let total = null;
    for (let page = 1; page <= CONFIG.detailPageLimit; page++) {
      const detailParams = new URLSearchParams({
        orderBy: '', orderModel: '', pageSize: '100', pageNO: String(page),
        statisticsType: 'day', selected: '0', statDate: visitor.statDate,
        buyerCookieId: visitor.buyerCookieId,
      });
      const detailResponse = await fetch(
        `/self/.json?action=CommonAction&iName=getVisitorDetails&ctoken=${encodeURIComponent(ctoken)}&_=${Date.now()}`,
        { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: detailParams.toString() },
      );
      if (!detailResponse.ok) throw new Error(`Visitor detail HTTP ${detailResponse.status}`);
      const detail = await detailResponse.json();
      if (detail.successed !== true || !Array.isArray(detail.value?.data) ||
          !Number.isInteger(detail.value.total) || detail.value.total < 0 ||
          detail.value.pageNO !== page) {
        throw new Error('Unexpected visitor detail response');
      }
      if (total === null) total = detail.value.total;
      if (detail.value.total !== total || total > CONFIG.detailEventLimit) {
        throw new Error('Visitor detail exceeds cap or changed while paging');
      }
      allEvents.push(...Object.values(detail.value.data));
      if (allEvents.length > total) throw new Error('Visitor detail pagination overlaps');
      if (allEvents.length === total) break;
    }
    if (allEvents.length !== total) throw new Error('Visitor detail pagination incomplete');
    return [...new Set(allEvents.map((event) => {
      const match = typeof event?.realUrl === 'string' &&
        event.realUrl.match(/_([0-9]+)\.html(?:[?#].*)?$/);
      return match ? match[1] : null;
    }).filter(Boolean))];
  }

  const rows = data.map((visitor) => {
    const date = visitor.statDate;
    if (typeof date !== 'string' || date < CONFIG.from || date > CONFIG.to ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) || visitor.isMcFb !== 1) {
      throw new Error('Visitor date or inquiry filter did not match');
    }
    const sourceTerm = cleanText(visitor.searchKeyword);
    // LSou's processPageData appends searchKeyword to the displayed serKeywords.
    const preferenceKeywords = [
      ...(typeof visitor.serKeywords === 'string' ? visitor.serKeywords.split(',') : []),
      sourceTerm,
    ].map(cleanText).filter(Boolean).slice(0, 100);
    return {
      store_key: CONFIG.storeKey, visit_date: date,
      source_term: sourceTerm,
      country: cleanText(visitor.buyerCountry),
      preference_keywords: [...new Set(preferenceKeywords)],
      viewed_product_ids: [],
      actions: [
        ...(visitor.isAtmFb === 1 ? ['tm'] : []),
        ...(visitor.isMcFb === 1 ? ['inquiry'] : []),
        ...(visitor.isClickPlaceOrder === 1 ? ['order_click'] : []),
      ],
    };
  });
  if (rows.length) rows[0].viewed_product_ids = await viewedProducts(data[0]);
  // Only this allowlisted projection leaves the browser. IDs, names, cookies,
  // company names, contact fields, and raw responses never enter the download.
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `Download ${rows.length} anonymous inquiry records`;
  button.style.cssText = 'position:fixed;z-index:2147483647;top:12px;right:12px;padding:12px;background:#1769aa;color:white';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const link = document.createElement('a');
    link.href = url;
    link.download = `visits_${CONFIG.from.replaceAll('-', '')}_${CONFIG.to.replaceAll('-', '')}_anonymous.jsonl`;
    link.click();
  });
  document.body.appendChild(button);
  console.info(`Anonymous visitor export ready: ${rows.length}/${total} records; product details checked for ${Math.min(rows.length, CONFIG.detailRecordLimit)} record. ${CONFIG.from}–${CONFIG.to}, ${CONFIG.storeKey}. Click the download button; save under ignored data/.`);
  setTimeout(() => { button.remove(); URL.revokeObjectURL(url); }, 120000);
})();
