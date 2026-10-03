"""Event signing and evidence envelopes."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .crypto import Signed, digest_of, sha256_digest, sign_payload
from .ids import new_id


def utc_now() -> str:
    """ISO-8601 UTC timestamp with milliseconds and a Z suffix, as ATCN timestamps require."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


@dataclass
class EventSigner:
    """Signs events for one actor. The private key never leaves the caller."""

    actor_id: str
    platform_id: str
    key_id: str
    private_key: str
    key_version: int = 1

    def sign(self, event_type: str, obligation_id: str, data: dict[str, Any] | None = None, causation_ids: list[str] | None = None) -> Signed:
        payload = {
            "schema_version": "1.0",
            "event_id": new_id("event"),
            "event_type": event_type,
            "obligation_id": obligation_id,
            "actor_id": self.actor_id,
            "actor_platform_id": self.platform_id,
            "event_time": utc_now(),
            "causation_ids": causation_ids or [],
            "data": data or {},
        }
        return sign_payload(payload, self.key_id, self.key_version, self.private_key)


def acceptance_data(terms: dict[str, Any], accepting_agent_id: str) -> dict[str, Any]:
    """Data for obligation.accepted: binds the acceptance to the exact terms version, digest, and policy."""
    return {
        "terms_version": terms["terms_version"],
        "terms_digest": digest_of(terms),
        "policy_id": terms["acceptance_policy"]["policy_id"],
        "policy_version": terms["acceptance_policy"]["policy_version"],
        "counterparty_agent_id": accepting_agent_id,
    }


@dataclass
class EvidenceInput:
    evidence_type: str
    producer_id: str
    content: bytes
    uri: str
    retrieval_method: str
    media_type: str
    verifiers: list[str]
    deliverable_ids: list[str]
    visible_to: list[str] = field(default_factory=lambda: ["issuer", "counterparty", "reviewer", "verifier"])


def evidence_envelope(item: EvidenceInput) -> dict[str, Any]:
    """Evidence envelope whose content_digest is computed from the bytes the producer holds."""
    return {
        "evidence_id": new_id("evidence"),
        "evidence_type": item.evidence_type,
        "producer_id": item.producer_id,
        "created_at": utc_now(),
        "content_digest": sha256_digest(item.content),
        "uri": item.uri,
        "retrieval_method": item.retrieval_method,
        "media_type": item.media_type,
        "access_policy": {"visible_to": item.visible_to},
        "verifiers": item.verifiers,
        "deliverable_ids": item.deliverable_ids,
    }
