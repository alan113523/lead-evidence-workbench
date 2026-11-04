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

function classifyBuyerLevel(row) {
  if (!row) return { status: 'extra_row_missing', buyer_level: null, buyer_level_raw: null, buyer_level_type: 'missing' };
  if (!row.sender) return { status: 'sender_missing', buyer_level: null, buyer_level_raw: null, buyer_level_type: 'missing' };
  if (!Object.prototype.hasOwnProperty.call(row.sender, 'userNewLevel')) {
    return { status: 'field_missing', buyer_level: null, buyer_level_raw: null, buyer_level_type: 'missing' };
  }
  const value = row.sender.userNewLevel;
  const type = value === null ? 'null' : typeof value;
  if (value === null || value === undefined || value === '') {
    return { status: 'empty', buyer_level: null, buyer_level_raw: value ?? null, buyer_level_type: type };
  }
  if (typeof value === 'string' && /^L\d+$/.test(value)) {
    return { status: 'value', buyer_level: value, buyer_level_raw: value, buyer_level_type: type };
  }
  return { status: 'unexpected_value', buyer_level: null, buyer_level_raw: value, buyer_level_type: type };
}

function matchBuyerLevelRows(group, list) {
  if (!list || typeof list !== 'object' || Array.isArray(list)) throw Error('Extra list missing');
  return group.map(record => {
    const inquiry_id = String(record.id);
    const row = Object.prototype.hasOwnProperty.call(list, inquiry_id) ? list[inquiry_id] : null;
    return { inquiry_id, ...classifyBuyerLevel(row) };
  });
}

function chunkBuyerLevelRows(records) {
  const groups = [];
  for (let i=0; i<records.length; i+=5) groups.push(records.slice(i,i+5));
  return groups;
}

function requireBuyerLevelResponse(response, payload) {
  if (!response.ok || payload.code !== 200) {
    const error = Error(`HTTP ${response.status} code ${payload.code}`);
    error.httpStatus = response.status;
    error.platformCode = payload.code;
    throw error;
  }
  return { payload, httpStatus: response.status };
}

if (typeof module !== 'undefined') module.exports = {
  classifyBuyerLevel, matchBuyerLevelRows, chunkBuyerLevelRows, requireBuyerLevelResponse,
};

if (typeof window !== 'undefined' && window.__LEW_BUYER_LEVEL_CONFIG__) {
  window.__LEW_BUYER_LEVEL_PROMISE__ = (async () => {
    const cfg = window.__LEW_BUYER_LEVEL_CONFIG__;
    requireExportStoreProof(cfg,cfg.store);
    if (location.hostname !== 'message.alibaba.com' || location.pathname !== '/message/default.htm') throw Error('Wrong message page');
    if (!/^[a-z0-9_-]+$/i.test(cfg.store) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(cfg.to) || !Array.isArray(cfg.inquiries) || !cfg.inquiries.length) {
      throw Error('Invalid buyer-level config');
    }
    const expected = new Map(cfg.inquiries.map(x => [String(x.inquiry_id), x]));
    if (expected.size !== cfg.inquiries.length || cfg.inquiries.some(x => !/^\d+$/.test(String(x.inquiry_id)))) {
      throw Error('Duplicate or invalid inquiry IDs');
    }
    const selected = new Set(cfg.selectedInquiryIds || cfg.inquiries.map(x => String(x.inquiry_id)));
    if (selected.size !== (cfg.selectedInquiryIds || cfg.inquiries).length ||
        [...selected].some(x => !expected.has(String(x)))) throw Error('Invalid buyer-level selection');
    const startTime = Date.parse(`${cfg.from}T00:00:00+08:00`);
    const endTime = Date.parse(`${cfg.to}T00:00:00+08:00`) + 86400000;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw Error('Invalid date range');
    const cookie = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('xman_us_t='));
    const ctoken = cookie?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1];
    const csrf = [...document.scripts].map(x => x.textContent || '').join('\n').match(/csrfTokenVal:\s*['"]([^'"]+)/)?.[1];
    if (!ctoken || !csrf) throw Error('Session page parameters absent');
    const post = async (path, params) => {
      const body = new URLSearchParams({_csrf_token_:csrf, postId:String(Date.now()), params:JSON.stringify(params)});
      const response = await fetch(`${path}?ctoken=${encodeURIComponent(ctoken)}`, {
        method:'POST', credentials:'same-origin',
        headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
        body:body.toString(),
      });
      const payload = await response.json();
      return requireBuyerLevelResponse(response,payload);
    };
    const records = [];
    let complete = false;
    for (let page=1; page<=100; page++) {
      const { payload } = await post('/message/ajax/feedback/subjectList.htm', {
        system:'feedback', listType:'all', isAdvanceSearch:'true',
        filter:{process:'',isShowAtm:false,queryType:'recentlyYear'},
        pagination:{nextPage:page,pageSize:100},
        order:{order:'desc',orderBy:'latest_contact_time'}, search:{startTime,endTime},
      });
      const list = payload.data?.list;
      if (!Array.isArray(list)) throw Error('Subject list missing');
      for (const item of list) {
        if (!Array.isArray(item) || !item[0]) throw Error('Invalid subject row');
        records.push(item[0]);
      }
      if (list.length < 100) { complete = true; break; }
    }
    if (!complete || records.length !== expected.size) throw Error('Source coverage differs from saved inquiries');
    const seen = new Set();
    for (const record of records) {
      const id = String(record.id);
      const saved = expected.get(id);
      if (!saved || seen.has(id) || Number(record.createTime) !== Date.parse(saved.created_at) ||
          (record.ownerName || null) !== (saved.owner || null) ||
          Number(record.createTime) < startTime || Number(record.createTime) >= endTime) {
        throw Error('Source inquiry identity differs from saved bundle');
      }
      seen.add(id);
    }
    const results = [];
    const group_diagnostics = [];
    const chosen = records.filter(x => selected.has(String(x.id)));
    if (chosen.length !== selected.size) throw Error('Selected inquiries absent');
    for (const group of chunkBuyerLevelRows(chosen)) {
      try {
        const { payload, httpStatus } = await post('/message/ajax/feedback/subjectListExtraInfo.htm', {
          secTradeIds:group.map(x => x.secTradeId), tradeIds:group.map(x => x.id),
        });
        results.push(...matchBuyerLevelRows(group,payload.data?.list));
        group_diagnostics.push({requested_count:group.length, http_status:httpStatus,
          platform_code:payload.code, observed_at:new Date().toISOString(), error:null});
      } catch (error) {
        results.push(...group.map(x => ({inquiry_id:String(x.id), status:'read_error',
          buyer_level:null, error:String(error.message || error).slice(0,120)})));
        group_diagnostics.push({requested_count:group.length, http_status:error.httpStatus ?? null,
          platform_code:error.platformCode ?? null, observed_at:new Date().toISOString(),
          error:String(error.message || error).slice(0,120)});
      }
    }
    return {store_key:cfg.store, source:'message.alibaba.com subjectListExtraInfo.sender.userNewLevel',
      observed_at:new Date().toISOString(), source_inquiries:cfg.inquiries.length,
      selected_inquiries:selected.size, selection_scope:selected.size === cfg.inquiries.length ? 'full' : 'subset',
      group_diagnostics, results};
  })();
}
