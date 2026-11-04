import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './inquiry_store.mjs';

export function conversionEvidenceReport(db, store) {
  if (typeof store !== 'string' || !store.trim()) throw new Error('--store is required');
  const counts = db.prepare(`
    SELECT COUNT(*) AS inquiries,
      COALESCE(SUM(CASE WHEN l.inquiry_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS crm_linked_inquiries,
      COALESCE(SUM(CASE WHEN l.inquiry_id IS NULL THEN 1 ELSE 0 END), 0) AS missing_crm_link
    FROM inquiries_current c
    LEFT JOIN (SELECT DISTINCT store_key, inquiry_id FROM inquiry_customer_links) l
      ON l.store_key=c.store_key AND l.inquiry_id=c.inquiry_id
    WHERE c.store_key=?
  `).get(store);
  return {
    store_key: store,
    ...counts,
    new_customer_assessment: 'unavailable',
    conversion_assessment: 'unavailable',
    missing_evidence: [
      'verified first contact or first customer relationship time with historical coverage',
      'individual order ID, buyer CRM ID, order time and completion status joined to this customer',
    ],
    interpretation: 'Inquiry creation, first observation, buyer registration and CRM record creation are different dates; none alone establishes a new customer. Aggregate order counts do not establish an inquiry-to-first-order link.',
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'report') throw new Error('usage: node scripts/conversion_evidence.mjs report --store verified-store-key [--db path]');
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('expected --option value pairs');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.store || Object.keys(options).some((key) => !['store', 'db'].includes(key))) {
    throw new Error('usage: node scripts/conversion_evidence.mjs report --store verified-store-key [--db path]');
  }
  const db = openStore(resolve(options.db || 'data/inquiries.sqlite'));
  try { process.stdout.write(`${JSON.stringify(conversionEvidenceReport(db, options.store), null, 2)}\n`); }
  finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
