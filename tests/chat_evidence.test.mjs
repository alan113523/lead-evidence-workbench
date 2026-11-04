import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import collector from '../scripts/alibaba_chat_collector.js';
import { acceptStep, prepare, prepareStep } from '../scripts/chat_collection.mjs';
import { bindChatEvidence, validateChatEvidence, validateChatRun } from '../lib/chat_evidence.mjs';
import {browserFixture,storeProof} from './store_binding_fixture.mjs';

const moduleName = 'lib/chat_evidence.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const put = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

function fixture(t, { targets = ['101'], members = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'okki-chat-evidence-'));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(basename(root), /^okki-chat-evidence-/);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'data'));
  browserFixture(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(dirname(join(root, moduleName)), { recursive: true });
  for (const name of ['scripts/alibaba_chat_collector.js', 'scripts/chat_collection.mjs', moduleName]) {
    copyFileSync(fileURLToPath(new URL('../' + name, import.meta.url)), join(root, name));
  }
  const source = { store_key: 'demobeta', private_name: 'SYNTHETIC_PRIVATE_COMPANY',
    inquiries: targets.map(inquiry_id => ({ store_key: 'demobeta', inquiry_id })),
    buyer_member_links: targets.map(inquiry_id => ({ store_key: 'demobeta', inquiry_id,
      buyer_member_id: `alibaba-visible-member:${members[inquiry_id] || 'buyer001'}`,
      source_system: 'alibaba-message-querySummary-contact-loginId-v1' })) };
  put(join(root, 'data/source.json'), source);
  prepare({ source: 'data/source.json', store: 'demobeta', browserMap:'data/browser-map.json', inquiryIds: targets, run: 'data/run', pageSize: 20, maxPages: 10 }, root);
  const config = json(join(root, 'data/run/config.json'));
  const message = (id, offset = 1000, extra = {}) => ({ messageId: id, sendTime: config.snapshot_at_ms - offset,
    owner: { accountId: 'seller-account' }, contact: { accountId: 'buyer-account' }, type: 1, subType: 1,
    content: 'SYNTHETIC_PRIVATE_BODY', messageType: 'rec', autoReply: 0, ...extra });
  async function accept(rows, { hasMore = false, failEndpoint, maxPages, resumeAfterReview = false } = {}) {
    prepareStep('data/run', { maxPages, resumeAfterReview }, root);
    const ticket = json(join(root, 'data/run/pending.json'));
    const previous = json(join(root, 'data/run/checkpoint.json'));
    let inquiryId;
    const environment = {
      location: { origin: 'https://message.alibaba.com', pathname: '/message/default.htm' }, AbortSignal,
      GDATA: { user: { memberId: 'synthetic-store-account' }, system: { csrfTokenKey: '_csrf_token_', csrfTokenVal: 'synthetic-csrf' } },
      document: { cookie: 'xman_us_t=abc&ctoken=synthetic-cookie&sign=x' },
      async fetch(url, options) {
        const endpoint = url.split('?')[0];
        if (endpoint === failEndpoint) return { ok: false, status: 403 };
        let body;
        if (endpoint === collector.ENDPOINTS.inquiry) {
          inquiryId = JSON.parse(options.body.get('params')).search.requestNo;
          body = { code: 200, data: { list: [[{ id: inquiryId, secTradeId: 'synthetic-sec-trade' }]] } };
        } else if (endpoint === collector.ENDPOINTS.summary) body = { code: 200, data: {
          tradeId: inquiryId, cid: 'same-conversation', contact: { accountId: 'buyer-account', loginId: members[inquiryId] || 'buyer001',
            accountIdEncrypt: 'synthetic-buyer-enc', secAccountId: 'synthetic-buyer-sec' },
          owner: { accountId: 'seller-account', accountIdEncrypt: 'synthetic-seller-enc' } } };
        else if (endpoint === collector.ENDPOINTS.session) body = { token: 'synthetic-message-token' };
        else if (endpoint === collector.ENDPOINTS.messages) body = { code: 200, data: { list: rows, hasMore } };
        else throw new Error('unexpected_endpoint');
        return { ok: true, status: 200, redirected: false, text: async () => JSON.stringify(body) };
      },
    };
    const proof = storeProof('demobeta',ticket.request_id);
    const state = await collector.step(ticket.config, previous, proof, environment);
    const response = `data/run/response-${state.revision}.json`;
    put(join(root, response), { request_id: ticket.request_id, previous_sha256: ticket.previous_sha256, store_proof:proof, state });
    acceptStep('data/run', response, root);
    return state;
  }
  const bind = (extra = {}) => bindChatEvidence({ chatRun: 'data/run', source: 'data/source.json', out: 'data/manifest.json', ...extra }, root);
  return { root, config, message, accept, bind };
}

