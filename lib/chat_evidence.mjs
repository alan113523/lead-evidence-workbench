import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import collector from '../scripts/alibaba_chat_collector.js';
import { assertNoPrivateTransport, dataPath, exportedMessages, stepScripts, bindingModulePath } from '../scripts/chat_collection.mjs';
import storeBinding from './store_binding.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'alibaba.chat-evidence-manifest.v1';
const MEMBER_PREFIX = 'alibaba-visible-member:';
const fail = code => { throw new Error(code); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : collector.canonical(value)).digest('hex');
const same = (left, right) => collector.canonical(left) === collector.canonical(right);
const exact = (value, fields, code) => check(object(value) && same(Object.keys(value).sort(), fields.split(' ').sort()), code);
const timestamp = value => check(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'invalid_evidence_timestamp');
const localName = (path, root) => relative(root, path).replaceAll('\\', '/');

function reader(root) {
  const artifacts = new Map();
  function read(path) {
    const safe = dataPath(path, root);
    check(statSync(safe).isFile() && statSync(safe).size <= 128 * 1024 * 1024, 'invalid_or_oversized_evidence_file');
    const bytes = readFileSync(safe);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('invalid_evidence_utf8'); }
    artifacts.set(localName(safe, root), hash(bytes));
    return text;
  }
  function json(path) {
    try { return JSON.parse(read(path).replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error instanceof SyntaxError) fail('invalid_evidence_json');
      throw error;
    }
  }
  return { read, json, artifacts };
}

function scope(config) {
  return { schema_version: config.schema_version, store_key: config.store_key,
    ...(config.browser_binding ? {browser_binding: config.browser_binding} : {}),
    targets: config.targets, page_size: config.page_size, snapshot_at_ms: config.snapshot_at_ms };
}

