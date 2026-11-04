// 国家统一为 ISO 3166-1 两位代码，展示用中文名；名称表由 Node ICU 生成（country_names.json）。
import {readFileSync} from 'node:fs';
const NAMES = JSON.parse(readFileSync(new URL('./country_names.json', import.meta.url), 'utf8'));
const fold = v => v.normalize('NFKC').trim().toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ');
const BY_NAME = new Map();
for (const [code, {zh, en}] of Object.entries(NAMES)) for (const n of [code, zh, en, en.replace('&', 'and')]) BY_NAME.set(fold(n), code);
// 平台与业务常见别名
for (const [alias, code] of Object.entries({usa: 'US', 'united states of america': 'US', america: 'US', uk: 'GB', 'great britain': 'GB',
  england: 'GB', uae: 'AE', 'emirates': 'AE', ksa: 'SA', russia: 'RU', 'russian federation': 'RU', 'south korea': 'KR', korea: 'KR',
  'ivory coast': 'CI', "cote d'ivoire": 'CI', 'cote divoire': 'CI', vietnam: 'VN', turkey: 'TR', 'czech republic': 'CZ', holland: 'NL',
  '阿联酋': 'AE', '沙特': 'SA', '韩国': 'KR', '俄罗斯联邦': 'RU', '台湾': 'TW', '香港': 'HK', '澳门': 'MO'})) BY_NAME.set(fold(alias), code);

/** 任意写法 → {code, zh, en}；无法识别返回 null，不猜测。 */
export function normalizeCountry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const code = BY_NAME.get(fold(value)) ?? null;
  return code ? {code, ...NAMES[code]} : null;
}

/** 平台各来源按可信度取第一个能识别的国家；冲突时保留并标出。 */
export function pickCountry(candidates) {
  const found = candidates.map(([source, value]) => ({source, value, country: normalizeCountry(value)})).filter(x => x.value);
  const known = found.filter(x => x.country);
  const codes = [...new Set(known.map(x => x.country.code))];
  return {country: known[0]?.country ?? null, source: known[0]?.source ?? null,
    conflict: codes.length > 1 ? codes : null, unrecognized: found.filter(x => !x.country).map(x => x.value)};
}