test('URL card metadata survives an accepted chain without becoming a read attachment body', async t => {
  const f=fixture(t);
  await f.accept([f.message(1,1000,{subType:53,content:'https://workspace.alibaba.com/card?type=12&name=catalog.pdf&id=123'})]);
  const result=f.bind();
  assert.equal(result.unique_message_count,1);
  const state=json(join(f.root,'data/run/checkpoint.json'));
  assert.equal(state.targets[0].messages[0].content_status,'metadata_only');
  assert.equal(state.targets[0].messages[0].attachments[0].name,'catalog.pdf');
});

test('binds a real synthetic accepted chain and derives buyer time without publishing bodies', async t => {
  const f = fixture(t);
  await f.accept([f.message(1), f.message(2, 2000, { messageType: 'send' })]);
  const result = f.bind(), manifest = json(join(f.root, 'data/manifest.json'));
  assert.equal(result.unique_message_count, 2);
  assert.equal(result.buyer_message_count, 1);
  assert.equal(result.seller_source_unknown_count, 1);
  assert.equal(manifest.associations[0].earliest_known_buyer_message_at, new Date(f.config.snapshot_at_ms - 1000).toISOString());
  const coverage = json(join(f.root, 'data/run/coverage-1.json'));
  assert.notEqual(manifest.associations[0].earliest_known_buyer_message_at, coverage.targets[0].earliest_known_message_at);
  for (const output of [result, manifest]) {
    assert.ok(!JSON.stringify(output).includes('SYNTHETIC_PRIVATE_BODY'));
    assert.ok(!JSON.stringify(output).includes('SYNTHETIC_PRIVATE_COMPANY'));
  }
  assert.equal(manifest.historyComplete, false);
  assert.equal(manifest.humanFollowupEstablished, false);
  assert.equal(manifest.effectiveBuyerReplyEstablished, false);
  assert.equal(manifest.publicEvidence, false);
  assert.equal(result.v3_research_validation, 'not_performed');
  assert.deepEqual(f.bind(), result);
  assert.deepEqual(validateChatEvidence({ manifest: 'data/manifest.json', expectedSha256: result.manifest_sha256 }, f.root), result);
});

test('walks all receipts including overlap, a failed page and an explicitly reviewed resume', async t => {
  const f = fixture(t);
  await f.accept([f.message(1), f.message(2, 2000)], { hasMore: true });
  await f.accept([], { failEndpoint: collector.ENDPOINTS.messages });
  await f.accept([f.message(2, 2000), f.message(3, 3000)], { resumeAfterReview: true });
  const result = f.bind();
  assert.equal(result.revision, 3);
  assert.equal(result.unique_message_count, 3);
  const manifest = json(join(f.root, 'data/manifest.json'));
  assert.ok(manifest.artifactsSha256['data/run/request-2.json']);
  assert.ok(manifest.artifactsSha256['data/run/accepted-1.json']);
  assert.equal(manifest.associations[0].pages_read, 2);
});

