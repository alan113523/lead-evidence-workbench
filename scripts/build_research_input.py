"""Build local research clues from explicitly pinned saved files. Never searches."""
import argparse
from html import escape
import json
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
from input_utils import read_json, digest, require, timestamp
from research_clues import empty_clues, saved_clues, merge_clues

SCHEMA = 'lew.research-input.v1'


def pinned(declaration, base):
    require(isinstance(declaration, dict) and isinstance(declaration.get('path'), str), 'explicit source required')
    path = Path(declaration['path'])
    if not path.is_absolute():
        path = base / path
    path = path.resolve()
    require('.private' not in {p.lower() for p in path.parts}, 'forbidden source path')
    require(declaration.get('sha256') == digest(path), 'source hash mismatch')
    return read_json(path), {'path': str(path), 'sha256': declaration['sha256']}


def population_rows(data):
    if isinstance(data.get('rows'), list):
        return [(row, f'/rows/{i}') for i, row in enumerate(data['rows'])]
    if isinstance(data.get('inquiries'), list):
        members = {}
        for link in data.get('buyer_member_links', []):
            key = (link['store_key'], link['inquiry_id'])
            require(key not in members, 'duplicate population member link')
            members[key] = link.get('buyer_member_id')
        for row in data['inquiries']:
            key = (row['store_key'], row['inquiry_id'])
            require(row.get('buyer_member_id') is None or key not in members or row['buyer_member_id'] == members[key], 'population member conflict')
        return [({**row, 'buyer_member_id': members.get((row['store_key'], row['inquiry_id']), row.get('buyer_member_id'))}, f'/inquiries/{i}') for i, row in enumerate(data['inquiries'])]
    raise ValueError('expected frozen rows or inquiry bundle')


