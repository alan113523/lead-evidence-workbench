import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dimensions = new Set(['country', 'traffic_source', 'subcategory']);
const additiveMetrics = new Set(['impressions', 'clicks', 'search_impressions', 'search_clicks', 'product_related_clicks', 'inquiries', 'orders', 'ad_spend', 'revenue']);
const day = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) { throw new Error(message); }
function validDate(value) {
  if (!day.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(`invalid date: ${value}`);
}
function interval(row) {
  validDate(row.from_day); validDate(row.to_day);
  if (row.from_day > row.to_day) fail('from_day after to_day');
  return Math.round((Date.parse(`${row.to_day}T00:00:00Z`) - Date.parse(`${row.from_day}T00:00:00Z`)) / 86400000) + 1;
}
function context(row) {
  return ['store_key', 'timezone', 'metric', 'unit', 'scope', 'attribution'].map(k => row[k]).join('\u001f');
}
function verifyRow(row, index) {
  for (const key of ['store_key', 'timezone', 'metric', 'unit', 'scope', 'attribution', 'period', 'dimension', 'segment', 'from_day', 'to_day', 'source', 'status']) {
    if (typeof row[key] !== 'string' || !row[key].trim()) fail(`row ${index + 1}: missing ${key}`);
  }
  if (!['previous', 'current'].includes(row.period)) fail(`row ${index + 1}: invalid period`);
  if (!dimensions.has(row.dimension)) fail(`row ${index + 1}: invalid dimension`);
  if (!['observed', 'missing'].includes(row.status)) fail(`row ${index + 1}: invalid status`);
  if (row.status === 'observed' && (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0)) fail(`row ${index + 1}: invalid value`);
  if (row.status === 'missing' && row.value != null) fail(`row ${index + 1}: missing value must be null`);
  if (row.total_basis != null && !['independent', 'derived_from_segments'].includes(row.total_basis)) fail(`row ${index + 1}: invalid total_basis`);
  interval(row);
}

export function analyze(rows, { store, metric, dimension } = {}) {
  if (!Array.isArray(rows) || !rows.length) fail('input must contain rows');
  rows.forEach(verifyRow);
  const selected = rows.filter(r => r.store_key === store && r.metric === metric && r.dimension === dimension);
  if (!selected.length) fail('no rows for requested store, metric and dimension');
  if (!dimensions.has(dimension)) fail('invalid dimension');
  const periods = {};
  for (const period of ['previous', 'current']) {
    const group = selected.filter(r => r.period === period);
    if (!group.length) fail(`missing ${period} period`);
    const first = group[0];
    if (group.some(r => r.from_day !== first.from_day || r.to_day !== first.to_day || context(r) !== context(first))) fail(`${period}: mixed dates or metric definitions`);
    if (new Set(group.map(r => r.segment)).size !== group.length) fail(`${period}: duplicate segment`);
    periods[period] = { from_day: first.from_day, to_day: first.to_day, days: interval(first), rows: group };
  }
  const a = periods.previous, b = periods.current;
  if (a.days !== b.days) fail('period lengths differ');
  if (context(a.rows[0]) !== context(b.rows[0])) fail('metric definitions differ between periods');
  const additive = additiveMetrics.has(metric);
  const total = p => p.rows.find(r => r.segment === '__ALL__');
  const ta = total(a), tb = total(b);
  const reasons = [];
  if (!additive) reasons.push('metric_not_declared_additive');
  if (!ta || !tb || ta.status !== 'observed' || tb.status !== 'observed') reasons.push('total_missing');
  if (ta?.total_basis !== 'independent' || tb?.total_basis !== 'independent') reasons.push('total_not_independent');
  const segA = new Map(a.rows.filter(r => r.segment !== '__ALL__').map(r => [r.segment, r]));
  const segB = new Map(b.rows.filter(r => r.segment !== '__ALL__').map(r => [r.segment, r]));
  const names = [...new Set([...segA.keys(), ...segB.keys()])].sort();
  if (!names.length) reasons.push('segments_missing');
  if (names.some(n => !segA.has(n) || !segB.has(n) || segA.get(n).status !== 'observed' || segB.get(n).status !== 'observed')) reasons.push('segment_period_or_value_missing');
  const sum = p => p.rows.filter(r => r.segment !== '__ALL__' && r.status === 'observed').reduce((s, r) => s + r.value, 0);
  const tolerance = (value) => Math.max(1e-8, Math.abs(value) * 1e-8);
  if (ta?.status === 'observed' && Math.abs(sum(a) - ta.value) > tolerance(ta.value)) reasons.push('previous_segments_do_not_reconcile');
  if (tb?.status === 'observed' && Math.abs(sum(b) - tb.value) > tolerance(tb.value)) reasons.push('current_segments_do_not_reconcile');
  const reconciled = reasons.length === 0;
  const totalChange = ta?.status === 'observed' && tb?.status === 'observed' ? tb.value - ta.value : null;
  const coverage = (periodRows, segmentMap, totalRow) => {
    const observedSegments = names.filter(name => segmentMap.get(name)?.status === 'observed').length;
    const segmentSum = sum(periodRows);
    return {
      observed_segments: observedSegments,
      compared_segments: names.length,
      segment_row_coverage: names.length ? observedSegments / names.length : null,
      segment_sum: segmentSum,
      sum_to_total_ratio_diagnostic: totalRow?.status === 'observed' && totalRow.value !== 0 ? segmentSum / totalRow.value : null,
      additive_value_coverage: additive && totalRow?.status === 'observed' && totalRow.total_basis === 'independent' && totalRow.value !== 0 ? segmentSum / totalRow.value : null,
    };
  };
  return {
    store_key: store, metric, dimension, unit: a.rows[0].unit, scope: a.rows[0].scope,
    attribution: a.rows[0].attribution, timezone: a.rows[0].timezone,
    previous: { from_day: a.from_day, to_day: a.to_day, total: ta?.status === 'observed' ? ta.value : null, total_basis: ta?.total_basis ?? 'unspecified', coverage: coverage(a, segA, ta) },
    current: { from_day: b.from_day, to_day: b.to_day, total: tb?.status === 'observed' ? tb.value : null, total_basis: tb?.total_basis ?? 'unspecified', coverage: coverage(b, segB, tb) },
    total_change: totalChange, reconciled, reasons,
    segments: names.map(name => {
      const x = segA.get(name), y = segB.get(name);
      const complete = x?.status === 'observed' && y?.status === 'observed';
      const change = complete ? y.value - x.value : null;
      return { segment: name, previous: x?.status === 'observed' ? x.value : null, current: y?.status === 'observed' ? y.value : null,
        change, contribution_to_total_change: reconciled && totalChange !== 0 ? change / totalChange : null };
    }),
    sources: [...new Set(selected.map(r => r.source))].sort(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => { if (i % 2 === 0) pairs.push([arg.replace(/^--/, ''), all[i + 1]]); return pairs; }, []));
    if (!args.file || !args.store || !args.metric || !args.dimension) fail('usage: node scripts/dimension_change.mjs --file rows.json --store verified-key --metric clicks --dimension country');
    const parsed = JSON.parse(readFileSync(args.file, 'utf8'));
    process.stdout.write(`${JSON.stringify(analyze(parsed.rows ?? parsed, args), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
