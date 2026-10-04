"""A2A billing-reference extension: the shared vectors parse the same way in Python as in TypeScript."""

import json
from pathlib import Path

import pytest

from atcn import (
    build_expectation_statement,
    build_outcome_statement,
    digest_of,
    generate_key_pair,
    verify_expectation_signature,
    verify_outcome_signature,
)
from atcn.a2a import (
    BILLING_REF_EXTENSION_URI,
    TERMINAL_CLAIM_BY_STATE,
    BillingRefError,
    billing_ref_extension,
    billing_ref_from_agent_card,
    broken_edge_gap,
    child_delegation_from_a2a,
    delegation_from_a2a,
    downstream_from_metadata,
    downstream_metadata,
    estimate_event_from_a2a,
    estimate_from_metadata,
    lineage_from_metadata,
    lineage_metadata,
    outcome_claim_from_a2a,
    outcome_from_metadata,
    provider_job_ref_for,
    sign_outcome,
    signed_estimate_metadata,
    signed_outcome_metadata,
    stated_skill_price,
    terminal_claim_type,
)

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/schema/test-vectors/billing-ref.json").read_text())
SUBLEDGER_VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/subledger/test-vectors/vectors.json").read_text())
BINDING = {"provider_id": "prv_gamma", "binding_id": "kb_1", "key_id": "gamma-key"}


def test_extension_uri_matches_typescript():
    assert VECTORS["extension_uri"] == BILLING_REF_EXTENSION_URI


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_billing_ref_matches_typescript(case):
    assert billing_ref_from_agent_card(case["card"]) == case["params"]
    assert provider_job_ref_for(case["card"], case["task"]) == case["provider_job_ref"]


@pytest.mark.parametrize("case", VECTORS["invalid"], ids=lambda c: c["name"])
def test_invalid_params_are_refused(case):
    with pytest.raises(BillingRefError):
        billing_ref_from_agent_card(case["card"])


def test_stated_skill_price_and_extension_entry():
    card = VECTORS["cases"][0]["card"]
    assert stated_skill_price(card, "web-search") == {"amount_minor": 1200, "currency": "USD", "unit": "task"}
    assert stated_skill_price(card, "other") is None
    entry = billing_ref_extension({"billing_ref": {"metadata_key": "invoice_ref"}})
    assert entry["uri"] == BILLING_REF_EXTENSION_URI and entry["required"] is False


def test_signed_estimate_metadata_verifies_with_the_agent_key():
    private_key, public_key = generate_key_pair()
    estimate = {
        "source": "beta-agent",
        "source_event_id": "est-1",
        "amount_minor": 9500,
        "currency": "USD",
        "issued_at": "2026-10-01T09:00:00Z",
        "basis": "fixed fee",
        "expires_at": None,
        "supersedes": None,
        "source_ref": None,
    }
    signed = signed_estimate_metadata(estimate, "beta-key-1", private_key)["atcn"]["estimate"]
    assert signed["issued_at"] == "2026-10-01T09:00:00.000Z"
    statement = build_expectation_statement(
        "estimate", "beta-agent", "est-1", 9500, "USD", signed["issued_at"],
        {"issued_by": "agent", "source_ref": None, "basis": "fixed fee", "expires_at": None, "supersedes": None},
    )
    assert verify_expectation_signature(statement, signed["signature"], public_key)


def test_estimate_round_trip_through_metadata_and_into_an_event():
    private_key, _ = generate_key_pair()
    estimate = {
        "source": "beta-agent",
        "source_event_id": "est-1",
        "amount_minor": 9500,
        "currency": "USD",
        "issued_at": "2026-10-01T09:00:00Z",
        "basis": None,
        "expires_at": None,
        "supersedes": None,
        "source_ref": None,
    }
    signed = estimate_from_metadata(signed_estimate_metadata(estimate, "beta-key", private_key))
    assert signed is not None and estimate_from_metadata({"atcn": {"estimate": {"amount_minor": "9500"}}}) is None

    event = estimate_event_from_a2a(signed, {"provider_job_ref": "t-1"}, {**BINDING, "key_id": "beta-key"})
    assert event["event_date"] == "2026-10-01T09:00:00.000Z"
    assert event["expectation"]["signer"] == {"provider_id": "prv_gamma", "binding_id": "kb_1", "key_id": "beta-key", "value": signed["signature"]}
    assert "signer" not in estimate_event_from_a2a(signed, {"provider_job_ref": "t-1"}, BINDING)["expectation"]


def test_delegation_from_a2a_records_the_card_and_the_billing_reference():
    card = VECTORS["cases"][0]["card"]
    task = {"id": "t-1", "contextId": "c-1", "metadata": {"invoice_ref": "inv-77"}}
    delegation = delegation_from_a2a(card, task, "USD", external_ref="first", skill_id="web-search", parent_delegation_id="del_parent")
    assert delegation == {
        "external_ref": "first",
        "parent_delegation_id": "del_parent",
        "provider_name_stated": card["name"],
        "provider_job_ref": provider_job_ref_for(card, task),
        "currency": "USD",
        "execution": {
            "execution_id": "a2a:t-1",
            "protocol": {"name": "a2a", "task_id": "t-1", "context_id": "c-1"},
            "agent": {"agent_id": card["name"], "agent_version": card["version"], "card_digest": digest_of(card)},
            "skill": {"namespace": "a2a", "skill_id": "web-search"},
        },
    }
    plain = {"name": "Plain", "version": "2.0.0", "capabilities": {}}
    fallback = delegation_from_a2a(plain, {"id": "t-2"}, "EUR", agent_id="agt_1", fallback_provider_job_ref="own-ref")
    assert fallback["provider_job_ref"] == "own-ref" and fallback["execution"]["agent"]["agent_id"] == "agt_1"
    assert list(fallback) == ["provider_name_stated", "provider_job_ref", "currency", "execution"]
    assert fallback["execution"]["protocol"] == {"name": "a2a", "task_id": "t-2"}


