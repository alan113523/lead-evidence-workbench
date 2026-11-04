import {prepareExportContext} from './browser_export_fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(resolve('scripts/export_inquiries_member_bundle_browser.js'), 'utf8');

test('adds querySummary contact.loginId without exporting contact details', async () => {
  const requests = [];
  let blob;
  let button;
  let error;
  const context = {
    window: { __LEW_INQUIRY_EXPORT_CONFIG__: {
      store: 'demo', from: '2026-09-22', to: '2026-09-22', pageSize: 10,
      maxPages: 1, maxExtraRequests: 1, knownMemberInquiryIds: ['2'],
    } },
    location: { hostname: 'message.alibaba.com', pathname: '/message/default.htm' },
    document: {
      cookie: 'xman_us_t=abc&ctoken=test-ctoken&sign=y',
      scripts: [{ textContent: 'csrfTokenVal: "test-csrf"' }],
      createElement: (tag) => ({ tag, style: {}, addEventListener(_name, handler) { this.handler = handler; }, click() {}, remove() {} }),
      body: { appendChild(element) { if (element.tag === 'button') button = element; } },
    },
    fetch: async (url, options) => {
      requests.push({ url, body: new URLSearchParams(options.body) });
      if (url.includes('querySummary')) return { ok: true, json: async () => ({
        code: 200, data: { contact: { loginId: 'vn29067819423sacp', email: 'private@example.com' } },
      }) };
      return { ok: true, json: async () => ({ code: 200, data: { list: [
        [{ id: 1, secTradeId: 'secure-1', createTime: Date.parse('2026-09-22T10:00:00+08:00'), sender: { name: 'private buyer' } }],
        [{ id: 2, secTradeId: 'secure-2', createTime: Date.parse('2026-09-22T11:00:00+08:00'), sender: { name: 'other buyer' } }],
      ] } }) };
    },
    URLSearchParams,
    URL: { createObjectURL(value) { blob = value; return 'blob:local'; }, revokeObjectURL() {} },
    Blob, Date, setTimeout() {},
    console: { info() {}, error(...args) { error = args; } },
  };
  await runInNewContext(source, prepareExportContext(context,'inquiries_member_bundle'));
  assert.equal(error, undefined);
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].body.get('params')).secTradeId, 'secure-1');
  button.handler({ preventDefault() {}, stopImmediatePropagation() {} });
  const bundle = JSON.parse(await blob.text());
  assert.equal(bundle.inquiries.length, 2);
  assert.deepEqual(bundle.buyer_member_links.map((row) => [row.inquiry_id, row.buyer_member_id]),
    [['1', 'alibaba-visible-member:vn29067819423sacp']]);
  assert.equal(JSON.stringify(bundle).includes('private@example.com'), false);
  assert.equal(JSON.stringify(bundle).includes('private buyer'), false);
});
