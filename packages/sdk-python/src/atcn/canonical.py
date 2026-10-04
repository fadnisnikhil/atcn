"""Canonical JSON (RFC 8785 JCS, restricted to safe integers) - byte-identical to the TypeScript SDK."""

import json
import re
from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _utf16_sort_key(key: str) -> bytes:
    # JCS orders object members by UTF-16 code units, like JavaScript's default sort.
    return key.encode("utf-16-be", "surrogatepass")


def _json_string(text: str) -> str:
    # JSON.stringify writes a lone surrogate as a \u escape; json.dumps would leave it unencodable.
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", json.dumps(text, ensure_ascii=False))


def canonicalize(value: Any) -> str:
    """Serializes a value canonically. Non-integer floats are rejected: amounts are integer minor units."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError(f"integer {value} exceeds the safe integer range")
        return str(value)
    if isinstance(value, float):
        # JSON 1.0 and 1 are the same value (JavaScript cannot tell them apart), so integral floats serialize as integers.
        if not value.is_integer():
            raise ValueError("floats are not allowed in canonical payloads; use integer minor units")
        return canonicalize(int(value))
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise ValueError("object keys must be strings")
        members = sorted(value.items(), key=lambda item: _utf16_sort_key(item[0]))
        return "{" + ",".join(_json_string(k) + ":" + canonicalize(v) for k, v in members) + "}"
    raise ValueError(f"unsupported type {type(value).__name__}")
