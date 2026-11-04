import {prepareExportContext} from './browser_export_fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(resolve('scripts/export_visitors_browser.js'), 'utf8');

async function run(responseValue, detailPages = []) {
  const requests = [];
  let blob, button, anchor, error;
  const context = {
    location: { origin: 'https://hz-mydata.alibaba.com' },
    document: {
      cookie: 'xman_us_t=abc&ctoken=private-token&sign=y',
      createElement: (tag) => {
        const element = { tag, style: {}, remove() {}, click() {},
          addEventListener(_name, handler) { this.handler = handler; } };
        if (tag === 'a') anchor = element;
        return element;
      },
      body: { appendChild(element) { button = element; } },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const page = Number(new URLSearchParams(options.body).get('pageNO'));
      return { ok: true, json: async () => url.includes('iName=getVisitorDetails')
        ? detailPages[page - 1] : responseValue };
    },
    URLSearchParams,
    URL: { createObjectURL(value) { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    Blob, Date, setTimeout() {},
    console: { info() {}, error(value) { error = value; } },
  };
  try { await runInNewContext(source, prepareExportContext(context,'visitors')); } catch (caught) { error = caught; }
  return { requests, blob, button, get anchor() { return anchor; }, error };
}

test('fixed inquiry sample projects only anonymous fields and caps detail pagination', async () => {
  const events = Array.from({ length: 22 }, (_, i) => ({
    realUrl: `https://example.alibaba.com/product-detail/diffuser_${i < 12 ? '123' : '456'}.html`,
    buyerName: 'Private Person',
  }));
  const detailPages = [events.slice(0, 15), events.slice(15)].map((page, i) => ({
    successed: true, value: { total: 22, pageNO: i + 1, data: page },
  }));
  const result = await run({ successed: true, value: { total: 1, data: [{
    statDate: '2026-09-22', buyerCountry: 'United States',
    searchKeyword: 'aroma diffuser', serKeywords: 'hotel scent',
    isMcFb: 1, isAtmFb: 1, isClickPlaceOrder: 0,
    visitorId: 'private-id', buyerCookieId: 'private-cookie', buyerName: 'Private Person',
    email: 'person@example.com',
  }] } }, detailPages);
  assert.equal(result.error, undefined);
  assert.equal(result.requests.length, 3);
  const { url, options } = result.requests[0];
  assert.match(url, /iName=getVisitors/);
  assert.equal(options.method, 'POST');
  const params = new URLSearchParams(options.body);
  assert.equal(params.get('startDate'), '2026-09-22');
  assert.equal(params.get('endDate'), '2026-09-23');
  assert.equal(params.get('isMcFb'), 'true');
  assert.equal(params.get('statisticType'), 'os');
  assert.equal(params.get('platform'), null);
  assert.equal(params.get('buyerRegion'), '');
  assert.equal(params.get('subMemberSeq'), '');
  assert.equal(params.get('pageSize'), '5');
  assert.equal(params.get('pageNO'), '1');
  assert.deepEqual(result.requests.slice(1).map((r) => new URLSearchParams(r.options.body).get('pageNO')), ['1', '2']);
  const detailParams = new URLSearchParams(result.requests[1].options.body);
  assert.equal(detailParams.get('statDate'), '2026-09-22');
  assert.equal(detailParams.get('buyerCookieId'), 'private-cookie');
  assert.equal(detailParams.get('visitorId'), null);
  assert.equal(result.button.tag, 'button');
  result.button.handler({ preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(result.anchor.download, 'visits_20260922_20260923_anonymous.jsonl');
  const text = await result.blob.text();
  const row = JSON.parse(text.trim());
  assert.deepEqual(Object.keys(row), ['store_key', 'visit_date', 'source_term', 'country',
    'preference_keywords', 'viewed_product_ids', 'actions']);
  assert.deepEqual(row.actions, ['tm', 'inquiry']);
  assert.deepEqual(row.preference_keywords, ['hotel scent', 'aroma diffuser']);
  assert.deepEqual(row.viewed_product_ids, ['123', '456']);
  assert.equal(text.includes('private-id'), false);
  assert.equal(text.includes('Private Person'), false);
  assert.equal(text.includes('person@example.com'), false);
});

test('excess total stops before download or further pages', async () => {
  const result = await run({ successed: true, value: { total: 6, data: [] } });
  assert.match(result.error.message, /exceeds cap/);
  assert.equal(result.requests.length, 1);
  assert.equal(result.blob, undefined);
});

test('incomplete detail stops without exporting partial product coverage', async () => {
  const detailPages = [1, 2].map((pageNO) => ({ successed: true, value: {
    total: 30, pageNO, data: Array.from({ length: 5 }, () =>
      ({ realUrl: 'https://example.alibaba.com/product-detail/item_123.html' })),
  } }));
  const result = await run({ successed: true, value: { total: 1, data: [{
    statDate: '2026-09-22', isMcFb: 1, buyerCookieId: 'private-cookie',
  }] } }, detailPages);
  assert.match(result.error.message, /pagination incomplete/);
  assert.equal(result.blob, undefined);
});
