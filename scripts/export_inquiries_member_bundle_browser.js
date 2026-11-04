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

window.__LEW_INQUIRY_EXPORT_PROMISE__ = (async () => {
  const CONFIG = {
    store: null,
    from: null,
    to: null,
    pageSize: 10,
    maxPages: 10,
    maxExtraRequests: 30,
    knownMemberInquiryIds: [],
    sampleLimit: null,
    returnBundleOnly: false,
    ...(window.__LEW_INQUIRY_EXPORT_CONFIG__ || {}),
  };
  requireExportStoreProof(CONFIG,CONFIG.store);

  function midnight(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Use YYYY-MM-DD dates');
    const time = Date.parse(`${day}T00:00:00+08:00`);
    if (!Number.isFinite(time) || new Date(time + 8 * 3600000).toISOString().slice(0, 10) !== day) {
      throw new Error(`Invalid date: ${day}`);
    }
    return time;
  }

  if (location.hostname !== 'message.alibaba.com' || location.pathname !== '/message/default.htm') {
    throw new Error('Open https://message.alibaba.com/message/default.htm in the verified store browser');
  }
  if (!/^[a-z0-9_-]+$/i.test(CONFIG.store)) throw new Error('Invalid store key');
  const startTime = midnight(CONFIG.from);
  const endTime = midnight(CONFIG.to) + 86400000;
  if (startTime >= endTime) throw new Error('From date is later than to date');
  if (!Number.isInteger(CONFIG.pageSize) || CONFIG.pageSize < 1 || CONFIG.pageSize > 100) {
    throw new Error('pageSize must be 1-100');
  }
  if (!Number.isInteger(CONFIG.maxPages) || CONFIG.maxPages < 1 || CONFIG.maxPages > 100) {
    throw new Error('maxPages must be 1-100');
  }
  if (!Number.isInteger(CONFIG.maxExtraRequests) || CONFIG.maxExtraRequests < 0 || CONFIG.maxExtraRequests > 100) {
    throw new Error('maxExtraRequests must be 0-100');
  }
  if (!Array.isArray(CONFIG.knownMemberInquiryIds) ||
      CONFIG.knownMemberInquiryIds.some((id) => typeof id !== 'string' || !/^\d+$/.test(id))) {
    throw new Error('knownMemberInquiryIds must be inquiry ID strings');
  }
  if (CONFIG.sampleLimit !== null &&
      (!Number.isInteger(CONFIG.sampleLimit) || CONFIG.sampleLimit < 1 || CONFIG.sampleLimit > 100)) {
    throw new Error('sampleLimit must be 1-100 or null');
  }
  if (typeof CONFIG.returnBundleOnly !== 'boolean') throw new Error('returnBundleOnly must be boolean');

  const sessionCookie = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('xman_us_t='));
  const ctoken = sessionCookie?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1];
  const scripts = [...document.scripts].map((script) => script.textContent || '').join('\n');
  const csrf = scripts.match(/csrfTokenVal:\s*['"]([^'"]+)/)?.[1];
  if (!ctoken || !csrf) throw new Error('Alibaba session parameters not found; refresh the page and sign in');

  const observedAt = new Date().toISOString();
  const results = [];
  const pendingExtra = [];
  const memberLinks = [];
  const known = new Set(CONFIG.knownMemberInquiryIds);
  const ids = new Set();
  let complete = false;
  let sampleOnly = false;
  let pages = 0;
  for (let page = 1; page <= CONFIG.maxPages; page++) {
    const query = {
      system: 'feedback', listType: 'all', isAdvanceSearch: 'true',
      filter: { process: '', isShowAtm: false, queryType: 'recentlyYear' },
      pagination: { nextPage: page, pageSize: CONFIG.pageSize },
      order: { order: 'desc', orderBy: 'latest_contact_time' },
      search: { startTime, endTime },
    };
    const body = new URLSearchParams({
      _csrf_token_: csrf,
      postId: String(Date.now()),
      params: JSON.stringify(query),
    });
    const response = await fetch(`/message/ajax/feedback/subjectList.htm?ctoken=${encodeURIComponent(ctoken)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    if (!response.ok) throw new Error(`Alibaba request failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 200 || !Array.isArray(payload.data?.list)) {
      throw new Error(`Alibaba returned an unexpected response on page ${page}`);
    }
    const items = payload.data.list;
    pages++;
    for (const item of items) {
      const record = Array.isArray(item) ? item[0] : null;
      const id = record?.id == null ? '' : String(record.id);
      const created = Number(record?.createTime);
      if (!id || !Number.isFinite(created)) throw new Error(`Missing inquiry ID or creation time on page ${page}`);
      if (created < startTime || created >= endTime) throw new Error(`Out-of-range inquiry on page ${page}; no file saved`);
      if (ids.has(id)) throw new Error(`Repeated inquiry ID across pages; no file saved`);
      ids.add(id);
      if (!known.has(id)) pendingExtra.push({ inquiryId: id, secTradeId: record.secTradeId });
      results.push({
        store_key: CONFIG.store,
        inquiry_id: id,
        customer_id: null,
        created_at: new Date(created).toISOString(),
        first_sent_at: null,
        owner: record.ownerName || null,
        source: record.subject || null,
        inquiry_type: record.feedbackType == null ? null : String(record.feedbackType),
        business_type: record.appFrom || null,
        follow_up_status: record.process || null,
        product_id: record.productInfo?.[0]?.productId == null ? null : String(record.productInfo[0].productId),
        observed_at: observedAt,
        source_system: 'alibaba-message-subjectList-v1',
      });
      if (CONFIG.sampleLimit !== null && results.length >= CONFIG.sampleLimit) {
        sampleOnly = true;
        break;
      }
    }
    if (sampleOnly) break;
    if (items.length < CONFIG.pageSize) { complete = true; break; }
  }
  if (!complete && !sampleOnly) throw new Error(`Reached maxPages=${CONFIG.maxPages}; increase the limit for this range; no file saved`);
  if (pendingExtra.length > CONFIG.maxExtraRequests) {
    throw new Error(`Need ${pendingExtra.length} member lookups, above maxExtraRequests=${CONFIG.maxExtraRequests}; no file saved`);
  }
  for (const item of pendingExtra) {
    if (typeof item.secTradeId !== 'string' || !item.secTradeId) {
      throw new Error(`Missing secTradeId for inquiry ${item.inquiryId}; no file saved`);
    }
    const body = new URLSearchParams({ _csrf_token_: csrf,
      params: JSON.stringify({ secTradeId: item.secTradeId }) });
    const response = await fetch(`/message/ajax/feedback/querySummary.htm?ctoken=${encodeURIComponent(ctoken)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    if (!response.ok) throw new Error(`Member lookup failed: HTTP ${response.status}; no file saved`);
    const payload = await response.json();
    if (payload.code !== 200 || !payload.data?.contact) {
      throw new Error(`Unexpected member lookup response for inquiry ${item.inquiryId}; no file saved`);
    }
    const loginId = payload.data.contact.loginId;
    if (loginId == null || loginId === '') continue;
    if (typeof loginId !== 'string' || !/^[a-z0-9]{3,64}$/i.test(loginId)) {
      throw new Error(`Invalid contact.loginId for inquiry ${item.inquiryId}; no file saved`);
    }
    memberLinks.push({ store_key: CONFIG.store, inquiry_id: item.inquiryId,
      buyer_member_id: `alibaba-visible-member:${loginId}`,
      observed_at: observedAt, source_system: 'alibaba-message-querySummary-contact-loginId-v1' });
  }

  const bundle = { store_key: CONFIG.store, observed_at: observedAt, from_day: CONFIG.from,
    to_day_inclusive: CONFIG.to, coverage_status: sampleOnly ? 'sample_only' : 'complete',
    inquiries: results, buyer_member_links: memberLinks };
  if (CONFIG.returnBundleOnly) return bundle;
  const filename = `inquiry-member-bundle-${CONFIG.store}-${CONFIG.from}-to-${CONFIG.to}.json`;
  const blob = new Blob([JSON.stringify(bundle)],
    { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `下载商机及会员 ID（${results.length} 条）`;
  Object.assign(button.style, {
    position: 'fixed', right: '24px', bottom: '24px', zIndex: '2147483647',
    padding: '12px 18px', background: '#1463d7', color: '#fff',
    borderRadius: '6px', fontSize: '14px', cursor: 'pointer',
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => { button.remove(); URL.revokeObjectURL(url); }, 60000);
  }, { once: true, capture: true });
  document.body.appendChild(button);
  console.info({ store: CONFIG.store, from: CONFIG.from, to: CONFIG.to, pages,
    inquiries: results.length, member_links: memberLinks.length,
    member_missing: pendingExtra.length - memberLinks.length, member_cached: results.length - pendingExtra.length,
    complete, sample_only: sampleOnly, filename, action: 'click the blue download link' });
  return bundle;
})();
window.__LEW_INQUIRY_EXPORT_PROMISE__.catch((error) => console.error('Inquiry export failed:', error.message));