test('a later receipt cannot edit a message already accepted on an earlier page', async t => {
  const f = fixture(t);
  await f.accept([f.message(1), f.message(2, 2000)], { hasMore: true });
  await f.accept([f.message(2, 2000), f.message(3, 3000)]);
  const file = join(f.root, 'data/run/accepted-2.json'), receipt = json(file);
  receipt.state.targets[0].messages.find(row => row.message_id === '1').text = 'changed previously accepted text';
  put(file, receipt);
  assert.throws(() => f.bind(), /previous_messages_changed/);
});

test('budget pauses are recorded as partial evidence and remain explicitly resumable', async t => {
  const f = fixture(t);
  await f.accept([f.message(1)], { hasMore: true, maxPages: 1 });
  const result = f.bind();
  assert.equal(result.chat_status, 'paused'); assert.equal(result.chat_stop_reason, 'page_budget_reached');
  assert.equal(result.history_complete, false); assert.equal(result.pages_read, 1);
  await f.accept([], { maxPages: 2 });
  const resumed = f.bind({ out: 'data/resumed-manifest.json' });
  assert.equal(resumed.chat_status, 'endpoint_exhausted'); assert.equal(resumed.history_complete, false);
  assert.throws(() => validateChatEvidence({ manifest: 'data/manifest.json' }, f.root), /unexpected_chat_chain_file|manifest_changed/);
});

for (const [name, mutate, expected] of [
  ['source', f => { const p = join(f.root, 'data/source.json'), data = json(p); data.private_name += '-changed'; put(p, data); }, /source_hash/],
  ['source proof', f => { const p = join(f.root, 'data/run/source-proof.json'), data = json(p); data.source_sha256 = 'f'.repeat(64); put(p, data); }, /source_hash/],
  ['final checkpoint', f => { const p = join(f.root, 'data/run/checkpoint.json'), data = json(p); data.session_member_id += '-changed'; put(p, data); }, /final_checkpoint/],
  ['JSONL export', f => { const p = join(f.root, 'data/run/messages-1.jsonl'), data = json(p); data.message.text += '-changed'; put(p, data); }, /message_export/],
  ['coverage export', f => { const p = join(f.root, 'data/run/coverage-1.json'), data = json(p); data.history_complete = true; put(p, data); }, /coverage_export/],
  ['ticket predecessor', f => { const p = join(f.root, 'data/run/request-1.json'), data = json(p); data.previous_sha256 = 'f'.repeat(64); put(p, data); }, /previous_state/],
  ['ticket config hash', f => { const p = join(f.root, 'data/run/request-1.json'), data = json(p); data.config_sha256 = 'f'.repeat(64); put(p, data); }, /ticket_config/],
  ['ticket collector hash', f => { const p = join(f.root, 'data/run/request-1.json'), data = json(p); data.collector_sha256 = 'f'.repeat(64); put(p, data); }, /collector_code/],
  ['accepted buyer', f => { const p = join(f.root, 'data/run/accepted-1.json'), data = json(p); data.state.targets[0].messages[0].buyer_account_id = 'wrong-buyer'; put(p, data); }, /buyer_binding/],
  ['generated page code', f => writeFileSync(join(f.root, 'data/run/step-1.browser.js'), 'unrelated script'), /generated_code/],
  ['missing chain file', f => rmSync(join(f.root, 'data/run/request-1.json')), /ENOENT/],
]) test(`rejects single-file tampering of ${name}`, async t => {
  const f = fixture(t); await f.accept([f.message(1)]); mutate(f);
  assert.throws(() => f.bind(), expected);
});

test('rejects changed source buyer even if a new source hash is supplied', async t => {
  const f = fixture(t); await f.accept([f.message(1)]);
  const sourcePath = join(f.root, 'data/source.json'), source = json(sourcePath);
  source.buyer_member_links[0].buyer_member_id = 'alibaba-visible-member:wrong001'; put(sourcePath, source);
  const proofPath = join(f.root, 'data/run/source-proof.json'), proof = json(proofPath);
  proof.source_sha256 = hash(readFileSync(sourcePath)); put(proofPath, proof);
  assert.throws(() => f.bind(), /source_buyer_binding/);
});

