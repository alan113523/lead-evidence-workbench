import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import customer_signal_diff as diff


def item(content='New diffuser catalogue', published='2026-10-27T12:00:00Z'):
    return {'content': content, 'content_sha256': diff.digest(content), 'url': 'https://synthetic.invalid/news/1',
            'published_at': published, 'observed_at': '2026-10-28T00:00:00Z', 'evidence_ref': 'synthetic-evidence#item'}


def snapshots():
    after = {'schema_version': diff.SNAPSHOT, 'captured_at': '2026-10-28T01:00:00Z',
             'entity': {'id': 'SYN-1', 'domain': 'synthetic.invalid', 'confirmed': True, 'evidence_ref': 'synthetic-confirmation'},
             'keywords': ['diffuser'], 'sources': [
                 {'id': 'news', 'scope_url': 'https://synthetic.invalid/news', 'status': 'checked', 'complete': True,
                  'evidence_ref': 'synthetic-evidence#source', 'observed_at': '2026-10-28T00:00:00Z', 'items': [item()]}]}
    before = copy.deepcopy(after)
    before['captured_at'] = '2026-10-26T01:00:00Z'
    before['sources'][0].update(observed_at='2026-10-26T00:00:00Z', items=[])
    return before, after


class SignalDiffTests(unittest.TestCase):
    def setUp(self):
        self.before, self.after = snapshots()

    def result(self):
        return diff.compare(self.before, self.after)

    def test_new_content_has_evidence_key_and_no_execution(self):
        original = copy.deepcopy((self.before, self.after))
        r = self.result()
        self.assertEqual(r['counts']['true_change'], 1)
        self.assertEqual(len(r['events'][0]['event_key']), 64)
        self.assertTrue(r['events'][0]['before_evidence_refs'])
        self.assertFalse(r['executed'])
        self.assertEqual(original, (self.before, self.after))

    def test_repeat_comparison_identical_and_seen_report_suppresses_new(self):
        r = self.result()
        self.assertEqual(r, self.result())
        seen = diff.compare(self.before, self.after, r)
        self.assertEqual(seen['counts']['duplicate'], 1)
        self.assertEqual(seen['counts']['true_change'], 0)

    def test_same_snapshot_has_no_new_change(self):
        r = diff.compare(self.after, self.after)
        self.assertEqual(r['counts']['true_change'], 0)
        self.assertEqual(r['coverage'][0]['result'], 'checked_no_new_content')

    def test_url_switch_whitespace_republication_and_multiple_sources_dedupe(self):
        self.before = copy.deepcopy(self.after)
        self.after['sources'][0]['items'][0].update(url='https://synthetic.invalid/new-url', published_at=None)
        content = ' New   diffuser\ncatalogue '
        self.after['sources'][0]['items'][0].update(content=content, content_sha256=diff.digest(content))
        source = copy.deepcopy(self.after['sources'][0])
        source['id'] = 'mirror'
        self.after['sources'].append(source)
        r = self.result()
        self.assertEqual(len(r['events']), 1)
        self.assertEqual(r['counts']['duplicate'], 1)
        self.assertEqual(len(r['events'][0]['evidence']), 2)

    def test_missing_old_and_incomplete_or_changed_scope_are_weak(self):
        for change in ['missing', 'incomplete', 'scope']:
            with self.subTest(change=change):
                before, after = snapshots()
                if change == 'missing': before['sources'] = []
                elif change == 'incomplete': after['sources'][0]['complete'] = False
                else: after['sources'][0]['scope_url'] = 'https://synthetic.invalid/other'
                self.assertEqual(diff.compare(before, after)['counts']['weak'], 1)

    def test_missing_old_publication_and_no_keyword_are_weak(self):
        for published, content in [(None, 'diffuser'), ('2026-10-25T00:00:00Z', 'diffuser'), ('2026-10-27T12:00:00Z', 'unrelated news')]:
            self.after['sources'][0]['items'] = [item(content, published)]
            self.assertEqual(self.result()['counts']['weak'], 1)

    def test_unconfirmed_entity_never_emits_actionable_change(self):
        for snapshot in [self.before, self.after]:
            snapshot['entity']['confirmed'] = False
        self.assertEqual(self.result()['counts']['unconfirmed'], 1)
        self.assertIn('不生成客户话术', self.result()['events'][0]['next_action'])

    def test_blocked_unconnected_and_checked_empty_distinct(self):
        for status in ['blocked', 'not_connected']:
            self.after['sources'][0].update(status=status, items=[], complete=False, reason='synthetic unavailable')
            r = self.result()
            self.assertEqual(r['coverage'][0]['result'], status)
            self.assertEqual(r['events'], [])
        self.after['sources'][0].update(status='checked', items=[], complete=True)
        self.assertEqual(self.result()['coverage'][0]['result'], 'checked_no_new_content')

    def test_removed_item_is_not_reported_as_deletion(self):
        before = copy.deepcopy(self.after)
        self.after['sources'][0]['items'] = []
        self.assertEqual(diff.compare(before, self.after)['events'], [])

    def test_mismatch_order_and_keyword_scope_rejected(self):
        for field in ['entity', 'order', 'keywords']:
            before, after = snapshots()
            if field == 'entity': after['entity']['id'] = 'SYN-other'
            elif field == 'order': before['captured_at'] = '2026-10-29T00:00:00Z'
            else: after['keywords'] = ['different']
            with self.assertRaises(ValueError): diff.compare(before, after)

    def test_invalid_hash_dates_status_ids_and_urls_rejected(self):
        for change in ['hash', 'date', 'future', 'status', 'duplicate', 'url', 'confirmed', 'complete']:
            with self.subTest(change=change):
                before, after = snapshots()
                source, entry = after['sources'][0], after['sources'][0]['items'][0]
                if change == 'hash': entry['content_sha256'] = '0' * 64
                elif change == 'date': entry['observed_at'] = '2026-10-28'
                elif change == 'future': entry['published_at'] = '2026-10-29T00:00:00Z'
                elif change == 'status': source['status'] = 'passed'
                elif change == 'duplicate': after['sources'].append(copy.deepcopy(source))
                elif change == 'url': entry['url'] = 'https://synthetic.invalid/news?token=synthetic'
                elif change == 'confirmed': after['entity']['evidence_ref'] = ''
                else: source['complete'] = 'true'
                with self.assertRaises(ValueError): diff.compare(before, after)

    def test_html_is_escaped(self):
        self.after['sources'][0]['items'] = [item('</pre><script>alert(1)</script> diffuser')]
        html = diff.render(self.result())
        self.assertNotIn('<script>', html)
        self.assertIn('&lt;script&gt;', html)

    def test_item_source_cannot_override_parent_source(self):
        self.after['sources'][0]['items'][0]['source_id'] = 'forged-other-source'
        with self.assertRaisesRegex(ValueError, 'source_id conflicts'):
            self.result()
        self.after['sources'][0]['items'][0]['source_id'] = 'news'
        self.assertEqual(self.result()['events'][0]['evidence'][0]['source_id'], 'news')

    def test_keyword_matching_and_event_key_share_whitespace_normalization(self):
        self.before['keywords'] = self.after['keywords'] = ['new diffuser']
        initial = self.result()
        self.after['sources'][0]['items'] = [item('New\ndiffuser catalogue')]
        changed = self.result()
        self.assertEqual(initial['counts'], changed['counts'])
        self.assertEqual(initial['events'][0]['event_key'], changed['events'][0]['event_key'])

    def test_cli_binds_bytes_refuses_overwrite_and_preserves_input(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            before, after = folder / 'before.json', folder / 'after.json'
            before.write_text(json.dumps(self.before), encoding='utf-8')
            after.write_text(json.dumps(self.after), encoding='utf-8')
            original = before.read_bytes(), after.read_bytes()
            args = ['--before', str(before), '--after', str(after), '--out', str(folder / 'report')]
            diff.main(args)
            saved = json.loads((folder / 'report/report.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['input_bindings'][0]['sha256'], diff.digest(original[0].decode()))
            with self.assertRaises(FileExistsError): diff.main(args)
            self.assertEqual(original, (before.read_bytes(), after.read_bytes()))


if __name__ == '__main__': unittest.main()