function checkState(config, state) {
  collector.validateState(config, state);
  assertNoPrivateTransport(state);
  for (const target of state.targets) {
    let cursor = null, rows = 0, duplicates = 0, newer = 0;
    target.pages.forEach((page, index) => {
      exact(page, 'page requested_cursor next_cursor row_count duplicate_count excluded_newer_count has_more observed_at', 'invalid_page_fields');
      check(page.page === index + 1 && page.requested_cursor === cursor, 'page_cursor_chain_mismatch');
      check(page.next_cursor === null || Number.isSafeInteger(page.next_cursor) && page.next_cursor > 0, 'invalid_page_cursor');
      check(page.row_count === 0 ? page.next_cursor === cursor : page.next_cursor !== null && (cursor === null || page.next_cursor <= cursor), 'page_cursor_chain_mismatch');
      check([page.duplicate_count, page.excluded_newer_count].every(n => Number.isInteger(n) && n >= 0) &&
        page.duplicate_count + page.excluded_newer_count <= page.row_count, 'invalid_page_counts');
      check(page.has_more === null || typeof page.has_more === 'boolean', 'invalid_page_end_evidence');
      check(!(page.row_count === 0 && page.has_more === true), 'invalid_page_end_evidence');
      timestamp(page.observed_at);
      rows += page.row_count; duplicates += page.duplicate_count; newer += page.excluded_newer_count;
      cursor = page.next_cursor;
    });
    check(target.cursor === cursor && target.duplicate_count === duplicates && target.excluded_newer_count === newer &&
      target.messages.length === rows - duplicates - newer, 'target_page_totals_mismatch');
    for (const [index, message] of target.messages.entries()) {
      const fields = 'message_id sent_at send_time_ms direction sender_account_id owner_account_id buyer_account_id type sub_type kind content_status source_content source_content_format content_redacted text attachments reply_source source_evidence automation_flags';
      exact(message, fields + (Object.hasOwn(message, 'account_mapping') ? ' account_mapping' : ''), 'invalid_message_fields');
      check(target.identity && message.buyer_account_id === target.identity.buyer_account_id, 'message_buyer_binding_mismatch');
      check(message.sent_at === new Date(message.send_time_ms).toISOString() &&
        (!index || target.messages[index - 1].send_time_ms <= message.send_time_ms), 'message_time_mismatch');
      check(Number.isInteger(message.type) && Number.isInteger(message.sub_type) &&
        ['buyer', 'seller', 'system'].includes(message.direction), 'message_direction_mismatch');
      check(message.type === 2 ? message.direction === 'system' && message.sender_account_id === null :
        message.direction !== 'system' && message.sender_account_id === (message.direction === 'buyer' ? message.buyer_account_id : message.owner_account_id), 'message_direction_mismatch');
      exact(message.automation_flags, 'auto_reply basic_auto_reply robot_message', 'invalid_automation_flags');
      check(Object.values(message.automation_flags).every(value => value === null || typeof value === 'boolean'), 'invalid_automation_flags');
      const markers = ['basicMessageInfo.entranceSource=sa_negotiation',
        'extParams.autoReceptionType=commonReceptionMsg+autoRcptBuyerDisplayIcon',
        'extParams.quotationType=autoQuote+rfqBuyerDisplayIcon'];
      check(message.source_evidence.every(value => markers.includes(value)) && new Set(message.source_evidence).size === message.source_evidence.length,
        'invalid_ai_source_evidence');
      check(message.reply_source === (message.type === 2 ? 'not_applicable' : message.source_evidence.length ? 'ai' : 'unknown'), 'reply_source_mismatch');
      if (message.content_status === 'recalled_or_hidden') {
        check(message.source_content === null && message.source_content_format === 'withheld' && message.text === '' &&
          message.attachments.length === 0 && message.content_redacted === false, 'hidden_message_body_present');
      } else {
        check(['read', 'unparsed_type', 'metadata_only'].includes(message.content_status) && typeof message.source_content === 'string' &&
          message.source_content_format !== 'withheld', 'source_content_required');
        if (message.content_status === 'metadata_only') {
          const card = collector.parseWorkspaceCard(message.source_content);
          check(card && card.kind === message.kind && collector.cleanText(card.text) === message.text,
            'invalid_card_metadata');
        }
        check(collector.sourceContent(message.source_content).source_content === message.source_content &&
          collector.cleanText(message.text) === message.text, 'unsanitized_message_transport');
        if (message.source_content_format === 'json') {
          let content; try { content = JSON.parse(message.source_content); } catch { fail('invalid_source_content_json'); }
          check(object(content) || Array.isArray(content), 'invalid_source_content_json');
        }
      }
    }
  }
  return state;
}

function transition(previous, next, config) {
  check(next.revision === previous.revision + 1 && next.pages_read >= previous.pages_read &&
    next.pages_read <= previous.pages_read + 1, 'invalid_receipt_transition');
  const active = previous.targets.findIndex(target => target.status !== 'endpoint_exhausted');
  check(active >= 0 && previous.pages_read < config.max_pages, 'unexpected_receipt_after_stop');
  check(previous.targets[active].status !== 'paused' || config.resume_after_review === true, 'unreviewed_chat_resume');
  if (previous.session_member_id) check(next.session_member_id === previous.session_member_id, 'chat_session_changed');
  for (let index = 0; index < previous.targets.length; index++) {
    const old = previous.targets[index], current = next.targets[index];
    if (index !== active) { check(same(old, current), 'inactive_target_changed'); continue; }
    check(same(current.pages.slice(0, old.pages.length), old.pages), 'previous_pages_changed');
    const messages = new Map(current.messages.map(message => [message.message_id, message]));
    check(old.messages.every(message => same(messages.get(message.message_id), message)), 'previous_messages_changed');
    check(!old.identity || same(old.identity, current.identity), 'previous_identity_changed');
    check(current.pages.length - old.pages.length === next.pages_read - previous.pages_read, 'page_transition_mismatch');
    if (next.pages_read === previous.pages_read) {
      check(current.status === 'paused' && same(current.messages, old.messages) && current.cursor === old.cursor &&
        current.duplicate_count === old.duplicate_count && current.excluded_newer_count === old.excluded_newer_count, 'invalid_failed_step');
    }
  }
  exact(next.last_step, 'stage request_count store_verified_at', 'missing_step_observation');
  const counts = { resolve_inquiry: 1, resolve_buyer: 2, message_session: 3, read_page: 4 };
  check(next.last_step.request_count === counts[next.last_step.stage], 'invalid_step_observation');
  timestamp(next.last_step.store_verified_at);
  if (next.pages_read > previous.pages_read) check(next.last_step.stage === 'read_page', 'page_without_read_step');
  const allEnded = next.targets.every(target => target.status === 'endpoint_exhausted');
  const target = next.targets[active];
  const expectedStatus = allEnded ? 'endpoint_exhausted' : target.status === 'paused' || next.pages_read >= config.max_pages ? 'paused' : 'ready';
  const expectedReason = target.status === 'paused' && target.stop_reason ? target.stop_reason : expectedStatus === 'paused' ? 'page_budget_reached' : null;
  check(next.status === expectedStatus && next.stop_reason === expectedReason, 'chat_stop_status_mismatch');
}

