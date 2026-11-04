import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../scripts/dimension_change.mjs';

function row(period, segment, value, extra = {}) {
  return { store_key: 'test-store', timezone: 'Asia/Shanghai', metric: 'clicks', unit: 'count', scope: 'all-store', attribution: 'visit-day',
    period, dimension: 'country', segment, from_day: period === 'previous' ? '2026-09-01' : '2026-09-08',
    to_day: period === 'previous' ? '2026-09-07' : '2026-09-14', source: 'synthetic fixture', status: 'observed', value, ...extra };
}
test('reconciled dimensions explain total change', () => {
  const rows = [row('previous', '__ALL__', 10, { total_basis: 'independent' }), row('previous', 'A', 6), row('previous', 'B', 4),
    row('current', '__ALL__', 15, { total_basis: 'independent' }), row('current', 'A', 9), row('current', 'B', 6)];
  const result = analyze(rows, { store: 'test-store', metric: 'clicks', dimension: 'country' });
  assert.equal(result.reconciled, true);
  assert.equal(result.total_change, 5);
  assert.equal(result.previous.coverage.segment_row_coverage, 1);
  assert.equal(result.previous.coverage.additive_value_coverage, 1);
  assert.deepEqual(result.segments.map(s => s.contribution_to_total_change), [0.6, 0.4]);
});
test('missing or unmatched coverage cannot explain totals', () => {
  const rows = [row('previous', '__ALL__', 10, { total_basis: 'independent' }), row('previous', 'A', 10), row('current', '__ALL__', 15, { total_basis: 'independent' }), row('current', 'A', 9)];
  const result = analyze(rows, { store: 'test-store', metric: 'clicks', dimension: 'country' });
  assert.equal(result.reconciled, false);
  assert.equal(result.segments[0].contribution_to_total_change, null);
  assert.equal(result.current.coverage.additive_value_coverage, 0.6);
  assert.ok(result.reasons.includes('current_segments_do_not_reconcile'));
});
test('rates are not additively explained', () => {
  const rows = [row('previous', '__ALL__', 0.1), row('previous', 'A', 0.1), row('current', '__ALL__', 0.2), row('current', 'A', 0.2)]
    .map(r => ({ ...r, metric: 'conversion_rate', unit: 'ratio' }));
  const result = analyze(rows, { store: 'test-store', metric: 'conversion_rate', dimension: 'country' });
  assert.equal(result.reconciled, false);
  assert.ok(result.reasons.includes('metric_not_declared_additive'));
});
test('mixed attribution is rejected', () => {
  assert.throws(() => analyze([row('previous', '__ALL__', 1), row('current', '__ALL__', 1, { attribution: 'inquiry-day' })],
    { store: 'test-store', metric: 'clicks', dimension: 'country' }), /metric definitions differ/);
});
test('distinct visitors can change by segment without additive contribution', () => {
  const rows = [row('previous', '__ALL__', 10), row('previous', 'A', 6), row('current', '__ALL__', 12), row('current', 'A', 8)]
    .map(r => ({ ...r, metric: 'visitors' }));
  const result = analyze(rows, { store: 'test-store', metric: 'visitors', dimension: 'country' });
  assert.equal(result.reconciled, false);
  assert.equal(result.segments[0].change, 2);
  assert.equal(result.segments[0].contribution_to_total_change, null);
  assert.equal(result.previous.coverage.additive_value_coverage, null);
});
test('row-derived total never establishes independent reconciliation', () => {
  const rows = [row('previous', '__ALL__', 10, { total_basis: 'derived_from_segments' }), row('previous', 'A', 10),
    row('current', '__ALL__', 12, { total_basis: 'derived_from_segments' }), row('current', 'A', 12)];
  const result = analyze(rows, { store: 'test-store', metric: 'clicks', dimension: 'country' });
  assert.equal(result.reconciled, false);
  assert.ok(result.reasons.includes('total_not_independent'));
  assert.equal(result.current.coverage.additive_value_coverage, null);
  assert.equal(result.segments[0].change, 2);
  assert.equal(result.segments[0].contribution_to_total_change, null);
});
