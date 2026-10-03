"""Prefixed ULIDs, matching the TypeScript ids (e.g. evt_01J9Z...)."""

import secrets
import time

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

PREFIXES = {
    "obligation": "obl",
    "event": "evt",
    "evidence": "evd",
    "agent": "agt",
    "principal": "prn",
    "platform": "plt",
}


def ulid(now_ms: int | None = None) -> str:
    remaining = int(time.time() * 1000) if now_ms is None else now_ms
    time_part = ""
    for _ in range(10):
        time_part = CROCKFORD[remaining % 32] + time_part
        remaining //= 32
    random_part = "".join(CROCKFORD[b % 32] for b in secrets.token_bytes(16))
    return time_part + random_part


def new_id(kind: str) -> str:
    return f"{PREFIXES[kind]}_{ulid()}"