function coverageFor(state, messages) {
  return { ...collector.summary(state), unique_message_count: messages.length,
    targets: state.targets.map(target => ({ inquiry_id: target.inquiry_id, identity: target.identity,
      status: target.status, stop_reason: target.stop_reason, pages: target.pages, duplicate_count: target.duplicate_count,
      earliest_known_message_at: target.messages[0]?.sent_at ?? null,
      latest_known_message_at: target.messages.at(-1)?.sent_at ?? null })) };
}

/** Private result. Never print this object or use its messages as public research sources. */
export function validateChatRun({ chatRun, source }, root = projectRoot) {
  const run = dataPath(chatRun, root), sourcePath = dataPath(source, root), read = reader(root);
  check(!existsSync(dataPath(join(run, 'pending.json'), root)), 'pending_chat_step_must_be_resolved');
  const config = collector.validateConfig(read.json(join(run, 'config.json')));
  const checkpoint = checkState(config, read.json(join(run, 'checkpoint.json')));
  check(checkpoint.revision > 0 && checkpoint.revision <= 1000, 'no_or_excessive_accepted_receipts');
  const bundle = read.json(sourcePath), proof = read.json(join(run, 'source-proof.json'));
  exact(proof, 'source_sha256 created_at', 'invalid_source_proof');
  timestamp(proof.created_at);
  check(proof.source_sha256 === read.artifacts.get(localName(sourcePath, root)), 'chat_source_hash_mismatch');
  check(bundle?.store_key === config.store_key && Array.isArray(bundle.inquiries) && Array.isArray(bundle.buyer_member_links), 'chat_source_scope_mismatch');
  for (const target of config.targets) {
    const inquiries = bundle.inquiries.filter(row => row.store_key === config.store_key && row.inquiry_id === target.inquiry_id);
    const links = bundle.buyer_member_links.filter(row => row.store_key === config.store_key && row.inquiry_id === target.inquiry_id);
    check(inquiries.length === 1 && links.length === 1 && links[0].source_system === 'alibaba-message-querySummary-contact-loginId-v1' &&
      links[0].buyer_member_id === target.buyer_member_id, 'chat_source_buyer_binding_mismatch');
  }
  for (const name of readdirSync(run)) {
    const match = /^(?:request|accepted)-(\d+)\.json$/.exec(name);
    if (match) check(String(Number(match[1])) === match[1] && Number(match[1]) >= 1 && Number(match[1]) <= checkpoint.revision, 'unexpected_chat_chain_file');
  }
  const collectorText = readFileSync(join(root, 'scripts/alibaba_chat_collector.js'), 'utf8');
  const collectorHash = hash(collectorText);
  let previous, lastConfig;
  for (let revision = 1; revision <= checkpoint.revision; revision++) {
    const ticket = read.json(join(run, `request-${revision}.json`));
    exact(ticket, 'request_id previous_sha256 config_sha256 collector_sha256 previous_revision config' + (config.browser_binding ? ' binding_sha256' : ''), 'invalid_chat_ticket');
    collector.validateConfig(ticket.config);
    check(ticket.config.resume_after_review === undefined || typeof ticket.config.resume_after_review === 'boolean', 'invalid_chat_ticket_config');
    check(same(scope(ticket.config), scope(config)) && hash(ticket.config) === ticket.config_sha256, 'chat_ticket_config_mismatch');
    check(ticket.collector_sha256 === collectorHash, 'chat_collector_code_changed');
    check(typeof ticket.request_id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(ticket.request_id), 'invalid_chat_request_id');
    previous ??= collector.newState(ticket.config);
    check(ticket.previous_revision === previous.revision && ticket.previous_sha256 === hash(previous), 'chat_previous_state_mismatch');
    const bindingText = config.browser_binding ? readFileSync(join(root, bindingModulePath), 'utf8') : '';
    if (config.browser_binding) check(hash(bindingText) === ticket.binding_sha256, 'chat_binding_code_changed');
    const {expression, identityExpression} = stepScripts(ticket, previous, collectorText, bindingText);
    check(read.read(join(run, `step-${revision}.browser.js`)) === expression &&
      read.read(join(run, `identity-${revision}.browser.js`)) === identityExpression, 'chat_generated_code_mismatch');
    const receipt = read.json(join(run, `accepted-${revision}.json`));
    exact(receipt, 'request_id previous_sha256 state' + (config.browser_binding ? ' store_proof' : ''), 'invalid_chat_receipt');
    if (config.browser_binding) storeBinding.proof(receipt.store_proof, config.store_key, config.browser_binding, ticket.request_id, false);
    assertNoPrivateTransport(receipt);
    check(receipt.request_id === ticket.request_id && receipt.previous_sha256 === ticket.previous_sha256, 'chat_receipt_ticket_mismatch');
    const state = checkState(ticket.config, receipt.state);
    transition(previous, state, ticket.config);
    previous = state; lastConfig = ticket.config;
  }
  check(same(checkpoint, previous) && same(config, lastConfig), 'chat_final_checkpoint_mismatch');
  const messages = exportedMessages(checkpoint);
  for (const row of messages) for (const inquiryId of row.inquiry_ids) {
    const target = checkpoint.targets.find(target => target.inquiry_id === inquiryId);
    check(target?.buyer_member_id === row.buyer_member_id && target.identity?.conversation_id === row.conversation_id &&
      target.identity?.buyer_account_id === row.message.buyer_account_id, 'cross_inquiry_buyer_conflict');
  }
  const expectedJsonl = messages.map(message => collector.canonical(message)).join('\n') + (messages.length ? '\n' : '');
  check(read.read(join(run, `messages-${checkpoint.revision}.jsonl`)) === expectedJsonl, 'chat_message_export_mismatch');
  check(same(read.json(join(run, `coverage-${checkpoint.revision}.json`)), coverageFor(checkpoint, messages)), 'chat_coverage_export_mismatch');
  return { run: localName(run, root), source: localName(sourcePath, root), sourcePreparedAt: proof.created_at,
    config, checkpoint, messages, artifacts: Object.fromEntries([...read.artifacts].sort(([a], [b]) => a.localeCompare(b))) };
}