def build(spec, base):
    require(spec.get('schema_version') == 'lew.research-input-source-spec.v1', 'unsupported research source spec')
    population, pop_ref = pinned(spec.get('population'), base)
    records, by_key = [], {}
    for row, pointer in population_rows(population):
        key = (row.get('store_key'), row.get('inquiry_id'))
        require(isinstance(key[0], str) and re.fullmatch(r'[a-z][a-z0-9-]{0,62}', key[0]) and isinstance(key[1], str) and key[1], 'exact population identity required')
        require(key not in by_key, 'duplicate population identity')
        item = {k: row.get(k) for k in ('store_key', 'inquiry_id', 'buyer_member_id', 'row_key', 'country')}
        item.update(excluded=bool(row.get('excluded')), clues=saved_clues(row, 'population', {**pop_ref, 'pointer': pointer}),
                    source_issues=[], research_status='not_performed', contact_status='not_contacted')
        records.append(item)
        by_key[key] = item
    receipts, seen_sources, unmatched = [], set(), []
    require(isinstance(spec.get('sources'), list), 'explicit research sources required')
    for declaration in spec['sources']:
        data, source = pinned(declaration, base)
        require(source['path'] not in seen_sources, 'duplicate research source')
        seen_sources.add(source['path'])
        shape = declaration.get('format')
        require(shape in ('intake_export', 'inquiry', 'platform_accepted'), 'unsupported research source format')
        if shape == 'intake_export':
            require(data.get('schema_version') == 'lew.export-comparison.v1', 'saved intake export schema required')
        receipts.append({**source, 'format': shape})
        if shape == 'platform_accepted':
            require(data.get('schema_version') == 'lew.platform-current-account.v1', 'accepted platform schema required')
            # Account contact clues may accompany multiple opportunities for the
            # same exact store/member, never a same-name or cross-store account.
            targets = [r for r in records if r['store_key'] == data.get('store_key') and r.get('buyer_member_id')
                       and r['buyer_member_id'] == data.get('buyer_member_id')]
            if not targets:
                unmatched.append({**source, 'reason': 'account_outside_population'})
                continue
            bare = data['buyer_member_id'].removeprefix('alibaba-visible-member:')
            binding = data.get('identity_binding') or {}
            contacts = (data.get('customerDetail') or {}).get('contactQueryCOList') or []
            matched = [c for c in contacts if isinstance(c, dict) and c.get('loginId') == bare
                       and binding.get('main_contact_id') is not None and c.get('id') == binding['main_contact_id']]
            if (data.get('observed_buyer_login_id') != bare or len(matched) != 1
                    or binding.get('crm_contact_exact_match') is not True or binding.get('homepage_exact_match') is not True
                    or binding.get('crm_customer_id_match') is not True
                    or ((data.get('buyerHomepage') or {}).get('buyerProfile') or {}).get('memberId') != bare
                    or ((data.get('homepagePageData') or {}).get('personalInfo') or {}).get('loginId') != bare):
                for target in targets:
                    target['source_issues'].append({**source, 'pointer': '', 'state': 'identity_pending', 'reason': 'accepted_contact_or_homepage_identity_unresolved'})
                continue
            observed = data.get('captured_at')
            if observed is not None:
                timestamp(observed)
            clues = saved_clues(data, shape, {**source, 'pointer': '', 'observation_basis': 'source_document.captured_at'}, observed)
            for target in targets:
                target['clues'] = merge_clues(target['clues'], clues)
            continue
        rows = data.get('rows') if shape == 'intake_export' else data.get('inquiries')
        require(isinstance(rows, list), 'saved source rows required')
        seen = set()
        for i, row in enumerate(rows):
            key = (row.get('store_key'), row.get('inquiry_id'))
            require(key not in seen, 'duplicate saved source inquiry')
            seen.add(key)
            target = by_key.get(key)
            location = {**source, 'pointer': ('/rows/' if shape == 'intake_export' else '/inquiries/') + str(i)}
            if not target:
                unmatched.append({**location, 'reason': 'inquiry_outside_population'})
                continue
            member = row.get('buyer_member_id')
            candidate = row.get('buyer_login_id_candidate')
            wanted = target.get('buyer_member_id')
            reason = None
            if member is not None and member != wanted:
                reason = 'member_conflict'
            elif candidate is not None and (not wanted or wanted != 'alibaba-visible-member:' + str(candidate)):
                reason = 'candidate_member_unresolved'
            elif shape == 'intake_export' and member is None and candidate is None:
                reason = 'member_missing'
            if reason:
                target['source_issues'].append({**location, 'state': 'identity_pending', 'reason': reason})
                continue
            observed = row.get('observed_at')
            clues = saved_clues(row, shape, location, observed)
            target['clues'] = merge_clues(target['clues'], clues)
    summary = {name: {state: sum(r['clues']['fields'][name]['status'] == state for r in records)
                       for state in sorted({r['clues']['fields'][name]['status'] for r in records})}
               for name in empty_clues()['fields']}
    return {'schema_version': SCHEMA, 'population': pop_ref, 'sources': receipts, 'records': records,
            'input_spec': {'schema_version': spec['schema_version'], 'population': pop_ref, 'sources': receipts},
            'counts': {'population': len(records), 'eligible': sum(not r['excluded'] for r in records),
                       'with_identity_issue': sum(bool(r['source_issues']) for r in records)},
            'field_status_counts': summary, 'unmatched_sources': unmatched,
            'research_status': 'not_performed', 'contact_status': 'not_contacted'}


