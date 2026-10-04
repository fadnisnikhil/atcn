"""A2A helpers: the billing-reference extension (v1), delegations for A2A tasks, and the estimates, signed outcomes and
multi-hop lineage agents carry in task metadata (metadata.atcn).

Mirrors @atcn/schema (billing.ts) and @atcn/adapter-a2a (billing.ts, outcome.ts, lineage.ts); the shared vectors in
packages/schema/test-vectors/billing-ref.json and packages/subledger/test-vectors/vectors.json keep both in step.
Tasks are A2A wire JSON (camelCase: id, contextId, metadata).
"""

import re
from typing import Any

from .crypto import digest_of
from .subledger import build_expectation_statement, build_outcome_statement, sign_expectation, sign_outcome_statement

Json = dict[str, Any]

BILLING_REF_EXTENSION_URI = "https://github.com/fadnisnikhil/atcn/blob/main/docs/extensions/billing-ref-v1.md"
ATCN_METADATA_KEY = "atcn"
A2A_SKILL_NAMESPACE = "a2a"

_CURRENCY = re.compile(r"^[A-Z]{3}$")


class BillingRefError(ValueError):
    """A card declares the billing-reference extension with params that do not follow the spec."""


def _check_params(params: Any) -> Json:
    if not isinstance(params, dict):
        raise BillingRefError("params must be an object")
    unknown = set(params) - {"billing_ref", "currency", "pricing"}
    if unknown:
        raise BillingRefError(f"unknown params: {', '.join(sorted(unknown))}")
    ref = params.get("billing_ref")
    if isinstance(ref, dict):
        key = ref.get("metadata_key")
        if set(ref) != {"metadata_key"} or not isinstance(key, str) or not 1 <= len(key) <= 100:
            raise BillingRefError("billing_ref object must be exactly {metadata_key: string}")
    elif ref not in ("task_id", "context_id"):
        raise BillingRefError('billing_ref must be "task_id", "context_id" or {metadata_key}')
    currency = params.get("currency")
    if "currency" in params and (not isinstance(currency, str) or not _CURRENCY.match(currency)):
        raise BillingRefError("currency must be an ISO 4217 code")
    pricing = params.get("pricing")
    if "pricing" in params:
        if not isinstance(pricing, list) or len(pricing) > 200:
            raise BillingRefError("pricing must be a list of at most 200 entries")
        for price in pricing:
            if not isinstance(price, dict) or set(price) != {"skill_id", "unit", "amount_minor"}:
                raise BillingRefError("each price must be exactly {skill_id, unit, amount_minor}")
            amount = price["amount_minor"]
            if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
                raise BillingRefError("amount_minor must be a non-negative integer")
            if not isinstance(price["skill_id"], str) or not 1 <= len(price["skill_id"]) <= 200:
                raise BillingRefError("skill_id must be a string of 1 to 200 characters")
            if not isinstance(price["unit"], str) or not 1 <= len(price["unit"]) <= 50:
                raise BillingRefError("unit must be a string of 1 to 50 characters")
    return params


def billing_ref_from_agent_card(card: Json) -> Json | None:
    """The billing-reference params a card declares, or None without the extension. Invalid params raise."""
    extensions = (card.get("capabilities") or {}).get("extensions") or []
    declared = next((e for e in extensions if e.get("uri") == BILLING_REF_EXTENSION_URI), None)
    if declared is None:
        return None
    return _check_params(declared.get("params"))


def provider_job_ref_for(card: Json, task: Json) -> str | None:
    """provider_job_ref for an A2A task (camelCase wire JSON), or None without the extension or the declared value."""
    params = billing_ref_from_agent_card(card)
    if params is None:
        return None
    ref = params["billing_ref"]
    if ref == "task_id":
        return task["id"]
    if ref == "context_id":
        return task.get("contextId") or None
    value = (task.get("metadata") or {}).get(ref["metadata_key"])
    return value if isinstance(value, str) and value else None


def stated_skill_price(card: Json, skill_id: str) -> Json | None:
    """The price a card states for a skill ({amount_minor, currency, unit}), or None."""
    params = billing_ref_from_agent_card(card)
    if params is None or "currency" not in params:
        return None
    price = next((p for p in params.get("pricing", []) if p["skill_id"] == skill_id), None)
    return None if price is None else {"amount_minor": price["amount_minor"], "currency": params["currency"], "unit": price["unit"]}


def billing_ref_extension(params: Json) -> Json:
    """The capabilities.extensions[] entry an agent adds to its card to declare what its bills reference."""
    return {
        "uri": BILLING_REF_EXTENSION_URI,
        "description": "Bills reference this value; buyers match charges to the delegated task by it",
        "required": False,
        "params": _check_params(params),
    }


