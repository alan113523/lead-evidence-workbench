import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const FIELDS = new Set([
  'store_key', 'inquiry_id', 'customer_id', 'created_at', 'first_sent_at',
  'owner', 'source', 'inquiry_type', 'business_type', 'follow_up_status',
  'product_id', 'observed_at', 'source_system',
]);

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string or null`);
  return value.trim() || null;
}

function timestamp(value, name, required = false) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  const raw = requiredString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error(`${name} must include a timezone offset`);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

export function normalizeInquiry(input, expectedStore) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('row must be an object');
  const unknown = Object.keys(input).filter((key) => !FIELDS.has(key));
  if (unknown.length) throw new Error(`unsupported fields: ${unknown.join(', ')}`);
  const row = {
    store_key: requiredString(input.store_key, 'store_key'),
    inquiry_id: requiredString(input.inquiry_id, 'inquiry_id'),
    customer_id: optionalString(input.customer_id, 'customer_id'),
    created_at: timestamp(input.created_at, 'created_at', true),
    first_sent_at: timestamp(input.first_sent_at, 'first_sent_at'),
    owner: optionalString(input.owner, 'owner'),
    source: optionalString(input.source, 'source'),
    // Alibaba's feedbackType is numeric in the subject list. Preserve the
    // original code as text, including 0, for files exported before this fix.
    inquiry_type: optionalString(typeof input.inquiry_type === 'number' && Number.isSafeInteger(input.inquiry_type)
      ? String(input.inquiry_type) : input.inquiry_type, 'inquiry_type'),
    business_type: optionalString(input.business_type, 'business_type'),
    follow_up_status: optionalString(input.follow_up_status, 'follow_up_status'),
    product_id: optionalString(input.product_id, 'product_id'),
    observed_at: timestamp(input.observed_at, 'observed_at', true),
    source_system: requiredString(input.source_system, 'source_system'),
  };
  if (row.store_key !== expectedStore) throw new Error('row store_key does not match --store');
  if (row.first_sent_at && row.first_sent_at < row.created_at) {
    throw new Error('first_sent_at precedes created_at');
  }
  return row;
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS inquiry_observations (
      store_key TEXT NOT NULL,
      inquiry_id TEXT NOT NULL,
      customer_id TEXT,
      created_at TEXT NOT NULL,
      first_sent_at TEXT,
      owner TEXT,
      source TEXT,
      inquiry_type TEXT,
      business_type TEXT,
      follow_up_status TEXT,
      product_id TEXT,
      observed_at TEXT NOT NULL,
      source_system TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (store_key, inquiry_id, observed_at)
    );
    CREATE TABLE IF NOT EXISTS inquiries_current (
      store_key TEXT NOT NULL,
      inquiry_id TEXT NOT NULL,
      customer_id TEXT,
      created_at TEXT NOT NULL,
      first_sent_at TEXT,
      owner TEXT,
      source TEXT,
      inquiry_type TEXT,
      business_type TEXT,
      follow_up_status TEXT,
      product_id TEXT,
      observed_at TEXT NOT NULL,
      source_system TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (store_key, inquiry_id)
    );
    CREATE INDEX IF NOT EXISTS inquiry_customer_idx ON inquiries_current(store_key, customer_id);
    CREATE TABLE IF NOT EXISTS inquiry_customer_links (
      store_key TEXT NOT NULL,
      inquiry_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      source_system TEXT NOT NULL,
      PRIMARY KEY (store_key, inquiry_id, customer_id, observed_at)
    );
    CREATE INDEX IF NOT EXISTS inquiry_customer_link_idx ON inquiry_customer_links(store_key, customer_id);
    CREATE TABLE IF NOT EXISTS inquiry_buyer_member_links (
      store_key TEXT NOT NULL,
      inquiry_id TEXT NOT NULL,
      buyer_member_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      source_system TEXT NOT NULL,
      PRIMARY KEY (store_key, inquiry_id, buyer_member_id, observed_at)
    );
    CREATE INDEX IF NOT EXISTS inquiry_buyer_member_idx ON inquiry_buyer_member_links(store_key, buyer_member_id);
    CREATE TABLE IF NOT EXISTS inquiry_import_coverage (
      store_key TEXT NOT NULL,
      from_day TEXT NOT NULL,
      to_day_inclusive TEXT NOT NULL,
      coverage_status TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (store_key, from_day, to_day_inclusive, observed_at)
    );
    CREATE TABLE IF NOT EXISTS native_inquiry_member_records (
      store_key TEXT NOT NULL,
      source_record_id TEXT NOT NULL,
      gmt_create TEXT NOT NULL,
      buyer_member_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      source_system TEXT NOT NULL,
      PRIMARY KEY (store_key, source_record_id)
    );
    CREATE INDEX IF NOT EXISTS native_inquiry_member_idx ON native_inquiry_member_records(store_key, buyer_member_id);
    DROP VIEW IF EXISTS inquiry_observed_events;
    CREATE VIEW inquiry_observed_events AS
    WITH ordered AS (
      SELECT store_key, inquiry_id, customer_id, owner, follow_up_status, source_system,
        observed_at,
        ROW_NUMBER() OVER (PARTITION BY store_key, inquiry_id ORDER BY observed_at) AS observation_number,
        ROW_NUMBER() OVER w AS source_observation_number,
        LAG(customer_id) OVER w AS previous_customer_id,
        LAG(owner) OVER w AS previous_owner,
        LAG(follow_up_status) OVER w AS previous_follow_up_status
      FROM inquiry_observations
      WINDOW w AS (PARTITION BY store_key, inquiry_id, source_system ORDER BY observed_at)
    )
    SELECT store_key, inquiry_id, observed_at, 'first_observed' AS event_kind
      FROM ordered WHERE observation_number = 1
    UNION ALL
    SELECT store_key, inquiry_id, observed_at, 'customer_id_changed'
      FROM ordered WHERE source_observation_number > 1
        AND customer_id IS NOT previous_customer_id
    UNION ALL
    SELECT store_key, inquiry_id, observed_at, 'owner_changed'
      FROM ordered WHERE source_observation_number > 1
        AND owner IS NOT previous_owner
    UNION ALL
    SELECT store_key, inquiry_id, observed_at, 'follow_up_status_changed'
      FROM ordered WHERE source_observation_number > 1
        AND follow_up_status IS NOT previous_follow_up_status;
  `);
  return db;
}