def render(data):
    labels = {'name': '姓名', 'email': '邮箱', 'website': '网站', 'phone': '电话', 'whatsapp': '平台明确标注的 WhatsApp'}
    states = {'present': '有值／未核归属', 'masked': '掩码／不还原', 'needs_review': '格式或内容待复核',
              'blocked': '私有链接或不安全内容未投射', 'missing': '已保存字段为空', 'not_collected': '当前来源未采集该字段',
              'multiple_values': '多值／全部保留未选定'}
    columns = ['present', 'multiple_values', 'masked', 'missing', 'not_collected', 'needs_review', 'blocked']
    summary = '<p>全批线索统计（含排除项；店铺筛选仅筛选下方逐条记录）</p><div style="overflow-x:auto"><table><tr><th>线索</th>' + ''.join('<th>' + states[s] + '</th>' for s in columns) + '</tr>'
    for name, label in labels.items():
        summary += '<tr><td>' + label + '</td>' + ''.join(f'<td>{data["field_status_counts"][name].get(s, 0)}</td>' for s in columns) + '</tr>'
    summary += '</table></div>'
    cards = []
    for row in data['records']:
        pieces = [f'<details data-store="{escape(row["store_key"])}"><summary>{escape(row["store_key"])} / {escape(row["inquiry_id"])} · {"排除项" if row["excluded"] else "纳入"}</summary>']
        for name, label in labels.items():
            field = row['clues']['fields'][name]
            pieces.append(f'<h3>{label}：{states[field["status"]]}</h3>')
            for item in field['items']:
                source = item['source']
                text = f'{states[item["status"]]} · {item["value"] or "未提供"} · 观察时间：{item["observed_at"] or "原记录未提供"} · {source.get("path", "内存来源")} {source["pointer"]} · SHA {source.get("sha256", "未提供")}'
                if item.get('saved_number_parts'):
                    text += ' · 原号码组成（未推定国际格式）：' + json.dumps(item['saved_number_parts'], ensure_ascii=False)
                pieces.append('<p>' + escape(text) + '</p>')
        for issue in row['source_issues']:
            pieces.append('<p class="issue">来源身份待核，未合并联系线索：' + escape(issue['reason'] + ' · ' + issue['path'] + ' ' + issue['pointer']) + '</p>')
        pieces.append('</details>')
        cards.append(''.join(pieces))
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>统一研究线索输入</title><style>body{max-width:1150px;margin:32px auto;padding:0 20px;font:15px/1.7 system-ui;color:#222}details{padding:14px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:bold}h3{font-size:15px;margin-bottom:2px}.issue{color:#995c10}select{font:inherit}table{border-collapse:collapse;white-space:nowrap}td,th{padding:9px;border-bottom:1px solid #ddd;text-align:left}</style><h1>统一研究线索输入</h1><p>仅整理已保存资料。公开研究尚未执行，未发送消息；线索有值不等于归属或可达性已核实。手机号不推为 WhatsApp。原始观察时间缺失如实保留。</p>''' + f'<p>商机 {len(data["records"])} 条，纳入 {data["counts"]["eligible"]} 条；来源身份待核 {data["counts"]["with_identity_issue"]} 条。</p>' + summary + '<label>店铺 <select id="store"><option value="">全部</option>' + ''.join(f'<option>{escape(s)}</option>' for s in sorted({r['store_key'] for r in data['records']})) + '</select></label>' + ''.join(cards) + '''<script>document.getElementById('store').onchange=function(){document.querySelectorAll('details').forEach(n=>n.hidden=Boolean(this.value&&n.dataset.store!==this.value));};</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec')
    parser.add_argument('--out')
    parser.add_argument('--html')
    parser.add_argument('--verify-input')
    args = parser.parse_args()
    if args.verify_input:
        require(not args.spec and not args.out and not args.html, 'verify mode has no outputs')
        path = Path(args.verify_input).resolve()
        require('.private' not in {x.lower() for x in path.parts}, 'forbidden source path')
        data = read_json(path)
        require(data == build(data.get('input_spec') or {}, path.parent), 'research input differs from saved source projection')
        print(json.dumps({'status': 'verified', 'research_status': 'not_performed'}))
        return
    require(args.spec and args.out, 'spec and out required')
    targets = [Path(p).resolve() for p in (args.out, args.html) if p]
    require(len(set(targets)) == len(targets) and all(not p.exists() for p in targets), 'output already exists; preserve originals')
    require(all('.private' not in {x.lower() for x in p.parts} for p in targets), 'forbidden output path')
    spec = Path(args.spec).resolve()
    require('.private' not in {x.lower() for x in spec.parts}, 'forbidden source path')
    data = build(read_json(spec), spec.parent)
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
    targets[0].write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.html:
        targets[1].write_text(render(data), encoding='utf-8')
    print(json.dumps({'out': str(targets[0]), 'counts': data['counts'], 'research_status': 'not_performed'}))


if __name__ == '__main__':
    main()
