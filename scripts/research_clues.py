"""Pure projection of explicitly saved contact fields; no lookup or contact action."""
import copy
import re

SCHEMA = 'lew.research-clues.v1'
FIELDS = ('name', 'email', 'website', 'phone', 'whatsapp')
MISSING = object()
EMPTY = {'', '-', '--', '—', '未提供', '未知', '暂无', '无', 'null', 'none', 'n/a'}


def at(record, path):
    value = record
    for part in path.split('/') if path else []:
        if isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return MISSING
    return value


def empty_clues():
    return {'schema_version': SCHEMA, 'fields': {name: {'status': 'not_collected', 'items': []} for name in FIELDS},
            'research_status': 'not_performed', 'contact_status': 'not_contacted'}


def summarize(field):
    states = {i['status'] for i in field['items']}
    field['status'] = next((s for s in ('present', 'masked', 'needs_review', 'blocked', 'missing') if s in states), 'not_collected')
    if len({i['value'] for i in field['items'] if i['status'] == 'present'}) > 1:
        field['status'] = 'multiple_values'


def merge_clues(left, right):
    result = copy.deepcopy(left)
    for name in FIELDS:
        for item in right['fields'][name]['items']:
            if item not in result['fields'][name]['items']:
                result['fields'][name]['items'].append(copy.deepcopy(item))
        summarize(result['fields'][name])
    return result


