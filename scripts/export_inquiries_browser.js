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
    from: null,
    to: null,
    pageSize: 10,
    maxPages: 10,
    ...(window.__LEW_INQUIRY_LIST_CONFIG__ || {}),
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

  const sessionCookie = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('xman_us_t='));
  const ctoken = sessionCookie?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1];
  const scripts = [...document.scripts].map((script) => script.textContent || '').join('\n');
  const csrf = scripts.match(/csrfTokenVal:\s*['"]([^'"]+)/)?.[1];
  if (!ctoken || !csrf) throw new Error('Alibaba session parameters not found; refresh the page and sign in');

  const observedAt = new Date().toISOString();
  const results = [];
  const ids = new Set();
  let complete = false;
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
    }
    if (items.length < CONFIG.pageSize) { complete = true; break; }
  }
  if (!complete) throw new Error(`Reached maxPages=${CONFIG.maxPages}; increase the limit for this range; no file saved`);

  const filename = `inquiries-${CONFIG.store}-${CONFIG.from}-to-${CONFIG.to}.jsonl`;
  const blob = new Blob([results.map((row) => JSON.stringify(row)).join('\n') + (results.length ? '\n' : '')],
    { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `下载商机 JSONL（${results.length} 条）`;
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
  console.info({ store: CONFIG.store, from: CONFIG.from, to: CONFIG.to, pages, inquiries: results.length, complete, filename, action: 'click the blue download link' });
})().catch((error) => console.error('Inquiry export failed:', error.message));
