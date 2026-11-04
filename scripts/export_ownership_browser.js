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
  const CONFIG = {kind:null,display_timezone_offset:null,target_id:null,max_rows:3,...(window.__LEW_OWNERSHIP_EXPORT_CONFIG__ || {})};
  requireExportStoreProof(CONFIG,CONFIG.store_key);
  if (!['assignment', 'pool'].includes(CONFIG.kind)) throw new Error('kind must be assignment or pool');
  if (!/^[+-]\d\d:\d\d$/.test(CONFIG.display_timezone_offset)) throw new Error('Set the verified page display timezone');
  if (!Number.isInteger(CONFIG.max_rows) || CONFIG.max_rows < 1 || CONFIG.max_rows > 20) throw new Error('max_rows must be 1 to 20');
  if (CONFIG.target_id !== null && (typeof CONFIG.target_id !== 'string' || !CONFIG.target_id.trim())) throw new Error('target_id must be null or an exact ID');
  const assignmentPage = location.hostname === 'message.alibaba.com' && location.pathname.endsWith('/imAssignLog.htm') && location.hash.includes('assignLog');
  const poolPage = location.hostname === 'i.alibaba.com' && location.pathname.includes('public_customer');
  if (CONFIG.kind === 'assignment' && !assignmentPage) throw new Error('Open the native assignment record page');
  if (CONFIG.kind === 'pool' && !poolPage) throw new Error('Open the native public pool page');
  const observed_at = new Date().toISOString();
  let rows;
  if (CONFIG.kind === 'assignment') {
    rows = [...document.querySelectorAll('.assign-list-item')].flatMap(el => {
      const id = el.querySelector('.inquiry-id')?.textContent?.match(/\b\d+\b/)?.[0];
      if (!id) return []; // TM rows have no visible inquiry ID here.
      const date = el.querySelector('.assign-date')?.textContent?.trim();
      const time = el.querySelector('.assign-time')?.textContent?.trim();
      const assigned = el.querySelector('.assign-content')?.textContent?.trim().match(/^(.*?)\s*分配给\s*(.+)$/);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}:\d{2}$/.test(time || '') || !assigned) throw new Error('Unrecognized assignment row; export stopped');
      const reason = el.querySelector('.assign-reason')?.textContent?.trim();
      const reasonCodes = { '按客户第一分配': 'customer_first', '按主账号自动流转询盘分配': 'main_account_auto' };
      return [{ store_key: CONFIG.store_key, inquiry_id: id,
        assigned_at: `${date}T${time}${CONFIG.display_timezone_offset}`,
        assigned_by: assigned[1].trim(), assigned_to: assigned[2].trim(),
        reason_code: reasonCodes[reason] || 'other', source_system: 'native-assignment-page' }];
    });
  } else {
    rows = [...document.querySelectorAll('tr[data-row-key]')].map(el => {
      const cells = [...el.querySelectorAll(':scope > td')];
      const customer_id = el.getAttribute('data-row-key');
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(customer_id || '') || cells.length < 15) throw new Error('Unrecognized pool row; export stopped');
      return { store_key: CONFIG.store_key, customer_id, observed_at, pool_status: 'in_pool',
        former_owner: cells[12].textContent.trim() === '-' ? null : cells[12].textContent.trim(),
        source_system: 'native-crm-pool-page' };
    });
  }
  if (CONFIG.target_id) rows = rows.filter(x => (CONFIG.kind === 'assignment' ? x.inquiry_id : x.customer_id) === CONFIG.target_id);
  rows = rows.slice(0, CONFIG.max_rows);
  if (!rows.length) throw new Error('No eligible records on this visible page');
  const content = rows.map(x => JSON.stringify(x)).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ndjson' }));
  const filename = `ownership-${CONFIG.store_key}-${CONFIG.kind}-${Date.now()}.jsonl`;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `下载 ${rows.length} 条${CONFIG.kind === 'assignment' ? '分配' : '公海'} JSONL`;
  Object.assign(button.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647', padding: '12px', background: '#1769aa', color: 'white', cursor: 'pointer' });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => { button.remove(); URL.revokeObjectURL(url); }, 60000);
  }, { once: true, capture: true });
  document.body.append(button);
  console.info(`Prepared ${rows.length} ownership records; use the visible download link.`);
})();