const COLUMNS = [
  'store_key', 'inquiry_id', 'customer_id', 'created_at', 'first_sent_at',
  'owner', 'source', 'inquiry_type', 'business_type', 'follow_up_status',
  'product_id', 'observed_at', 'source_system', 'content_hash',
];

export function importRows(db, inputs, expectedStore) {
  const rows = inputs.map((input) => normalizeInquiry(input, expectedStore));
  const placeholders = COLUMNS.map(() => '?').join(', ');
  const insertObservation = db.prepare(`INSERT OR IGNORE INTO inquiry_observations (${COLUMNS.join(', ')}) VALUES (${placeholders})`);
  const insertCurrent = db.prepare(`INSERT INTO inquiries_current (${COLUMNS.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(store_key, inquiry_id) DO UPDATE SET ${COLUMNS.slice(2).map((c) => `${c}=excluded.${c}`).join(', ')}
    WHERE excluded.observed_at > inquiries_current.observed_at`);
  const getObservation = db.prepare('SELECT content_hash FROM inquiry_observations WHERE store_key=? AND inquiry_id=? AND observed_at=?');
  const getCurrent = db.prepare('SELECT observed_at FROM inquiries_current WHERE store_key=? AND inquiry_id=?');
  const result = { input: rows.length, observations_added: 0, current_updated: 0, duplicates: 0, older_observations: 0 };
  db.exec('SAVEPOINT import_rows');
  try {
    for (const row of rows) {
      const hash = createHash('sha256').update(JSON.stringify(row)).digest('hex');
      const values = COLUMNS.map((column) => column === 'content_hash' ? hash : row[column]);
      const observation = insertObservation.run(...values);
      if (!observation.changes) {
        const prior = getObservation.get(row.store_key, row.inquiry_id, row.observed_at);
        if (prior.content_hash !== hash) throw new Error('conflicting observations for the same inquiry and observed_at');
        result.duplicates++;
        continue;
      }
      result.observations_added++;
      const current = getCurrent.get(row.store_key, row.inquiry_id);
      if (current && current.observed_at > row.observed_at) result.older_observations++;
      const updated = insertCurrent.run(...values);
      result.current_updated += Number(updated.changes);
    }
    db.exec('RELEASE import_rows');
  } catch (error) {
    db.exec('ROLLBACK TO import_rows');
    db.exec('RELEASE import_rows');
    throw error;
  }
  return result;
}

