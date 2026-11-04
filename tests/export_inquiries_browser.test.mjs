import {prepareExportContext} from './browser_export_fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(resolve('scripts/export_inquiries_browser.js'), 'utf8');

test('browser export paginates a dated query and saves only approved fields', async () => {
  const requests = [];
  let savedBlob;
  let downloadLink;
  let downloadButton;
  let reported;
  let error;
  const base = Date.parse('2026-09-22T10:00:00+08:00');
  const records = Array.from({ length: 23 }, (_, i) => [{
    id: 1000 + i,
    createTime: base + i * 60000,
    ownerName: 'owner',
    subject: 'Inquiry from TM',
    process: 'NEW',
    feedbackType: 0,
    sender: { name: 'private buyer name' },
  }]);
  const context = {
    location: { hostname: 'message.alibaba.com', pathname: '/message/default.htm' },
    document: {
      cookie: 'xman_us_t=abc&ctoken=test-ctoken&sign=y',
      scripts: [{ textContent: 'system: { csrfTokenVal: "test-csrf" }' }],
      createElement: (tag) => ({ tag, style: {}, addEventListener(_name, handler) { this.handler = handler; }, click() {}, remove() {} }),
      body: { appendChild(element) { if (element.tag === 'button') downloadButton = element; else downloadLink = element; } },
    },
    fetch: async (url, options) => {
      const body = new URLSearchParams(options.body);
      const query = JSON.parse(body.get('params'));
      requests.push({ url, query });
      const page = query.pagination.nextPage;
      return { ok: true, json: async () => ({ code: 200, data: { list: records.slice((page - 1) * 10, page * 10) } }) };
    },
    URLSearchParams,
    URL: { createObjectURL(blob) { savedBlob = blob; return 'blob:local-test'; }, revokeObjectURL() {} },
    Blob,
    Date,
    setTimeout() {},
    console: { info(value) { reported = value; }, error(...args) { error = args; } },
  };
  await runInNewContext(source, prepareExportContext(context,'inquiries'));
  assert.equal(error, undefined);
  downloadButton.handler({ preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(downloadLink.download, 'inquiries-demobeta-2026-09-22-to-2026-09-23.jsonl');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((r) => r.query.pagination.nextPage), [1, 2, 3]);
  assert.equal(requests[0].query.pagination.pageSize, 10);
  assert.equal(requests[0].query.search.startTime, Date.parse('2026-09-22T00:00:00+08:00'));
  assert.equal(requests[0].query.search.endTime, Date.parse('2026-09-24T00:00:00+08:00'));
  assert.equal(reported.inquiries, 23);
  assert.equal(reported.complete, true);
  const rows = (await savedBlob.text()).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 23);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'store_key', 'inquiry_id', 'customer_id', 'created_at', 'first_sent_at',
    'owner', 'source', 'inquiry_type', 'business_type', 'follow_up_status',
    'product_id', 'observed_at', 'source_system',
  ].sort());
  assert.equal(rows[0].customer_id, null);
  assert.equal(rows[0].inquiry_type, '0');
  assert.equal(JSON.stringify(rows).includes('private buyer name'), false);
});