@pytest.mark.parametrize("case", SUBLEDGER_VECTORS["outcome_statements"], ids=lambda c: c["input"]["type"])
def test_sign_outcome_matches_the_typescript_signature(case):
    given = case["input"]
    outcome = {"type": given["type"], "task_id": given["provider_job_ref"], "occurred_at": given["occurred_at"], "note": given.get("note"), "evidence": given.get("evidence", [])}
    signed = sign_outcome(outcome, "gamma-key", SUBLEDGER_VECTORS["private_key"])
    assert signed["signature"] == case["signature"]
    assert signed["occurred_at"] == case["statement"]["occurred_at"]

    relayed = {**outcome, "key_id": "gamma-key", "signature": case["signature"]}
    claim = outcome_claim_from_a2a(relayed, BINDING)
    statement = build_outcome_statement(claim["type"], given["provider_job_ref"], claim["occurred_at"], claim["note"], claim["evidence"])
    assert verify_outcome_signature(statement, claim["signer"]["value"], SUBLEDGER_VECTORS["public_key"])


def test_outcome_metadata_and_the_buyer_claim():
    private_key, _ = generate_key_pair()
    outcome = {"type": "completion", "task_id": "gamma-task-1", "occurred_at": "2026-10-01T12:06:00Z", "note": "done", "evidence": []}
    metadata = signed_outcome_metadata(outcome, "gamma-key", private_key)
    signed = outcome_from_metadata(metadata)
    assert signed == metadata["atcn"]["outcome"] and signed["occurred_at"] == "2026-10-01T12:06:00.000Z"
    assert outcome_from_metadata({"atcn": {"outcome": {"type": "completion"}}}) is None
    assert outcome_from_metadata(None) is None

    claim = outcome_claim_from_a2a(signed, BINDING)
    assert claim == {
        "type": "completion",
        "asserted_by": "provider",
        "note": "done",
        "occurred_at": "2026-10-01T12:06:00.000Z",
        "evidence": [],
        "signer": {"provider_id": "prv_gamma", "binding_id": "kb_1", "key_id": "gamma-key", "value": signed["signature"]},
    }
    assert "signer" not in outcome_claim_from_a2a(signed, {**BINDING, "key_id": "other"})
    assert "signer" not in outcome_claim_from_a2a(signed)


def test_terminal_states_become_claims():
    assert {state: terminal_claim_type(state) for state in TERMINAL_CLAIM_BY_STATE} == {
        "TASK_STATE_FAILED": "provider_failure",
        "TASK_STATE_CANCELED": "cancellation",
        "TASK_STATE_REJECTED": "cancellation",
    }
    with pytest.raises(ValueError, match="TASK_STATE_COMPLETED is not a terminal non-success A2A state"):
        terminal_claim_type("TASK_STATE_COMPLETED")


def test_lineage_and_downstream_metadata_shapes():
    parent_task = {"id": "beta-task-1", "contextId": "ctx-1", "metadata": {"atcn": {"lineage": [{"task_id": "root-1", "context_id": None, "agent": "Alpha"}, {"bad": 1}]}}}
    assert lineage_metadata(parent_task, "Beta") == {
        "atcn": {"lineage": [{"task_id": "root-1", "context_id": None, "agent": "Alpha"}, {"task_id": "beta-task-1", "context_id": "ctx-1", "agent": "Beta"}]}
    }
    assert lineage_metadata({"id": "x"}, "Solo") == {"atcn": {"lineage": [{"task_id": "x", "context_id": None, "agent": "Solo"}]}}
    assert lineage_from_metadata({}) == [] and lineage_from_metadata({"atcn": {"lineage": "nope"}}) == []

    edges = [
        {"agent": "Gamma", "task_id": "gamma-task-1", "context_id": "ctx-2", "outcome": None},
        {"agent": "Delta", "task_id": "delta-task-1", "context_id": None, "outcome": None},
    ]
    metadata = downstream_metadata(edges)
    assert metadata == {"atcn": {"downstream": edges}}
    assert downstream_from_metadata({"atcn": {"downstream": [*edges, {"agent": 3}, None]}}) == edges

    assert child_delegation_from_a2a(edges[0], "del_beta", "USD", provider_id="prv_gamma") == {
        "parent_delegation_id": "del_beta",
        "provider_id": "prv_gamma",
        "provider_name_stated": "Gamma",
        "provider_job_ref": "gamma-task-1",
        "currency": "USD",
    }
    assert "provider_id" not in child_delegation_from_a2a(edges[1], "del_beta", "USD")
    assert broken_edge_gap(edges[1], "del_delta") == {"delegation_id": "del_delta", "kind": "broken_edge", "detail": "Delta task delta-task-1 reported no outcome"}
