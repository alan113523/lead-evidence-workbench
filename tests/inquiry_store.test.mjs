import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importRows, importCustomerLinks, importBuyerMemberLinks, importNativeInquiryMembers, importMemberBundle, openStore, summarize, summarizeEvents } from '../scripts/inquiry_store.mjs';

const row = (overrides = {}) => ({
  store_key: 'store-a', inquiry_id: 'inq-1', customer_id: 'buyer-1',
  created_at: '2026-09-22T09:00:00+08:00',
  observed_at: '2026-09-22T10:00:00+08:00',
  source_system: 'synthetic-test', follow_up_status: 'new', ...overrides,
});

test('bundle import is atomic when its member link is invalid', () => {
  const db = openStore(':memory:');
  try {
    const bundle = { store_key: 'store-a', observed_at: row().observed_at,
      from_day: '2026-09-22', to_day_inclusive: '2026-09-22', coverage_status: 'sample_only',
      inquiries: [row()], buyer_member_links: [{ store_key: 'store-a', inquiry_id: 'inq-1',
        buyer_member_id: 'invalid', observed_at: row().observed_at,
        source_system: 'alibaba-message-querySummary-contact-loginId-v1' }] };
    assert.throws(() => importMemberBundle(db, bundle, 'store-a'), /visible Alibaba membership ID/);
    for (const table of ['inquiry_observations', 'inquiries_current', 'inquiry_buyer_member_links', 'inquiry_import_coverage']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    bundle.buyer_member_links[0].buyer_member_id = 'alibaba-visible-member:example123';
    assert.equal(importMemberBundle(db, bundle, 'store-a').coverage_status, 'sample_only');
    assert.equal(db.prepare('SELECT coverage_status FROM inquiry_import_coverage').get().coverage_status, 'sample_only');
  } finally { db.close(); }
});

test('keeps stores separate, deduplicates repeats, and retains later status', () => {
  const db = openStore(':memory:');
  try {
    assert.equal(importRows(db, [row()], 'store-a').observations_added, 1);
    assert.equal(importRows(db, [row()], 'store-a').duplicates, 1);
    importRows(db, [row({ store_key: 'store-b' })], 'store-b');
    importRows(db, [row({ observed_at: '2026-09-23T10:00:00+08:00', follow_up_status: 'replied' })], 'store-a');
    assert.equal(summarize(db, 'store-a').inquiries, 1);
    assert.equal(summarize(db, 'store-b').inquiries, 1);
    assert.equal(db.prepare("SELECT follow_up_status FROM inquiries_current WHERE store_key='store-a'").get().follow_up_status, 'replied');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inquiry_observations').get().n, 3);
  } finally { db.close(); }
});

test('rejects unapproved columns and rolls back a conflicting batch', () => {
  const db = openStore(':memory:');
  try {
    assert.throws(() => importRows(db, [row({ email: 'private@example.com' })], 'store-a'), /unsupported fields/);
    assert.throws(() => importRows(db, [row(), row({ follow_up_status: 'changed' })], 'store-a'), /conflicting observations/);
    assert.equal(summarize(db, 'store-a').inquiries, 0);
    assert.throws(() => importRows(db, [row({ store_key: 'store-b' })], 'store-a'), /does not match/);
  } finally { db.close(); }
});

test('older observations do not replace current state', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [row({ observed_at: '2026-09-24T10:00:00+08:00', follow_up_status: 'replied' })], 'store-a');
    const outcome = importRows(db, [row()], 'store-a');
    assert.equal(outcome.older_observations, 1);
    assert.equal(db.prepare("SELECT follow_up_status FROM inquiries_current WHERE store_key='store-a'").get().follow_up_status, 'replied');
  } finally { db.close(); }
});

test('date summary uses inclusive Shanghai calendar days', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [
      row({ inquiry_id: 'before', created_at: '2026-09-21T23:59:59+08:00' }),
      row({ inquiry_id: 'inside', created_at: '2026-09-22T00:00:00+08:00' }),
      row({ inquiry_id: 'last', created_at: '2026-09-23T23:59:59+08:00' }),
      row({ inquiry_id: 'after', created_at: '2026-09-24T00:00:00+08:00' }),
    ], 'store-a');
    assert.equal(summarize(db, 'store-a', '2026-09-22', '2026-09-23').inquiries, 2);
    assert.throws(() => summarize(db, 'store-a', '2026-09-22'), /used together/);
  } finally { db.close(); }
});

