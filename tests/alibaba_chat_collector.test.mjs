import test from 'node:test';
import assert from 'node:assert/strict';
import collector from '../scripts/alibaba_chat_collector.js';
const now = Date.now();
const config = (extra = {}) => ({ schema_version: collector.VERSION, store_key: 'demobeta',
  targets: [{ inquiry_id: '101', buyer_member_id: 'alibaba-visible-member:buyer001' }],
  page_size: 2, max_pages: 5, snapshot_at_ms: now, ...extra });
const identity = { conversation_id: 'conv-1', buyer_account_id: 'buyer-1', owner_account_id: 'seller-1' };
const message = (n, time = now - n * 1000, extra = {}) => ({ messageId: n, sendTime: time, owner: { accountId: 'seller-1' },
  contact: { accountId: 'buyer-1' }, type: 1, subType: 1, content: `Synthetic message ${n}`, messageType: 'send', autoReply: 0, ...extra });
const page = (rows, extra = {}) => ({ code: '200', data: { list: rows, ...extra } });
const target = () => ({ ...collector.newState(config()).targets[0], identity });
const consume = (t, rows, extra = {}) => collector.consumePage(t, page(rows,extra), config());
function environment(pages, { failEndpoint, wrongBuyer = false } = {}) {
  const requests = [];
  const env = { location: { origin: 'https://message.alibaba.com', pathname: '/message/default.htm' },
    GDATA: { user: { memberId: 'store-account' }, system: { csrfTokenKey: '_csrf_token_', csrfTokenVal: 'synthetic-csrf-value' } },
    document: { cookie: 'xman_us_t=abc&ctoken=synthetic-cookie-value&sign=x' }, AbortSignal,
    async fetch(url, options) {
      const endpoint = url.split('?')[0], body = Object.fromEntries(options.body);
      requests.push({ endpoint, options, body });
      if (failEndpoint === endpoint) return { ok: false, status: 403, json: async () => ({ credential: 'not-output' }) };
      let json;
      if (endpoint === collector.ENDPOINTS.inquiry) json = { code: 200, data: { list: [[{ id: 101, secTradeId: 'synthetic-sec-trade-id' }]] } };
      else if (endpoint === collector.ENDPOINTS.summary) json = { code: 200, data: { tradeId: 101, cid: 'conv-1',
        contact: { accountId: 'buyer-1', loginId: wrongBuyer ? 'other001' : 'buyer001', accountIdEncrypt: 'enc-buyer', secAccountId: 'sec-buyer' },
        owner: { accountId: 'seller-1', accountIdEncrypt: 'enc-seller' } } };
      else if (endpoint === collector.ENDPOINTS.session) json = { token: 'synthetic-onetalk-token' };
      else if (endpoint === collector.ENDPOINTS.messages) json = pages.shift();
      else throw new Error('unknown_endpoint');
      return { ok: true, status: 200, redirected: false, text: async () => JSON.stringify(json) };
    } };
  return { env, requests };
}
const proof = () => ({ store_host: 'demobeta.en.alibaba.com', source_url: collector.IDENTITY_ENDPOINT, observed_at_ms: Date.now() });
test('raw content scrubs relative URLs and private locator assignments while preserving product parameters',()=>{
  const content='<a href="//files.invalid/file?productId=42&token=synthetic-token">file</a> secTradeId="synthetic-trade" accountIdEncrypt=synthetic-encrypt';
  const clean=collector.sourceContent(content);
  assert.ok(!clean.source_content.includes('synthetic-token'));assert.ok(!clean.source_content.includes('synthetic-trade'));
  assert.ok(!clean.source_content.includes('synthetic-encrypt'));assert.ok(clean.source_content.includes('productId=42'));
  assert.equal(clean.content_redacted,true);
  assert.ok(!collector.cleanText('/file?signature=synthetic-sign&productId=43').includes('synthetic-sign'));
  for(const text of ['价格 USD/吨','Packing A/B#123','<b>重量/公斤</b>','/产品?productId=43#detail'])assert.equal(collector.cleanText(text),text);
});
test('session switch while a message request is in flight stops without accepting that page',async()=>{
  const {env}=environment([page([message(1)])]),fetch=env.fetch;
  env.fetch=async(url,options)=>{const response=await fetch(url,options);if(url===collector.ENDPOINTS.messages)env.GDATA.user.memberId='another-account';return response;};
  const s=await collector.step(config(),collector.newState(config()),proof(),env);
  assert.equal(s.stop_reason,'session_changed');assert.equal(s.pages_read,0);assert.equal(s.targets[0].messages.length,0);
});
test('legacy workspace card read timestamps do not create conflicting message versions', () => {
  const card = 'https://workspace.alibaba.com/card?type=100010&name=catalogue&ctime=';
  const a = collector.normalizeMessage(message(1, undefined, { subType: 100010, content: card + '1000' }), identity);
  const b = collector.normalizeMessage(message(1, undefined, { subType: 100010, content: card + '2000' }), identity);
  assert.deepEqual(a, b);
  assert.equal(a.content_redacted, true);
  assert.match(a.source_content, /name=catalogue/);
  assert.notEqual(a.source_content, collector.sourceContent(card.replace('catalogue', 'changed') + '2000').source_content);
  assert.match(collector.safeUrl('https://example.invalid/card?ctime=1000'), /ctime=1000/);
  assert.match(collector.safeUrl('https://workspace.alibaba.com/other?ctime=1000'), /ctime=1000/);
});
test('actual encrypted request locators are removed when repeated in message content',async()=>{
  const {env}=environment([page([message(1,undefined,{content:'enc-buyer enc-seller sec-buyer'})])]);
  const s=await collector.step(config(),collector.newState(config()),proof(),env);
  assert.equal(s.targets[0].messages[0].source_content,'[redacted] [redacted] [redacted]');
});
test('two pages overlap safely, short page requires a further empty response', () => {
  const t = target(); consume(t, [message(1),message(2)]); consume(t, [message(2),message(3)]);
  assert.equal(t.messages.length, 3); assert.equal(t.duplicate_count, 1);
  consume(t, [message(4)]); assert.equal(t.status, 'collecting');
  consume(t, []); assert.equal(t.status, 'endpoint_exhausted'); assert.equal(t.stop_reason, 'empty_page');
});
test('explicit server end is recorded separately', () => {
  const t = target(); consume(t, [message(1)], { hasMore: false });
  assert.equal(t.stop_reason, 'explicit_end');
});
test('successful empty data object is an observed endpoint end, preserving earlier messages', async () => {
  const { env } = environment([page([message(1)]), { code: '200', data: {} }]);
  const first = await collector.step(config(), collector.newState(config()), proof(), env);
  const ended = await collector.step(config(), first, proof(), env);
  assert.equal(ended.status, 'endpoint_exhausted');
  assert.equal(ended.pages_read, 2);
  assert.deepEqual(ended.targets[0].messages, first.targets[0].messages);
  assert.equal(ended.targets[0].pages.at(-1).row_count, 0);
  assert.equal(collector.summary(ended).history_complete, false);
});
test('missing or malformed message data is still rejected without changing accepted pages', () => {
  const t = target(); consume(t, [message(1)]); const before = JSON.stringify(t);
  for (const payload of [{ code: '200' }, { code: '200', data: null }, { code: '200', data: [] },
    { code: '500', data: {} }, { code: '200', data: { list: null } },
    { code: '200', data: { hasMore: true } }, { code: '200', data: { error: 'synthetic' } }]) {
    assert.throws(() => collector.consumePage(t, payload, config()), /invalid_message_response/);
    assert.equal(JSON.stringify(t), before);
  }
});
test('empty response is not a successful end when server says more', () => {
  assert.throws(() => consume(target(), [], { hasMore: true }), /empty_page_with_more/);
});
test('same timestamp full boundary and non-decreasing cursor pause', () => {
  const t = target(); consume(t, [message(1,now-1000),message(2,now-1000)]);
  assert.equal(t.stop_reason, 'timestamp_boundary_ambiguous');
  const s = target(); consume(s,[message(1)]); consume(s,[message(1)]); assert.equal(s.stop_reason, 'cursor_stalled');
});
test('conflicts, malformed message, reversed order and newer-than-cursor do not commit a page', () => {
  const t = target(); consume(t,[message(1),message(2)]); const before = JSON.stringify(t);
  assert.throws(()=>consume(t,[message(2,undefined,{content:'changed'})]), /conflicting_duplicate/);
  assert.equal(JSON.stringify(t),before);
  assert.throws(()=>consume(t,[message(3),message(4,undefined,{messageId:Number.MAX_SAFE_INTEGER+1})]), /unsafe_id/);
  assert.equal(JSON.stringify(t),before);
  assert.throws(()=>consume(target(),[message(2),message(1)]), /unordered_page/);
  assert.throws(()=>consume(t,[message(1)]), /cursor_out_of_range/);
  assert.throws(()=>consume(target(),[message(1),message(1)]), /duplicate_within_page/);
});
test('snapshot excludes newly arrived messages while retaining pagination cursor', () => {
  const t = target(); consume(t,[message(1,now+1000),message(2)]);
  assert.equal(t.messages.length,1); assert.equal(t.excluded_newer_count,1); assert.equal(t.cursor,now-2000);
});
test('message direction follows API send/rec and system type, with actual per-message owner', () => {
  const m = collector.normalizeMessage(message(1,undefined,{owner:{accountId:'prior-owner'}}),identity);
  assert.equal(m.sender_account_id,'prior-owner'); assert.equal(m.reply_source,'unknown');
  assert.equal(collector.normalizeMessage(message(2,undefined,{messageType:'rec'}),identity).direction,'buyer');
  assert.equal(collector.normalizeMessage(message(3,undefined,{type:2}),identity).reply_source,'not_applicable');
  assert.throws(()=>collector.normalizeMessage(message(1,undefined,{contact:{accountId:'wrong'}}),identity), /message_buyer_mismatch/);
});
test('absence or false automated flags and mobile client never imply human', () => {
  const m = message(1,undefined,{extInfo:{icbuData:{robotMessage:false,extend:JSON.stringify({basicMessageInfo:{autoReply:false,clientInfo:'iOS'}})}}});
  assert.equal(collector.sourceEvidence(m).reply_source,'unknown');
  assert.equal(collector.sourceEvidence({...m,autoReply:1}).reply_source,'unknown');
});
test('AI label requires official marker predicate, and evidence excludes raw extend', () => {
  const make = b => message(1,undefined,{extInfo:{icbuData:{extend:JSON.stringify({basicMessageInfo:b})}}});
  assert.equal(collector.sourceEvidence(make({extParams:{autoReceptionType:'commonReceptionMsg'}})).reply_source,'unknown');
  for (const b of [{entranceSource:'sa_negotiation'},
    {extParams:{autoReceptionType:'commonReceptionMsg',autoRcptBuyerDisplayIcon:'known-key'}},
    {extParams:{quotationType:'autoQuote',rfqBuyerDisplayIcon:'known-key'}}]) {
    const m = collector.normalizeMessage(make({...b,chatToken:'never-export-this'}),identity);
    assert.equal(m.reply_source,'ai'); assert.ok(!JSON.stringify(m).includes('never-export-this'));
  }
});
test('attachment cards are allowlisted, credentials and signed links are removed', () => {
  const m=collector.normalizeMessage(message(1,undefined,{subType:61,content:JSON.stringify({name:'sample.pdf',size:200,
    url:'https://files.example.test/file.pdf?token=private#secret',chatToken:'private',unknown:'business-detail'})}),identity);
  assert.equal(m.kind,'file'); assert.equal(m.attachments[0].url,'https://files.example.test/file.pdf');
  assert.ok(!JSON.stringify(m).includes('private'));
  assert.equal(JSON.parse(m.source_content).unknown,'business-detail');assert.equal(m.content_redacted,true);
  assert.equal(collector.safeUrl('javascript:alert(1)'),null);
  assert.equal(collector.safeUrl('https://user:password@example.test/a'),null);
  assert.ok(!collector.cleanText('chatToken="secret-value" {"authorization":"secret2"} token: foo').includes('secret'));
});

