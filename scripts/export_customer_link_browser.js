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

(() => {
  const CONFIG=window.__LEW_CUSTOMER_LINK_CONFIG__ || {};
  const STORE=CONFIG.store;
  requireExportStoreProof(CONFIG,STORE);
  if (location.hostname !== 'message.alibaba.com' || location.pathname !== '/message/maDetail.htm') {
    throw new Error('Open an Alibaba inquiry detail page in the verified store browser');
  }
  const inquiryId = new URL(location.href).searchParams.get('imInquiryId');
  if (String(CONFIG.inquiryId)!==inquiryId || !/^\d+$/.test(inquiryId || '')) throw new Error('Inquiry ID missing from page URL');
  const ids = new Set([...document.querySelectorAll('a[href]')].flatMap((link) => {
    try {
      const url = new URL(link.href);
      if (url.hostname !== 'alicrm.alibaba.com' || url.pathname !== '/crmpage/customer_detail') return [];
      const value = url.searchParams.get('customerId');
      return /^[a-f0-9]{32}$/i.test(value || '') ? [value.toLowerCase()] : [];
    } catch { return []; }
  }));
  if (ids.size !== 1) throw new Error('Expected exactly one valid CRM customer ID link');
  const row = {
    store_key: STORE,
    inquiry_id: inquiryId,
    customer_id: `alibaba-crm:${[...ids][0]}`,
    observed_at: new Date().toISOString(),
    source_system: 'alibaba-message-detail-crm-link-v1',
  };
  const blob = new Blob([`${JSON.stringify(row)}\n`], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '下载客户关联 JSONL（1 条）';
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
    link.download = `customer-link-${STORE}-${inquiryId}.jsonl`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => { button.remove(); URL.revokeObjectURL(url); }, 60000);
  }, { once: true, capture: true });
  document.body.appendChild(button);
  console.info({ store: STORE, matched_links: ids.size, action: 'click the blue download link' });
})();
