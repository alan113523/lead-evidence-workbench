import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { importRows, importCustomerLinks, importBuyerMemberLinks, importNativeInquiryMembers, importMemberBundle, openStore, summarize, summarizeEvents } from './inquiry_store.mjs';

function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('expected --option value pairs');
    values[args[i].slice(2)] = args[i + 1];
  }
  return values;
}

function shanghaiBoundary(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('date must use YYYY-MM-DD');
  const instant = new Date(`${day}T00:00:00+08:00`);
  if (Number.isNaN(instant.getTime()) || new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 10) !== day) {
    throw new Error('invalid date');
  }
  return instant;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = options(rest);
  if (!['import', 'import-customer-links', 'import-buyer-member-links', 'import-native-members', 'import-member-bundle', 'member-cache', 'summary', 'events-summary'].includes(command) || !args.store) {
    throw new Error('usage: node scripts/inquiries.mjs import|import-customer-links|import-buyer-member-links|import-native-members --file path.jsonl --store verified-store-key [--db path] | import-member-bundle --file path.json --store verified-store-key [--db path] | member-cache|summary|events-summary --store verified-store-key [--db path]');
  }
  const dbPath = resolve(args.db || 'data/inquiries.sqlite');
  let rows;
  if (command === 'import' || command === 'import-customer-links' || command === 'import-buyer-member-links' || command === 'import-native-members') {
    if (!args.file) throw new Error('import requires --file');
    rows = readFileSync(args.file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`invalid JSON on line ${index + 1}`); }
    });
  }
  let bundle;
  if (command === 'import-member-bundle') {
    if (!args.file) throw new Error('import-member-bundle requires --file');
    bundle = JSON.parse(readFileSync(args.file, 'utf8'));
    if (bundle.store_key !== args.store || !Array.isArray(bundle.inquiries) || !Array.isArray(bundle.buyer_member_links)) {
      throw new Error('invalid member bundle or store mismatch');
    }
  }
  if (command === 'member-cache' && ((args.from === undefined) !== (args.to === undefined))) {
    throw new Error('member-cache requires --from and --to together');
  }
  const db = openStore(dbPath);
  try {
    const output = command === 'import'
      ? importRows(db, rows, args.store)
      : command === 'import-customer-links'
      ? importCustomerLinks(db, rows, args.store)
      : command === 'import-buyer-member-links'
      ? importBuyerMemberLinks(db, rows, args.store)
      : command === 'import-native-members'
      ? importNativeInquiryMembers(db, rows, args.store)
      : command === 'import-member-bundle'
      ? importMemberBundle(db, bundle, args.store)
      : command === 'member-cache'
      ? { store_key: args.store, knownMemberInquiryIds: (() => {
          const start = args.from ? shanghaiBoundary(args.from) : null;
          const end = args.to ? shanghaiBoundary(args.to) : null;
          if (start && start > end) throw new Error('--from must not be later than --to');
          return db.prepare(`SELECT DISTINCT l.inquiry_id FROM inquiry_buyer_member_links l
            JOIN inquiries_current i ON i.store_key=l.store_key AND i.inquiry_id=l.inquiry_id
            WHERE l.store_key=? AND (? IS NULL OR i.created_at>=?) AND (? IS NULL OR i.created_at<?)
            ORDER BY l.inquiry_id`).all(args.store, start?.toISOString() ?? null, start?.toISOString() ?? null,
              end?.toISOString() ?? null, end ? new Date(end.getTime() + 86400000).toISOString() : null)
            .map((row) => row.inquiry_id);
        })() }
      : command === 'events-summary'
      ? { store_key: args.store, event_time_semantics: 'observed_at; actual platform occurrence time unknown', ...summarizeEvents(db, args.store) }
      : {
          store_key: args.store,
          timezone: 'Asia/Shanghai',
          from_day: args.from ?? null,
          to_day_inclusive: args.to ?? null,
          ...summarize(db, args.store, args.from ?? null, args.to ?? null),
        };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
