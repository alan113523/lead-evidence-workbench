"""Validate private host routing metadata and live seller receipts, never credentials."""
import re
import time

from extract_research_view import read_json, require

STORES = ("demoalpha", "demobeta", "demogamma")
ENDPOINT = "https://i.alibaba.com/ajax/sellerProfileAjax.do"


def binding(value):
    require(isinstance(value, dict) and set(value) == {"channel", "browser_id"}, "invalid browser binding")
    require(value["channel"] in {"chrome-devtools", "cua-cdp"} and isinstance(value["browser_id"], str) and
            re.fullmatch(r"[a-zA-Z0-9_.:-]{1,160}", value["browser_id"]), "invalid browser binding")
    return value


def proof(value, store, route, request_id, fresh=True):
    binding(route)
    require(isinstance(value, dict) and set(value) == {"schema_version", "store_key", "store_host", "source_url",
            "browser_binding", "request_id", "observed_at_ms"}, "invalid store proof")
    binding(value["browser_binding"])
    require(value["schema_version"] == "alibaba-store-proof-v1" and isinstance(store, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,62}', store) and value["store_key"] == store and
            value["store_host"] == store+".en.alibaba.com" and value["source_url"] == ENDPOINT, "store identity mismatch")
    require(value["browser_binding"] == route, "browser binding mismatch")
    require(isinstance(value["request_id"], str) and re.fullmatch(r"[a-zA-Z0-9-]{1,100}", value["request_id"]) and
            value["request_id"] == request_id, "identity request mismatch")
    observed = value["observed_at_ms"]
    require(type(observed) is int and 0 < observed <= 9007199254740991 and
            (not fresh or 0 <= int(time.time()*1000)-observed < 300000), "fresh store verification required")
    return value


def resolve(path, store, channel=None):
    require(channel is None or channel in {"chrome-devtools", "cua-cdp"}, "invalid browser channel")
    value = read_json(path)
    require(isinstance(value, dict) and set(value) == {"schema_version", "bindings"} and
            value["schema_version"] == "alibaba-store-browser-map-v1" and isinstance(value["bindings"], list), "invalid browser map")
    stores, browsers, found = set(), set(), []
    for row in value["bindings"]:
        require(isinstance(row, dict), "invalid store proof")
        proof(row, row.get("store_key"), row.get("browser_binding"), row.get("request_id"), fresh=False)
        route = row["browser_binding"]
        shop, browser = (route["channel"], row["store_key"]), (route["channel"], route["browser_id"])
        require(shop not in stores and browser not in browsers, "ambiguous browser map")
        stores.add(shop)
        browsers.add(browser)
        if row["store_key"] == store and (channel is None or route["channel"] == channel):
            found.append(route)
    require(isinstance(store, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,62}', store) and len(found) == 1, "store route missing or ambiguous; select an explicit channel")
    return dict(found[0])
