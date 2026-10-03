"""Webhook signature verification (header: ATCN-Signature: t=..,key_id=..,key_version=..,sig=..)."""

import time
from dataclasses import dataclass

from .crypto import sign_bytes, verify_bytes

WEBHOOK_SIGNATURE_HEADER = "atcn-signature"


@dataclass
class WebhookVerification:
    valid: bool
    reason: str | None = None
    key_id: str | None = None
    key_version: int | None = None


def parse_webhook_header(header: str) -> dict[str, str]:
    parts: dict[str, str] = {}
    for item in header.split(","):
        name, sep, value = item.partition("=")
        if sep:
            parts[name.strip()] = value.strip()
    return parts


def sign_webhook(body: str, key_id: str, key_version: int, private_key: str, timestamp: int | None = None) -> str:
    t = int(time.time()) if timestamp is None else timestamp
    sig = sign_bytes(f"{t}.{body}".encode("utf-8"), private_key)
    return f"t={t},key_id={key_id},key_version={key_version},sig={sig}"


def verify_webhook(body: str, header: str, public_key: str, tolerance_seconds: int = 300, now: int | None = None) -> WebhookVerification:
    """Verifies the raw request body against the header using the published ATCN service key."""
    parts = parse_webhook_header(header)
    if "t" not in parts or "sig" not in parts or not parts["t"].lstrip("-").isdigit():
        return WebhookVerification(False, "malformed_header")
    timestamp = int(parts["t"])
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        return WebhookVerification(False, "timestamp_outside_tolerance")
    if not verify_bytes(f"{timestamp}.{body}".encode("utf-8"), parts["sig"], public_key):
        return WebhookVerification(False, "bad_signature")
    return WebhookVerification(True, None, parts.get("key_id"), int(parts.get("key_version", "0")))