test('accepts numeric Alibaba feedback type without losing zero', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [row({ inquiry_type: 0 })], 'store-a');
    assert.equal(db.prepare('SELECT inquiry_type FROM inquiries_current').get().inquiry_type, '0');
  } finally { db.close(); }
});

test('derives observation events in time order, including late imports', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [row({ observed_at: '2026-09-24T10:00:00+08:00', owner: 'B', follow_up_status: 'replied' })], 'store-a');
    importRows(db, [row({ owner: 'A' })], 'store-a');
    assert.deepEqual(summarizeEvents(db, 'store-a'), {
      first_observed: 1, customer_id_changed: 0, owner_changed: 1, follow_up_status_changed: 1,
    });
  } finally { db.close(); }
});

test('does not count status encoding differences between sources as events', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [row({ follow_up_status: '待跟进', source_system: 'source-a' })], 'store-a');
    importRows(db, [row({ observed_at: '2026-09-23T10:00:00+08:00', follow_up_status: 'NEW', source_system: 'source-b' })], 'store-a');
    assert.equal(summarizeEvents(db, 'store-a').follow_up_status_changed, 0);
  } finally { db.close(); }
});

test('joins a validated CRM customer link without changing the inquiry snapshot', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [row({ customer_id: null })], 'store-a');
    const link = { store_key: 'store-a', inquiry_id: 'inq-1',
      customer_id: 'alibaba-crm:0123456789abcdef0123456789abcdef',
      observed_at: '2026-09-23T10:00:00+08:00', source_system: 'alibaba-message-detail-crm-link-v1' };
    assert.equal(importCustomerLinks(db, [link], 'store-a').links_added, 1);
    assert.equal(importCustomerLinks(db, [link], 'store-a').duplicates, 1);
    assert.equal(summarize(db, 'store-a').missing_customer_id, 0);
    assert.equal(db.prepare('SELECT customer_id FROM inquiries_current').get().customer_id, null);
    assert.throws(() => importCustomerLinks(db, [{ ...link, customer_id: 'alibaba-crm:ffffffffffffffffffffffffffffffff' }], 'store-a'), /conflicting/);
  } finally { db.close(); }
});

test('caches visible buyer membership separately and rejects conflicting links', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [row({ customer_id: null })], 'store-a');
    const link = { store_key: 'store-a', inquiry_id: 'inq-1',
      buyer_member_id: 'alibaba-visible-member:vn29067819423sacp',
      observed_at: '2026-09-26T10:00:00+08:00',
      source_system: 'alibaba-buyer-profile-visible-member-id-v1' };
    assert.equal(importBuyerMemberLinks(db, [link], 'store-a').links_added, 1);
    assert.equal(importBuyerMemberLinks(db, [link], 'store-a').duplicates, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inquiry_buyer_member_links').get().n, 1);
    assert.throws(() => importBuyerMemberLinks(db, [{ ...link, buyer_member_id: 'alibaba-visible-member:us29139482927txmt' }], 'store-a'), /conflicting/);
    assert.throws(() => importBuyerMemberLinks(db, [{ ...link, store_key: 'store-b' }], 'store-a'), /does not match/);
  } finally { db.close(); }
});

test('native inquiry member records are isolated from platform inquiry IDs', () => {
  const db = openStore(':memory:');
  try {
    const source = { store_key: 'store-a', source_record_id: `alibaba-native-inquiry:${'a'.repeat(64)}:1`,
      gmt_create: '2026-09-24 20:08:15', buyer_member_id: 'alibaba-visible-member:ravish',
      observed_at: '2026-09-26T10:00:00+08:00', source_system: 'alibaba-native-inquiry-xlsx-sender-member-id-v1' };
    assert.equal(importNativeInquiryMembers(db, [source], 'store-a').records_added, 1);
    assert.equal(importNativeInquiryMembers(db, [source], 'store-a').duplicates, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inquiries_current').get().n, 0);
    assert.throws(() => importNativeInquiryMembers(db, [{ ...source, store_key: 'store-b' }], 'store-a'), /does not match/);
    assert.throws(() => importNativeInquiryMembers(db, [{ ...source, buyer_member_id: 'alibaba-visible-member:other' }], 'store-a'), /conflicting/);
  } finally { db.close(); }
});