function buildManifest(options, root) {
  const verified = validateChatRun(options, root), { checkpoint, messages } = verified;
  const read = reader(root), v3 = options.input !== undefined && options.input !== null;
  check(v3 === (options.bindings !== undefined && options.bindings !== null), 'v3_input_and_bindings_required_together');
  let inputBinding = null;
  const mapping = new Map();
  if (v3) {
    const inputPath = dataPath(options.input, root), bindingsPath = dataPath(options.bindings, root);
    const input = read.json(inputPath), bindings = read.json(bindingsPath);
    check(input?.schemaVersion === 'nanyue.due-diligence-input.v3' && Array.isArray(input.records), 'invalid_v3_binding_input');
    exact(bindings, 'schemaVersion inputSha256 records', 'invalid_v3_bindings');
    check(bindings.schemaVersion === 'alibaba.chat-evidence-bindings.v1' &&
      bindings.inputSha256 === read.artifacts.get(localName(inputPath, root)) && Array.isArray(bindings.records), 'v3_binding_input_hash_mismatch');
    const crmIds = new Set(), logins = new Set();
    for (const record of input.records) {
      check(typeof record?.crmCustomerId === 'string' && record.crmCustomerId.trim() === record.crmCustomerId && record.crmCustomerId &&
        typeof record.buyerLoginId === 'string' && record.buyerLoginId.trim() === record.buyerLoginId && record.buyerLoginId &&
        !/[,，]$/.test(record.buyerLoginId) && !crmIds.has(record.crmCustomerId) && !logins.has(record.buyerLoginId), 'invalid_v3_binding_identity');
      crmIds.add(record.crmCustomerId); logins.add(record.buyerLoginId);
    }
    for (const binding of bindings.records) {
      exact(binding, 'store_key inquiry_id buyer_member_id sourceRecordIndex', 'invalid_v3_binding_record');
      const target = checkpoint.targets.find(target => binding.store_key === checkpoint.store_key &&
        binding.inquiry_id === target.inquiry_id && binding.buyer_member_id === target.buyer_member_id);
      check(target && Number.isInteger(binding.sourceRecordIndex) && binding.sourceRecordIndex >= 0 && binding.sourceRecordIndex < input.records.length &&
        `${MEMBER_PREFIX}${input.records[binding.sourceRecordIndex].buyerLoginId}` === target.buyer_member_id, 'v3_buyer_binding_mismatch');
      const key = binding.inquiry_id;
      check(!mapping.has(key) || same(mapping.get(key), binding), 'conflicting_v3_binding');
      mapping.set(key, binding);
    }
    check(mapping.size === checkpoint.targets.length, 'v3_chat_bindings_incomplete');
    inputBinding = { input: localName(inputPath, root), bindings: localName(bindingsPath, root),
      inputSha256: bindings.inputSha256, inputValidation: 'not_performed', researchValidation: 'not_performed' };
  }
  const associations = checkpoint.targets.map(target => {
    const buyerMessages = target.messages.filter(message => message.direction === 'buyer');
    return { store_key: checkpoint.store_key, inquiry_id: target.inquiry_id, buyer_member_id: target.buyer_member_id,
      sourceRecordIndex: mapping.get(target.inquiry_id)?.sourceRecordIndex ?? null, identity: target.identity,
      status: target.status, stop_reason: target.stop_reason, pages_read: target.pages.length,
      earliest_known_buyer_message_at: buyerMessages[0]?.sent_at ?? null,
      latest_known_buyer_message_at: buyerMessages.at(-1)?.sent_at ?? null,
      message_indexes: messages.flatMap((message, index) => message.inquiry_ids.includes(target.inquiry_id) ? [index] : []) };
  });
  const codeSha256 = Object.fromEntries(['scripts/alibaba_chat_collector.js', 'scripts/chat_collection.mjs',
    ...(checkpoint.browser_binding ? [bindingModulePath, 'lib/store_browser.mjs'] : []),
    'lib/chat_evidence.mjs'].map(name => [name, hash(readFileSync(join(root, name)))]));
  return { schemaVersion: SCHEMA, status: 'chat_evidence_bound', mode: v3 ? 'v3_identity_binding' : 'local',
    chatRun: verified.run, source: verified.source, sourcePreparedAt: verified.sourcePreparedAt,
    revision: checkpoint.revision, chatStatus: checkpoint.status, chatStopReason: checkpoint.stop_reason,
    pagesRead: checkpoint.pages_read, artifactsSha256: { ...verified.artifacts, ...Object.fromEntries(read.artifacts) }, codeSha256,
    inputBinding, associations, messageCount: messages.length,
    buyerMessageCount: messages.filter(row => row.message.direction === 'buyer').length,
    aiMessageCount: messages.filter(row => row.message.reply_source === 'ai').length,
    sellerSourceUnknownCount: messages.filter(row => row.message.direction === 'seller' && row.message.reply_source === 'unknown').length,
    hiddenMessageCount: messages.filter(row => row.message.content_status === 'recalled_or_hidden').length,
    historyComplete: false, publicEvidence: false, humanFollowupEstablished: false, effectiveBuyerReplyEstablished: false,
    assurance: 'Local file, identity and append-only receipt consistency; not proof of API authenticity, complete company history, human follow-up, payment or v3 research completion.' };
}

