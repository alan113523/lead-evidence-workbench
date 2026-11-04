/* Alibaba webpage API collector. No SDK calls: the SDK can mark messages read.
 * CommonJS for offline tests; the local runner embeds it in a page-scoped closure.
 * Endpoint/field evidence: docs/architecture.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OkkiChatCollector = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'alibaba-chat-api-v1';
  const IDENTITY_ENDPOINT = 'https://i.alibaba.com/ajax/sellerProfileAjax.do';
  const validStore = value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(value);
  const sensitiveKey = /token|csrf|authorization|cookie|credential|secret|password|sessionKey|secTradeId|secAccountId|accountIdEncrypt|signature|^sign$|^sig$|accesskey|^policy$|^x-amz-|^x-oss-/i;
  const ENDPOINTS = Object.freeze({
    inquiry: 'https://message.alibaba.com/message/ajax/feedback/subjectList.htm',
    summary: 'https://message.alibaba.com/message/ajax/feedback/querySummary.htm',
    session: 'https://onetalk.alibaba.com/csrf/getToken.htm',
    messages: 'https://onetalk.alibaba.com/message/getOpMessages.htm',
  });
  const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
  const check = (condition, code) => { if (!condition) fail(code); };
  const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  // CDP transports can reorder object keys. Identity/dedup must compare values.
  const canonical = (x) => JSON.stringify(x, (_key, value) => object(value) ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const keys = (x, allowed) => check(object(x) && Object.keys(x).every(k => allowed.split(' ').includes(k)), 'unexpected_result_fields');
  const id = (x) => {
    check(typeof x === 'string' || Number.isSafeInteger(x), 'invalid_or_unsafe_id');
    const result = String(x);
    check(result.length > 0 && result.length <= 256 && !/[\s<>]/.test(result), 'invalid_or_unsafe_id');
    return result;
  };
  const parseObject = (x) => {
    if (object(x)) return x;
    if (typeof x !== 'string') return {};
    try { const value = JSON.parse(x); return object(value) ? value : {}; } catch { return {}; }
  };
  const scalarFlag = (x) => x === true || x === 1 ? true : x === false || x === 0 ? false : null;
  function validateConfig(c) {
    keys(c, 'schema_version store_key targets page_size max_pages snapshot_at_ms resume_after_review browser_binding');
    check(object(c) && c.schema_version === VERSION && validStore(c.store_key), 'invalid_config');
    if (c.browser_binding !== undefined) {
      keys(c.browser_binding, 'channel browser_id');
      check(['chrome-devtools','cua-cdp'].includes(c.browser_binding.channel) &&
        typeof c.browser_binding.browser_id === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(c.browser_binding.browser_id), 'invalid_browser_binding');
    }
    check(Array.isArray(c.targets) && c.targets.length > 0 && c.targets.length <= 20, 'invalid_targets');
    const ids = new Set();
    for (const t of c.targets) {
      keys(t, 'inquiry_id buyer_member_id');
      check(object(t) && typeof t.inquiry_id === 'string' && /^\d{1,20}$/.test(t.inquiry_id), 'invalid_inquiry_id');
      check(!ids.has(t.inquiry_id), 'duplicate_target'); ids.add(t.inquiry_id);
      check(typeof t.buyer_member_id === 'string' && /^alibaba-visible-member:[a-z0-9]{3,64}$/i.test(t.buyer_member_id), 'buyer_link_required');
    }
    check(Number.isInteger(c.page_size) && c.page_size >= 1 && c.page_size <= 100, 'invalid_page_size');
    check(Number.isInteger(c.max_pages) && c.max_pages >= 1 && c.max_pages <= 100, 'invalid_page_budget');
    check(Number.isSafeInteger(c.snapshot_at_ms) && c.snapshot_at_ms > 0, 'invalid_snapshot');
    return c;
  }
  function newState(c) {
    validateConfig(c);
    return { schema_version: VERSION, store_key: c.store_key, ...(c.browser_binding ? {browser_binding: {...c.browser_binding}} : {}), snapshot_at_ms: c.snapshot_at_ms,
      page_size: c.page_size, revision: 0, pages_read: 0, status: 'ready', stop_reason: null,
      targets: c.targets.map(t => ({ ...t, identity: null, cursor: null, status: 'pending',
        stop_reason: null, pages: [], messages: [], duplicate_count: 0, excluded_newer_count: 0 })) };
  }
  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const u = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
      // Keep business parameters (product IDs, filenames, language); remove auth/signing values.
      for (const key of [...u.searchParams.keys()]) if (sensitiveKey.test(key)) u.searchParams.delete(key);
      // This legacy card URL regenerates ctime on reads of the same message.
      if (u.hostname === 'workspace.alibaba.com' && u.pathname === '/card') u.searchParams.delete('ctime');
      u.hash = ''; return u.href;
    } catch { return null; }
  }
  function cleanText(value, secrets = []) {
    let s = String(value ?? '');
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) s = s.split(secret).join('[redacted]');
    s = s.replace(/(?:https?:\/\/|\/\/|\/)[^\s<>"']+/g, url => {
      if (!url.startsWith('/') || url.startsWith('//')) return safeUrl(url) || '[unsafe-url]';
      const u = new URL(url, 'https://redaction.invalid');
      const privateKeys = [...u.searchParams.keys()].filter(key=>sensitiveKey.test(key));
      if (!privateKeys.length) return url;
      for (const key of privateKeys) u.searchParams.delete(key);
      return url.split('?')[0] + u.search + u.hash;
    });
    return s.replace(/\b(?:ctoken|chatToken|token|access_token|refresh_token|authorization|cookie|password|secret|_csrf_token_|_csrf|sessionKey|secTradeId|secAccountId|accountIdEncrypt|signature)\b["']?\s*[=:]\s*["']?[^\s"'<>;&,}]+/gi, '[redacted]');
  }
  function sourceContent(value, secrets = []) {
    check(typeof value === 'string' && value.length <= 1_000_000, 'invalid_content');
    let parsed;
    try { parsed = JSON.parse(value); } catch {}
    const scrub = x => Array.isArray(x) ? x.map(scrub) : object(x) ? Object.fromEntries(Object.entries(x)
      .filter(([key]) => !sensitiveKey.test(key)).map(([key,v]) => [key,scrub(v)])) : typeof x === 'string' ? cleanText(x,secrets) : x;
    const isJson = object(parsed) || Array.isArray(parsed);
    const output = isJson ? JSON.stringify(scrub(parsed)) : cleanText(value,secrets);
    return { source_content: output, source_content_format: isJson ? 'json' : /<[a-z!/]/i.test(value) ? 'html' : 'text',
      content_redacted: isJson ? canonical(scrub(parsed)) !== canonical(parsed) : output !== value };
  }
  function textFromHtml(value, environment) {
    check(typeof value === 'string' && value.length <= 1_000_000, 'invalid_content');
    // Never insert source HTML in a live document or execute it.
    if (environment.document?.createElement) {
      const template = environment.document.createElement('template');
      template.innerHTML = value;
      const d = template.content; // Inert template: no image/iframe requests.
      for (const node of d.querySelectorAll('script,style,noscript,iframe,object,template')) node.remove();
      for (const br of d.querySelectorAll('br')) br.replaceWith('\n');
      for (const block of d.querySelectorAll('p,div,li,tr')) block.append('\n');
      return { text: d.textContent || '', attachments: [...d.querySelectorAll('img[src],video[src],a[href]')]
        .map(n => ({ kind: n.tagName.toLowerCase() === 'img' ? 'image' : n.tagName.toLowerCase() === 'video' ? 'video' : 'link',
          name: n.getAttribute('alt') || n.textContent || null, url: safeUrl(n.getAttribute('src') || n.getAttribute('href')), size_bytes: null })) };
    }
    // Tests supply a parser for HTML; plain text does not require a browser parser.
    check(!/<[a-z!/]/i.test(value), 'html_parser_required');
    return { text: value, attachments: [] };
  }
  function sourceEvidence(m) {
    const basic = parseObject(parseObject(m.extInfo?.icbuData?.extend).basicMessageInfo);
    const ext = object(basic.extParams) ? basic.extParams : {};
    const origin = parseObject(m.originExt?.basicMessageInfo);
    // These exact predicates render the official AI badge (messenger 1.0.459).
    const evidence = [];
    if (origin.entranceSource === 'sa_negotiation' || basic.entranceSource === 'sa_negotiation')
      evidence.push('basicMessageInfo.entranceSource=sa_negotiation');
    if (ext.autoReceptionType === 'commonReceptionMsg' && typeof ext.autoRcptBuyerDisplayIcon === 'string' && ext.autoRcptBuyerDisplayIcon)
      evidence.push('extParams.autoReceptionType=commonReceptionMsg+autoRcptBuyerDisplayIcon');
    if (ext.quotationType === 'autoQuote' && typeof ext.rfqBuyerDisplayIcon === 'string' && ext.rfqBuyerDisplayIcon)
      evidence.push('extParams.quotationType=autoQuote+rfqBuyerDisplayIcon');
    const flags = { auto_reply: scalarFlag(m.autoReply), basic_auto_reply: scalarFlag(basic.autoReply),
      robot_message: scalarFlag(m.extInfo?.icbuData?.robotMessage) };
    const source = Number(m.type) === 2 ? 'not_applicable' : evidence.length ? 'ai' : 'unknown';
    return { reply_source: source, source_evidence: evidence, automation_flags: flags };
  }
  // Workspace cards are URL envelopes, not attachment bodies. Decode only the
  // observed display fields; no fetch, HTML execution, or inferred download URL.
  function parseWorkspaceCard(value) {
    if (typeof value !== 'string' || value.length > 1_000_000) return null;
    const url = safeUrl(value.trim());
    if (!url) return null;
    const u = new URL(url);
    if (u.hostname !== 'workspace.alibaba.com' || u.pathname !== '/card' || u.port) return null;
    const type = u.searchParams.get('type');
    if (!/^\d+$/.test(type || '') || u.searchParams.getAll('type').length !== 1) return null;
    const types = { '6': 'inquiry_card', '12': 'file', '13': 'image', '14': 'video', '2028': 'product_card' };
    const kind = types[type] || 'card';
    const name = u.searchParams.get('name') || null;
    const text = [...new Set(['title', 'subject', 'text', 'name'].map(k => u.searchParams.get(k)).filter(Boolean))].map(v => cleanText(v)).join('\n');
    const size = u.searchParams.get('orgSize') || u.searchParams.get('size');
    return { kind, content_status: 'metadata_only', text,
      attachments: [{ kind: ['file','image','video'].includes(kind) ? kind : 'link', name, url,
        size_bytes: size !== null && /^\d+$/.test(size) && Number.isSafeInteger(Number(size)) ? Number(size) : null }] };
  }
  function normalizeMessage(m, identity, environment = {}, secrets = []) {
    check(object(m), 'invalid_message');
    const messageId = id(m.messageId), time = m.sendTime;
    check(Number.isSafeInteger(time) && time > 0 && time <= 8640000000000000, 'invalid_message_time');
    check(Number.isInteger(m.type) && Number.isInteger(m.subType), 'invalid_message_type');
    check(['send', 'rec'].includes(m.messageType) || m.type === 2, 'unknown_direction');
    const owner = id(m.owner?.accountId), contact = id(m.contact?.accountId);
    let buyer = contact, accountMapping = null;
    if (m.type === 2 && m.subType === 10 && m.messageType === 'rec' && m.viewType === 1 && owner === identity.buyer_account_id) {
      check(contact === identity.owner_account_id && owner !== contact &&
        identity.buyer_account_id !== identity.owner_account_id, 'message_buyer_mismatch');
      buyer = owner;
      accountMapping = {rule:'system_reverse_pair_v1', source_message_type:m.messageType,
        source_view_type:m.viewType, source_contact_account_id:contact};
    } else check(contact === identity.buyer_account_id, 'message_buyer_mismatch');
    const direction = m.type === 2 ? 'system' : m.messageType === 'send' ? 'seller' : 'buyer';
    let content = { text: '', attachments: [] }, kind = m.type === 2 ? 'system' : 'other', contentStatus = null;
    const hidden = m.viewType === 3;
    if (!hidden && m.subType === 1) { kind = m.type === 2 ? 'system' : 'text'; content = textFromHtml(m.content, environment); }
    else if (!hidden) {
      const card = parseObject(m.content), workspaceCard = m.type === 2 ? null : parseWorkspaceCard(m.content);
      if (workspaceCard) {
        content = workspaceCard; kind = workspaceCard.kind; contentStatus = workspaceCard.content_status;
      } else if (Object.keys(card).length) {
        // Explicit display allowlist; raw cards/extend can contain chatToken/IP/auth links.
        content.text = [card.title, card.subject, card.text, card.name].filter(v => typeof v === 'string').join('\n');
        const url = safeUrl(card.url || card.downloadUrl || card.imageUrl);
        if (url || typeof card.name === 'string') content.attachments.push({ kind: m.subType === 61 ? 'file' : 'media',
          name: typeof card.name === 'string' ? card.name : null, url,
          size_bytes: Number.isSafeInteger(card.size) && card.size >= 0 ? card.size : null });
        kind = m.subType === 61 ? 'file' : m.subType === 50 ? 'inquiry_card' : 'card';
      } else if (typeof m.content === 'string') content = textFromHtml(m.content, environment);
    }
    return { message_id: messageId, sent_at: new Date(time).toISOString(), send_time_ms: time,
      direction, sender_account_id: direction === 'seller' ? owner : direction === 'buyer' ? contact : null,
      owner_account_id: owner, buyer_account_id: buyer, type: m.type, sub_type: m.subType,
      ...(accountMapping ? {account_mapping:accountMapping} : {}),
      kind, content_status: hidden ? 'recalled_or_hidden' : contentStatus || (kind === 'other' ? 'unparsed_type' : 'read'),
      ...(hidden ? { source_content: null, source_content_format: 'withheld', content_redacted: false } : sourceContent(m.content, secrets)),
      text: cleanText(content.text, secrets), attachments: content.attachments.map(a => ({ ...a,
        name: a.name === null ? null : cleanText(a.name, secrets), url: a.url === null ? null : cleanText(a.url, secrets) })),
      ...sourceEvidence(m) };
  }
  function validateState(c, s) {
    validateConfig(c);
    keys(s, 'schema_version store_key browser_binding snapshot_at_ms page_size revision pages_read status stop_reason targets session_member_id last_step');
    check(canonical(s.browser_binding) === canonical(c.browser_binding), 'browser_binding_mismatch');
    check(object(s) && s.schema_version === VERSION && s.store_key === c.store_key &&
      s.snapshot_at_ms === c.snapshot_at_ms && s.page_size === c.page_size, 'checkpoint_scope_mismatch');
    check(Number.isSafeInteger(s.revision) && s.revision >= 0 && Number.isSafeInteger(s.pages_read) && s.pages_read >= 0,
      'invalid_checkpoint');
    check(Array.isArray(s.targets) && s.targets.length === c.targets.length, 'checkpoint_targets_mismatch');
    let pages = 0;
    for (let i = 0; i < s.targets.length; i++) {
      const t = s.targets[i], expected = c.targets[i];
      keys(t, 'inquiry_id buyer_member_id identity cursor status stop_reason pages messages duplicate_count excluded_newer_count');
      check(Number.isSafeInteger(t.duplicate_count) && t.duplicate_count >= 0 && Number.isSafeInteger(t.excluded_newer_count) && t.excluded_newer_count >= 0, 'invalid_checkpoint');
      if (t.identity !== null) {
        keys(t.identity, 'conversation_id buyer_account_id owner_account_id');
        for (const key of ['conversation_id','buyer_account_id','owner_account_id']) id(t.identity[key]);
      }
      check(t.inquiry_id === expected.inquiry_id && t.buyer_member_id === expected.buyer_member_id, 'checkpoint_targets_mismatch');
      check(Array.isArray(t.messages) && Array.isArray(t.pages) && ['pending','collecting','paused','endpoint_exhausted'].includes(t.status), 'invalid_checkpoint');
      check(t.cursor === null || Number.isSafeInteger(t.cursor) && t.cursor > 0, 'invalid_cursor');
      const seen = new Set();
      for (const m of t.messages) {
        keys(m, 'message_id sent_at send_time_ms direction sender_account_id owner_account_id buyer_account_id type sub_type kind content_status source_content source_content_format content_redacted text attachments reply_source source_evidence automation_flags account_mapping');
        if (Object.hasOwn(m, 'account_mapping')) {
          const mapping = m.account_mapping;
          keys(mapping, 'rule source_message_type source_view_type source_contact_account_id');
          check(mapping.rule === 'system_reverse_pair_v1' && mapping.source_message_type === 'rec' && mapping.source_view_type === 1 &&
            typeof mapping.source_contact_account_id === 'string' && id(mapping.source_contact_account_id) === t.identity?.owner_account_id &&
            m.type === 2 && m.sub_type === 10 && m.direction === 'system' && m.sender_account_id === null &&
            m.reply_source === 'not_applicable' && m.content_status !== 'recalled_or_hidden' &&
            m.owner_account_id === t.identity?.buyer_account_id && m.buyer_account_id === m.owner_account_id &&
            m.owner_account_id !== mapping.source_contact_account_id, 'invalid_account_mapping');
        }
        check((typeof m.source_content === 'string' || m.source_content === null) && ['text','html','json','withheld'].includes(m.source_content_format) && typeof m.content_redacted === 'boolean', 'source_content_required');
        keys(m.automation_flags, 'auto_reply basic_auto_reply robot_message');
        check(Array.isArray(m.source_evidence) && m.source_evidence.every(e => typeof e === 'string' && e.length < 160), 'invalid_source_evidence');
        for (const a of m.attachments) {
          keys(a, 'kind name url size_bytes');
          check(a.url === null || typeof a.url === 'string' && safeUrl(a.url) === a.url, 'unsafe_attachment_url');
        }
        check(object(m) && typeof m.message_id === 'string' && !seen.has(m.message_id) &&
          Number.isSafeInteger(m.send_time_ms) && m.send_time_ms > 0 && m.send_time_ms <= s.snapshot_at_ms &&
          typeof m.text === 'string' && Array.isArray(m.attachments) && ['ai','unknown','not_applicable'].includes(m.reply_source), 'invalid_checkpoint_message');
        seen.add(m.message_id);
      }
      for (const p of t.pages) {
        keys(p, 'page requested_cursor next_cursor row_count duplicate_count excluded_newer_count has_more observed_at');
        check(Number.isInteger(p.page) && p.page > 0 && Number.isInteger(p.row_count) && p.row_count >= 0 && p.row_count <= c.page_size, 'invalid_page_evidence');
      }
      if (t.pages.length) check(t.identity && t.cursor === t.pages.at(-1).next_cursor, 'checkpoint_cursor_mismatch');
      pages += t.pages.length;
    }
    if (s.last_step) keys(s.last_step, 'stage request_count store_verified_at');
    check(['ready','paused','endpoint_exhausted'].includes(s.status) && (s.stop_reason === null || /^[a-z0-9_]+$/.test(s.stop_reason)), 'invalid_checkpoint');
    check(pages === s.pages_read, 'checkpoint_page_count_mismatch');
    return s;
  }
  function consumePage(target, payload, c, environment = {}, secrets = []) {
    check(object(payload) && String(payload.code) === '200' && object(payload.data), 'invalid_message_response');
    // The legacy endpoint returns data:{} at its end; the official UI uses list || [].
    const list = Object.keys(payload.data).length === 0 ? [] : payload.data.list;
    check(Array.isArray(list), 'invalid_message_response');
    check(list.length <= c.page_size, 'page_size_exceeded');
    check(payload.data.hasMore === undefined || typeof payload.data.hasMore === 'boolean', 'invalid_has_more');
    const before = target.cursor;
    const rows = list.map(m => normalizeMessage(m, target.identity, environment, secrets));
    check(rows.every((m, i) => !i || rows[i - 1].send_time_ms >= m.send_time_ms), 'unordered_page');
    check(before === null || rows.every(m => m.send_time_ms <= before), 'cursor_out_of_range');
    check(new Set(rows.map(m => m.message_id)).size === rows.length, 'duplicate_within_page');
    const next = rows.length ? Math.min(...rows.map(m => m.send_time_ms)) : before;
    const byId = new Map(target.messages.map(m => [m.message_id, m]));
    let duplicates = 0, newer = 0;
    for (const row of rows) {
      if (row.send_time_ms > c.snapshot_at_ms) { newer++; continue; }
      if (byId.has(row.message_id)) {
        check(canonical(byId.get(row.message_id)) === canonical(row), 'conflicting_duplicate'); duplicates++;
      } else byId.set(row.message_id, row);
    }
    check(!(list.length === 0 && payload.data.hasMore === true), 'empty_page_with_more');
    // Prepare fully before committing this page, so parse errors preserve prior state.
    target.messages = [...byId.values()].sort((a,b) => a.send_time_ms - b.send_time_ms || a.message_id.localeCompare(b.message_id));
    target.duplicate_count += duplicates; target.excluded_newer_count += newer;
    target.cursor = next;
    const stalled = rows.length > 0 && before !== null && next >= before;
    const tied = rows.length === c.page_size && rows.filter(m => m.send_time_ms === next).length > 1;
    const ended = rows.length === 0 || payload.data.hasMore === false;
    target.status = stalled || tied ? 'paused' : ended ? 'endpoint_exhausted' : 'collecting';
    target.stop_reason = stalled ? 'cursor_stalled' : tied ? 'timestamp_boundary_ambiguous' : ended ?
      (payload.data.hasMore === false ? 'explicit_end' : 'empty_page') : null;
    target.pages.push({ page: target.pages.length + 1, requested_cursor: before, next_cursor: next,
      row_count: rows.length, duplicate_count: duplicates, excluded_newer_count: newer,
      has_more: payload.data.hasMore ?? null, observed_at: new Date().toISOString() });
  }
  function summary(s) {
    return { schema_version: VERSION, store_key: s.store_key, revision: s.revision, status: s.status,
      stop_reason: s.stop_reason, pages_read: s.pages_read,
      target_count: s.targets.length, exhausted_targets: s.targets.filter(t => t.status === 'endpoint_exhausted').length,
      message_count: s.targets.reduce((n,t) => n + t.messages.length, 0),
      ai_messages: s.targets.reduce((n,t) => n + t.messages.filter(m => m.reply_source === 'ai').length, 0),
      seller_source_unknown: s.targets.reduce((n,t) => n + t.messages.filter(m => m.direction === 'seller' && m.reply_source === 'unknown').length, 0),
      history_complete: false, coverage_basis: 'timestamp_pagination_of_current_account_visible_endpoint',
      limitation: 'No server total or guaranteed timestamp tie coverage; endpoint exhaustion is not company-wide full history.' };
  }
  async function verifyStore(store, environment = globalThis) {
    check(validStore(store) && environment.location?.origin === 'https://i.alibaba.com', 'wrong_identity_page');
    let response;
    try { response = await environment.fetch(IDENTITY_ENDPOINT, { method: 'GET', credentials: 'same-origin', redirect: 'error',
      signal: environment.AbortSignal.timeout(15000) }); } catch { fail('identity_request_failed'); }
    check(response.ok && !response.redirected, 'identity_http_error');
    let data; try { data = await response.json(); } catch { fail('identity_not_json'); }
    check(typeof data?.minisite === 'string' && typeof data.componyName === 'string' && data.componyName.trim(), 'identity_fields_missing');
    let site; try { site = new URL(data.minisite.startsWith('//') ? `https:${data.minisite}` : data.minisite); } catch { fail('invalid_store_identity'); }
    check(['http:','https:'].includes(site.protocol) && !site.username && !site.password && !site.port &&
      site.hostname === `${store}.en.alibaba.com`, 'store_identity_mismatch');
    return { store_host: site.hostname, source_url: IDENTITY_ENDPOINT, observed_at_ms: Date.now() };
  }
  async function step(config, previous, proof, environment = globalThis) {
    const c = validateConfig(config), s = JSON.parse(JSON.stringify(validateState(c, previous)));
    check(environment.location?.origin === 'https://message.alibaba.com' && environment.location?.pathname === '/message/default.htm', 'wrong_page');
    check(object(proof) && proof.store_host === `${c.store_key}.en.alibaba.com` &&
      proof.source_url === IDENTITY_ENDPOINT &&
      Number.isSafeInteger(proof.observed_at_ms) && Date.now() - proof.observed_at_ms >= 0 && Date.now() - proof.observed_at_ms < 300000,
      'fresh_store_verification_required');
    if (c.browser_binding) check(canonical(proof.browser_binding) === canonical(c.browser_binding), 'browser_binding_mismatch');
    const target = s.targets.find(t => t.status !== 'endpoint_exhausted');
    check(target, 'already_exhausted');
    check(s.pages_read < c.max_pages, 'page_budget_reached');
    check(target.status !== 'paused' || c.resume_after_review === true, 'review_required_before_resume');
    const binding = environment.GDATA?.user?.memberId;
    check(binding !== undefined && binding !== null, 'session_identity_missing');
    const userBinding = id(binding);
    if (s.session_member_id) check(s.session_member_id === userBinding, 'session_changed');
    s.session_member_id = userBinding;
    let stage = 'session', requests = 0;
    const secrets = [];
    async function request(endpoint, params, sessionToken) {
      check(Object.values(ENDPOINTS).includes(endpoint), 'endpoint_not_allowed');
      check(id(environment.GDATA?.user?.memberId) === userBinding, 'session_changed');
      requests++;
      let url = endpoint, body = new URLSearchParams();
      if (endpoint.startsWith('https://message.alibaba.com/')) {
        const sys = environment.GDATA?.system;
        const token = environment.document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('xman_us_t='))?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1];
        check(token && sys?.csrfTokenVal && sys?.csrfTokenKey, 'session_parameters_missing');
        secrets.push(token, sys.csrfTokenVal);
        url += `?ctoken=${encodeURIComponent(token)}`; body.set(sys.csrfTokenKey, sys.csrfTokenVal);
        body.set('postId', String(Date.now())); // Official DataSource v2 envelope.
      } else if (endpoint === ENDPOINTS.messages) { check(sessionToken, 'session_parameters_missing'); body.set('_csrf', sessionToken); }
      if (params) body.set('params', JSON.stringify(params));
      let response;
      try { response = await environment.fetch(url, { method: 'POST', credentials: 'include', mode: 'cors', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body,
        signal: environment.AbortSignal.timeout(20000) }); } catch { fail('network_or_redirect_error'); }
      if ([401,403,429].includes(response.status)) fail(`http_${response.status}`);
      check(response.ok && !response.redirected, 'http_error');
      let data, responseText;
      try { responseText = await response.text(); } catch { fail('response_read_failed'); }
      check(id(environment.GDATA?.user?.memberId) === userBinding, 'session_changed');
      check(responseText.length <= 8_000_000, 'response_too_large');
      try { data = JSON.parse(responseText); } catch {
        // Classification only: never retain response HTML, headers or arbitrary error text.
        if (/captcha|punish|x5sec|验证码|滑块|风控/i.test(responseText)) fail('site_challenge');
        if (/passport|sign.?in|登录/i.test(responseText)) fail('login_required');
        fail('non_json_response');
      }
      if (endpoint !== ENDPOINTS.session) check(String(data?.code) === '200', 'api_rejected');
      return data;
    }
    try {
      stage = 'resolve_inquiry';
      const found = await request(ENDPOINTS.inquiry, { system: 'feedback', listType: 'all', isAdvanceSearch: 'true',
        filter: { process: '', isShowAtm: false, queryType: 'recentlyYear' }, pagination: { nextPage: 1, pageSize: 10 },
        order: { order: 'desc', orderBy: 'latest_contact_time' }, search: { requestNo: target.inquiry_id } });
      check(Array.isArray(found.data?.list), 'invalid_inquiry_response');
      const candidates = found.data.list.flatMap(item => Array.isArray(item) ? item : []).filter(r => String(r.id) === target.inquiry_id);
      check(candidates.length === 1 && typeof candidates[0].secTradeId === 'string' && candidates[0].secTradeId, 'inquiry_not_uniquely_resolved');
      const secTradeId = candidates[0].secTradeId; secrets.push(secTradeId);
      stage = 'resolve_buyer';
      const resolved = (await request(ENDPOINTS.summary, { secTradeId })).data;
      check(object(resolved) && String(resolved.tradeId) === target.inquiry_id &&
        `alibaba-visible-member:${resolved.contact?.loginId}` === target.buyer_member_id, 'inquiry_buyer_mismatch');
      const identity = { conversation_id: id(resolved.cid), buyer_account_id: id(resolved.contact.accountId),
        owner_account_id: id(resolved.owner?.accountId) };
      check(!target.identity || canonical(identity) === canonical(target.identity), 'conversation_identity_changed');
      check(resolved.contact.accountIdEncrypt && resolved.owner.accountIdEncrypt, 'missing_conversation_locator');
      secrets.push(resolved.contact.accountIdEncrypt, resolved.owner.accountIdEncrypt, resolved.contact.secAccountId);
      target.identity = identity;
      stage = 'message_session';
      const auth = await request(ENDPOINTS.session);
      check(typeof auth.token === 'string' && auth.token, 'session_parameters_missing'); secrets.push(auth.token);
      stage = 'read_page';
      const page = await request(ENDPOINTS.messages, { scene: '',
        timeSlide: { timeStamp: target.cursor, forward: target.cursor === null ? null : false, pageSize: c.page_size },
        secOwnerAccountId: resolved.owner.accountIdEncrypt, secTargetAccountId: resolved.contact.accountIdEncrypt,
        secTradeId, openRealTimeTranslation: false, contactAccountId: resolved.contact.accountId,
        contactAccountIdEncrypt: resolved.contact.secAccountId }, auth.token);
      consumePage(target, page, c, environment, secrets);
      s.pages_read++;
      s.status = s.targets.every(t => t.status === 'endpoint_exhausted') ? 'endpoint_exhausted' :
        target.status === 'paused' ? 'paused' : s.pages_read >= c.max_pages ? 'paused' : 'ready';
      s.stop_reason = target.stop_reason && target.status === 'paused' ? target.stop_reason :
        s.status === 'paused' ? 'page_budget_reached' : null;
    } catch (e) {
      target.status = 'paused'; target.stop_reason = e.code || 'unexpected_error';
      s.status = 'paused'; s.stop_reason = target.stop_reason;
    }
    s.revision++;
    s.last_step = { stage, request_count: requests, store_verified_at: new Date(proof.observed_at_ms).toISOString() };
    validateState(c, s);
    return s;
  }
  return { VERSION, IDENTITY_ENDPOINT, ENDPOINTS, canonical, validateConfig, newState, validateState, safeUrl, cleanText, sourceContent,
    sourceEvidence, parseWorkspaceCard, normalizeMessage, consumePage, summary, verifyStore, step };
});
