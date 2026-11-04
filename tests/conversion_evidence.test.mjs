import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversionEvidenceReport } from '../scripts/conversion_evidence.mjs';
import { importCustomerLinks, importRows, openStore } from '../scripts/inquiry_store.mjs';

test('linked CRM customer remains unassessable without first-contact and order evidence', () => {
  const db = openStore(':memory:');
  try {
    importRows(db, [{
      store_key: 'sample-store', inquiry_id: 'sample-inquiry', customer_id: null,
      created_at: '2026-09-23T17:00:00+08:00', observed_at: '2026-09-26T10:00:00+08:00',
      source_system: 'synthetic-test',
    }], 'sample-store');
    importCustomerLinks(db, [{
      store_key: 'sample-store', inquiry_id: 'sample-inquiry',
      customer_id: 'alibaba-crm:0123456789abcdef0123456789abcdef',
      observed_at: '2026-09-26T11:00:00+08:00', source_system: 'alibaba-message-detail-crm-link-v1',
    }], 'sample-store');
    const report = conversionEvidenceReport(db, 'sample-store');
    assert.equal(report.inquiries, 1);
    assert.equal(report.crm_linked_inquiries, 1);
    assert.equal(report.missing_crm_link, 0);
    assert.equal(report.new_customer_assessment, 'unavailable');
    assert.equal(report.conversion_assessment, 'unavailable');
    assert.equal(report.missing_evidence.length, 2);
  } finally { db.close(); }
});
