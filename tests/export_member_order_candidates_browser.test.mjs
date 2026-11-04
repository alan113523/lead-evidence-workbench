import {prepareExportContext} from './browser_export_fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(resolve('scripts/export_member_order_candidates_browser.js'), 'utf8');

test('member search follows every page and keeps hits as unverified candidates', async () => {
  const requests = [];
  let blob;
  let button;
  let error;
  class TestURL extends URL {
    static createObjectURL(value) { blob = value; return 'blob:test'; }
    static revokeObjectURL() {}
  }
  const context = {
    window: { __LEW_ORDER_EXPORT_CONFIG__: { store: 'demo',
      buyerMemberIds: ['alibaba-visible-member:vn29067819423sacp'], pageSize: 1, maxPagesPerMember: 2 } },
    location: { hostname: 'biz.alibaba.com', pathname: '/ta/list/scene/mainList.htm' },
    document: {
      cookie: 'xman_us_t=abc&ctoken=session&sign=x; _tb_token_=tb',
      createElement: (tag) => ({ tag, style: {}, addEventListener(_name, handler) { this.handler = handler; }, click() {}, remove() {} }),
      body: { appendChild(element) { if (element.tag === 'button') button = element; } },
    },
    fetch: async (url) => {
      const query = new URL(url, 'https://biz.alibaba.com').searchParams;
      const request = JSON.parse(query.get('json'));
      requests.push(request);
      const page = request.pagination.currentPage;
      return { ok: true, json: async () => ({ code: 200, data: { pageData: {
        pagination: { currentPage: page, pageSize: 1, totalPage: 2, totalRecord: 2 },
        data: [{ baseInfo: { id: String(page), createTimestamp: Date.parse('2026-09-24T00:00:00Z') },
          statusAction: { status: { name: 'paid' } },
          paymentInfo: { currency: 'USD', totalAmount: { number: 100 } },
          buyer: { email: 'private@example.com' } }],
      } } }) };
    },
    URL: TestURL, URLSearchParams, Blob, Date, setTimeout() {},
    console: { info() {}, error(...args) { error = args; } },
  };
  await runInNewContext(source, prepareExportContext(context,'member_order_candidates'));
  assert.equal(error, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((row) => row.requests.fuzzySearchValue), ['vn29067819423sacp', 'vn29067819423sacp']);
  assert.deepEqual(requests.map((row) => row.pagination.currentPage), [1, 2]);
  button.handler({ preventDefault() {}, stopImmediatePropagation() {} });
  const bundle = JSON.parse(await blob.text());
  assert.equal(bundle.searches[0].identity_status, 'candidate_search_only');
  assert.equal(bundle.searches[0].pagination_complete, true);
  assert.deepEqual(bundle.searches[0].orders.map((row) => row.order_id), ['1', '2']);
  assert.equal(JSON.stringify(bundle).includes('private@example.com'), false);
});

test('explicit one-order sample returns known total and truthful pagination status', async () => {
  const requests = [];
  let error;
  const context = {
    window: { __LEW_ORDER_EXPORT_CONFIG__: { store: 'demo',
      buyerMemberIds: ['alibaba-visible-member:vn29067819423sacp'], pageSize: 1,
      maxPagesPerMember: 2, sampleLimit: 1, returnBundleOnly: true } },
    location: { hostname: 'biz.alibaba.com', pathname: '/ta/list/scene/mainList.htm' },
    document: { cookie: 'xman_us_t=abc&ctoken=session&sign=x; _tb_token_=tb' },
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ code: 200, data: { pageData: {
        pagination: { currentPage: 1, pageSize: 1, totalPage: context.totalPages, totalRecord: context.totalRecords },
        data: [{ baseInfo: { id: '1' } }],
      } } }) };
    },
    URL, URLSearchParams, Blob, Date,
    console: { info() {}, error(...args) { error = args; } },
  };
  context.totalPages = 2;
  context.totalRecords = 2;
  runInNewContext(source, prepareExportContext(context,'member_order_candidates'));
  const bundle = await context.window.__LEW_ORDER_EXPORT_PROMISE__;
  assert.equal(error, undefined);
  assert.equal(requests.length, 1);
  assert.equal(bundle.searches[0].sample_only, true);
  assert.equal(bundle.searches[0].pagination_complete, false);
  assert.equal(bundle.searches[0].truncation_reason, 'sample_limit');
  assert.equal(bundle.searches[0].fetched_pages, 1);
  assert.equal(bundle.searches[0].total_records, 2);
  assert.equal(bundle.searches[0].orders.length, 1);
  context.totalPages = 1;
  context.totalRecords = 1;
  runInNewContext(source, prepareExportContext(context,'member_order_candidates'));
  const complete = await context.window.__LEW_ORDER_EXPORT_PROMISE__;
  assert.equal(complete.searches[0].sample_only, true);
  assert.equal(complete.searches[0].pagination_complete, true);
  assert.equal(complete.searches[0].truncation_reason, null);
});
