"""Local input validation shared by the public research-clue adapters."""
from datetime import datetime
import hashlib
import ipaddress
import json
from pathlib import Path
import re
from urllib.parse import parse_qsl, urlsplit


class Invalid(ValueError):
    pass


def require(value, message):
    if not value:
        raise Invalid(message)


def timestamp(value):
    require(isinstance(value, str), "timestamp must be text")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Invalid("invalid timestamp") from exc
    require(parsed.tzinfo is not None, "timestamp needs timezone")
    return parsed


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "JSON contains duplicate keys")
            result[key] = value
        return result

    def nonfinite(_):
        raise Invalid("nonfinite JSON number")

    return json.loads(Path(path).read_text(encoding="utf-8-sig"),
                      object_pairs_hook=pairs, parse_constant=nonfinite)


def safe_text(value):
    require(isinstance(value, str), "text required")
    require(not re.search(r"(?i)<\s*/?\s*(?:script|iframe|html|body)|(?:bearer\s+\S+)|(?:token|authorization|cookie|password|secret|api[_-]?key)\s*[:=]\s*\S+", value), "unsafe text")
    require(not re.search(r"(?i)(?:file|javascript|data):|https?://[^\s/]+:[^\s/]+@", value), "private transport")
    return value


def public_url(value):
    safe_text(value)
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError as exc:
        raise Invalid("invalid URL") from exc
    require(parsed.scheme in {"http", "https"} and host and "." in host,
            "public HTTP URL required")
    require(not parsed.username and not getattr(parsed, "pass" + "word") and port in {None, 80, 443}, "private URL")
    require(not host.endswith((".localhost", ".local", ".internal")) and host != "localhost", "local URL")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    require(address is None or address.is_global, "private IP URL")
    require(host not in {"i.alibaba.com", "message.alibaba.com", "workspace.alibaba.com", "crm.alibaba.com", "profile.alibaba.com"}, "account URL")
    require(not any(re.search(r"(?i)token|session|auth|cookie|password|secret|signature|^sign$", key)
                    for key, _ in parse_qsl(parsed.query)), "credential URL")
    return value