export function importCustomerLinks(db, inputs, expectedStore) {
  const rows = inputs.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('row must be an object');
    const fields = ['store_key', 'inquiry_id', 'customer_id', 'observed_at', 'source_system'];
    if (Object.keys(input).some((field) => !fields.includes(field))) throw new Error('unsupported customer link fields');
    const row = {
      store_key: requiredString(input.store_key, 'store_key'),
      inquiry_id: requiredString(input.inquiry_id, 'inquiry_id'),
      customer_id: requiredString(input.customer_id, 'customer_id'),
      observed_at: timestamp(input.observed_at, 'observed_at', true),
      source_system: requiredString(input.source_system, 'source_system'),
    };
    if (row.store_key !== expectedStore) throw new Error('row store_key does not match --store');
    if (!/^alibaba-crm:[a-f0-9]{32}$/.test(row.customer_id) || row.source_system !== 'alibaba-message-detail-crm-link-v1') {
      throw new Error('customer link must use a validated Alibaba CRM detail ID');
    }
    return row;
  });
  const knownInquiry = db.prepare('SELECT 1 FROM inquiries_current WHERE store_key=? AND inquiry_id=?');
  const otherId = db.prepare('SELECT 1 FROM inquiry_customer_links WHERE store_key=? AND inquiry_id=? AND customer_id<>?');
  const insert = db.prepare('INSERT OR IGNORE INTO inquiry_customer_links VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (!knownInquiry.get(row.store_key, row.inquiry_id)) throw new Error('customer link inquiry not found in current store');
      if (otherId.get(row.store_key, row.inquiry_id, row.customer_id)) throw new Error('conflicting customer IDs for one inquiry');
      added += Number(insert.run(row.store_key, row.inquiry_id, row.customer_id, row.observed_at, row.source_system).changes);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { input: rows.length, links_added: added, duplicates: rows.length - added };
}

export function importMemberBundle(db, bundle, expectedStore) {
  if (!bundle || bundle.store_key !== expectedStore || !Array.isArray(bundle.inquiries) ||
      !Array.isArray(bundle.buyer_member_links)) throw new Error('invalid member bundle or store mismatch');
  const hasCoverage = bundle.coverage_status !== undefined;
  if (hasCoverage && (!['complete', 'sample_only'].includes(bundle.coverage_status) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(bundle.from_day || '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(bundle.to_day_inclusive || '') ||
      dateBoundary(bundle.from_day) > dateBoundary(bundle.to_day_inclusive) ||
      bundle.inquiries.some((row) => !Number.isFinite(Date.parse(row.created_at)) ||
        Date.parse(row.created_at) < dateBoundary(bundle.from_day).getTime() ||
        Date.parse(row.created_at) >= dateBoundary(bundle.to_day_inclusive).getTime() + 86400000))) {
    throw new Error('invalid member bundle coverage');
  }
  db.exec('BEGIN');
  try {
    const inquiries = importRows(db, bundle.inquiries, expectedStore);
    const buyer_member_links = importBuyerMemberLinks(db, bundle.buyer_member_links, expectedStore);
    if (hasCoverage) {
      const observedAt = bundle.observed_at || bundle.inquiries[0]?.observed_at || bundle.buyer_member_links[0]?.observed_at;
      if (!observedAt) throw new Error('bundle coverage requires an observation timestamp');
      db.prepare('INSERT OR IGNORE INTO inquiry_import_coverage VALUES (?, ?, ?, ?, ?)').run(
        expectedStore, bundle.from_day, bundle.to_day_inclusive, bundle.coverage_status, observedAt);
    }
    db.exec('COMMIT');
    return { inquiries, buyer_member_links, coverage_status: hasCoverage ? bundle.coverage_status : 'unknown' };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function importBuyerMemberLinks(db, inputs, expectedStore) {
  const rows = inputs.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('row must be an object');
    const fields = ['store_key', 'inquiry_id', 'buyer_member_id', 'observed_at', 'source_system'];
    if (Object.keys(input).some((field) => !fields.includes(field))) throw new Error('unsupported buyer member link fields');
    const row = {
      store_key: requiredString(input.store_key, 'store_key'),
      inquiry_id: requiredString(input.inquiry_id, 'inquiry_id'),
      buyer_member_id: requiredString(input.buyer_member_id, 'buyer_member_id'),
      observed_at: timestamp(input.observed_at, 'observed_at', true),
      source_system: requiredString(input.source_system, 'source_system'),
    };
    if (row.store_key !== expectedStore) throw new Error('row store_key does not match --store');
    if (!/^alibaba-visible-member:[a-z0-9]{3,64}$/i.test(row.buyer_member_id) ||
        !['alibaba-buyer-profile-visible-member-id-v1', 'alibaba-message-querySummary-contact-loginId-v1'].includes(row.source_system)) {
      throw new Error('buyer member link requires a sourced visible Alibaba membership ID');
    }
    return row;
  });
  const knownInquiry = db.prepare('SELECT 1 FROM inquiries_current WHERE store_key=? AND inquiry_id=?');
  const otherId = db.prepare('SELECT 1 FROM inquiry_buyer_member_links WHERE store_key=? AND inquiry_id=? AND buyer_member_id<>?');
  const insert = db.prepare('INSERT OR IGNORE INTO inquiry_buyer_member_links VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  db.exec('SAVEPOINT import_buyer_links');
  try {
    for (const row of rows) {
      if (!knownInquiry.get(row.store_key, row.inquiry_id)) throw new Error('buyer member link inquiry not found in current store');
      if (otherId.get(row.store_key, row.inquiry_id, row.buyer_member_id)) throw new Error('conflicting visible member IDs for one inquiry');
      added += Number(insert.run(row.store_key, row.inquiry_id, row.buyer_member_id, row.observed_at, row.source_system).changes);
    }
    db.exec('RELEASE import_buyer_links');
  } catch (error) { db.exec('ROLLBACK TO import_buyer_links'); db.exec('RELEASE import_buyer_links'); throw error; }
  return { input: rows.length, links_added: added, duplicates: rows.length - added };
}

export function importNativeInquiryMembers(db, inputs, expectedStore) {
  const rows = inputs.map((input) => {
    const fields = ['store_key', 'source_record_id', 'gmt_create', 'buyer_member_id', 'observed_at', 'source_system'];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((field) => !fields.includes(field))) throw new Error('invalid native inquiry member row');
    const row = Object.fromEntries(fields.map((field) => [field, requiredString(input[field], field)]));
    if (row.store_key !== expectedStore) throw new Error('row store_key does not match --store');
    if (!/^alibaba-native-inquiry:[a-f0-9]{64}:[1-9]\d*$/.test(row.source_record_id) ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.gmt_create) ||
        !/^alibaba-visible-member:[a-z0-9]{3,64}$/i.test(row.buyer_member_id) ||
        row.source_system !== 'alibaba-native-inquiry-xlsx-sender-member-id-v1') {
      throw new Error('invalid native inquiry member provenance');
    }
    row.observed_at = timestamp(row.observed_at, 'observed_at', true);
    return row;
  });
  const insert = db.prepare('INSERT OR IGNORE INTO native_inquiry_member_records VALUES (?, ?, ?, ?, ?, ?)');
  const previous = db.prepare('SELECT * FROM native_inquiry_member_records WHERE store_key=? AND source_record_id=?');
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const old = previous.get(row.store_key, row.source_record_id);
      if (old && (old.gmt_create !== row.gmt_create || old.buyer_member_id !== row.buyer_member_id)) {
        throw new Error('conflicting native inquiry record');
      }
      added += Number(insert.run(...['store_key', 'source_record_id', 'gmt_create', 'buyer_member_id', 'observed_at', 'source_system'].map((key) => row[key])).changes);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { input: rows.length, records_added: added, duplicates: rows.length - added };
}