def signed_estimate_metadata(estimate: Json, key_id: str, private_key: str) -> Json:
    """Agent side: task metadata carrying an estimate signed with the agent's key (metadata.atcn.estimate).

    estimate has source, source_event_id, amount_minor, currency, issued_at, basis, expires_at, supersedes and
    source_ref. Recorded by the buyer only; nothing is reserved or enforced.
    """
    statement = build_expectation_statement(
        "estimate",
        estimate["source"],
        estimate["source_event_id"],
        estimate["amount_minor"],
        estimate["currency"],
        estimate["issued_at"],
        {
            "issued_by": "agent",
            "source_ref": estimate.get("source_ref"),
            "basis": estimate.get("basis"),
            "expires_at": estimate.get("expires_at"),
            "supersedes": estimate.get("supersedes"),
        },
    )
    signed = {
        **estimate,
        "issued_at": statement["issued_at"],
        "expires_at": statement["expires_at"],
        "key_id": key_id,
        "signature": sign_expectation(statement, private_key),
    }
    return {ATCN_METADATA_KEY: {"estimate": signed}}


def _atcn_metadata(metadata: Json | None) -> Json:
    value = (metadata or {}).get(ATCN_METADATA_KEY)
    return value if isinstance(value, dict) else {}


def _signer_for(signed: Json, binding: Json | None) -> Json | None:
    """The signer block for a relayed signature: only with the buyer's key binding for the agent's own key_id."""
    if "signature" not in signed or binding is None or binding["key_id"] != signed.get("key_id"):
        return None
    return {"provider_id": binding["provider_id"], "binding_id": binding["binding_id"], "key_id": binding["key_id"], "value": signed["signature"]}


# ---------- Delegations ----------


def delegation_from_a2a(
    card: Json,
    task: Json,
    currency: str,
    external_ref: str | None = None,
    skill_id: str | None = None,
    agent_id: str | None = None,
    fallback_provider_job_ref: str | None = None,
    parent_delegation_id: str | None = None,
) -> Json:
    """A subledger delegation body for work sent to an A2A agent. provider_job_ref comes from the card's declared billing
    reference (fallback_provider_job_ref when the card declares none), and the run descriptor records the card's digest.
    skill_id is the AgentSkill the task performs; agent_id is the agent's ATCN id, else the card's name identifies it;
    parent_delegation_id is the buyer's delegation the task was sent under when an agent delegates further."""
    protocol = {"name": "a2a", "task_id": task["id"]}
    if task.get("contextId"):
        protocol["context_id"] = task["contextId"]
    execution: Json = {
        "execution_id": f"a2a:{task['id']}",
        "protocol": protocol,
        "agent": {"agent_id": card["name"] if agent_id is None else agent_id, "agent_version": card["version"], "card_digest": digest_of(card)},
    }
    if skill_id:
        execution["skill"] = {"namespace": A2A_SKILL_NAMESPACE, "skill_id": skill_id}
    delegation: Json = {}
    if external_ref:
        delegation["external_ref"] = external_ref
    if parent_delegation_id:
        delegation["parent_delegation_id"] = parent_delegation_id
    job_ref = provider_job_ref_for(card, task)
    return {
        **delegation,
        "provider_name_stated": card["name"],
        "provider_job_ref": job_ref if job_ref is not None else fallback_provider_job_ref,
        "currency": currency,
        "execution": execution,
    }


# ---------- Estimates ----------


def estimate_from_metadata(metadata: Json | None) -> Json | None:
    """The estimate in metadata.atcn.estimate, or None when there is none."""
    value = _atcn_metadata(metadata).get("estimate")
    if not isinstance(value, dict):
        return None
    amount = value.get("amount_minor")
    is_number = isinstance(amount, (int, float)) and not isinstance(amount, bool)
    return value if is_number and isinstance(value.get("source_event_id"), str) else None


def estimate_event_from_a2a(estimate: Json, match: dict[str, str], binding: Json | None = None) -> Json:
    """Buyer side: the financial event body for an agent's estimate, matched like a charge (usually by provider_job_ref).
    binding ({provider_id, binding_id, key_id}) is the buyer's key binding for the agent's key; without one for the
    estimate's key_id the estimate is relayed unsigned and stays buyer_recorded."""
    expectation: Json = {
        "issued_by": "agent",
        "source_ref": estimate["source_ref"],
        "basis": estimate["basis"],
        "expires_at": estimate["expires_at"],
        "supersedes": estimate["supersedes"],
    }
    signer = _signer_for(estimate, binding)
    if signer is not None:
        expectation["signer"] = signer
    return {
        "type": "estimate",
        "source": estimate["source"],
        "source_event_id": estimate["source_event_id"],
        "amount_minor": estimate["amount_minor"],
        "currency": estimate["currency"],
        "event_date": estimate["issued_at"],
        "match": match,
        "expectation": expectation,
    }


# ---------- Signed outcomes ----------

# A2A terminal states where the work ended undelivered, and the subledger claim each one becomes.
TERMINAL_CLAIM_BY_STATE = {
    "TASK_STATE_FAILED": "provider_failure",
    "TASK_STATE_CANCELED": "cancellation",
    "TASK_STATE_REJECTED": "cancellation",
}


