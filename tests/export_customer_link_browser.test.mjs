import {prepareExportContext} from './browser_export_fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(resolve('scripts/export_customer_link_browser.js'), 'utf8');

test('exports only namespaced CRM ID and matching inquiry ID', async () => {
  let blob;
  let download;
  let button;
  let reported;
  class TestURL extends URL {
    static createObjectURL(value) { blob = value; return 'blob:local'; }
    static revokeObjectURL() {}
  }
  const context = {
    location: { hostname: 'message.alibaba.com', pathname: '/message/maDetail.htm',
      href: 'https://message.alibaba.com/message/maDetail.htm?imInquiryId=123' },
    document: {
      querySelectorAll: () => [{ href: 'https://alicrm.alibaba.com/crmpage/customer_detail?customerId=0123456789abcdef0123456789abcdef' }],
      createElement: (tag) => ({ tag, style: {}, addEventListener(_name, handler) { this.handler = handler; }, click() {}, remove() {} }),
      body: { appendChild(element) { if (element.tag === 'button') button = element; else download = element; } },
    },
    URL: TestURL,
    Blob, Date, setTimeout() {}, console: { info(value) { reported = value; } },
  };
  runInNewContext(source, prepareExportContext(context,'customer_link'));
  button.handler({ preventDefault() {}, stopImmediatePropagation() {} });
  const row = JSON.parse((await blob.text()).trim());
  assert.equal(download.download, 'customer-link-demobeta-123.jsonl');
  assert.deepEqual(Object.keys(row).sort(), ['store_key', 'inquiry_id', 'customer_id', 'observed_at', 'source_system'].sort());
  assert.equal(row.customer_id, 'alibaba-crm:0123456789abcdef0123456789abcdef');
  assert.equal(reported.matched_links, 1);
});
