"""国家统一为中文名（与 scripts/country.mjs 共用 country_names.json）；识别不了的原样保留，不猜。"""
import json
import re
import unicodedata
from pathlib import Path

NAMES = json.loads((Path(__file__).with_name("country_names.json")).read_text(encoding="utf-8"))
ALIASES = {"usa": "US", "united states of america": "US", "america": "US", "uk": "GB", "great britain": "GB", "england": "GB",
           "uae": "AE", "emirates": "AE", "ksa": "SA", "russia": "RU", "russian federation": "RU", "south korea": "KR", "korea": "KR",
           "ivory coast": "CI", "cote d'ivoire": "CI", "cote divoire": "CI", "vietnam": "VN", "turkey": "TR", "czech republic": "CZ",
           "holland": "NL", "阿联酋": "AE", "沙特": "SA", "韩国": "KR", "俄罗斯联邦": "RU", "台湾": "TW", "香港": "HK", "澳门": "MO"}


def _fold(value):
    return re.sub(r"\s+", " ", re.sub(r"[.'’]", "", unicodedata.normalize("NFKC", value).strip().lower()))


BY_NAME = {}
for _code, _n in NAMES.items():
    for _name in (_code, _n["zh"], _n["en"], _n["en"].replace("&", "and")):
        BY_NAME[_fold(_name)] = _code
for _alias, _code in ALIASES.items():
    BY_NAME[_fold(_alias)] = _code


def country_zh(value):
    """任意写法 → 中文国名；空值返回 None；识别不了返回原值。"""
    if not isinstance(value, str) or not value.strip() or value.strip() == "未取得":
        return None
    code = BY_NAME.get(_fold(value))
    return NAMES[code]["zh"] if code else value.strip()