test('rejects old bodies without final fields, and hidden bodies cannot be restored', async t => {
  const f = fixture(t); await f.accept([f.message(1, 1000, { viewType: 3, content: 'HIDDEN_PRIVATE_BODY' })]);
  const result = f.bind(); assert.equal(result.hidden_message_count, 1);
  assert.ok(!readFileSync(join(f.root, 'data/run/messages-1.jsonl'), 'utf8').includes('HIDDEN_PRIVATE_BODY'));
  const p = join(f.root, 'data/run/checkpoint.json'), state = json(p);
  state.targets[0].messages[0].source_content = 'restored hidden message'; put(p, state);
  assert.throws(() => validateChatRun({ chatRun: 'data/run', source: 'data/source.json' }, f.root), /hidden_message_body/);
  delete state.targets[0].messages[0].source_content; put(p, state);
  assert.throws(() => validateChatRun({ chatRun: 'data/run', source: 'data/source.json' }, f.root), /source_content_required/);
});

test('deduplicates conversation messages while retaining exact multiple inquiry associations', async t => {
  const f = fixture(t, { targets: ['101', '102'] });
  const rows = [f.message(1)]; await f.accept(rows); await f.accept(rows);
  const result = f.bind(), manifest = json(join(f.root, 'data/manifest.json'));
  assert.equal(result.target_count, 2); assert.equal(result.unique_message_count, 1); assert.equal(result.buyer_message_count, 1);
  assert.deepEqual(manifest.associations.map(row => row.message_indexes), [[0], [0]]);
});

test('rejects same-conversation duplicate exports with conflicting member associations', async t => {
  const f = fixture(t, { targets: ['101', '102'], members: { '102': 'buyer002' } });
  const rows = [f.message(1)]; await f.accept(rows); await f.accept(rows);
  assert.throws(() => f.bind(), /cross_inquiry_buyer_conflict/);
});

function v3Files(f, { duplicate = false } = {}) {
  const input = { schemaVersion: 'nanyue.due-diligence-input.v3', generatedAt: new Date().toISOString(), sourceDate: '2026-10-04',
    records: [{ crmCustomerId: 'synthetic-crm-identity', buyerLoginId: 'buyer001', buyerList: {}, customerDetail: {},
      buyerHomepageStatus: 'not_collected_no_profile_link', buyerHomepage: null }] };
  const inputPath = join(f.root, 'data/input.json'); put(inputPath, input);
  const binding = { store_key: 'demobeta', inquiry_id: '101', buyer_member_id: 'alibaba-visible-member:buyer001', sourceRecordIndex: 0 };
  put(join(f.root, 'data/bindings.json'), { schemaVersion: 'alibaba.chat-evidence-bindings.v1', inputSha256: hash(readFileSync(inputPath)),
    records: duplicate ? [binding, { ...binding }] : [binding] });
  return { input: 'data/input.json', bindings: 'data/bindings.json' };
}

test('optional v3 binding locks file hash/index/login, deduplicates mapping and never certifies v3', async t => {
  const f = fixture(t); await f.accept([f.message(1)]);
  const result = f.bind(v3Files(f, { duplicate: true })), manifest = json(join(f.root, 'data/manifest.json'));
  assert.equal(result.mode, 'v3_identity_binding'); assert.equal(manifest.associations.length, 1);
  assert.equal(manifest.associations[0].sourceRecordIndex, 0);
  assert.equal(manifest.inputBinding.inputValidation, 'not_performed');
  assert.equal(manifest.inputBinding.researchValidation, 'not_performed');
  assert.deepEqual(validateChatEvidence({ manifest: 'data/manifest.json' }, f.root), result);
  put(join(f.root, 'data/input.json'), { ...json(join(f.root, 'data/input.json')), sourceDate: '2026-10-03' });
  assert.throws(() => validateChatEvidence({ manifest: 'data/manifest.json' }, f.root), /input_hash/);
});

