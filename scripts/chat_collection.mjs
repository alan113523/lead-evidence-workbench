import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import collector from './alibaba_chat_collector.js';
import storeBinding from '../lib/store_binding.js';
import { browserModule } from '../lib/store_browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const bindingModulePath = 'lib/store_binding.js';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : collector.canonical(value)).digest('hex');
const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
function within(base, path) { const r = relative(base, path); return r === '' || !r.startsWith('..') && !isAbsolute(r); }
export function dataPath(input, projectRoot = root) {
  requireThat(typeof input === 'string' && input.length > 0, 'path_required');
  const base = resolve(projectRoot, 'data'), path = resolve(projectRoot, input);
  requireThat(path !== base && within(base, path), 'files_must_be_inside_ignored_data');
  let current = path;
  while (current !== resolve(projectRoot) && current !== dirname(current)) {
    if (existsSync(current)) {
      requireThat(!lstatSync(current).isSymbolicLink(), 'symlink_not_allowed');
      requireThat(within(resolve(projectRoot), realpathSync(current)), 'path_escapes_project');
    }
    current = dirname(current);
  }
  return path;
}
function createJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
function exactJson(path, value) {
  if (existsSync(path)) {
    try { requireThat(hash(readJson(path)) === hash(value), 'existing_artifact_conflict'); return; }
    catch (e) { if (e.message === 'existing_artifact_conflict') throw e; }
  }
  exactText(path, JSON.stringify(value, null, 2) + '\n');
}
function exactText(path, text) {
  if (existsSync(path)) {
    const old = readFileSync(path), expected = Buffer.from(text, 'utf8');
    if (old.equals(expected)) return;
    requireThat(old.length < expected.length && expected.subarray(0,old.length).equals(old), 'existing_artifact_conflict');
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); renameSync(tmp, path);
}
function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  createJson(tmp, value); renameSync(tmp, path);
}
export function prepare({ source, store, inquiryIds, run, browserMap, channel, pageSize = 20, maxPages = 5 }, projectRoot = root) {
  const sourcePath = dataPath(source, projectRoot), runPath = dataPath(run, projectRoot), bundle = readJson(sourcePath);
  requireThat(!existsSync(runPath), 'run_already_exists');
  const browserBinding = storeBinding.resolve(readJson(dataPath(browserMap, projectRoot)), store, channel);
  requireThat(bundle.store_key === store && Array.isArray(bundle.inquiries) && Array.isArray(bundle.buyer_member_links), 'invalid_source_bundle');
  requireThat(Array.isArray(inquiryIds) && inquiryIds.length && new Set(inquiryIds).size === inquiryIds.length, 'explicit_unique_inquiry_ids_required');
  const targets = inquiryIds.map(inquiryId => {
    requireThat(bundle.inquiries.filter(t => t.inquiry_id === inquiryId && t.store_key === store).length === 1, 'inquiry_not_in_source');
    const links = bundle.buyer_member_links.filter(t => t.inquiry_id === inquiryId && t.store_key === store);
    requireThat(links.length === 1 && links[0].source_system === 'alibaba-message-querySummary-contact-loginId-v1', 'verified_buyer_link_required');
    return { inquiry_id: inquiryId, buyer_member_id: links[0].buyer_member_id };
  });
  const config = collector.validateConfig({ schema_version: collector.VERSION, store_key: store, browser_binding: browserBinding, targets,
    page_size: Number(pageSize), max_pages: Number(maxPages), snapshot_at_ms: Date.now() });
  mkdirSync(runPath, { recursive: true, mode: 0o700 });
  createJson(join(runPath, 'config.json'), config);
  createJson(join(runPath, 'source-proof.json'), { source_sha256: hash(readFileSync(sourcePath, 'utf8')), created_at: new Date().toISOString() });
  const state = collector.newState(config);
  createJson(join(runPath, 'checkpoint.json'), state);
  return { run: runPath, ...collector.summary(state) };
}
export function prepareStep(run, { maxPages, resumeAfterReview = false } = {}, projectRoot = root) {
  const runPath = dataPath(run, projectRoot), config = readJson(join(runPath, 'config.json'));
  requireThat(config.browser_binding, 'legacy_run_unbound_create_store_bound_run');
  storeBinding.binding(config.browser_binding);
  const previous = collector.validateState(config, readJson(join(runPath, 'checkpoint.json')));
  const pendingPath = join(runPath, 'pending.json');
  if (existsSync(pendingPath)) {
    const ticket = readJson(pendingPath);
    requireThat(maxPages === undefined && !resumeAfterReview, 'pending_step_exists_accept_or_inspect_first');
    requireThat(ticket.previous_sha256 === hash(previous) && ticket.previous_revision === previous.revision &&
      hash(ticket.config) === ticket.config_sha256, 'pending_scope_changed');
    return writeStepScripts(runPath, ticket, previous, projectRoot, true);
  }
  requireThat(previous.status !== 'endpoint_exhausted', 'already_exhausted');
  if (maxPages !== undefined) { config.max_pages = Number(maxPages); collector.validateConfig(config); }
  requireThat(previous.pages_read < config.max_pages, 'page_budget_reached_use_explicit_higher_budget');
  const target = previous.targets.find(t => t.status !== 'endpoint_exhausted');
  requireThat(target.status !== 'paused' || resumeAfterReview, 'review_required_before_resume');
  config.resume_after_review = resumeAfterReview;
  const source = readFileSync(join(projectRoot, 'scripts/alibaba_chat_collector.js'), 'utf8');
  const ticket = { request_id: randomUUID(), previous_sha256: hash(previous), config_sha256: hash(config), collector_sha256: hash(source),
    binding_sha256: hash(readFileSync(join(projectRoot, bindingModulePath), 'utf8')),
    previous_revision: previous.revision, config };
  atomicJson(pendingPath, ticket);
  return writeStepScripts(runPath, ticket, previous, projectRoot, false);
}
function writeStepScripts(runPath, ticket, previous, projectRoot, reused) {
  const source = readFileSync(join(projectRoot, 'scripts/alibaba_chat_collector.js'), 'utf8');
  requireThat(hash(source) === ticket.collector_sha256, 'pending_collector_changed');
  const config = ticket.config;
  const bindingText = config.browser_binding ? readFileSync(join(projectRoot, bindingModulePath), 'utf8') : '';
  if (config.browser_binding) requireThat(hash(bindingText) === ticket.binding_sha256, 'pending_binding_code_changed');
  const {expression, identityExpression} = stepScripts(ticket, previous, source, bindingText);
  exactText(join(runPath, `step-${previous.revision + 1}.browser.js`), expression);
  exactText(join(runPath, `identity-${previous.revision + 1}.browser.js`), identityExpression);
  return { script: join(runPath, `step-${previous.revision + 1}.browser.js`), next_revision: previous.revision + 1,
    identity_script: join(runPath, `identity-${previous.revision + 1}.browser.js`), browser_binding: config.browser_binding,
    planned_max_pages: config.max_pages, request_id: ticket.request_id, reused_pending: reused };
}
export function stepScripts(ticket, previous, source, bindingText = '') {
  const config = ticket.config, bound = config.browser_binding;
  const guard = bound ? browserModule(bindingText) + `storeBinding.proof(storeProof,${JSON.stringify(config.store_key)},${JSON.stringify(bound)},${JSON.stringify(ticket.request_id)});\n` : '';
  const expression = `(async function(storeProof) {\n${guard}const module = {exports:{}};\n${source}\n` +
    `const state = await module.exports.step(${JSON.stringify(config)},${JSON.stringify(previous)},storeProof);\n` +
    `return {request_id:${JSON.stringify(ticket.request_id)},previous_sha256:${JSON.stringify(ticket.previous_sha256)},${bound ? 'store_proof:storeProof,' : ''}state};\n})`;
  const identityExpression = bound ? `(async function() {\n${browserModule(bindingText)}return storeBinding.probe(${JSON.stringify(bound)},${JSON.stringify(ticket.request_id)},${JSON.stringify(config.store_key)});\n})()` :
    `(async function() {\nconst module={exports:{}};\n${source}\nreturn await module.exports.verifyStore(${JSON.stringify(config.store_key)});\n})()`;
  return {expression, identityExpression};
}
const bannedKey = /^(?:ctoken|chatToken|token|_csrf|_csrf_token_|cookie|authorization|secTradeId|accountIdEncrypt|secAccountId|extInfo|originExt|raw)$/i;
export function assertNoPrivateTransport(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    requireThat(!bannedKey.test(key), 'transport_or_raw_fields_in_result');
    assertNoPrivateTransport(child);
  }
}
export function exportedMessages(state) {
  const byKey = new Map();
  for (const t of state.targets) for (const m of t.messages) {
    const key = JSON.stringify([state.store_key, t.identity.conversation_id, m.message_id]);
    if (byKey.has(key)) {
      const old = byKey.get(key);
      requireThat(collector.canonical(old.message) === collector.canonical(m), 'cross_inquiry_message_conflict');
      old.inquiry_ids.push(t.inquiry_id);
    } else byKey.set(key, { schema_version: collector.VERSION, store_key: state.store_key,
      conversation_id: t.identity.conversation_id, buyer_member_id: t.buyer_member_id, inquiry_ids: [t.inquiry_id], message: m });
  }
  return [...byKey.values()].sort((a,b) => a.message.send_time_ms - b.message.send_time_ms || a.message.message_id.localeCompare(b.message.message_id));
}
export function acceptStep(run, responsePath, projectRoot = root) {
  const runPath = dataPath(run, projectRoot), file = dataPath(responsePath, projectRoot);
  const receipt = readJson(file), previous = readJson(join(runPath, 'checkpoint.json'));
  const currentConfig = readJson(join(runPath, 'config.json'));
  collector.validateState(currentConfig, previous);
  requireThat(receipt && typeof receipt === 'object' && receipt.state && typeof receipt.state === 'object', 'stale_or_mismatched_receipt');
  requireThat(Object.keys(receipt).every(k=>['request_id','previous_sha256','store_proof','state'].includes(k)), 'unexpected_receipt_fields');
  assertNoPrivateTransport(receipt);
  const pending = join(runPath, 'pending.json');
  if (!existsSync(pending)) {
    const saved = join(runPath, `accepted-${previous.revision}.json`);
    requireThat(existsSync(saved) && hash(readJson(saved)) === hash(receipt) && hash(previous) === hash(receipt.state), 'no_matching_pending_step');
    return { ...collector.summary(previous), unique_message_count: exportedMessages(previous).length, already_accepted: true };
  }
  const ticket = readJson(pending);
  const checkpointWritten = hash(previous) === hash(receipt.state) &&
    existsSync(join(runPath, `accepted-${previous.revision}.json`)) &&
    hash(readJson(join(runPath, `accepted-${previous.revision}.json`))) === hash(receipt);
  requireThat((hash(previous) === ticket.previous_sha256 || checkpointWritten) && receipt.previous_sha256 === ticket.previous_sha256 &&
    receipt.request_id === ticket.request_id, 'stale_or_mismatched_receipt');
  requireThat(hash(ticket.config) === ticket.config_sha256, 'pending_config_changed');
  requireThat(currentConfig.store_key === ticket.config.store_key &&
    collector.canonical(currentConfig.browser_binding) === collector.canonical(ticket.config.browser_binding), 'pending_browser_binding_changed');
  if (ticket.config.browser_binding) storeBinding.proof(receipt.store_proof, ticket.config.store_key,
    ticket.config.browser_binding, ticket.request_id, false);
  const state = collector.validateState(ticket.config, receipt.state);
  requireThat(state.revision === ticket.previous_revision + 1 && (checkpointWritten || state.pages_read >= previous.pages_read &&
    state.pages_read <= previous.pages_read + 1), 'invalid_transition');
  // The result is an append-only transition; never lose a successful previous page.
  for (let i = 0; i < previous.targets.length; i++) {
    const old = previous.targets[i], next = state.targets[i];
    requireThat(collector.canonical(next.pages.slice(0, old.pages.length)) === collector.canonical(old.pages), 'previous_pages_changed');
    const messages = new Map(next.messages.map(m => [m.message_id, m]));
    for (const m of old.messages) requireThat(collector.canonical(messages.get(m.message_id)) === collector.canonical(m), 'previous_messages_changed');
    if (old.identity) requireThat(collector.canonical(old.identity) === collector.canonical(next.identity), 'previous_identity_changed');
  }
  assertNoPrivateTransport(state);
  const messages = exportedMessages(state);
  const receiptFile = join(runPath, `accepted-${state.revision}.json`);
  exactJson(receiptFile, receipt);
  // Immutable receipt is the recovery source if a process ends during export/rename.
  exactText(join(runPath, `messages-${state.revision}.jsonl`), messages.map(r => collector.canonical(r)).join('\n') + (messages.length ? '\n' : ''));
  exactJson(join(runPath, `coverage-${state.revision}.json`), { ...collector.summary(state),
    unique_message_count: messages.length, targets: state.targets.map(t => ({ inquiry_id: t.inquiry_id, identity: t.identity,
      status: t.status, stop_reason: t.stop_reason, pages: t.pages, duplicate_count: t.duplicate_count,
      earliest_known_message_at: t.messages[0]?.sent_at ?? null, latest_known_message_at: t.messages.at(-1)?.sent_at ?? null })) });
  atomicJson(join(runPath, 'config.json'), ticket.config);
  atomicJson(join(runPath, 'checkpoint.json'), state);
  renameSync(join(runPath, 'pending.json'), join(runPath, `request-${state.revision}.json`));
  return { ...collector.summary(state), unique_message_count: messages.length,
    messages_file: join(runPath, `messages-${state.revision}.jsonl`), checkpoint_file: join(runPath, 'checkpoint.json') };
}
function argumentsMap(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; requireThat(key.startsWith('--'), 'invalid_argument');
    if (key === '--resume-after-review') values[key] = true;
    else { requireThat(args[i+1] && !args[i+1].startsWith('--'), 'argument_value_required'); values[key] = args[++i]; }
  }
  return values;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2), a = argumentsMap(args);
    let result;
    if (action === 'prepare') result = prepare({ source: a['--source'], store: a['--store'], inquiryIds: a['--inquiry']?.split(','),
      run: a['--run'], browserMap: a['--browser-map'], channel: a['--channel'], pageSize: a['--page-size'] ?? 20, maxPages: a['--max-pages'] ?? 5 });
    else if (action === 'next') result = prepareStep(a['--run'], { maxPages: a['--max-pages'], resumeAfterReview: a['--resume-after-review'] === true });
    else if (action === 'accept') result = acceptStep(a['--run'], a['--response']);
    else if (action === 'status') result = collector.summary(readJson(join(dataPath(a['--run']), 'checkpoint.json')));
    else throw new Error('use_prepare_next_accept_or_status');
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    // Raw network errors, paths with private IDs, and response bodies never go to logs.
    const code = /^[a-z_]+$/.test(e.message) ? e.message : 'local_workflow_error';
    console.error(JSON.stringify({ error: code })); process.exitCode = 1;
  }
}