function summary(manifest, manifestHash) {
  return { status: manifest.status, mode: manifest.mode, revision: manifest.revision,
    chat_status: manifest.chatStatus, chat_stop_reason: manifest.chatStopReason, pages_read: manifest.pagesRead,
    target_count: manifest.associations.length, unique_message_count: manifest.messageCount,
    buyer_message_count: manifest.buyerMessageCount, ai_message_count: manifest.aiMessageCount,
    seller_source_unknown_count: manifest.sellerSourceUnknownCount, hidden_message_count: manifest.hiddenMessageCount,
    history_complete: false, public_evidence: false, human_followup_established: false,
    effective_buyer_reply_established: false, v3_research_validation: 'not_performed', manifest_sha256: manifestHash };
}

export function bindChatEvidence(options, root = projectRoot) {
  const out = dataPath(options.out, root), manifest = buildManifest(options, root);
  check(!Object.hasOwn(manifest.artifactsSha256, localName(out, root)), 'manifest_would_overwrite_evidence');
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (existsSync(out)) check(readFileSync(out, 'utf8') === text, 'existing_chat_manifest_conflict');
  else { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  return summary(manifest, hash(readFileSync(out)));
}

export function validateChatEvidence({ manifest: file, expectedSha256 }, root = projectRoot) {
  const read = reader(root), path = dataPath(file, root), manifest = read.json(path);
  if (expectedSha256 !== undefined) check(read.artifacts.get(localName(path, root)) === expectedSha256, 'chat_manifest_hash_mismatch');
  check(manifest?.schemaVersion === SCHEMA && ['local', 'v3_identity_binding'].includes(manifest.mode), 'invalid_chat_manifest');
  const expected = buildManifest({ chatRun: manifest.chatRun, source: manifest.source,
    input: manifest.inputBinding?.input, bindings: manifest.inputBinding?.bindings }, root);
  check(same(manifest, expected), 'chat_manifest_changed');
  return summary(manifest, read.artifacts.get(localName(path, root)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2), options = {};
    const names = { '--chat-run': 'chatRun', '--source': 'source', '--out': 'out', '--input': 'input', '--bindings': 'bindings',
      '--manifest': 'manifest', '--expected-sha256': 'expectedSha256' };
    for (let index = 0; index < args.length; index += 2) {
      check(names[args[index]] && args[index + 1] && !args[index + 1].startsWith('--') && !Object.hasOwn(options, names[args[index]]), 'invalid_chat_evidence_argument');
      options[names[args[index]]] = args[index + 1];
    }
    check(action === 'bind' || action === 'validate', 'use_bind_or_validate');
    const allowed = action === 'bind' ? ['chatRun', 'source', 'out', 'input', 'bindings'] : ['manifest', 'expectedSha256'];
    check(Object.keys(options).every(key => allowed.includes(key)), 'invalid_chat_evidence_argument');
    console.log(JSON.stringify(action === 'bind' ? bindChatEvidence(options) : validateChatEvidence(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'chat_evidence_failed', error: /^[a-z_]+$/.test(error.message) ? error.message : 'local_chat_evidence_error' }));
    process.exitCode = 1;
  }
}
