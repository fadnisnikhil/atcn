"""Canonical JSON (RFC 8785 JCS, restricted to safe integers) - byte-identical to the TypeScript SDK."""

import json
from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1


def _utf16_sort_key(key: str) -> bytes:
    # JCS orders object members by UTF-16 code units, like JavaScript's default sort.
    return key.encode("utf-16-be")


def canonicalize(value: Any) -> str:
    """Serializes a value canonically. Floats are rejected: amounts are integer minor units."""
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
        raise ValueError("floats are not allowed in canonical payloads; use integer minor units")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise ValueError("object keys must be strings")
        members = sorted(value.items(), key=lambda item: _utf16_sort_key(item[0]))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonicalize(v) for k, v in members) + "}"
    raise ValueError(f"unsupported type {type(value).__name__}")
