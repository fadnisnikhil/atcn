"""End-to-end against a running ATCN API: Python-signed events are verified by the TypeScript service.

Runs when ATCN_BASE_URL is set and ATCN_SEED_FILE points to the API's seed file (its dev keys and API keys).
"""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from atcn import AtcnApiError, AtcnClient, EventSigner, acceptance_data, digest_of, new_id

BASE_URL = os.environ.get("ATCN_BASE_URL")
SEED_PATH = Path(os.environ.get("ATCN_SEED_FILE", ".data/dev-keys/seed.json"))

pytestmark = pytest.mark.skipif(not BASE_URL or not SEED_PATH.exists(), reason="set ATCN_BASE_URL and ATCN_SEED_FILE")


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def signer(actor: dict, platform_id: str) -> EventSigner:
    return EventSigner(actor_id=actor["id"], platform_id=platform_id, key_id=actor["keyId"], private_key=actor["privateKey"])


def test_offer_accept_and_idempotent_retry():
    seed = json.loads(SEED_PATH.read_text())
    acme_client = AtcnClient(BASE_URL, seed["acme"]["apiKey"])
    beta_client = AtcnClient(BASE_URL, seed["beta"]["apiKey"])
    orchestrator = signer(seed["acme"]["orchestrator"], seed["acme"]["platform"]["id"])
    coder = signer(seed["beta"]["coder"], seed["beta"]["platform"]["id"])

    policy = acme_client.request("GET", "/v1/policies/code-change-checks/1.0.0")
    now = datetime.now(timezone.utc)
    obligation_id = new_id("obligation")
    terms = {
        "schema_version": "1.0",
        "obligation_id": obligation_id,
        "terms_version": 1,
        "parent_obligation_id": None,
        "principal_id": seed["acme"]["principal"]["id"],
        "payer_id": seed["acme"]["principal"]["id"],
        "issuer_agent_id": orchestrator.actor_id,
        "counterparty_agent_id": coder.actor_id,
        "payee_selection": None,
        "scope": {"task_type": "code_change", "description": "Python SDK interop check"},
        "currency": "USD",
        "max_amount_minor": 500,
        "deliverables": [{"deliverable_id": "main", "description": "Patch", "amount_minor": 500, "required_checks": ["unit_tests", "lint", "patch"]}],
        "acceptance_policy": {"policy_id": "code-change-checks", "policy_version": "1.0.0", "policy_digest": policy["policy_digest"]},
        "deadline": iso(now + timedelta(days=3)),
        "offer_expires_at": iso(now + timedelta(days=1)),
        "allow_subdelegation": False,
        "subdelegation_limits": None,
        "dispute_reviewer_id": None,
        "verifier_agent_ids": [],
        "issued_at": iso(now),
    }
    offer = orchestrator.sign("obligation.offered", obligation_id, {"terms": terms, "terms_digest": digest_of(terms)})
    created = acme_client.create_obligation(offer)
    assert created["obligation"]["state"] == "offered"
    assert created["obligation"]["terms_digest"] == digest_of(terms)

    replay = acme_client.create_obligation(offer)
    assert replay == created

    accepted = beta_client.accept_obligation(obligation_id, coder.sign("obligation.accepted", obligation_id, acceptance_data(terms, coder.actor_id)))
    assert accepted["obligation"]["state"] == "accepted"

    forged = coder.sign("obligation.started", obligation_id)
    forged["payload"]["actor_id"] = orchestrator.actor_id
    with pytest.raises(AtcnApiError) as error:
        acme_client.append_event(obligation_id, forged)
    assert error.value.status in (401, 403, 400)