function dateBoundary(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('dates must use YYYY-MM-DD');
  const date = new Date(`${day}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== day) {
    throw new Error('invalid date');
  }
  return date;
}

export function summarize(db, store, fromDay = null, toDay = null) {
  if ((fromDay === null) !== (toDay === null)) throw new Error('--from and --to must be used together');
  let start = null;
  let end = null;
  if (fromDay !== null) {
    start = dateBoundary(fromDay);
    end = dateBoundary(toDay);
    if (start > end) throw new Error('--from must not be later than --to');
    end = new Date(end.getTime() + 86400000);
  }
  return db.prepare(`SELECT COUNT(*) AS inquiries,
    COALESCE(SUM(CASE WHEN COALESCE(l.customer_id, c.customer_id) IS NULL THEN 1 ELSE 0 END), 0) AS missing_customer_id,
    COUNT(DISTINCT COALESCE(l.customer_id, c.customer_id)) AS distinct_customer_ids,
    MIN(c.created_at) AS earliest_created_at,
    MAX(c.created_at) AS latest_created_at
    FROM inquiries_current c LEFT JOIN (
      SELECT store_key, inquiry_id, MIN(customer_id) AS customer_id
      FROM inquiry_customer_links GROUP BY store_key, inquiry_id
    ) l ON l.store_key=c.store_key AND l.inquiry_id=c.inquiry_id
    WHERE c.store_key = ?
      AND (? IS NULL OR c.created_at >= ?)
      AND (? IS NULL OR c.created_at < ?)`).get(
        store, start?.toISOString() ?? null, start?.toISOString() ?? null,
        end?.toISOString() ?? null, end?.toISOString() ?? null,
      );
}

export function summarizeEvents(db, store) {
  const counts = Object.fromEntries(db.prepare(`
    SELECT event_kind, COUNT(*) AS count FROM inquiry_observed_events
    WHERE store_key = ? GROUP BY event_kind
  `).all(store).map((row) => [row.event_kind, row.count]));
  return {
    first_observed: counts.first_observed ?? 0,
    customer_id_changed: counts.customer_id_changed ?? 0,
    owner_changed: counts.owner_changed ?? 0,
    follow_up_status_changed: counts.follow_up_status_changed ?? 0,
  };
}
