/* One bounded observation on an existing, authorized page. No navigation or SDK. */
(function (factory) { if (typeof module === 'object') module.exports = factory(); })(function () {
  const fail = code => { const e = new Error(code); e.code = code; throw e; };
  const check = (ok, code) => { if (!ok) fail(code); };
  const EXTRA_INFO = 'https://message.alibaba.com/message/ajax/feedback/subjectListExtraInfo.htm';
  const text = v => typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
  const bool = v => typeof v === 'boolean' ? v : null;
  // Whitelisted platform facts only; never encrypted locators, tokens or message bodies.
  function buyerFacts(listRow, summary, extra) {
    const sender = listRow?.sender || {}, contact = summary?.contact || {}, extraSender = extra?.sender || {};
    return {list_country_code: text(sender.countryCode), list_country_name: text(sender.countryName), list_name: text(sender.name),
      summary_country_code: text(contact.countryCode), summary_name: text(contact.name),
      buyer_level: text(extraSender.userNewLevel), buyer_level_legacy: text(extraSender.userLevel), join_year: text(extraSender.joinYear),
      company_name: text(extraSender.companyName), high_quality: bool(extraSender.highQuality), extra_error: null};
  }
  async function observe(task, proof, legacy, binding, env = globalThis) {
    const result = { kind: task.kind, request_id: task.request_id, observed_at_ms: Date.now(),
      store_proof: proof, identity: null, session_member_id: null, rows: [], has_more: null, error: null };
    try {
      check(env.location?.origin === 'https://message.alibaba.com' && env.location?.pathname === '/message/default.htm', 'wrong_page');
      binding.proof(proof, task.store_key, task.browser_binding, task.request_id);
      const session = String(env.GDATA?.user?.memberId || '');
      check(session, 'session_identity_missing'); result.session_member_id = session;
      check(!task.session_member_id || session === task.session_member_id, 'session_changed');
      const secrets = [];
      async function request(endpoint, params, token) {
        binding.proof(proof, task.store_key, task.browser_binding, task.request_id);
        check(String(env.GDATA?.user?.memberId || '') === session, 'session_changed');
        check([...Object.values(legacy.ENDPOINTS), EXTRA_INFO].includes(endpoint), 'endpoint_not_allowed');
        let url = endpoint; const body = new URLSearchParams();
        if (endpoint.startsWith('https://message.alibaba.com/')) {
          const sys = env.GDATA?.system;
          const cookie = env.document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('xman_us_t='))?.match(/(?:^|&)\s*ctoken\s*=\s*([^&]+)/)?.[1];
          check(cookie && sys?.csrfTokenKey && sys?.csrfTokenVal, 'session_parameters_missing');
          secrets.push(cookie, sys.csrfTokenVal); url += `?ctoken=${encodeURIComponent(cookie)}`;
          body.set(sys.csrfTokenKey, sys.csrfTokenVal); body.set('postId', String(Date.now()));
        } else if (endpoint === legacy.ENDPOINTS.messages) { check(token, 'session_parameters_missing'); body.set('_csrf', token); }
        if (params) body.set('params', JSON.stringify(params));
        let response;
        try { response = await env.fetch(url, {method: 'POST', credentials: 'include', mode: 'cors', redirect: 'error',
          headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body,
          signal: env.AbortSignal.timeout(20000)}); } catch { fail('network_or_redirect_error'); }
        if ([401,403,429].includes(response.status)) fail(`http_${response.status}`);
        check(response.ok && !response.redirected, 'http_error');
        const text = await response.text(); check(text.length <= 8_000_000, 'response_too_large');
        check(String(env.GDATA?.user?.memberId || '') === session, 'session_changed');
        let data;
        try { data = JSON.parse(text); } catch {
          if (/captcha|punish|x5sec|验证码|风控/i.test(text)) fail('site_challenge');
          if (/passport|sign.?in|登录/i.test(text)) fail('login_required');
          fail('non_json_response');
        }
        if (endpoint !== legacy.ENDPOINTS.session) check(String(data?.code) === '200', 'api_rejected');
        return data;
      }
      const found = await request(legacy.ENDPOINTS.inquiry, {system:'feedback', listType:'all', isAdvanceSearch:'true',
        filter:{process:'',isShowAtm:false,queryType:'recentlyYear'}, pagination:{nextPage:1,pageSize:10},
        order:{order:'desc',orderBy:'latest_contact_time'},search:{requestNo:task.target.inquiry_id}});
      check(Array.isArray(found.data?.list), 'invalid_inquiry_response');
      const rows = found.data.list.flatMap(r => Array.isArray(r) ? r : []).filter(r => String(r.id) === task.target.inquiry_id);
      check(rows.length === 1 && typeof rows[0].secTradeId === 'string', 'inquiry_not_uniquely_resolved');
      check(Number(rows[0].createTime) === task.target.created_at_ms, 'inquiry_creation_changed');
      const secTradeId = rows[0].secTradeId; secrets.push(secTradeId);
      const resolved = (await request(legacy.ENDPOINTS.summary, {secTradeId})).data;
      check(String(resolved?.tradeId) === task.target.inquiry_id &&
        `alibaba-visible-member:${resolved.contact?.loginId}` === task.target.buyer_member_id, 'inquiry_buyer_mismatch');
      const identity = {conversation_id:String(resolved.cid || ''),buyer_account_id:String(resolved.contact.accountId || ''),
        owner_account_id:String(resolved.owner?.accountId || '')};
      check(Object.values(identity).every(v => v && !/[\s<>]/.test(v)), 'invalid_conversation_identity');
      check(!task.identity || legacy.canonical(identity) === legacy.canonical(task.identity), 'conversation_identity_changed');
      result.identity = identity;
      if (task.kind === 'resolve') {
        let extra = null, extraError = null;
        try {
          const info = await request(EXTRA_INFO, {secTradeIds:[secTradeId], tradeIds:[rows[0].id]});
          extra = info.data?.list?.[task.target.inquiry_id] ?? null;
          if (!extra) extraError = 'extra_row_missing';
        } catch (error) { extraError = /^[a-z_0-9]+$/.test(error.code || '') ? error.code : 'extra_read_failed'; }
        result.buyer_facts = {...buyerFacts(rows[0], resolved, extra), extra_error: extraError};
      }
      if (task.kind === 'page') {
        check(resolved.contact.accountIdEncrypt && resolved.owner.accountIdEncrypt, 'missing_conversation_locator');
        secrets.push(resolved.contact.accountIdEncrypt, resolved.owner.accountIdEncrypt, resolved.contact.secAccountId);
        const auth = await request(legacy.ENDPOINTS.session); check(typeof auth.token === 'string' && auth.token, 'session_parameters_missing'); secrets.push(auth.token);
        const payload = await request(legacy.ENDPOINTS.messages, {scene:'',
          timeSlide:{timeStamp:task.cursor,forward:task.cursor === null ? null : false,pageSize:task.page_size},
          secOwnerAccountId:resolved.owner.accountIdEncrypt,secTargetAccountId:resolved.contact.accountIdEncrypt,secTradeId,
          openRealTimeTranslation:false,contactAccountId:resolved.contact.accountId,contactAccountIdEncrypt:resolved.contact.secAccountId}, auth.token);
        // Reuse the tested normalizer, ordering, timestamp-boundary and response checks.
        const config = {schema_version:legacy.VERSION,store_key:task.store_key,targets:[{inquiry_id:task.target.inquiry_id,
          buyer_member_id:task.target.buyer_member_id}],page_size:task.page_size,max_pages:1,snapshot_at_ms:8640000000000000};
        const target = legacy.newState(config).targets[0]; target.identity = identity; target.cursor = task.cursor;
        legacy.consumePage(target, payload, config, env, secrets);
        result.rows = target.messages.slice().reverse(); result.has_more = target.pages[0].has_more;
        result.boundary_error = target.status === 'paused' ? target.stop_reason : null;
      }
    } catch (error) {
      result.rows = []; result.error = /^[a-z_0-9]+$/.test(error.code || '') ? error.code : 'unexpected_error';
    }
    result.observed_at_ms = Date.now();
    return result;
  }
  return {observe, buyerFacts, EXTRA_INFO};
});