test('workspace URL envelopes expose metadata without claiming attachment bodies were read', () => {
  for (const [type,subType,kind] of [[12,61,'file'],[12,53,'file'],[13,60,'image'],[14,62,'video'],[6,50,'inquiry_card'],[2019,100010,'card'],[2028,100010,'product_card']]) {
    const content=`https://workspace.alibaba.com/card?type=${type}&name=GRASSE%20OIL.pdf&orgSize=123&token=secret-value&ctime=99`;
    const m=collector.normalizeMessage(message(1,undefined,{subType,content}),identity);
    assert.equal(m.kind,kind);assert.equal(m.content_status,'metadata_only');
    assert.equal(m.text,'GRASSE OIL.pdf');assert.equal(m.attachments[0].name,'GRASSE OIL.pdf');
    assert.equal(m.attachments[0].size_bytes,123);
    assert.ok(!JSON.stringify(m).includes('secret-value'));assert.ok(!m.attachments[0].url.includes('ctime='));
    assert.match(m.attachments[0].url,/workspace\.alibaba\.com\/card/);
    const hidden=collector.normalizeMessage(message(1,undefined,{subType,content,viewType:3}),identity);
    assert.equal(hidden.content_status,'recalled_or_hidden');assert.deepEqual(hidden.attachments,[]);
  }
  const unnamed=collector.parseWorkspaceCard('https://workspace.alibaba.com/card?type=13&id=123');
  assert.equal(unnamed.text,'');assert.equal(unnamed.attachments[0].name,null);
  assert.equal(unnamed.attachments[0].size_bytes,null);
});