def terminal_claim_type(state: str) -> str:
    """The subledger claim type for an A2A task that ended undelivered; raises ValueError for any other state."""
    claim_type = TERMINAL_CLAIM_BY_STATE.get(state)
    if claim_type is None:
        raise ValueError(f"{state} is not a terminal non-success A2A state; use TASK_STATE_FAILED, TASK_STATE_CANCELED or TASK_STATE_REJECTED")
    return claim_type


def sign_outcome(outcome: Json, key_id: str, private_key: str) -> Json:
    """Agent side: how the agent's A2A task ended, signed with the agent's key.

    outcome has type (completion, partial_completion, cancellation or provider_failure), task_id, occurred_at, note and
    evidence ([{uri, digest, evidence_type}]). The signature covers the task id as the provider_job_ref.
    """
    statement = build_outcome_statement(outcome["type"], outcome["task_id"], outcome["occurred_at"], outcome["note"], outcome["evidence"])
    return {**outcome, "occurred_at": statement["occurred_at"], "key_id": key_id, "signature": sign_outcome_statement(statement, private_key)}


def signed_outcome_metadata(outcome: Json, key_id: str, private_key: str) -> Json:
    """Agent side: task or status metadata carrying a signed outcome (metadata.atcn.outcome)."""
    return {ATCN_METADATA_KEY: {"outcome": sign_outcome(outcome, key_id, private_key)}}


def outcome_from_metadata(metadata: Json | None) -> Json | None:
    """The outcome in metadata.atcn.outcome, or None when there is none."""
    value = _atcn_metadata(metadata).get("outcome")
    if not isinstance(value, dict):
        return None
    return value if isinstance(value.get("task_id"), str) and isinstance(value.get("type"), str) else None


def outcome_claim_from_a2a(outcome: Json, binding: Json | None = None) -> Json:
    """Buyer side: the delivery claim body for an agent's outcome, for the delegation whose provider_job_ref is the task
    id. The signature counts only with the buyer's key binding ({provider_id, binding_id, key_id}) for the outcome's
    key_id; otherwise the claim is relayed unsigned and stays buyer_recorded."""
    claim = {
        "type": outcome["type"],
        "asserted_by": "provider",
        "note": outcome["note"],
        "occurred_at": outcome["occurred_at"],
        "evidence": outcome["evidence"],
    }
    signer = _signer_for(outcome, binding)
    if signer is not None:
        claim["signer"] = signer
    return claim


# ---------- Multi-hop lineage ----------


def _hops(value: Any) -> list[Json]:
    """Entries of a lineage or downstream list with a string task_id and agent."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict) and isinstance(item.get("task_id"), str) and isinstance(item.get("agent"), str)]


def lineage_from_metadata(metadata: Json | None) -> list[Json]:
    """The chain of tasks in metadata.atcn.lineage ([{task_id, context_id, agent}]), root first; empty when there is none."""
    return _hops(_atcn_metadata(metadata).get("lineage"))


def lineage_metadata(parent_task: Json, agent: str) -> Json:
    """Delegating agent's side: metadata for the message that starts a sub-task. The chain is the one the agent's own
    task arrived with, plus its own task."""
    hop = {"task_id": parent_task["id"], "context_id": parent_task.get("contextId"), "agent": agent}
    return {ATCN_METADATA_KEY: {"lineage": [*lineage_from_metadata(parent_task.get("metadata")), hop]}}


def downstream_metadata(edges: list[Json]) -> Json:
    """Delegating agent's side: task or status metadata reporting its sub-tasks (metadata.atcn.downstream).
    Each edge is {agent, task_id, context_id, outcome}, with the sub-agent's own (signed) outcome relayed unchanged,
    or None when none arrived."""
    return {ATCN_METADATA_KEY: {"downstream": edges}}


def downstream_from_metadata(metadata: Json | None) -> list[Json]:
    """The sub-tasks in metadata.atcn.downstream; empty when there are none."""
    return _hops(_atcn_metadata(metadata).get("downstream"))


def child_delegation_from_a2a(edge: Json, parent_delegation_id: str, currency: str, provider_id: str | None = None) -> Json:
    """Buyer side: the child delegation body for a reported sub-task, under the delegation of the agent that reported
    it. Pass provider_id when the sub-agent is a known provider with a bound key, so its signed outcome counts."""
    delegation: Json = {"parent_delegation_id": parent_delegation_id}
    if provider_id:
        delegation["provider_id"] = provider_id
    return {**delegation, "provider_name_stated": edge["agent"], "provider_job_ref": edge["task_id"], "currency": currency}


def broken_edge_gap(edge: Json, child_delegation_id: str) -> Json:
    """Buyer side: the capture gap body for a sub-task that reported no outcome."""
    return {"delegation_id": child_delegation_id, "kind": "broken_edge", "detail": f"{edge['agent']} task {edge['task_id']} reported no outcome"}
