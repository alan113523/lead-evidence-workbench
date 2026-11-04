"""Offline contact projection, frozen-source binding and original compatibility."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_research_input as builder
from research_clues import saved_clues


class SavedClueTests(unittest.TestCase):
    def fields(self, row, shape='inquiry'):
        return saved_clues(row, shape)['fields']

    def test_phone_cannot_manufacture_whatsapp_or_salesperson_become_contact(self):
        f = self.fields({'buyer_name': 'Synthetic buyer', 'owner': 'Synthetic seller', 'mobile': '+1 212 555 0100', 'memo': 'WhatsApp please'})
        self.assertEqual(f['phone']['status'], 'present')
        self.assertEqual(f['whatsapp']['status'], 'not_collected')
        self.assertEqual([v['value'] for v in f['name']['items']], ['Synthetic buyer'])

    def test_explicit_whatsapp_tags_and_unknown_numeric_type(self):
        f = self.fields({'socialAccounts': [{'type': 91, 'account': '+1 212 555 0100'},
                      {'label': 'WhatsApp Business', 'value': '+1 212 555 0101'}]})
        self.assertEqual([v['value'] for v in f['whatsapp']['items']], ['+1 212 555 0101'])
        self.assertEqual(f['whatsapp']['items'][0]['platform_label'], 'WhatsApp Business')

    def test_masked_empty_absent_and_format_review_are_distinct(self):
        f = self.fields({'email': 'synthetic***@example.com', 'mobile': None, 'website': ''})
        self.assertEqual(f['email']['status'], 'masked')
        self.assertFalse(f['email']['items'][0]['usable_as_search_term'])
        self.assertEqual(f['phone']['status'], 'missing')
        self.assertEqual(f['website']['status'], 'missing')
        self.assertEqual(f['whatsapp']['status'], 'not_collected')
        self.assertEqual(self.fields({'email': 'incomplete@'})['email']['status'], 'needs_review')

    def test_private_website_and_credentials_do_not_leak_value(self):
        for value in ['https://profile.alibaba.com/profile/my_profile.htm', 'https://example.com/?token=synthetic', 'Cookie: synthetic']:
            f = self.fields({'website': value})
            self.assertEqual(f['website']['status'], 'blocked')
            self.assertIsNone(f['website']['items'][0]['value'])

    def test_crm_multiple_contacts_keep_each_location_and_same_contact_name_parts(self):
        row = {'customerDetail': {'fieldsMissingFromList': {'contacts': [
            {'firstName': 'Synthetic', 'lastName': 'One', 'emailFull': 'one@example.com'},
            {'contactName': 'Synthetic Two', 'emailFull': 'two@example.com'}]}}}
        f = self.fields(row, 'crm_v3')
        self.assertEqual(f['email']['status'], 'multiple_values')
        self.assertEqual([x['value'] for x in f['name']['items']], ['Synthetic One', 'Synthetic Two'])
        self.assertEqual(f['name']['items'][0]['normalization'], 'joined_name_parts_from_same_contact')
        self.assertIn('/contacts/1/', f['email']['items'][1]['source']['pointer'])
        self.assertIn('not_buyer_authority', f['email']['items'][1]['association_status'])


class ResearchInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.row = {'store_key': 'demobeta', 'inquiry_id': '101', 'buyer_member_id': 'alibaba-visible-member:synthetic001',
                    'buyer_name': 'Synthetic Buyer', 'excluded': False}
        self.population = self.put('population.json', {'rows': [self.row]})
        self.spec = {'schema_version': 'lew.research-input-source-spec.v1', 'population': self.population, 'sources': []}

    def put(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data), encoding='utf-8')
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def intake(self, **changes):
        row = {'store_key': 'demobeta', 'inquiry_id': '101', 'buyer_login_id_candidate': 'synthetic001',
               'raw': {'客户名': 'Synthetic Buyer', '邮箱': 'buyer@example.com', '手机': None}}
        row.update(changes)
        self.spec['sources'] = [{**self.put('intake.json', {'schema_version': 'lew.export-comparison.v1', 'rows': [row]}), 'format': 'intake_export'}]

    def test_exact_frozen_export_and_missing_observation(self):
        self.intake()
        before = Path(self.population['path']).read_bytes()
        data = builder.build(self.spec, self.root)
        row = data['records'][0]
        self.assertEqual(row['clues']['fields']['email']['items'][0]['value'], 'buyer@example.com')
        self.assertIsNone(row['clues']['fields']['email']['items'][0]['observed_at'])
        self.assertEqual(data['research_status'], 'not_performed')
        self.assertEqual(data['contact_status'], 'not_contacted')
        self.assertEqual(before, Path(self.population['path']).read_bytes())

    def test_wrong_member_does_not_merge_contact_values(self):
        self.intake(buyer_login_id_candidate='somebody_else')
        row = builder.build(self.spec, self.root)['records'][0]
        self.assertEqual(row['clues']['fields']['email']['status'], 'not_collected')
        self.assertEqual(row['source_issues'][0]['state'], 'identity_pending')

    def test_duplicate_or_conflicting_population_members_rejects(self):
        for links, value in [([{'store_key': 'demobeta', 'inquiry_id': '101', 'buyer_member_id': self.row['buyer_member_id']}] * 2, self.row),
                             ([{'store_key': 'demobeta', 'inquiry_id': '101', 'buyer_member_id': 'other'}], self.row)]:
            self.spec['population'] = self.put('bundle.json', {'inquiries': [value], 'buyer_member_links': links})
            with self.assertRaises(ValueError): builder.build(self.spec, self.root)

    def accepted(self):
        return {'schema_version': 'lew.platform-current-account.v1', 'store_key': 'demobeta', 'buyer_member_id': self.row['buyer_member_id'],
                'observed_buyer_login_id': 'synthetic001', 'captured_at': '2026-10-01T00:00:00Z',
                'identity_binding': {'main_contact_id': 9, 'crm_contact_exact_match': True, 'homepage_exact_match': True, 'crm_customer_id_match': True},
                'customerDetail': {'contactQueryCOList': [{'id': 8, 'loginId': 'wrong', 'email': ['wrong@example.com']},
                    {'id': 9, 'loginId': 'synthetic001', 'email': ['right@example.com']}]},
                'buyerHomepage': {'buyerProfile': {'memberId': 'synthetic001'}},
                'homepagePageData': {'personalInfo': {'loginId': 'synthetic001'}}}

    def test_accepted_uses_exact_contact_instead_of_first(self):
        source = self.accepted()
        self.spec['sources'] = [{**self.put('accepted.json', source), 'format': 'platform_accepted'}]
        row = builder.build(self.spec, self.root)['records'][0]
        self.assertEqual([x['value'] for x in row['clues']['fields']['email']['items']], ['right@example.com'])
        source['buyerHomepage']['buyerProfile']['memberId'] = 'wrong'
        self.spec['sources'] = [{**self.put('accepted.json', source), 'format': 'platform_accepted'}]
        row = builder.build(self.spec, self.root)['records'][0]
        self.assertEqual(row['clues']['fields']['email']['status'], 'not_collected')
        self.assertTrue(row['source_issues'])
        self.assertEqual(row['source_issues'][0]['pointer'], '')
        self.assertIn('来源身份待核', builder.render(builder.build(self.spec, self.root)))

    def test_modified_source_bytes_and_duplicate_targets_reject(self):
        self.intake()
        Path(self.spec['sources'][0]['path']).write_text('{}')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'): builder.build(self.spec, self.root)
        self.spec['sources'] = []
        self.spec['population'] = self.put('duplicate.json', {'rows': [self.row, self.row]})
        with self.assertRaisesRegex(ValueError, 'duplicate population'): builder.build(self.spec, self.root)

    def test_cli_refuses_overwrite_and_replay_rejects_forged_value(self):
        self.intake()
        spec = self.root / 'spec.json';spec.write_text(json.dumps(self.spec))
        out = self.root / 'research.json'
        cmd = [sys.executable, '-B', str(ROOT / 'scripts/build_research_input.py')]
        run = subprocess.run([*cmd, '--spec', str(spec), '--out', str(out)], capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertNotEqual(subprocess.run([*cmd, '--spec', str(spec), '--out', str(out)], capture_output=True).returncode, 0)
        self.assertEqual(subprocess.run([*cmd, '--verify-input', str(out)], capture_output=True).returncode, 0)
        body = json.loads(out.read_bytes());body['records'][0]['clues']['fields']['email']['items'][0]['value'] = 'forged@example.com'
        out.write_text(json.dumps(body))
        self.assertNotEqual(subprocess.run([*cmd, '--verify-input', str(out)], capture_output=True).returncode, 0)

    def test_html_escapes_saved_names_and_contains_no_external_request(self):
        self.row['buyer_name'] = '<img src=https://example.com/evil>'
        self.spec['population'] = self.put('name.json', {'rows': [self.row]})
        html = builder.render(builder.build(self.spec, self.root))
        self.assertNotIn('<img', html)
        self.assertNotIn('fetch(', html)


if __name__ == '__main__': unittest.main()