def saved_clues(record, shape, source=None, observed_at=None):
    """Keep raw values and exact field locations, including missing/masked fields."""
    from input_utils import safe_text, public_url, timestamp
    result = empty_clues()
    if observed_at is not None:
        timestamp(observed_at)
    source = source or {'kind': 'in_memory', 'pointer': ''}
    prefix = source.get('pointer', '')

    def add(name, path, label=None, value_override=MISSING, components=None):
        value = at(record, path) if value_override is MISSING else value_override
        if value is MISSING:
            return
        item = {'value': None, 'status': 'missing', 'source': {**source, 'pointer': prefix + '/' + path},
                'observed_at': observed_at, 'observation_status': 'recorded' if observed_at else 'not_recorded',
                'source_nature': 'saved_platform_or_export_field', 'usable_as_search_term': False}
        item['association_status'] = ('crm_customer_contact_not_buyer_authority_confirmation' if shape == 'crm_v3'
                                      else 'exact_saved_account_keys_not_live_authentication' if shape == 'platform_accepted'
                                      else 'frozen_source_keys_only')
        if label:
            item['platform_label'] = label
        if components:
            item['source']['component_pointers'] = [prefix + '/' + p for p in components]
            item['normalization'] = 'joined_name_parts_from_same_contact'
        if value is None or isinstance(value, str) and value.strip().lower() in EMPTY:
            result['fields'][name]['items'].append(item)
            return
        if not isinstance(value, (str, int)) or isinstance(value, bool):
            item.update(status='needs_review', reason='unsupported_field_shape')
            result['fields'][name]['items'].append(item)
            return
        raw = str(value).strip()
        try:
            safe_text(raw)
            if name == 'website':
                public_url(raw if '://' in raw else 'https://' + raw)
        except ValueError:
            item.update(status='blocked', reason='private_link_credentials_or_unsafe_content')
            result['fields'][name]['items'].append(item)
            return
        item['value'] = raw
        masked = bool(re.search(r'[*•●…]|(?:\d[xX]{2,}|[xX]{2,}\d)', raw))
        if masked:
            item.update(status='masked', reason='masked_value_not_reconstructed')
        elif name == 'email' and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', raw):
            item.update(status='needs_review', reason='email_syntax_unconfirmed')
        elif name in ('phone', 'whatsapp') and not (
                re.fullmatch(r'[+\d(). /-]+', raw) and 5 <= len(re.sub(r'\D', '', raw)) <= 20
                or name == 'whatsapp' and raw.startswith(('https://wa.me/', 'https://api.whatsapp.com/', 'https://www.whatsapp.com/'))):
            item.update(status='needs_review', reason='number_or_handle_format_unconfirmed')
        else:
            item.update(status='present', usable_as_search_term=True)
        result['fields'][name]['items'].append(item)

    def scalar_or_list(name, path):
        value = at(record, path)
        if isinstance(value, list):
            for i in range(len(value)):
                add(name, path + '/' + str(i))
            if not value:
                result['fields'][name]['items'].append({'value': None, 'status': 'missing',
                    'source': {**source, 'pointer': prefix + '/' + path}, 'observed_at': observed_at,
                    'observation_status': 'recorded' if observed_at else 'not_recorded',
                    'source_nature': 'saved_platform_or_export_field', 'usable_as_search_term': False})
        else:
            add(name, path)

    def social(path):
        items = at(record, path)
        if not isinstance(items, list):
            return
        for i, account in enumerate(items):
            if not isinstance(account, dict):
                continue
            labels = [account.get(k) for k in ('type', 'name', 'label', 'platform', 'imType')]
            whatsapp = [v for v in labels if isinstance(v, str) and re.sub(r'[\s_-]', '', v.lower()) in ('whatsapp', 'whatsappbusiness')]
            if whatsapp:
                for key in ('account', 'value', 'number', 'phoneNumber', 'accountName'):
                    if key in account:
                        add('whatsapp', f'{path}/{i}/{key}', whatsapp[0])

    if shape in ('population', 'inquiry'):
        for name, paths in {'name': ['buyer_name', 'contact_name'], 'email': ['email', 'emailFull'],
                            'website': ['official_website', 'website'], 'phone': ['phone', 'mobile', 'telephone'],
                            'whatsapp': ['whatsapp', 'whatsApp', 'whatsappNumber']}.items():
            for path in paths:
                add(name, path, 'WhatsApp field' if name == 'whatsapp' else None)
        social('socialAccounts')
    elif shape == 'intake_export':
        for name, paths in {'name': ['raw/客户名'], 'email': ['raw/邮箱'], 'website': ['raw/官网', 'raw/网站'],
                            'phone': ['raw/手机', 'raw/座机'], 'whatsapp': ['raw/WhatsApp', 'raw/whatsapp']}.items():
            for path in paths:
                add(name, path, 'WhatsApp export column' if name == 'whatsapp' else None)
    elif shape in ('crm_v3', 'platform_accepted'):
        detail = 'customerDetail/fieldsMissingFromList/contacts'
        if shape == 'platform_accepted':
            detail = 'customerDetail/contactQueryCOList'
        contacts = at(record, detail)
        if isinstance(contacts, list):
            for i, contact in enumerate(contacts):
                if not isinstance(contact, dict):
                    continue
                if shape == 'platform_accepted':
                    member = record.get('buyer_member_id', '').removeprefix('alibaba-visible-member:')
                    main_id = (record.get('identity_binding') or {}).get('main_contact_id')
                    if not member or contact.get('loginId') != member or main_id is None or contact.get('id') != main_id:
                        continue
                p = detail + '/' + str(i)
                if contact.get('contactName'):
                    add('name', p + '/contactName')
                else:
                    components = [p + '/' + key for key in ('firstName', 'lastName')
                                  if isinstance(contact.get(key), str) and contact[key].strip()]
                    if components:
                        add('name', p, value_override=' '.join(at(record, part).strip() for part in components), components=components)
                for key in ('emailFull', 'email', 'maskedEmail'):
                    scalar_or_list('email', p + '/' + key)
                for key in ('mobile', 'phone'):
                    add('phone', p + '/' + key)
                for key in ('mobiles', 'phoneNumbers'):
                    phones = at(record, p + '/' + key)
                    if isinstance(phones, list):
                        for j, phone in enumerate(phones):
                            if isinstance(phone, dict):
                                for f in ('phoneNumber', 'number'):
                                    add('phone', f'{p}/{key}/{j}/{f}')
                                    if f in phone and result['fields']['phone']['items']:
                                        parts = {k: str(phone[k]) for k in ('countryCode', 'areaCode', 'ext') if phone.get(k) is not None}
                                        try:
                                            for part in parts.values(): safe_text(part)
                                        except ValueError:
                                            parts = {}
                                        if parts: result['fields']['phone']['items'][-1]['saved_number_parts'] = parts
                            else:
                                add('phone', f'{p}/{key}/{j}')
                for key in ('whatsapp', 'whatsApp', 'whatsappNumber'):
                    add('whatsapp', p + '/' + key, 'WhatsApp field')
                social(p + '/socialAccounts')
                social(p + '/ims')
        for name, paths in {'name': ['buyerHomepage/buyerProfile/displayName'],
                            'email': ['buyerHomepage/buyerProfile/maskedEmail'],
                            'phone': ['buyerHomepage/buyerProfile/phoneNumber'],
                            'website': ['buyerHomepage/enterpriseInfo/officialWebsite', 'customerDetail/fieldsMissingFromList/website',
                                        'customerDetail/customerDetailCO/website', 'crmFields/website']}.items():
            for path in paths:
                add(name, path)
    else:
        raise ValueError('unsupported research clue source format')
    for field in result['fields'].values():
        summarize(field)
    return result