test('v3 wrong index/login, extra mappings and omitted paired arguments are refused', async t => {
  const f = fixture(t); await f.accept([f.message(1)]);
  const options = v3Files(f), file = join(f.root, 'data/bindings.json'), original = json(file);
  for (const changed of [
    { ...original, records: [{ ...original.records[0], sourceRecordIndex: 1 }] },
    { ...original, records: [{ ...original.records[0], buyer_member_id: 'alibaba-visible-member:buyer999' }] },
    { ...original, records: [...original.records, { ...original.records[0], inquiry_id: '999' }] },
    { ...original, records: [] },
  ]) { put(file, changed); assert.throws(() => f.bind(options), /binding/); }
  put(file, original);
  assert.throws(() => f.bind({ input: options.input }), /required_together/);
  assert.throws(() => f.bind({ bindings: options.bindings }), /required_together/);
});

test('v3 login mismatch is rejected even with the correct changed input hash', async t => {
  const f = fixture(t); await f.accept([f.message(1)]);
  const options = v3Files(f), inputPath = join(f.root, 'data/input.json'), bindingsPath = join(f.root, 'data/bindings.json');
  const input = json(inputPath); input.records[0].buyerLoginId = 'buyer999'; put(inputPath, input);
  const bindings = json(bindingsPath); bindings.inputSha256 = hash(readFileSync(inputPath)); put(bindingsPath, bindings);
  assert.throws(() => f.bind(options), /v3_buyer_binding_mismatch/);
});

test('pending steps and output outside ignored data are rejected without writing', async t => {
  const f = fixture(t); await f.accept([f.message(1)], { hasMore: true });
  assert.throws(() => f.bind({ out: 'outside.json' }), /ignored_data/);
  prepareStep('data/run', {}, f.root); assert.throws(() => f.bind(), /pending_chat_step/);
});

test('later code or manifest changes invalidate a saved binding', async t => {
  const f = fixture(t); await f.accept([f.message(1)]); const result = f.bind();
  const modulePath = join(f.root, 'scripts/chat_collection.mjs'); writeFileSync(modulePath, readFileSync(modulePath, 'utf8') + '\n// changed\n');
  assert.throws(() => validateChatEvidence({ manifest: 'data/manifest.json' }, f.root), /manifest_changed/);
  const file = join(f.root, 'data/manifest.json'), manifest = json(file); manifest.publicEvidence = true; put(file, manifest);
  assert.throws(() => validateChatEvidence({ manifest: 'data/manifest.json', expectedSha256: result.manifest_sha256 }, f.root), /manifest_hash/);
});

test('CLI outputs only safe summaries and fixed failure codes', async t => {
  const f = fixture(t); await f.accept([f.message(1)]);
  const run = (...args) => spawnSync(process.execPath, [join(f.root, moduleName), ...args], { cwd: f.root, encoding: 'utf8' });
  const result = run('bind', '--chat-run', 'data/run', '--source', 'data/source.json', '--out', 'data/cli-manifest.json');
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout); assert.equal(summary.unique_message_count, 1);
  for (const value of ['SYNTHETIC_PRIVATE', 'buyer001', 'buyer-account', 'same-conversation', 'data/source.json']) assert.ok(!result.stdout.includes(value));
  const failure = run('bind', '--chat-run', 'data/private-buyer@example.test/missing', '--source', 'data/source.json', '--out', 'data/failed.json');
  assert.equal(failure.status, 1); assert.equal(failure.stdout, ''); assert.ok(!failure.stderr.includes('private-buyer'));
  assert.equal(JSON.parse(failure.stderr).status, 'chat_evidence_failed');
});