test('workspace decoder rejects unrelated and ambiguous cards; unknown numeric types stay metadata only', () => {
  for(const url of ['https://workspace.alibaba.com.evil.test/card?type=13','https://workspace.alibaba.com/other?type=13',
    'https://workspace.alibaba.com/card?type=unknown','https://workspace.alibaba.com/card?type=12&type=13',
    'javascript:alert(1)','https://user:pass@workspace.alibaba.com/card?type=13'])
    assert.equal(collector.parseWorkspaceCard(url),null);
  const c=collector.parseWorkspaceCard('https://workspace.alibaba.com/card?type=12&name=%E7%9B%AE%E5%BD%95%2B2026.pdf&size=9007199254740992');
  assert.equal(c.text,'目录+2026.pdf');assert.equal(c.attachments[0].size_bytes,null);
  const unknown=collector.parseWorkspaceCard('https://workspace.alibaba.com/card?type=999');
  assert.equal(unknown.kind,'card');assert.equal(unknown.content_status,'metadata_only');assert.equal(unknown.text,'');
});
test('original content preserves business fields, markup and ordinary URL parameters',()=>{
  const content=JSON.stringify({productId:'p1',quantity:20,other:{requirement:'Keep this full text'},chatToken:'secret',url:'https://example.test/item?id=123&token=secret'});
  const preserved=collector.sourceContent(content);const body=JSON.parse(preserved.source_content);
  assert.equal(body.quantity,20);assert.equal(body.other.requirement,'Keep this full text');assert.equal(body.chatToken,undefined);
  assert.equal(body.url,'https://example.test/item?id=123');assert.equal(preserved.content_redacted,true);
  assert.equal(collector.sourceContent('<b>Bold</b>').source_content,'<b>Bold</b>');
});
test('recalled/hidden body is not exported, unknown types remain marked',()=>{
  const m=collector.normalizeMessage(message(1,undefined,{viewType:3,content:'do not retain hidden content'}),identity);
  assert.equal(m.text,'');assert.equal(m.content_status,'recalled_or_hidden');
  assert.equal(collector.normalizeMessage(message(2,undefined,{subType:999}),identity).content_status,'unparsed_type');
});
test('one step uses four exact read endpoints, resumes from checkpoint without credentials', async()=>{
  const c=config(), {env,requests}=environment([page([message(1),message(2)]),page([])]);
  const s1=await collector.step(c,collector.newState(c),proof(),env);
  assert.equal(s1.pages_read,1);assert.equal(s1.status,'ready');
  const s2=await collector.step(c,s1,proof(),env);
  assert.equal(s2.status,'endpoint_exhausted');assert.equal(collector.summary(s2).history_complete,false);
  const q=JSON.parse(requests.at(-1).body.params);assert.equal(q.timeSlide.timeStamp,now-2000);assert.equal(q.timeSlide.forward,false);
  assert.ok(requests.every(r=>Object.values(collector.ENDPOINTS).includes(r.endpoint)&&r.options.redirect==='error'));
  assert.ok(!JSON.stringify(s2).includes('synthetic-onetalk-token'));assert.ok(!JSON.stringify(s2).includes('synthetic-sec-trade-id'));
});
test('HTTP 403, invalid business response and buyer mismatch stop without empty success', async()=>{
  const c=config();
  for(const opts of [{failEndpoint:collector.ENDPOINTS.messages},{wrongBuyer:true},{}]){
    const {env,requests}=environment([{code:501,data:{list:[]}}],opts);
    const s=await collector.step(c,collector.newState(c),proof(),env);
    assert.equal(s.status,'paused');assert.equal(s.pages_read,0);assert.equal(s.targets[0].messages.length,0);
    assert.ok(!requests.some(r=>/readstatus|markRead|send|reply/.test(r.endpoint)));
    await assert.rejects(()=>collector.step(c,s,proof(),env),/review_required/);
  }
});
test('fresh store proof, message origin, session identity and scope are gates', async()=>{
  const c=config(), {env,requests}=environment([page([message(1)])]);
  await assert.rejects(()=>collector.step(c,collector.newState(c),{...proof(),store_host:'demogamma.en.alibaba.com'},env),/verification/);
  await assert.rejects(()=>collector.step(c,collector.newState(c),{...proof(),observed_at_ms:now-600000},env),/verification/);
  const s=await collector.step(c,collector.newState(c),proof(),env); env.GDATA.user.memberId='different';
  await assert.rejects(()=>collector.step(c,s,proof(),env),/session_changed/);
  assert.throws(()=>collector.validateState({...c,store_key:'demogamma'},s),/scope_mismatch/);
  assert.equal(requests.length,4);
});
test('budget stops before extra requests and prior data remains usable', async()=>{
  const c=config({max_pages:1}), {env,requests}=environment([page([message(1)])]);
  const s=await collector.step(c,collector.newState(c),proof(),env);
  assert.equal(s.stop_reason,'page_budget_reached');assert.equal(s.targets[0].messages.length,1);
  await assert.rejects(()=>collector.step(c,s,proof(),env),/page_budget_reached/);assert.equal(requests.length,4);
});
test('CDP-reordered object keys preserve identity and overlap dedup on resume', async()=>{
  const c=config(),{env}=environment([page([message(1),message(2)]),page([message(2),message(3)])]);
  const s=await collector.step(c,collector.newState(c),proof(),env);
  const transported=JSON.parse(collector.canonical(s));
  const next=await collector.step(c,transported,proof(),env);
  assert.equal(next.status,'ready');assert.equal(next.targets[0].messages.length,3);assert.equal(next.targets[0].duplicate_count,1);
});
test('non-JSON login/challenge responses stop with safe diagnostic codes',async()=>{
  for(const [body,code] of [['<html>passport login</html>','login_required'],['<html>x5sec captcha</html>','site_challenge'],['bad-data','non_json_response']]){
    const c=config(),{env}=environment([]);env.fetch=async()=>({ok:true,status:200,text:async()=>body});
    const s=await collector.step(c,collector.newState(c),proof(),env);
    assert.equal(s.stop_reason,code);assert.equal(s.pages_read,0);assert.ok(!JSON.stringify(s).includes(body));
  }
});
test('unknown checkpoint fields and arbitrary endpoint configuration are rejected',()=>{
  const c=config(),s=collector.newState(c);
  assert.throws(()=>collector.validateConfig({...c,url:'https://example.test'}),/unexpected_result_fields/);
  assert.throws(()=>collector.validateState(c,{...s,raw:{chatToken:'secret'}}),/unexpected_result_fields/);
});
test('live identity reads the seller profile API in its own origin and rejects wrong shop',async()=>{
  const env={location:{origin:'https://i.alibaba.com'},AbortSignal,fetch:async(url,options)=>{
    assert.equal(url,collector.IDENTITY_ENDPOINT);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({minisite:'//demobeta.en.alibaba.com/',componyName:'Synthetic company'})};
  }};
  const p=await collector.verifyStore('demobeta',env);assert.equal(p.store_host,'demobeta.en.alibaba.com');
  assert.ok(!JSON.stringify(p).includes('Synthetic company'));
  await assert.rejects(()=>collector.verifyStore('demogamma',env),/store_identity_mismatch/);
});
