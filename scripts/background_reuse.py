"""Bind explicitly supplied saved review bundles to a frozen daily dashboard."""
import hashlib
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'lew.saved-background-bundle-audit.v1'


def require(ok, message):
    if not ok: raise ValueError(message)


def stable(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def sha(content):
    return hashlib.sha256(content).hexdigest()


def instant(value):
    require(isinstance(value,str), 'source timestamp required')
    parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
    require(parsed.utcoffset() is not None, 'source timestamp requires timezone')
    return parsed


def read_json(path):
    require('.private' not in {s.lower() for s in path.resolve().parts}, 'forbidden reference path')
    def unique(pairs):
        out = {}
        for k,v in pairs:
            require(k not in out, 'duplicate JSON field: ' + k)
            out[k] = v
        return out
    content = path.read_bytes()
    return json.loads(content.decode('utf-8-sig'), object_pairs_hook=unique), sha(content)


def unique_units(units):
    require(isinstance(units, list), 'units array required')
    out = {}
    for u in units:
        require(isinstance(u, dict) and isinstance(u.get('unit_key'), str) and u['unit_key'] not in out, 'duplicate or invalid unit key')
        out[u['unit_key']] = u
    return out


def json_pointer(value, pointer):
    """Resolve an explicit JSON pointer; never search for a similar record."""
    require(isinstance(pointer, str) and (pointer == '' or pointer.startswith('/')), 'explicit JSON pointer required')
    for part in pointer.split('/')[1:]:
        require(not any(part[i] == '~' and (i + 1 == len(part) or part[i + 1] not in '01') for i in range(len(part))), 'invalid JSON pointer escape')
        part = part.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            require(part.isdecimal() and str(int(part)) == part and int(part) < len(value), 'invalid JSON array index')
            value = value[int(part)]
        else:
            require(isinstance(value, dict) and part in value, 'JSON pointer not found')
            value = value[part]
    return value


def load_legacy_entries(manifest, current, overlays, ref):
    """Trace unchanged old fields to source records without creating v2 claims."""
    entries = manifest.get('legacy_entries', [])
    require(isinstance(entries, list), 'legacy entries array required')
    seen, receipts = set(), []

    def source_record(source, target, key):
        require(isinstance(source, dict), 'legacy source declaration required')
        require(isinstance(source.get('path'), str) and Path(source['path']).is_absolute(), 'absolute legacy source path required')
        # Source files must already be pinned by this frozen row, not merely by
        # the new manifest. The row's own prior/decision references are authority.
        allowed = [target.get('base_prior_ref'), *target.get('parent_decision_sources', []),
                   *(target.get('diligence') or {}).get('evidence_refs', [])]
        def same_file(declaration):
            if not isinstance(declaration, dict) or not isinstance(declaration.get('path'), str):
                return False
            p = Path(declaration['path'])
            if not p.is_absolute(): p = ROOT / p
            q = Path(source.get('path', ''))
            if not q.is_absolute(): q = ROOT / q
            return p.resolve() == q.resolve() and declaration.get('sha256') == source.get('sha256')
        require(any(same_file(d) for d in allowed), 'legacy source not pinned by frozen row')
        document = ref(source)
        pointer = source.get('pointer')
        record = json_pointer(document, pointer)
        require(isinstance(record, dict), 'legacy source record required')
        for field, expected in [('store_key', key[0]), ('inquiry_id', key[1])]:
            require(field not in record or record[field] == expected, 'legacy source explicit identity conflict')
        exact_object = record.get('store_key') == key[0] and record.get('inquiry_id') == key[1]
        exact_key = '/' + (key[0] + ':' + key[1]).replace('~', '~0').replace('/', '~1')
        require(exact_object or pointer == exact_key, 'legacy source record identity mismatch')
        if 'row_key' in record:
            require(record['row_key'] == target.get('row_key'), 'legacy source row mismatch')
        if record.get('buyer_member_id') is not None:
            require(record['buyer_member_id'] == target.get('buyer_member_id'), 'legacy source member mismatch')
        return document, record, pointer

    def target_record(entry):
        require(isinstance(entry, dict), 'legacy entry object required')
        key = (entry.get('store_key'), entry.get('inquiry_id'))
        axis = entry.get('axis')
        require(axis in ('business_model', 'purchase_purpose'), 'unknown legacy axis')
        require((*key, axis) not in seen, 'duplicate legacy axis entry')
        seen.add((*key, axis))
        target = current.get(key)
        require(target and not target['excluded'] and entry.get('row_key') == target.get('row_key'), 'legacy target scope mismatch')
        return key, axis, target

    for entry in entries:
        key, axis, target = target_record(entry)
        source = entry.get('source')
        document, record, pointer = source_record(source, target, key)
        fields = entry.get('fields')
        require(isinstance(fields, dict), 'legacy field pointers required')
        values = {}
        for name, field in [('summary', axis), ('basis', axis + '_basis'), ('uncertainty', axis + '_uncertainty')]:
            field_pointer = fields.get(name)
            require(field_pointer == pointer + '/' + field, 'legacy field pointer has wrong semantic role')
            value = json_pointer(document, field_pointer)
            require(isinstance(value, str) and value == target.get(field, ''), 'legacy field differs from frozen judgment: ' + name)
            values[name] = value
        require(values['summary'].strip() and values['basis'].strip(), 'legacy summary and basis required')
        require(values['summary'].strip() not in ('未明确', '待判断', '未判断', '未知', '待确认', '未提供') and not values['summary'].strip().startswith('证据不足'), 'legacy unknown is not a judgment')
        date_pointer = fields.get('assessed_at')
        values['assessed_at'] = None
        require(not record.get('assessed_at') or date_pointer == pointer + '/assessed_at', 'legacy source date must be retained')
        if date_pointer is not None:
            require(date_pointer == pointer + '/assessed_at', 'legacy date pointer has wrong semantic role')
            values['assessed_at'] = json_pointer(document, date_pointer)
            instant(values['assessed_at'])
        provenance = {**values, 'source': source, 'field_pointers': fields,
                      'verification': '旧结论、原依据及不确定性与原文件逐字段一致；不代表重新核验聊天或网页',
                      'state': '旧结论已追溯'}
        overlay = overlays.setdefault(key, {'evidence': []})
        overlay.setdefault('legacy_traced', {})[axis] = provenance
        receipts.append({'key': list(key), 'axis': axis, 'source': source, 'fields': fields})
    pending = manifest.get('legacy_pending', [])
    require(isinstance(pending, list), 'legacy pending array required')
    for entry in pending:
        key, axis, target = target_record(entry)
        checked = entry.get('checked_sources')
        require(isinstance(checked, list) and checked, 'pending source checks required')
        for source in checked:
            _, record, _ = source_record(source, target, key)
            require(record.get(axis) == target.get(axis) and record.get(axis + '_basis') == target.get(axis + '_basis'), 'pending conclusion and basis must match')
            require(record.get(axis + '_uncertainty') != target.get(axis + '_uncertainty'), 'pending uncertainty must actually differ')
        overlay = overlays.setdefault(key, {'evidence': []})
        overlay.setdefault('legacy_pending', {})[axis] = {
            'reason': '已声明原判断源的结论和依据可对应，但不确定性字段未与当前冻结记录完整匹配；继续待适配',
            'checked_sources': checked}
    return receipts


def refs_for(profile):
    ids = set(profile.get('evidence_refs') or [])
    for name in ('business_model','purchase_purpose'):
        a = profile[name]
        ids.update(a.get('evidence_refs') or [])
        ids.update(a.get('reviewed_evidence_refs') or [])
        for c in [*a.get('claims',[]),*a.get('conflicts',[])]: ids.update(c.get('evidence_refs') or [])
    for name in ('entity_assessment','risk_assessment'): ids.update(profile[name].get('evidence_refs') or [])
    return ids


def replay(analysis, review):
    node = os.environ.get('NODE_EXECUTABLE') or shutil.which('node')
    require(node, 'Node.js required for existing pure profile validator')
    result = subprocess.run([node,str(ROOT/'scripts/profile_reuse_validate.mjs')],
        input=json.dumps({'analysis':analysis,'review':review},ensure_ascii=False),
        encoding='utf-8', capture_output=True, check=False)
    require(result.returncode == 0, 'pure profile validation failed: '+result.stderr[:300])
    return json.loads(result.stdout)


def bind_saved_evidence(analysis, manifest, raw, current):
    """Restore only original message metadata using already frozen associations."""
    import unicodedata
    associations = {(a['store_key'],a['inquiry_id']):a for a in manifest['associations']}
    require(len(associations) == len(manifest['associations']), 'duplicate saved chat association')
    normalized = copy.deepcopy(analysis)
    def normal(value):
        return ' '.join(unicodedata.normalize('NFKC',value).split()) if isinstance(value,str) else ''
    for e in normalized['evidence']:
        if e.get('kind') != 'chat_message': continue
        k = (e.get('store_key'),e.get('inquiry_id'))
        a, target = associations.get(k), current.get(k)
        require(a and target and a.get('buyer_member_id') == e.get('buyer_member_id') == target.get('buyer_member_id'), 'saved chat member mismatch')
        mid = e.get('message_id')
        conversation = (a.get('identity') or {}).get('conversation_id')
        require(all(isinstance(v,str) and v.strip() for v in [k[0],k[1],mid,conversation]), 'non-empty exact chat identity required')
        message_key = '|'.join([k[0],conversation or '',mid or ''])
        r = raw.get(message_key)
        require(r and r.get('key')==message_key and r.get('store_key') == k[0] and r.get('conversation_id') == conversation and r.get('message_id') == mid and not r.get('content_conflict') and isinstance(r.get('variants'),list) and len(r['variants']) == 1, 'frozen message identity/version conflict')
        require(e.get('locator') == 'chat-message:'+mid, 'saved evidence message locator mismatch')
        refs = [v for v in (target.get('reviewed_message_binding') or {}).get('messages',[]) if v.get('message_key')==message_key and v.get('role')=='current_inquiry_window']
        require(len(refs)==1 and not refs[0].get('content_conflict'), 'saved message is not in exact frozen current-window binding')
        for field in ('line','byte_offset','byte_length'):
            if field in refs[0]: require(refs[0][field]==(r.get('_position') or {}).get(field), 'frozen message byte position mismatch')
        proofs = []
        for part in [r,r['variants'][0]]:
            require(not part.get('content_conflict'), 'frozen variant conflict')
            for name,wanted in [('inquiry_keys',k[0]+'|'+k[1]),('inquiry_ids',k[1])]:
                if name in part:
                    require(isinstance(part[name],list), 'invalid original inquiry list')
                    if part[name]: proofs.append(wanted in part[name])
            if 'associations' in part:
                require(isinstance(part['associations'],list), 'invalid original association list')
                if part['associations']: proofs.append(any(isinstance(v,dict) and v.get('store_key')==k[0] and v.get('inquiry_id')==k[1] and v.get('conversation_id',conversation)==conversation for v in part['associations']))
        require(proofs and all(proofs), 'frozen original inquiry association missing or contradictory')
        m = r['variants'][0].get('message')
        require(isinstance(m,dict) and m.get('message_id')==mid and m.get('direction') in ('buyer','seller') and m.get('content_status')!='recalled_or_hidden', 'unreadable frozen message')
        require(isinstance(m.get('automation_flags',{}),dict) and all(isinstance(v,bool) for v in m.get('automation_flags',{}).values()), 'invalid original automation flags')
        sent = instant(m.get('sent_at'))
        require(sent <= instant(e.get('observed_at')) and sent < instant(target['_cutoff']), 'original message after observation or frozen cutoff')
        require(e.get('quote') is None or normal(e['quote']) and any(normal(e['quote']) in normal(m.get(f)) for f in ('text','source_content')), 'saved quote differs from frozen original')
        if e.get('scope') == 'current_purchase':
            require(instant(target['created_at']) <= sent, 'purchase evidence outside frozen inquiry window')
        e.update(direction=m['direction'],reply_source=m.get('reply_source'),content_status=m.get('content_status'),
                 sent_at=m.get('sent_at'),automatic=any(v is True for v in (m.get('automation_flags') or {}).values()),chat_bound=True)
        if m.get('content_status') not in ('read','readable'):
            # Insufficient/checked metadata may explain a gap but cannot support any
            # claim or conflict in the existing pure validator (content=True).
            e['state'] = 'missing'
    return normalized


def load_reuse(path, data, final_sha):
    """Return per-inquiry overlays; never mutate frozen final-data or issue new judgments."""
    manifest, manifest_sha = read_json(Path(path))
    require(manifest.get('schema_version') == SCHEMA and manifest.get('final_data',{}).get('sha256') == final_sha,
            'background reuse manifest does not bind this final-data')
    require(isinstance(manifest.get('bundles'),list), 'explicit bundle list required')
    current = {(r['store_key'],r['inquiry_id']):{**r,'_cutoff':data['analysis_before_exclusive']} for r in data['rows']}
    require(len(current) == len(data['rows']), 'duplicate frozen inquiry key')
    cache, candidates, rejected, bundle_ids, bindings = {}, {}, [], set(), []
    raw_path = Path(manifest['messages']['path']).resolve()
    require('.private' not in {s.lower() for s in raw_path.parts}, 'forbidden reference path')
    raw_content = raw_path.read_bytes()
    require(sha(raw_content) == manifest['messages']['sha256'], 'saved frozen messages hash changed')
    for row in data['rows']:
        declared = (row.get('reviewed_message_binding') or {}).get('messages_file') or {}
        require(declared.get('sha256') == manifest['messages']['sha256'], 'reuse messages do not match frozen row declaration')
    raw = {}
    offset = 0
    for line_number, line in enumerate(raw_content.splitlines(keepends=True),1):
        record = json.loads(line.decode('utf-8-sig'))
        require(isinstance(record.get('key'),str) and record['key'] not in raw, 'duplicate frozen message key')
        record['_position'] = {'line':line_number,'byte_offset':offset,'byte_length':len(line)}
        raw[record['key']] = record
        offset += len(line)
    def ref(declaration):
        require(isinstance(declaration,dict) and isinstance(declaration.get('path'),str), 'explicit local file reference required')
        p = Path(declaration['path'])
        if not p.is_absolute(): p = Path(path).resolve().parent/p
        p = p.resolve()
        require('.private' not in {s.lower() for s in p.parts}, 'forbidden reference path')
        if p not in cache:
            cache[p] = read_json(p)
        value, actual = cache[p]
        require(declaration.get('sha256') == actual, 'saved bundle file hash changed: '+p.name)
        return value
    for b in manifest['bundles']:
        bid = b.get('id')
        require(isinstance(bid,str) and bid and bid not in bundle_ids, 'duplicate or missing bundle ID')
        bundle_ids.add(bid)
        files = {name:ref(b[name]) for name in ('input','analysis','review','scope','source','chat_manifest')}
        local, analysis, review = (files[k] for k in ('input','analysis','review'))
        require(analysis.get('schema_version') == 'lew.local-analysis.v2' and review.get('schema_version') == 'lew.buyer-due-diligence-local.v1', 'unsupported saved review schema')
        require(analysis.get('input_sha256') == b['input']['sha256'] and review.get('analysis_source_sha256') == b['analysis']['sha256'], 'input/analysis/review chain mismatch')
        require(review.get('analysis_as_of') == analysis.get('as_of'), 'saved assessment cutoff mismatch')
        require(local.get('source_sha256') == review.get('source_sha256') == b['source']['sha256'], 'saved source hash mismatch')
        require(local.get('scope_sha256') == review.get('scope_sha256') == b['scope']['sha256'], 'saved scope hash mismatch')
        require(local.get('scope') == review.get('scope') == files['scope'], 'saved scope values differ')
        require((review.get('chat_manifest') or {}).get('sha256') == b['chat_manifest']['sha256'], 'saved chat receipt mismatch')
        # Only artifacts under the existing private data root may be followed, and only
        # after the explicitly supplied receipt bytes have matched their pinned SHA.
        artifacts = files['chat_manifest'].get('artifactsSha256')
        require(isinstance(artifacts,dict) and bool(artifacts), 'saved chat artifact hashes required')
        for name, expected in artifacts.items():
            p = (ROOT/name).resolve()
            require(p.is_relative_to((ROOT/'data').resolve()), 'chat artifact outside project data')
            require('.private' not in {s.lower() for s in p.parts}, 'forbidden reference path')
            if p not in cache: cache[p] = (None,sha(p.read_bytes()))
            require(cache[p][1] == expected, 'saved chat artifact changed')
        inputs, units = unique_units(local.get('units')), unique_units(review.get('units'))
        evidence = analysis.get('evidence')
        require(isinstance(evidence,list), 'saved analysis evidence required')
        by_id = {e['id']:e for e in evidence}
        require(len(by_id) == len(evidence), 'duplicate saved evidence ID')
        bindings.append({'id':bid,**{k:b[k] for k in files}})
        analysis = bind_saved_evidence(analysis,files['chat_manifest'],raw,current)
        evidence = analysis['evidence']
        by_id = {e['id']:e for e in evidence}
        for checked in replay(analysis,review):
            uk = checked['unit_key']
            require(uk in inputs and uk in units, 'profile unit outside saved input')
            u = units[uk]
            base_refs = {(r['store_key'],r['inquiry_id'],r.get('buyer_member_id')) for r in inputs[uk]['inquiry_refs']}
            actual_refs = {(r['store_key'],r['inquiry_id'],r.get('buyer_member_id')) for r in u['inquiry_refs']}
            require(base_refs == actual_refs, 'review unit inquiry membership changed')
            for store, inquiry, member in sorted(actual_refs):
                target = current.get((store,inquiry))
                if target is None or target['excluded']: continue
                if target.get('profile') is not None:
                    rejected.append({'key':[store,inquiry],'bundle':bid,'reason':'frozen profile already present; not overwritten'});continue
                known = [target.get('buyer_member_id'),(target.get('reviewed_message_binding') or {}).get('buyer_member_id'),(target.get('collection_current') or {}).get('precise_member_id')]
                require(isinstance(member,str) and member and target.get('buyer_member_id') == member and all(m == member for m in known if m is not None), 'exact frozen buyer membership mismatch')
                if checked['status'] != 'validated':
                    rejected.append({'key':[store,inquiry],'bundle':bid,'reason':checked['reason']});continue
                profile = checked['profile']
                support = [by_id[eid] for eid in sorted(refs_for(profile))]
                require(all(e.get('unit_key') == uk for e in support), 'profile evidence outside unit')
                projected = []
                for e in support:
                    # Current-purchase evidence is never broadcast across inquiries.
                    if (e.get('store_key'),e.get('inquiry_id')) != (store,inquiry): continue
                    uses = []
                    business_refs = {ref for c in [*profile['business_model'].get('claims',[]),*profile['business_model'].get('conflicts',[])] for ref in c.get('evidence_refs',[])}
                    if e['id'] in business_refs: uses.append('core_category')
                    if e['id'] in profile['entity_assessment'].get('evidence_refs',[]): uses.append('identity')
                    # Other dimensions require an explicit existing evidence use; no text mining.
                    if e.get('use') in ('identity','core_category','business_strength','decisionChain','contact_matrix'): uses.append(e['use'])
                    unavailable = e.get('state','observed')!='observed' or e.get('content_status') in ('metadata_only','recalled_or_hidden','placeholder','empty','unparsed')
                    if unavailable: uses=[]
                    projected.append({**e,'id':f'{bid}:{uk}:{e["id"]}', 'row_key':target.get('row_key'),
                        'use':uses[0] if uses else '已有画像依据', 'dimension_uses':sorted(set(uses)),
                        'description':'原记录仅用于不足说明，正文不可用；见原定位' if unavailable else e.get('quote') or e.get('description') or '已有复核依据，具体内容见原定位',
                        'source_type':'仅元数据/正文不可用（不足上下文）' if unavailable else ('买家陈述（已保存原聊天）' if e.get('direction')=='buyer' else '卖方消息（上下文）') if e.get('kind')=='chat_message' else e.get('kind') or '已有复核来源'})
                # Keep the original IDs inside the profile; namespacing is a display-only
                # alias to avoid colliding with IDs from the frozen final-data index.
                p = copy.deepcopy(profile)
                aliases = {e['id']:f'{bid}:{uk}:{e["id"]}' for e in support}
                def remap(value):
                    if isinstance(value,dict):
                        return {k:[aliases[i] for i in v] if k in ('evidence_refs','reviewed_evidence_refs') else remap(v) for k,v in value.items()}
                    if isinstance(value,list): return [remap(v) for v in value]
                    return value
                p = remap(p)
                fields = ['id','kind','unit_key','store_key','inquiry_id','buyer_member_id','message_id','locator','observed_at','scope','quote','direction','content_status','reply_source','automatic']
                signature = stable({'profile':{k:v for k,v in profile.items() if k!='assessed_at'},
                                    'support':[{k:e[k] for k in fields if k in e} for e in support]})
                candidates.setdefault((store,inquiry),[]).append({'signature':signature,'profile':p,'evidence':projected,
                    'provenance':{'status':'复用已有本地复核记录','assessed_at':profile['assessed_at'],
                                  'review_path':b['review']['path'],'review_sha256':b['review']['sha256'],
                                  'bundle_id':bid,'note':'仅离线适配；未重新研究，不签发正式背调完成证明'}})
    overlays = {}
    for k, values in candidates.items():
        if len({v['signature'] for v in values}) != 1:
            overlays[k] = {'background_reuse':{'status':'版本冲突，未自动复用','note':'存在不同已保存画像或来源，请核对原复核版本'},'profile':None,'evidence':[]}
            continue
        chosen = values[0]
        chosen['provenance']['equivalent_reviews'] = [v['provenance']['review_path'] for v in values]
        chosen['provenance']['account_binding'] = {'store_key':k[0],'inquiry_id':k[1],
            'final_data_sha256':final_sha,'review_sha256':chosen['provenance']['review_sha256'],
            'note':'仅原文件平台账号与商机关联，不证明法定企业或采购意图'}
        overlays[k] = {'unit_key':chosen['profile']['unit_key'],'profile':chosen['profile'],
                       'background_reuse':chosen['provenance'],'evidence':chosen['evidence']}
    for item in rejected:
        k = tuple(item['key'])
        if k not in overlays and current[k].get('profile') is None:
            overlays[k] = {'background_reuse':{'status':'已有复核记录未复用','note':item['reason']},'evidence':[]}
    legacy_receipts = load_legacy_entries(manifest, current, overlays, ref)
    return overlays, {'manifest_sha256':manifest_sha,'bindings':bindings,'rejected':rejected,
                       'legacy_traced': legacy_receipts,
                       'legacy_pending': manifest.get('legacy_pending', []),
                       'overlays':len(overlays),'conflicts':sum(v.get('background_reuse',{}).get('status')=='版本冲突，未自动复用' for v in overlays.values())}
