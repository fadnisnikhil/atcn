"""Offline verification of a closure package, check for check the same as @atcn/core's verifyClosurePackage.

A closure package is the clearing network's signed record of an obligation tree: its events, keys, policies, evidence
envelopes, verifier results, clearing decisions, journal and settlement. verify_closure_package checks the signatures,
the event references and obligation lineage, re-runs the deterministic clearing engine for every automated decision,
checks that the journal balances, the settlement references, that the package's tables match the events the service
signed, the trace evidence (given the trace files) and, for package 1.1, the attestation conflicts. It makes no network
calls. The report has the same check names, results and details as the TypeScript verifier and `npx @atcn/verify-cli`.

Differences from the TypeScript verifier, all on hostile input only:
- Ed25519 is verified by OpenSSL (strict RFC 8032); the TypeScript verifier uses noble's ZIP-215 rules, which also
  accept some non-canonical point encodings. A signature crafted for that gap verifies there and fails here.
- z.url() (a skill's agent_card_url) is approximated by a scheme check.
- Where the TypeScript code sorts with a comparator that never returns 0 (picking the newest evidence or verifier
  result), V8's order is reproduced exactly for fewer than 64 candidates. With 64 or more candidates that share both
  sort keys, a different one may be picked.
- An object key named "__proto__" is kept as an ordinary key; JavaScript drops it when zod copies the object.
"""

import functools
import json
from typing import Any, Callable

from .canonical import MAX_SAFE_INTEGER, _utf16_sort_key
from .crypto import digest_of, sha256_digest, verify_payload
from .documents import (
    _MISSING,
    AGENT_TRACE,
    AMOUNT_MINOR,
    ATTESTATION_REF,
    CANONICAL_VALUE,
    DIGEST,
    EXECUTION_BINDING,
    EXECUTION_DESCRIPTOR,
    ISO_DATETIME,
    POSITIVE,
    PRICING,
    REFUND_TERMS,
    SKILL_REF,
    Array,
    Bool,
    Enum,
    Int,
    Literal,
    Nullable,
    Obj,
    Optional,
    Record,
    Refined,
    Str,
    Union,
    parse,
)
from .projection import date_parse, disputes_in_effect, find_conflicts, in_effect, resolve_attestations
from .rails import _js_number, _js_string
from .trace import _js_add, trace_digest, trace_problems, usage_cost_details

Json = dict[str, Any]

SUPPORTED_PACKAGE_VERSIONS = ("1.0", "1.1")
SERVICE_ACTOR = "svc_atcn"
CLEARING_ENGINE_ID = "atcn-clearing-engine@1.1.0"
CLEARING_ENGINE_ID_V1_0 = "atcn-clearing-engine@1.0.0"
AGENT_TRACE_EVIDENCE_TYPE = "agent_trace"
ATTESTATION_EVIDENCE_TYPES = ("verifier_attestation", "witness_attestation")
CLEARING_SOURCE = "atcn-clearing"

EVENT_TYPE_NAMES = (
    "obligation.created",
    "obligation.offered",
    "obligation.accepted",
    "obligation.amended",
    "obligation.delegated",
    "obligation.started",
    "evidence.submitted",
    "completion.proposed",
    "completion.accepted",
    "completion.partially_accepted",
    "completion.rejected",
    "completion.insufficient_evidence",
    "completion.disputed",
    "dispute.opened",
    "dispute.resolved",
    "obligation.cancelled",
    "obligation.expired",
    "obligation.cleared",
    "journal.posted",
    "settlement.reported",
    "journal.reversed",
    "event.superseded",
)
CLEARING_OUTCOMES = ("accepted", "partially_accepted", "rejected", "insufficient_evidence", "disputed", "cancelled", "expired")
SETTLEMENT_STATUSES = ("submitted", "processing", "pending_finality", "settled", "failed", "returned", "refunded", "unknown")
SETTLEMENT_ADAPTERS = ("manual", "sandbox", "stripe")
ACCOUNT_TYPES = (
    "obligation_expense",
    "contingent_expense",
    "contingent_payable",
    "payable",
    "receivable",
    "platform_fee",
    "dispute_frozen",
    "reserve_reported",
    "settlement_reported",
    "refund",
    "unallocated_residual",
)
ALLOCATION_ROLES = (
    "payer_expense",
    "payee_share",
    "parent_margin",
    "child_cost",
    "platform_fee",
    "contingent",
    "dispute_freeze",
    "settlement",
    "reserve",
    "refund",
    "unallocated_residual",
)
ENTRY_TYPES = ("contingent", "clearing", "dispute_freeze", "dispute_release", "settlement", "reserve", "refund", "return", "reversal")
REASON_CODES = (
    "missing_evidence",
    "invalid_evidence",
    "failed_criteria",
    "verifier_unavailable",
    "probabilistic_review_required",
    "partial_not_permitted",
    "passed",
    "dispute_amended",
    "dispute_upheld",
    "failure_terms_dispute",
    "conflicting_attestations",
    "witness_quorum_not_met",
)
CONFLICT_KINDS = ("equivocation", "disagreement", "execution_mismatch", "disputed")
OUTCOME_EVENT_TYPES = ("completion.accepted", "completion.partially_accepted", "completion.rejected", "completion.insufficient_evidence", "completion.disputed")

# ---------- Schemas (@atcn/schema types.ts) ----------

_ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}"


def _prefixed(prefix: str) -> Str:
    return Str(pattern=f"^{prefix}_{_ULID_BODY}$", message=f"expected {prefix}_<ULID>")


PRINCIPAL_ID = _prefixed("prn")
PLATFORM_ID = _prefixed("plt")
AGENT_ID = _prefixed("agt")
OBLIGATION_ID = _prefixed("obl")
EVENT_ID = _prefixed("evt")
EVIDENCE_ID = _prefixed("evd")
DECISION_ID = _prefixed("dec")
KEY_ID = Str(pattern=f"^(key_{_ULID_BODY}|key_atcn_service)$")
ACTOR_ID = Str(pattern=f"^((prn|agt|plt)_{_ULID_BODY}|svc_atcn)$")
CURRENCY = Str(pattern=r"^[A-Z]{3}$")
SEMVER = Str(pattern=r"^\d+\.\d+\.\d+$")
SNAKE_NAME = Str(pattern=r"^[a-z0-9_]+$")
CANONICAL_RECORD = Record(Str(), CANONICAL_VALUE)

SIGNATURE = Obj({"key_id": KEY_ID, "key_version": POSITIVE, "algorithm": Literal("Ed25519"), "value": Str(min_length=1)})
MODEL = Obj({"name": Str(), "version": Str(), "confidence_bps": Int()})

POLICY_CHECK = Obj({"check_id": SNAKE_NAME, "verifier": SNAKE_NAME, "verifier_version": SEMVER, "evidence_type": SNAKE_NAME, "config": CANONICAL_RECORD})
POLICY_TEMPLATE = Obj(
    {
        "schema_version": Literal("1.0"),
        "policy_id": Str(pattern=r"^[a-z0-9-]+$"),
        "policy_version": SEMVER,
        "task_type": Str(min_length=1),
        "description": Str(),
        "evidence_admissibility": Obj(
            {"allowed_producers": Array(Enum(("issuer", "counterparty", "verifier", "witness")), 1), "require_digest_match": Bool()}
        ),
        "required_evidence": Array(SNAKE_NAME),
        "checks": Array(POLICY_CHECK),
        "thresholds": Obj({"partial_acceptance": Bool(), "failed_portion_outcome": Enum(("rejected", "disputed"))}),
        "verifier_unavailable_outcome": Enum(("insufficient_evidence", "disputed")),
        "probabilistic_routing": Enum(("evidence_only", "human_review")),
        "timeouts": Obj({"evaluation_window_seconds": POSITIVE}),
        "dispute": Obj({"window_seconds": POSITIVE, "review_window_seconds": POSITIVE, "default_outcome": Enum(("uphold",))}),
        "allocation": Obj({"platform_fee_bps": Int(("min", 0), ("max", 10000))}),
        "rounding": Literal("largest_remainder"),
    }
)
POLICY_REF = Obj({"policy_id": Str(), "policy_version": SEMVER, "policy_digest": DIGEST})
DELIVERABLE = Obj({"deliverable_id": Str(pattern=r"^[a-z0-9_-]+$"), "description": Str(), "amount_minor": AMOUNT_MINOR, "required_checks": Array(Str(), 1)})
WITNESS_POLICY = Obj(
    {
        "min_independent_witnesses": Int(("min", 1), ("max", 10)),
        "witness_agent_ids": Optional(Array(AGENT_ID, 1, 20)),
        "independence": Literal("distinct_verified_domain"),
    },
    strict=True,
)


def _js_sum(values: Any) -> int | float:
    """A sum as JavaScript adds numbers: exact while it stays a safe integer, then in floating point."""
    total: int | float = 0
    for value in values:
        total = _js_add(total, value)
    return total


def _no_listed_party_witnesses(t: Json) -> bool:
    witnesses = (t.get("witness_policy") or {}).get("witness_agent_ids", [])
    return not any(w in (t["issuer_agent_id"], t["counterparty_agent_id"], t["principal_id"]) for w in witnesses)


OBLIGATION_TERMS = Refined(
    Obj(
        {
            "schema_version": Enum(("1.0", "1.1", "1.2")),
            "obligation_id": OBLIGATION_ID,
            "terms_version": POSITIVE,
            "parent_obligation_id": Nullable(OBLIGATION_ID),
            "principal_id": PRINCIPAL_ID,
            "payer_id": Union([PRINCIPAL_ID, AGENT_ID]),
            "issuer_agent_id": AGENT_ID,
            "counterparty_agent_id": Nullable(AGENT_ID),
            "payee_selection": Nullable(Obj({"type": Literal("open_offer"), "allowed_platform_ids": Array(PLATFORM_ID, 1)})),
            "scope": Obj({"task_type": Str(min_length=1), "description": Str(min_length=1), "artifact_ref": Optional(Str())}),
            "currency": CURRENCY,
            "max_amount_minor": AMOUNT_MINOR,
            "deliverables": Array(DELIVERABLE, 1),
            "acceptance_policy": POLICY_REF,
            "deadline": ISO_DATETIME,
            "offer_expires_at": ISO_DATETIME,
            "allow_subdelegation": Bool(),
            "subdelegation_limits": Nullable(Obj({"max_depth": POSITIVE, "max_total_minor": AMOUNT_MINOR, "allowed_policy_ids": Array(Str())})),
            "dispute_reviewer_id": Nullable(Union([AGENT_ID, PRINCIPAL_ID])),
            "verifier_agent_ids": Array(AGENT_ID),
            "issued_at": ISO_DATETIME,
            "skill": Optional(SKILL_REF),
            "pricing": Optional(PRICING),
            "refund_terms": Optional(REFUND_TERMS),
            "witness_policy": Optional(WITNESS_POLICY),
        }
    ),
    [
        (lambda t: "skill" not in t or t["schema_version"] != "1.0", "skill requires schema_version 1.1 or later"),
        (lambda t: "pricing" not in t or t["schema_version"] == "1.2", "pricing requires schema_version 1.2"),
        (lambda t: "refund_terms" not in t or t["schema_version"] == "1.2", "refund_terms requires schema_version 1.2"),
        (
            lambda t: (t.get("refund_terms") or {}).get("on_failure") != "dispute" or t["dispute_reviewer_id"] is not None,
            "refund_terms.on_failure dispute requires dispute_reviewer_id",
        ),
        (
            lambda t: "refund_terms" not in t or t["refund_terms"]["on_timeout"] == "refund",
            "refund_terms.on_timeout must be refund: the network expires an obligation at its deadline and pays nothing",
        ),
        (
            lambda t: "refund_terms" not in t or t["refund_terms"]["after_settlement"]["cap_minor"] <= t["max_amount_minor"],
            "refund_terms.after_settlement.cap_minor exceeds max_amount_minor",
        ),
        (lambda t: "witness_policy" not in t or t["schema_version"] == "1.2", "witness_policy requires schema_version 1.2"),
        (_no_listed_party_witnesses, "witness_policy.witness_agent_ids must not include the issuer, the counterparty or the principal"),
        (lambda t: t["counterparty_agent_id"] is not None or t["payee_selection"] is not None, "either counterparty_agent_id or payee_selection is required"),
        (lambda t: not t["allow_subdelegation"] or t["subdelegation_limits"] is not None, "subdelegation_limits are required when allow_subdelegation is true"),
        (lambda t: _js_sum(d["amount_minor"] for d in t["deliverables"]) <= t["max_amount_minor"], "sum of deliverable amounts exceeds max_amount_minor"),
        (lambda t: len({d["deliverable_id"] for d in t["deliverables"]}) == len(t["deliverables"]), "deliverable_id values must be unique"),
    ],
)
EVIDENCE_ENVELOPE = Obj(
    {
        "evidence_id": EVIDENCE_ID,
        "evidence_type": SNAKE_NAME,
        "producer_id": ACTOR_ID,
        "created_at": ISO_DATETIME,
        "content_digest": DIGEST,
        "uri": Str(min_length=1),
        "retrieval_method": Enum(("https", "atcn-blob", "out_of_band")),
        "media_type": Str(min_length=1),
        "access_policy": Obj({"visible_to": Array(Enum(("issuer", "counterparty", "reviewer", "verifier")), 1)}),
        "verifiers": Array(Str(), 1),
        "deliverable_ids": Array(Str()),
    }
)
EVENT_PAYLOAD = Obj(
    {
        "schema_version": Literal("1.0"),
        "event_id": EVENT_ID,
        "event_type": Enum(EVENT_TYPE_NAMES),
        "obligation_id": OBLIGATION_ID,
        "actor_id": ACTOR_ID,
        "actor_platform_id": Union([PLATFORM_ID, Literal("svc_atcn")]),
        "event_time": ISO_DATETIME,
        "causation_ids": Array(EVENT_ID),
        "data": CANONICAL_RECORD,
    }
)
RECORDED_EVENT = Obj({"payload": EVENT_PAYLOAD, "signature": SIGNATURE, "payload_hash": DIGEST, "received_at": ISO_DATETIME, "sequence": POSITIVE})
VERIFIER_RESULT = Obj(
    {
        "result_id": Str(),
        "obligation_id": OBLIGATION_ID,
        "check_id": Str(),
        "deliverable_id": Str(),
        "verifier_name": Str(),
        "verifier_version": SEMVER,
        "config_digest": DIGEST,
        "kind": Enum(("deterministic", "probabilistic")),
        "evidence_ids": Array(EVIDENCE_ID),
        "evidence_digests": Array(DIGEST),
        "status": Enum(("pass", "fail", "invalid_evidence", "missing_evidence", "unavailable")),
        "details": CANONICAL_RECORD,
        "model": Nullable(MODEL),
        "executed_at": ISO_DATETIME,
    }
)
EXTERNAL_ATTESTATION_PAYLOAD = Refined(
    Obj(
        {
            "role": Optional(Enum(("verifier", "witness"))),
            "obligation_id": OBLIGATION_ID,
            "deliverable_id": Str(),
            "check_id": Str(),
            "verifier_id": AGENT_ID,
            "status": Enum(("pass", "fail")),
            "probabilistic": Bool(),
            "model": Nullable(MODEL),
            "summary": Str(),
            "execution": Optional(EXECUTION_BINDING),
            "evidence_digests": Optional(Array(DIGEST, max_items=50)),
            "issued_at": Optional(ISO_DATETIME),
            "expires_at": Optional(ISO_DATETIME),
            "refs": Optional(Array(ATTESTATION_REF, max_items=20)),
        }
    ),
    [
        (lambda a: "issued_at" in a or ("expires_at" not in a and "refs" not in a), "issued_at is required with expires_at or refs"),
        (
            lambda a: "issued_at" not in a or "expires_at" not in a or date_parse(a["issued_at"]) < date_parse(a["expires_at"]),
            "expires_at must be after issued_at",
        ),
        (
            lambda a: a.get("role") != "witness" or ("execution" in a and len(a.get("evidence_digests", [])) > 0),
            "a witness attestation must cite the run and the evidence it saw",
        ),
    ],
)
SIGNED_EXTERNAL_ATTESTATION = Obj({"payload": EXTERNAL_ATTESTATION_PAYLOAD, "signature": SIGNATURE})
ATTESTATION_CONFLICT = Obj({"kind": Enum(CONFLICT_KINDS), "subject": Str(min_length=1), "attestation_digests": Array(DIGEST, 1), "signers": Array(Str())}, strict=True)
REASON = Obj({"code": Enum(REASON_CODES), "check_id": Optional(Str()), "evidence_type": Optional(Str()), "detail": Optional(Str())})
DELIVERABLE_OUTCOME = Obj(
    {"deliverable_id": Str(), "amount_minor": AMOUNT_MINOR, "outcome": Enum(("accepted", "rejected", "insufficient_evidence", "disputed")), "reasons": Array(REASON)}
)
DECISION_BODY = Obj(
    {
        "obligation_id": OBLIGATION_ID,
        "terms_version": POSITIVE,
        "terms_digest": DIGEST,
        "policy": POLICY_REF,
        "outcome": Enum(CLEARING_OUTCOMES),
        "currency": CURRENCY,
        "accepted_amount_minor": AMOUNT_MINOR,
        "rejected_amount_minor": AMOUNT_MINOR,
        "disputed_amount_minor": AMOUNT_MINOR,
        "pending_amount_minor": AMOUNT_MINOR,
        "deliverable_outcomes": Array(DELIVERABLE_OUTCOME),
        "input_event_ids": Array(EVENT_ID),
        "evidence_digests": Array(DIGEST),
        "verifier_output_digests": Array(DIGEST),
        "decision_maker": Obj({"type": Enum(("automated", "human")), "id": Str()}),
    }
)
CLEARING_DECISION = DECISION_BODY.extend(
    {
        "decision_id": DECISION_ID,
        "decision_digest": DIGEST,
        "decided_at": ISO_DATETIME,
        "supersedes_decision_id": Nullable(DECISION_ID),
        "input_cutoff_sequence": Int(("min", 0)),
    }
)
POSTING_LINE = Obj(
    {
        "account_type": Enum(ACCOUNT_TYPES),
        "party_id": Str(),
        "allocation_role": Enum(ALLOCATION_ROLES),
        "currency": CURRENCY,
        "debit_minor": AMOUNT_MINOR,
        "credit_minor": AMOUNT_MINOR,
    }
)
POSTING_BATCH = Obj(
    {
        "batch_id": Str(),
        "obligation_id": OBLIGATION_ID,
        "entry_type": Enum(ENTRY_TYPES),
        "decision_id": Nullable(DECISION_ID),
        "settlement_event_id": Nullable(Str()),
        "reverses_batch_id": Nullable(Str()),
        "policy_version": Nullable(Str()),
        "source_event_ids": Array(EVENT_ID),
        "rounding": Nullable(Obj({"method": Str(), "detail": Str()})),
        "lines": Array(POSTING_LINE, 2),
        "posted_at": ISO_DATETIME,
    }
)
SETTLEMENT_INSTRUCTION = Obj(
    {
        "instruction_id": Str(),
        "obligation_id": OBLIGATION_ID,
        "decision_id": DECISION_ID,
        "beneficiary_party_id": Str(),
        "beneficiary_ref": Str(min_length=1),
        "currency": CURRENCY,
        "amount_minor": AMOUNT_MINOR,
        "adapter": Enum(SETTLEMENT_ADAPTERS),
        "idempotency_key": Str(min_length=1),
        "expires_at": ISO_DATETIME,
        "status": Enum(SETTLEMENT_STATUSES),
        "created_at": ISO_DATETIME,
    }
)
SETTLEMENT_EVENT = Obj(
    {
        "settlement_event_id": Str(),
        "instruction_id": Nullable(Str()),
        "provider": Enum(SETTLEMENT_ADAPTERS),
        "provider_event_id": Str(min_length=1),
        "provider_reference": Str(min_length=1),
        "provider_status": Str(min_length=1),
        "normalized_status": Enum(SETTLEMENT_STATUSES),
        "currency": CURRENCY,
        "amount_minor": AMOUNT_MINOR,
        "raw_json": Str(),
        "reported_at": ISO_DATETIME,
    }
)
PUBLIC_KEY_RECORD = Obj(
    {
        "key_id": KEY_ID,
        "key_version": POSITIVE,
        "actor_id": ACTOR_ID,
        "algorithm": Literal("Ed25519"),
        "public_key": Str(),
        "valid_from": ISO_DATETIME,
        "revoked_at": Nullable(ISO_DATETIME),
    }
)


def _no_pending_finality_in_1_0(b: Json) -> bool:
    statuses = [s["normalized_status"] for s in b["settlement_events"]] + [i["status"] for i in b["settlement_instructions"]]
    return b["package_version"] == "1.1" or "pending_finality" not in statuses


CLOSURE_PACKAGE_BODY = Refined(
    Obj(
        {
            "package_version": Enum(SUPPORTED_PACKAGE_VERSIONS),
            "generated_at": ISO_DATETIME,
            "root_obligation_id": OBLIGATION_ID,
            "requested_obligation_id": OBLIGATION_ID,
            "obligations": Array(
                Obj(
                    {
                        "obligation_id": OBLIGATION_ID,
                        "parent_obligation_id": Nullable(OBLIGATION_ID),
                        "redacted": Bool(),
                        "effective_terms": Nullable(OBLIGATION_TERMS),
                        "effective_terms_digest": Nullable(DIGEST),
                        "state": Str(),
                    }
                )
            ),
            "events": Array(RECORDED_EVENT),
            "public_keys": Array(PUBLIC_KEY_RECORD),
            "policies": Array(POLICY_TEMPLATE),
            "evidence": Array(EVIDENCE_ENVELOPE),
            "verifier_results": Array(VERIFIER_RESULT),
            "decisions": Array(CLEARING_DECISION),
            "posting_batches": Array(POSTING_BATCH),
            "settlement_instructions": Array(SETTLEMENT_INSTRUCTION),
            "settlement_events": Array(SETTLEMENT_EVENT),
            "attestations": Optional(Array(Obj({"evidence_id": EVIDENCE_ID, "content": Str()}, strict=True))),
            "attestation_conflicts": Optional(Array(ATTESTATION_CONFLICT)),
        }
    ),
    [
        (
            lambda b: b["package_version"] == "1.1" or ("attestations" not in b and "attestation_conflicts" not in b),
            "attestations and attestation_conflicts require package_version 1.1",
        ),
        (
            lambda b: b["package_version"] == "1.0" or ("attestations" in b and "attestation_conflicts" in b),
            "package_version 1.1 requires attestations and attestation_conflicts",
        ),
        (_no_pending_finality_in_1_0, "settlement status pending_finality requires package_version 1.1"),
    ],
)
CLOSURE_PACKAGE = Obj({"payload": CLOSURE_PACKAGE_BODY, "signature": SIGNATURE})

# ---------- JavaScript semantics the checks depend on ----------


def _js_truthy(value: Any) -> bool:
    """JavaScript truthiness: empty arrays and objects are true; a missing member is false."""
    if value is _MISSING or value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and value == value
    if isinstance(value, str):
        return value != ""
    return True


def _js_get(value: Any, key: str) -> Any:
    """value?.[key] for a JSON value; _MISSING where JavaScript gives undefined."""
    return value.get(key, _MISSING) if isinstance(value, dict) else _MISSING


def _js_text(value: Any) -> str:
    """String(value) in JavaScript, where a missing member is undefined."""
    return "undefined" if value is _MISSING else _js_string(value)


def _same_value(a: Any, b: Any) -> bool:
    """JavaScript's === on JSON values: a boolean never equals a number, and arrays and objects are never equal."""
    if a is _MISSING or b is _MISSING:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a is b
    return type(a) is type(b) and a == b


def _js_less(a: str, b: str) -> bool:
    """a < b on JavaScript strings, which compares UTF-16 code units."""
    return _utf16_sort_key(a) < _utf16_sort_key(b)


def _utf8_encode(text: str) -> bytes:
    """TextEncoder: a lone surrogate becomes U+FFFD."""
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _parse_int(text: str) -> int | float:
    # JavaScript reads every number as a double; past Python's digit limit for int(), read it as a float as well.
    return int(text) if len(text) <= 4000 else float(text)


def _json_parse(text: str) -> Any:
    """JSON.parse: NaN and Infinity are not JSON. Raises ValueError."""
    return json.loads(text, parse_constant=_reject_constant, parse_int=_parse_int)


def _v8_sort(items: list[Any], compare: Callable[[Any, Any], int]) -> list[Any]:
    """Array.prototype.sort as V8 runs it on fewer than 64 items (one run, then binary insertion), so a comparator that
    never returns 0 leaves equal items in the same order. Longer lists use a stable sort."""
    a = list(items)
    n = len(a)
    if n < 2:
        return a
    if n >= 64:
        return sorted(a, key=functools.cmp_to_key(compare))
    run = 2
    descending = compare(a[1], a[0]) < 0
    previous = a[1]
    for index in range(2, n):
        order = compare(a[index], previous)
        if (descending and order >= 0) or (not descending and order < 0):
            break
        previous = a[index]
        run += 1
    if descending:
        a[:run] = a[:run][::-1]
    for start in range(run, n):
        pivot = a[start]
        left, right = 0, start
        while left < right:
            middle = left + ((right - left) >> 1)
            if compare(pivot, a[middle]) < 0:
                right = middle
            else:
                left = middle + 1
        a[left + 1 : start + 1] = a[left:start]
        a[left] = pivot
    return a


def _by_subject_then_kind(conflicts: list[Json]) -> list[Json]:
    return sorted(conflicts, key=lambda c: (_utf16_sort_key(c["subject"]), _utf16_sort_key(c["kind"])))


def _key_ref(key_id: str, key_version: Any) -> str:
    return f"{key_id}#{_js_number(key_version)}"


# ---------- Clearing (@atcn/core clearing.ts, evidence.ts, conflicts.ts, journal.ts) ----------


def verifier_output_digest(result: Json) -> str:
    """Digest of a verifier result over its immutable fields (execution time and result id excluded)."""
    return digest_of({k: v for k, v in result.items() if k not in ("executed_at", "result_id")})


def producer_role(terms: Json, producer_id: str) -> str:
    """Role of an evidence producer, derived only from the signed terms."""
    if producer_id in (terms["issuer_agent_id"], terms["principal_id"]):
        return "issuer"
    if producer_id == terms["counterparty_agent_id"]:
        return "counterparty"
    if producer_id in terms["verifier_agent_ids"]:
        return "verifier"
    witness_policy = terms.get("witness_policy")
    if witness_policy and ("witness_agent_ids" not in witness_policy or producer_id in witness_policy["witness_agent_ids"]):
        return "witness"
    return "other"


def resolve_counterparty(terms: Json, events: list[Json]) -> Json:
    """Open offers are signed without a counterparty; the first acceptance event names it."""
    if terms["counterparty_agent_id"]:
        return terms
    ordered = sorted(events, key=lambda e: e["sequence"])
    acceptance = next(
        (e for e in ordered if e["payload"]["obligation_id"] == terms["obligation_id"] and e["payload"]["event_type"] == "obligation.accepted"), None
    )
    counterparty = _js_text(acceptance["payload"]["data"].get("counterparty_agent_id", _MISSING)) if acceptance else None
    return {**terms, "counterparty_agent_id": counterparty}


def declared_executions(events: list[Json], counterparty_agent_id: str | None) -> list[Json]:
    """Runs the counterparty declared in its signed obligation.started events. A descriptor naming another agent is ignored."""
    runs = []
    for e in events:
        p = e["payload"]
        if p["event_type"] != "obligation.started" or p["actor_id"] != counterparty_agent_id:
            continue
        execution = p["data"].get("execution", _MISSING)
        descriptor, issues = parse(EXECUTION_DESCRIPTOR, execution)
        if issues or descriptor["agent"]["agent_id"] != p["actor_id"]:
            continue
        runs.append(
            {
                "execution_id": descriptor["execution_id"],
                "execution_digest": digest_of(execution),
                "started_event_id": p["event_id"],
                "descriptor": descriptor,
                "started_at": e["received_at"],
            }
        )
    return runs


def build_evidence_inputs(events: list[Json], signed_terms: Json, cutoff_sequence: int | None = None) -> list[Json]:
    """Clearing evidence inputs from an obligation's recorded events. An evidence.submitted event whose envelope does not
    match the envelope schema is left out."""
    visible = [e for e in events if cutoff_sequence is None or e["sequence"] <= cutoff_sequence]
    terms = resolve_counterparty(signed_terms, visible)
    actor_of = {e["payload"]["event_id"]: e["payload"]["actor_id"] for e in visible}
    superseded = set()
    for e in visible:
        if e["payload"]["event_type"] != "event.superseded":
            continue
        target = _js_text(e["payload"]["data"].get("superseded_event_id", _MISSING))
        if actor_of.get(target) == e["payload"]["actor_id"]:
            superseded.add(target)
    inputs = []
    for e in visible:
        if e["payload"]["event_type"] != "evidence.submitted":
            continue
        envelope, issues = parse(EVIDENCE_ENVELOPE, e["payload"]["data"].get("envelope", _MISSING))
        if issues:
            continue
        inputs.append(
            {
                "envelope": envelope,
                "event_id": e["payload"]["event_id"],
                "producer_role": producer_role(terms, envelope["producer_id"]),
                "superseded": e["payload"]["event_id"] in superseded,
            }
        )
    return inputs


def _newest_evidence_first(a: Json, b: Json) -> int:
    x, y = a["envelope"], b["envelope"]
    if x["created_at"] != y["created_at"]:
        return 1 if x["created_at"] < y["created_at"] else -1
    return 1 if x["evidence_id"] < y["evidence_id"] else -1


def _newest_result_first(a: Json, b: Json) -> int:
    if a["executed_at"] != b["executed_at"]:
        return 1 if a["executed_at"] < b["executed_at"] else -1
    return 1 if _js_less(a["result_id"], b["result_id"]) else -1


def _select_evidence(evidence: list[Json], policy: Json, evidence_type: str, deliverable_id: str) -> Json | None:
    """Latest admissible evidence of a type covering a deliverable (ordered by created_at, then evidence_id)."""
    candidates = [
        e
        for e in evidence
        if not e["superseded"]
        and e["producer_role"] in policy["evidence_admissibility"]["allowed_producers"]
        and e["envelope"]["evidence_type"] == evidence_type
        and (not e["envelope"]["deliverable_ids"] or deliverable_id in e["envelope"]["deliverable_ids"])
    ]
    ordered = _v8_sort(candidates, _newest_evidence_first)
    return ordered[0] if ordered else None


def _combine_verdicts(verdicts: list[str]) -> str:
    for verdict in ("insufficient_evidence", "disputed", "rejected"):
        if verdict in verdicts:
            return verdict
    return "accepted"


def _overall_outcome(outcomes: list[Json], policy: Json) -> str:
    def has(v: str) -> bool:
        return any(d["outcome"] == v for d in outcomes)

    if has("insufficient_evidence"):
        return "insufficient_evidence"
    if all(d["outcome"] == "accepted" for d in outcomes):
        return "accepted"
    if has("disputed") and not has("accepted"):
        return "disputed"
    if not has("accepted"):
        return "rejected"
    if not policy["thresholds"]["partial_acceptance"]:
        return "rejected"
    if has("disputed"):
        return "disputed"
    return "partially_accepted"


def evaluate_clearing(
    terms: Json,
    terms_digest: str,
    policy: Json,
    policy_digest: str,
    acceptance_event_id: str,
    completion_event_id: str | None,
    evidence: list[Json],
    verifier_results: list[Json],
    decision_maker: Json | None = None,
    attestation_conflicts: list[Json] | None = None,
) -> Json:
    """The deterministic clearing engine: a pure function of the accepted terms, the policy, admissible evidence
    metadata and recorded verifier results. Returns the decision body."""
    used_evidence: dict[str, Json] = {}
    used_results: dict[str, Json] = {}
    outcomes: list[Json] = []
    conflicts = attestation_conflicts or []
    obligation_id = terms["obligation_id"]

    for deliverable in terms["deliverables"]:
        deliverable_id = deliverable["deliverable_id"]
        reasons: list[Json] = []
        verdicts: list[str] = []
        for evidence_type in policy["required_evidence"]:
            found = _select_evidence(evidence, policy, evidence_type, deliverable_id)
            if found is None:
                reasons.append({"code": "missing_evidence", "evidence_type": evidence_type})
                verdicts.append("insufficient_evidence")
            else:
                used_evidence[found["envelope"]["evidence_id"]] = found

        for check_id in deliverable["required_checks"]:
            check = next((c for c in policy["checks"] if c["check_id"] == check_id), None)
            if check is None:
                reasons.append({"code": "verifier_unavailable", "check_id": check_id, "detail": "check not defined by policy"})
                verdicts.append(policy["verifier_unavailable_outcome"])
                continue
            found = _select_evidence(evidence, policy, check["evidence_type"], deliverable_id)
            if found is None:
                reasons.append({"code": "missing_evidence", "check_id": check_id, "evidence_type": check["evidence_type"]})
                verdicts.append("insufficient_evidence")
                continue
            used_evidence[found["envelope"]["evidence_id"]] = found

            results = [
                r
                for r in _v8_sort(verifier_results, _newest_result_first)
                if r["check_id"] == check_id
                and r["deliverable_id"] == deliverable_id
                and found["envelope"]["evidence_id"] in r["evidence_ids"]
                and r["verifier_name"] == check["verifier"]
                and r["verifier_version"] == check["verifier_version"]
            ]
            result = next((r for r in results if r["kind"] == "deterministic"), None) or next((r for r in results if r["kind"] == "probabilistic"), None)
            if result is None:
                reasons.append({"code": "verifier_unavailable", "check_id": check_id, "detail": "no verifier result recorded"})
                verdicts.append(policy["verifier_unavailable_outcome"])
                continue
            used_results[verifier_output_digest(result)] = result

            status = result["status"]
            if status == "missing_evidence":
                reasons.append({"code": "missing_evidence", "check_id": check_id, "evidence_type": check["evidence_type"]})
                verdicts.append("insufficient_evidence")
            elif status == "invalid_evidence":
                reasons.append({"code": "invalid_evidence", "check_id": check_id, "evidence_type": check["evidence_type"]})
                verdicts.append("insufficient_evidence")
            elif status == "unavailable":
                reasons.append({"code": "verifier_unavailable", "check_id": check_id})
                verdicts.append(policy["verifier_unavailable_outcome"])
            elif result["kind"] == "probabilistic":
                reasons.append({"code": "probabilistic_review_required", "check_id": check_id, "detail": f"probabilistic result: {status}"})
                verdicts.append("disputed" if policy["probabilistic_routing"] == "human_review" else "insufficient_evidence")
            elif status == "fail" and check["verifier"] == "witness_quorum":
                refused = result["details"].get("refused")
                reasons.append({"code": "witness_quorum_not_met", "check_id": check_id, "detail": "" if refused is None else _js_string(refused)})
                verdicts.append("insufficient_evidence")
            elif status == "fail":
                reasons.append({"code": "failed_criteria", "check_id": check_id})
                verdicts.append("rejected")
            else:
                reasons.append({"code": "passed", "check_id": check_id})
                verdicts.append("accepted")
            on_check = [c for c in conflicts if c["subject"] == f"{obligation_id}/{deliverable_id}/{check_id}"]
            if on_check:
                reasons.append({"code": "conflicting_attestations", "check_id": check_id, "detail": ",".join(c["kind"] for c in on_check)})
                verdicts.append("disputed")
        on_run = [c for c in conflicts if c["subject"].startswith(f"{obligation_id}/execution:")]
        if on_run:
            runs = ", ".join(c["subject"].split("/execution:")[1] for c in on_run)
            reasons.append({"code": "conflicting_attestations", "detail": f"the counterparty declared conflicting descriptors for {runs}"})
            verdicts.append("disputed")

        verdict = _combine_verdicts(verdicts)
        if verdict == "rejected" and (terms.get("refund_terms") or {}).get("on_failure") == "dispute":
            verdict = "disputed"
            reasons.append({"code": "failure_terms_dispute"})
        outcomes.append({"deliverable_id": deliverable_id, "amount_minor": deliverable["amount_minor"], "outcome": verdict, "reasons": reasons})

    outcome = _overall_outcome(outcomes, policy)
    for d in outcomes:
        if outcome == "rejected" and d["outcome"] == "accepted":
            d["outcome"] = "rejected"
            d["reasons"].append({"code": "partial_not_permitted"})
        if outcome == "partially_accepted" and d["outcome"] == "rejected" and policy["thresholds"]["failed_portion_outcome"] == "disputed":
            d["outcome"] = "disputed"

    def sum_by(verdict: str) -> int:
        return sum(d["amount_minor"] for d in outcomes if d["outcome"] == verdict)

    input_event_ids = {acceptance_event_id}
    if completion_event_id:
        input_event_ids.add(completion_event_id)
    input_event_ids.update(e["event_id"] for e in used_evidence.values())
    return {
        "obligation_id": obligation_id,
        "terms_version": terms["terms_version"],
        "terms_digest": terms_digest,
        "policy": {"policy_id": policy["policy_id"], "policy_version": policy["policy_version"], "policy_digest": policy_digest},
        "outcome": outcome,
        "currency": terms["currency"],
        "accepted_amount_minor": 0 if outcome == "insufficient_evidence" else sum_by("accepted"),
        "rejected_amount_minor": sum_by("rejected"),
        "disputed_amount_minor": sum_by("disputed"),
        "pending_amount_minor": sum_by("insufficient_evidence") + (sum_by("accepted") if outcome == "insufficient_evidence" else 0),
        "deliverable_outcomes": outcomes,
        "input_event_ids": sorted(input_event_ids),
        "evidence_digests": sorted({e["envelope"]["content_digest"] for e in used_evidence.values()}),
        "verifier_output_digests": sorted(used_results),
        "decision_maker": decision_maker or {"type": "automated", "id": CLEARING_ENGINE_ID},
    }


def _execution_conflicts(events: list[Json], terms: Json) -> list[Json]:
    """Two obligation.started events that give one execution_id different descriptors: the counterparty equivocated."""
    by_id: dict[str, list[str]] = {}
    for run in declared_executions(events, terms["counterparty_agent_id"]):
        digests = by_id.setdefault(run["execution_id"], [])
        if run["execution_digest"] not in digests:
            digests.append(run["execution_digest"])
    return [
        {
            "kind": "equivocation",
            "subject": f"{terms['obligation_id']}/execution:{execution_id}",
            "attestation_digests": sorted(digests),
            "signers": [terms["counterparty_agent_id"]],
        }
        for execution_id, digests in by_id.items()
        if len(digests) > 1
    ]


def obligation_attestation_conflicts(
    events: list[Json],
    terms: Json,
    contents: dict[str, str],
    resolve_key: Callable[[str, int], Json | None],
    at: str,
    cutoff_sequence: int | None = None,
) -> list[Json]:
    """Conflicts among an obligation's attestations in effect at `at`, plus runs the counterparty declared twice with
    different descriptors. An attestation counts only when its signature verifies with a key of its signer and the
    signer may attest: an agreed verifier, or for witness attestations anyone but the parties (only the agreed witnesses
    when the terms list them)."""
    visible = [e for e in events if cutoff_sequence is None or e["sequence"] <= cutoff_sequence]
    resolved = resolve_counterparty(terms, visible)
    parties = [resolved["issuer_agent_id"], resolved["counterparty_agent_id"], resolved["principal_id"]]
    items: list[Json] = []
    claims: list[Json] = []
    seen: set[str] = set()
    for evidence in build_evidence_inputs(visible, terms):
        envelope = evidence["envelope"]
        if evidence["superseded"] or envelope["evidence_type"] not in ATTESTATION_EVIDENCE_TYPES:
            continue
        content = contents.get(envelope["content_digest"])
        if content is None:
            continue
        try:
            raw = _json_parse(content)
        except ValueError:
            continue
        parsed, issues = parse(SIGNED_EXTERNAL_ATTESTATION, raw)
        if issues:
            continue
        p, signature = parsed["payload"], parsed["signature"]
        if p["obligation_id"] != resolved["obligation_id"]:
            continue
        signer = p["verifier_id"]
        if p.get("role", "verifier") == "verifier":
            allowed = signer in resolved["verifier_agent_ids"]
        else:
            listed = (resolved.get("witness_policy") or {}).get("witness_agent_ids")
            allowed = signer not in parties and signer in (listed if listed is not None else [signer])
        if not allowed:
            continue
        key = resolve_key(signature["key_id"], signature["key_version"])
        try:
            if not key or key["actor_id"] != signer or not verify_payload(raw, key["public_key"]):
                continue
            digest = digest_of(raw["payload"])
        except ValueError:
            # Members zod dropped that are not canonical JSON (a float, say): the text cannot be verified.
            continue
        revoked_at = key.get("revoked_at", _MISSING)
        if revoked_at is not None and date_parse(revoked_at) <= date_parse(p.get("issued_at", at)):
            continue
        if digest in seen:
            continue
        seen.add(digest)
        items.append({"digest": digest, "signer": signer, "issued_at": p.get("issued_at"), "expires_at": p.get("expires_at"), "refs": p.get("refs")})
        claim = {"digest": digest, "signer": signer, "subject": f"{resolved['obligation_id']}/{p['deliverable_id']}/{p['check_id']}", "status": p["status"]}
        if "execution" in p:
            claim["execution_digest"] = p["execution"]["execution_digest"]
        claims.append(claim)
    resolution = resolve_attestations(items, at)
    effective = [c for c in claims if in_effect(resolution, c["digest"])]
    found = _by_subject_then_kind(find_conflicts(effective, disputes_in_effect(items, resolution)))
    return _by_subject_then_kind(found + _execution_conflicts(visible, resolved))


def check_balanced(lines: list[Json]) -> Json:
    """Each batch must balance per currency using double-entry semantics. Totals add up as JavaScript adds them."""
    by_currency: dict[str, Json] = {}
    problems: list[str] = []
    if len(lines) < 2:
        problems.append("a posting batch needs at least two lines")
    for line in lines:
        if line["debit_minor"] < 0 or line["credit_minor"] < 0:
            problems.append("negative amount")
        if (line["debit_minor"] > 0) == (line["credit_minor"] > 0):
            problems.append("each line must be exactly one of debit or credit")
        totals = by_currency.setdefault(line["currency"], {"debit": 0, "credit": 0})
        totals["debit"] = _js_add(totals["debit"], line["debit_minor"])
        totals["credit"] = _js_add(totals["credit"], line["credit_minor"])
    for currency, totals in by_currency.items():
        if totals["debit"] != totals["credit"]:
            problems.append(f"{currency} debits {_js_number(totals['debit'])} != credits {_js_number(totals['credit'])}")
    return {"balanced": not problems, "by_currency": by_currency, "problems": problems}


# ---------- Traces (@atcn/schema trace.ts) ----------


def _model_allowed(run: Json, model: Json) -> bool:
    agent = run["agent"]
    declared = ([agent["model"]] if "model" in agent else []) + agent.get("additional_models", [])
    return not declared or any(m["provider"] == model["provider"] and m["name"] == model["name"] for m in declared)


def check_trace(raw: Any, runs: list[Json], end_at: str | None) -> Json:
    """Parses a trace and checks it against the declared runs: well formed, bound to a declared run, using only that
    run's declared models, and inside the run's time window. Returns {"ok", "trace"} or {"ok", "code", "error"}."""
    trace, issues = parse(AGENT_TRACE, raw)
    if issues:
        return {"ok": False, "code": "malformed", "error": f"trace does not match the schema: {issues[0]}"}
    problems = trace_problems(trace)
    if problems:
        return {"ok": False, "code": "malformed", "error": "; ".join(problems)}
    execution = trace["execution"]
    run = next((r for r in runs if r["execution_id"] == execution["execution_id"] and r["execution_digest"] == execution["execution_digest"]), None)
    if run is None:
        return {
            "ok": False,
            "code": "execution_not_declared",
            "error": f"run {execution['execution_id']} with digest {execution['execution_digest']} was not declared",
        }
    for step in trace["steps"]:
        model = step.get("model")
        if model is not None and not _model_allowed(run["descriptor"], model):
            return {
                "ok": False,
                "code": "model_mismatch",
                "error": f"step {step['seq']} uses {model['provider']}/{model['name']}, which run {run['execution_id']} did not declare",
            }
        if "started_at" in run and date_parse(step["started_at"]) < date_parse(run["started_at"]):
            return {
                "ok": False,
                "code": "trace_outside_run",
                "error": f"step {step['seq']} starts at {step['started_at']}, before run {run['execution_id']} was declared at {run['started_at']}",
            }
        if end_at is not None and date_parse(step["ended_at"]) > date_parse(end_at):
            return {"ok": False, "code": "trace_outside_run", "error": f"step {step['seq']} ends at {step['ended_at']}, after {end_at}"}
    return {"ok": True, "trace": trace}


# ---------- Closure package ----------


def _key_valid_at(key: Json, at: str) -> bool:
    return key["valid_from"] <= at and (key["revoked_at"] is None or key["revoked_at"] > at)


def _same_instant(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    return date_parse(a) == date_parse(b)


def _same_key(a: Json, b: Json) -> bool:
    return (
        a["actor_id"] == b.get("actor_id")
        and a["public_key"] == b.get("public_key")
        and _same_instant(a["valid_from"], b.get("valid_from", _MISSING))
        and _same_instant(a["revoked_at"], b.get("revoked_at", _MISSING))
    )


def _attestation_contents(body: Json) -> dict[str, str]:
    """Attestation text by content digest, from a 1.1 package's attestations."""
    return {sha256_digest(_utf8_encode(a["content"])): a["content"] for a in body.get("attestations", [])}


def _attestation_signature_keys(body: Json) -> list[str]:
    """Key references of the signatures on the package's attestations, so their keys count as used."""
    refs = []
    for a in body.get("attestations", []):
        try:
            raw = _json_parse(a["content"])
        except ValueError:
            continue
        if raw is None:
            continue
        signature = _js_get(raw, "signature")
        key_id, key_version = _js_get(signature, "key_id"), _js_get(signature, "key_version")
        if isinstance(key_id, str) and isinstance(key_version, (int, float)) and not isinstance(key_version, bool):
            refs.append(_key_ref(key_id, key_version))
    return refs


def package_attestation_conflicts(body: Json, contents: dict[str, str], resolve_key: Callable[[str, int], Json | None]) -> list[Json]:
    """The conflicts a package must record: every unredacted obligation's attestation conflicts at generated_at."""
    conflicts = []
    for o in body["obligations"]:
        if o["redacted"] or o["effective_terms"] is None:
            continue
        events = [e for e in body["events"] if e["payload"]["obligation_id"] == o["obligation_id"]]
        conflicts.extend(obligation_attestation_conflicts(events, o["effective_terms"], contents, resolve_key, body["generated_at"]))
    return _by_subject_then_kind(conflicts)


def _attestation_conflicts_check(body: Json, contents: dict[str, str], resolve_key: Callable[[str, int], Json | None]) -> Json:
    """Package 1.1: every attestation evidence item must come with its exact text, and attestation_conflicts must be
    exactly what those attestations produce at generated_at."""
    name = "attestation_conflicts"
    problems = []
    envelopes = {e["evidence_id"]: e for e in body["evidence"]}
    attestations = body.get("attestations", [])
    for a in attestations:
        envelope = envelopes.get(a["evidence_id"])
        if envelope is None or envelope["evidence_type"] not in ATTESTATION_EVIDENCE_TYPES:
            problems.append(f"attestation {a['evidence_id']} is not attestation evidence in the package")
        elif sha256_digest(_utf8_encode(a["content"])) != envelope["content_digest"]:
            problems.append(f"attestation {a['evidence_id']} text does not match its content digest")
    supplied = {a["evidence_id"] for a in attestations}
    for e in body["evidence"]:
        if e["evidence_type"] in ATTESTATION_EVIDENCE_TYPES and e["evidence_id"] not in supplied:
            problems.append(f"attestation evidence {e['evidence_id']} has no text in the package")
    expected = package_attestation_conflicts(body, contents, resolve_key)
    recorded = body.get("attestation_conflicts", [])
    if digest_of(expected) != digest_of(recorded):
        problems.append(f"attestation_conflicts do not match the attestations (expected {len(expected)} conflict(s), recorded {len(recorded)})")
    if problems:
        return {"name": name, "ok": False, "details": problems}
    if not expected:
        return {"name": name, "ok": True, "details": ["no conflicting attestations"]}
    listed = "; ".join(f"{c['kind']} on {c['subject']}" for c in expected)
    return {"name": name, "ok": True, "details": [f"{len(expected)} conflict(s) recomputed: {listed}"]}


def _same(a: Any, b: Any) -> bool:
    """Equal canonical JSON (a missing value counts as null). A value that is not canonical JSON matches nothing."""
    try:
        return digest_of(None if a is _MISSING else a) == digest_of(None if b is _MISSING else b)
    except ValueError:
        return False


def _records_match_events_check(body: Json) -> Json:
    """Each table row must match the event the service signed for it; posting lines may name only the obligation's
    parties, and settlement instructions may not exceed what the decision's clearing made payable."""
    problems: list[str] = []
    events = body["events"]

    def of_type(types: tuple[str, ...]) -> list[Json]:
        return [e for e in events if e["payload"]["event_type"] in types]

    reports = of_type(("settlement.reported",))
    for s in body["settlement_events"]:
        report = next((e for e in reports if _same_value(e["payload"]["data"].get("settlement_event_id", _MISSING), s["settlement_event_id"])), None)
        if report is None:
            problems.append(f"settlement event {s['settlement_event_id']} has no settlement.reported event")
            continue
        data = report["payload"]["data"]
        fields = ("instruction_id", "provider", "provider_reference", "provider_status", "normalized_status", "amount_minor", "currency")
        differing = [f for f in fields if not _same(s[f], data.get(f, _MISSING))]
        if differing:
            problems.append(f"settlement event {s['settlement_event_id']} {', '.join(differing)} differ from its settlement.reported event")

    journal_events = of_type(("journal.posted", "journal.reversed"))
    for b in body["posting_batches"]:
        batch_id = b["batch_id"]
        event = next((e for e in journal_events if _same_value(e["payload"]["data"].get("batch_id", _MISSING), batch_id)), None)
        if event is None:
            problems.append(f"posting batch {batch_id} has no journal event")
            continue
        data = event["payload"]["data"]
        totals = {currency: t["debit"] for currency, t in check_balanced(b["lines"])["by_currency"].items()}
        if event["payload"]["obligation_id"] != b["obligation_id"]:
            problems.append(f"posting batch {batch_id} belongs to {event['payload']['obligation_id']} by its journal event")
        if (
            not _same(data.get("entry_type", _MISSING), b["entry_type"])
            or not _same(data.get("reverses_batch_id", _MISSING), b["reverses_batch_id"])
            or not _same(data.get("decision_id", _MISSING), b["decision_id"])
        ):
            problems.append(f"posting batch {batch_id} entry type, reversal or decision differ from its journal event")
        if not _same(data.get("totals", _MISSING), totals):
            problems.append(f"posting batch {batch_id} totals differ from its journal event")
        if not _same(sorted(b["source_event_ids"]), sorted(event["payload"]["causation_ids"])):
            problems.append(f"posting batch {batch_id} source events differ from its journal event's causes")
        obligation_events = [e for e in events if e["payload"]["obligation_id"] == b["obligation_id"]]
        agreed_policy_versions = [
            _js_get(_js_get(e["payload"]["data"].get("terms", _MISSING), "acceptance_policy"), "policy_version") for e in obligation_events
        ]
        if b["policy_version"] is not None and b["policy_version"] not in agreed_policy_versions:
            problems.append(f"posting batch {batch_id} policy version {b['policy_version']} is not in the obligation's terms")
        obligation = next((o for o in body["obligations"] if o["obligation_id"] == b["obligation_id"]), None)
        if obligation is not None and obligation["effective_terms"]:
            terms = resolve_counterparty(obligation["effective_terms"], obligation_events)
            parties = {terms["payer_id"], *([terms["counterparty_agent_id"]] if terms["counterparty_agent_id"] else [])}
            for e in obligation_events:
                parties.update((e["payload"]["actor_id"], e["payload"]["actor_platform_id"]))
            for line in b["lines"]:
                if line["party_id"] not in parties:
                    problems.append(f"posting batch {batch_id} names {line['party_id']}, who is not a party to {b['obligation_id']}")

    outcome_events = of_type(OUTCOME_EVENT_TYPES)
    for d in body["decisions"]:
        event = next((e for e in outcome_events if _same_value(e["payload"]["data"].get("decision_id", _MISSING), d["decision_id"])), None)
        if event is None:
            problems.append(f"decision {d['decision_id']} has no outcome event")
            continue
        data = event["payload"]["data"]
        if (
            not _same(data.get("decision_digest", _MISSING), d["decision_digest"])
            or not _same(data.get("outcome", _MISSING), d["outcome"])
            or not _same(data.get("supersedes_decision_id", _MISSING), d["supersedes_decision_id"])
        ):
            problems.append(f"decision {d['decision_id']} differs from its outcome event")
        if date_parse(d["decided_at"]) > date_parse(event["payload"]["event_time"]):
            problems.append(f"decision {d['decision_id']} was decided after its outcome event")
        if d["input_cutoff_sequence"] >= event["sequence"]:
            problems.append(f"decision {d['decision_id']} input cutoff is not before its outcome event")

    instructed: dict[str, int | float] = {}
    for i in body["settlement_instructions"]:
        key = f"{i['decision_id']}|{i['beneficiary_party_id']}|{i['currency']}"
        instructed[key] = _js_add(instructed.get(key, 0), i["amount_minor"])
    for key, amount in instructed.items():
        decision_id, beneficiary, currency = key.split("|")[:3]
        payable: int | float = 0
        for b in body["posting_batches"]:
            if b["entry_type"] != "clearing" or b["decision_id"] != decision_id:
                continue
            for line in b["lines"]:
                if line["account_type"] == "payable" and line["party_id"] == beneficiary and line["currency"] == currency:
                    payable = _js_add(_js_add(payable, line["credit_minor"]), -line["debit_minor"])
        if amount > payable:
            problems.append(
                f"settlement instructions for decision {decision_id} pay {beneficiary} {_js_number(amount)} {currency}, "
                f"more than the {_js_number(payable)} its clearing made payable"
            )

    return {"name": "records_match_signed_events", "ok": not problems, "details": problems}


def _trace_evidence_check(body: Json, files: list[bytes]) -> Json:
    """Trace evidence, when its files are supplied: each file must match an agent_trace envelope, pass every trace rule
    against the obligation's declared runs, and each recorded usage_cost result must recompute from the terms' pricing
    and its traces. Evidence whose file was not supplied is reported as not inspected."""
    name = "trace_evidence"
    envelopes = [e for e in body["evidence"] if e["evidence_type"] == AGENT_TRACE_EVIDENCE_TYPE]
    usage_results = [r for r in body["verifier_results"] if r["verifier_name"] == "usage_cost" and isinstance(r["details"].get("trace_digests"), str)]
    if not envelopes and not usage_results:
        return {"name": name, "ok": True, "details": ["no trace evidence"]}

    file_by_digest = {sha256_digest(data): data for data in files}
    obligation_of_evidence: dict[str, str] = {}
    for e in body["events"]:
        evidence_id = _js_get(e["payload"]["data"].get("envelope", _MISSING), "evidence_id")
        if e["payload"]["event_type"] == "evidence.submitted" and isinstance(evidence_id, str) and evidence_id:
            obligation_of_evidence[evidence_id] = e["payload"]["obligation_id"]
    problems: list[str] = []
    notes: list[str] = []
    traces_by_obligation: dict[str, dict[str, Json]] = {}
    inspected = 0

    for envelope in envelopes:
        evidence_id = envelope["evidence_id"]
        data = file_by_digest.get(envelope["content_digest"])
        obligation_id = obligation_of_evidence.get(evidence_id)
        if data is None:
            notes.append(f"not inspected: trace evidence {evidence_id} (file not supplied)")
            continue
        obligation = next((o for o in body["obligations"] if o["obligation_id"] == obligation_id), None)
        if not obligation_id or obligation is None or not obligation["effective_terms"]:
            problems.append(f"trace evidence {evidence_id}: its obligation is not in the package")
            continue
        inspected += 1
        try:
            raw = _json_parse(data.decode("utf-8-sig", errors="replace"))
        except ValueError:
            problems.append(f"trace evidence {evidence_id}: file is not JSON")
            continue
        events = [e for e in body["events"] if e["payload"]["obligation_id"] == obligation_id]
        terms = resolve_counterparty(obligation["effective_terms"], events)
        checked = check_trace(raw, declared_executions(events, terms["counterparty_agent_id"]), None)
        if not checked["ok"]:
            problems.append(f"trace evidence {evidence_id}: {checked['code']}: {checked['error']}")
            continue
        traces_by_obligation.setdefault(obligation_id, {})[trace_digest(checked["trace"])] = checked["trace"]

    for result in usage_results:
        digests = [d for d in result["details"]["trace_digests"].split(",") if d]
        available = traces_by_obligation.get(result["obligation_id"], {})
        missing = [d for d in digests if d not in available]
        label = f"usage_cost result for {result['obligation_id']}/{result['deliverable_id']}"
        if not digests or missing:
            notes.append(f"not inspected: {label} ({len(missing) or 'no'} trace file(s) not supplied)")
            continue
        obligation = next((o for o in body["obligations"] if o["obligation_id"] == result["obligation_id"]), None)
        terms = obligation["effective_terms"] if obligation is not None else None
        deliverable = next((d for d in terms["deliverables"] if d["deliverable_id"] == result["deliverable_id"]), None) if terms else None
        if not terms or "pricing" not in terms or deliverable is None:
            problems.append(f"{label}: the package's terms carry no pricing for this deliverable")
            continue
        inspected += 1
        try:
            recomputed = usage_cost_details(terms["pricing"], deliverable["amount_minor"], [available[d] for d in digests])
        except ValueError:
            problems.append(f"{label}: usage too large to price exactly")
            continue
        fields = ("expected_minor", "amount_minor", "within_tolerance", "trace_digests", "lines_digest", "unpriced")
        differing = [f for f in fields if not _same_value(recomputed[f], result["details"].get(f, _MISSING))]
        if differing:
            problems.append(f"{label}: recorded {', '.join(differing)} do not match the traces and pricing")

    if problems:
        return {"name": name, "ok": False, "details": problems}
    details = [*([f"{inspected} trace item(s) and usage result(s) rechecked"] if inspected > 0 else []), *notes]
    if inspected == 0:
        return {"name": name, "ok": True, "details": details, "state": "not_inspected"}
    return {"name": name, "ok": True, "details": details}


def _check_decision(
    decision: Json,
    events: list[Json],
    terms_by_digest: dict[str, Json],
    policies: dict[str, Json],
    verifier_results: list[Json],
    event_ids: set[str],
    evidence_digests: set[str],
    result_digests: set[str],
    contents: dict[str, str],
    resolve_key: Callable[[str, int], Json | None],
) -> list[str]:
    problems = []
    decision_id = decision["decision_id"]
    stored_digest = decision["decision_digest"]
    cutoff = decision["input_cutoff_sequence"]
    body = {k: v for k, v in decision.items() if k not in ("decision_id", "decision_digest", "decided_at", "supersedes_decision_id", "input_cutoff_sequence")}
    if digest_of(body) != stored_digest:
        problems.append(f"{decision_id}: decision_digest does not match decision body")
    problems.extend(f"{decision_id}: input event {e} missing" for e in decision["input_event_ids"] if e not in event_ids)
    problems.extend(f"{decision_id}: evidence digest {d} missing" for d in decision["evidence_digests"] if d not in evidence_digests)
    problems.extend(f"{decision_id}: verifier output {d} missing" for d in decision["verifier_output_digests"] if d not in result_digests)
    if decision["decision_maker"]["type"] != "automated":
        return problems

    policy_ref = decision["policy"]
    terms = terms_by_digest.get(decision["terms_digest"])
    policy = policies.get(f"{policy_ref['policy_id']}@{policy_ref['policy_version']}")
    if terms is None:
        return [*problems, f"{decision_id}: terms {decision['terms_digest']} not in package"]
    if policy is None:
        return [*problems, f"{decision_id}: policy {policy_ref['policy_id']}@{policy_ref['policy_version']} not in package"]
    if digest_of(policy) != policy_ref["policy_digest"]:
        problems.append(f"{decision_id}: policy digest mismatch")

    obligation_events = [e for e in events if e["payload"]["obligation_id"] == decision["obligation_id"]]
    acceptance = next(
        (
            e
            for e in obligation_events
            if e["payload"]["event_type"] == "obligation.accepted" and _same_value(e["payload"]["data"].get("terms_digest", _MISSING), decision["terms_digest"])
        ),
        None,
    )
    proposals = [e for e in obligation_events if e["payload"]["event_type"] == "completion.proposed" and e["sequence"] <= cutoff]
    completion = sorted(proposals, key=lambda e: -e["sequence"])[0] if proposals else None
    if acceptance is None:
        return [*problems, f"{decision_id}: acceptance event not in package"]

    maker = decision["decision_maker"]
    replay = evaluate_clearing(
        terms=terms,
        terms_digest=decision["terms_digest"],
        policy=policy,
        policy_digest=policy_ref["policy_digest"],
        acceptance_event_id=acceptance["payload"]["event_id"],
        completion_event_id=completion["payload"]["event_id"] if completion else None,
        evidence=build_evidence_inputs(obligation_events, terms, cutoff),
        verifier_results=[r for r in verifier_results if r["obligation_id"] == decision["obligation_id"] and r["executed_at"] <= decision["decided_at"]],
        decision_maker=maker,
        attestation_conflicts=(
            []
            if maker["id"] == CLEARING_ENGINE_ID_V1_0
            else obligation_attestation_conflicts(obligation_events, terms, contents, resolve_key, decision["decided_at"], cutoff)
        ),
    )
    if digest_of(replay) != stored_digest:
        problems.append(f"{decision_id}: replaying the clearing policy produced a different decision")
    return problems


def verify_closure_package(package: Any, trusted_keys: list[Json], traces: list[bytes] | None = None) -> Json:
    """Verifies a closure package offline and returns {"valid", "checks", "unsupported_schema_version"?}.

    trusted_keys are the published keys trusted out of band ({key_id, key_version, actor_id, algorithm, public_key,
    valid_from, revoked_at}); the ATCN service key must be among them. traces are the trace files (raw bytes) behind
    agent_trace evidence, to recheck the traces and recompute usage_cost results. Each check is {"name", "ok",
    "details", "state"?}; state "not_inspected" means the check had nothing it could inspect, which is not a pass.
    """
    payload = package.get("payload") if isinstance(package, dict) else None
    declared = payload.get("package_version") if isinstance(payload, dict) else None
    if isinstance(declared, str) and declared not in SUPPORTED_PACKAGE_VERSIONS:
        supported = ", ".join(SUPPORTED_PACKAGE_VERSIONS)
        return {
            "valid": False,
            "unsupported_schema_version": declared,
            "checks": [{"name": "schema", "ok": False, "details": [f"package_version {declared} is not supported by this verifier (supports {supported})"]}],
        }
    pkg, issues = parse(CLOSURE_PACKAGE, package)
    if issues:
        return {"valid": False, "checks": [{"name": "schema", "ok": False, "details": issues}]}
    body = pkg["payload"]
    signature = pkg["signature"]
    checks: list[Json] = [{"name": "schema", "ok": True, "details": []}]

    # Keys: trusted keys win; package keys must not contradict them.
    keys: dict[str, Json] = {_key_ref(k["key_id"], k["key_version"]): k for k in body["public_keys"]}
    key_problems = []
    for trusted in trusted_keys:
        ref = _key_ref(trusted["key_id"], trusted["key_version"])
        existing = keys.get(ref)
        if existing is not None and not _same_key(existing, trusted):
            key_problems.append(f"package key {ref} contradicts published key")
        keys[ref] = trusted
    used_keys = {
        _key_ref(signature["key_id"], signature["key_version"]),
        *(_key_ref(e["signature"]["key_id"], e["signature"]["key_version"]) for e in body["events"]),
        *_attestation_signature_keys(body),
    }
    for k in body["public_keys"]:
        ref = _key_ref(k["key_id"], k["key_version"])
        if ref not in used_keys:
            key_problems.append(f"package key {ref} signs nothing in the package")
    checks.append({"name": "keys_consistent", "ok": not key_problems, "details": key_problems})

    # Package signature by the ATCN service.
    service_key = next(
        (k for k in trusted_keys if k["key_id"] == signature["key_id"] and k["key_version"] == signature["key_version"] and k["actor_id"] == SERVICE_ACTOR), None
    )
    package_signature_ok = service_key is not None and verify_payload(pkg, service_key["public_key"])
    package_signature_problem = "signature does not verify" if service_key is not None else "service key not among trusted keys"
    checks.append({"name": "package_signature", "ok": package_signature_ok, "details": [] if package_signature_ok else [package_signature_problem]})

    # Event signatures, hashes, key validity, and causation references.
    event_ids = {e["payload"]["event_id"] for e in body["events"]}
    event_problems = []
    for event in body["events"]:
        p = event["payload"]
        event_id = p["event_id"]
        if digest_of(p) != event["payload_hash"]:
            event_problems.append(f"{event_id}: payload_hash mismatch")
        key = keys.get(_key_ref(event["signature"]["key_id"], event["signature"]["key_version"]))
        if key is None:
            event_problems.append(f"{event_id}: unknown signing key {event['signature']['key_id']}#{event['signature']['key_version']}")
            continue
        if key["actor_id"] != p["actor_id"]:
            event_problems.append(f"{event_id}: key belongs to {key['actor_id']}, not {p['actor_id']}")
        if not _key_valid_at(key, event["received_at"]):
            event_problems.append(f"{event_id}: key not valid at receipt time {event['received_at']}")
        if not verify_payload(event, key["public_key"]):
            event_problems.append(f"{event_id}: signature does not verify")
        event_problems.extend(f"{event_id}: causation {cause} not in package" for cause in p["causation_ids"] if cause not in event_ids)
    checks.append({"name": "event_signatures_and_references", "ok": not event_problems, "details": event_problems})

    # Obligation lineage and terms digests.
    obligation_ids = {o["obligation_id"] for o in body["obligations"]}
    lineage_problems = []
    root_id = body["root_obligation_id"]
    root = next((o for o in body["obligations"] if o["obligation_id"] == root_id), None)
    if root is None:
        lineage_problems.append(f"root obligation {root_id} missing")
    elif root["parent_obligation_id"] is not None:
        lineage_problems.append(f"root obligation {root_id} has a parent")
    if body["requested_obligation_id"] not in obligation_ids:
        lineage_problems.append(f"requested obligation {body['requested_obligation_id']} missing")
    terms_by_digest: dict[str, Json] = {}
    for event in body["events"]:
        data = event["payload"]["data"]
        terms, terms_digest = data.get("terms", _MISSING), data.get("terms_digest", _MISSING)
        if _js_truthy(terms) and _js_truthy(terms_digest):
            if not _same_value(digest_of(terms), terms_digest):
                lineage_problems.append(f"{event['payload']['event_id']}: terms_digest mismatch")
            # Only terms that are valid terms can be replayed; a decision citing other terms finds none.
            if isinstance(terms_digest, str) and not parse(OBLIGATION_TERMS, terms)[1]:
                terms_by_digest[terms_digest] = terms
    for o in body["obligations"]:
        obligation_id = o["obligation_id"]
        if o["parent_obligation_id"] and o["parent_obligation_id"] not in obligation_ids:
            lineage_problems.append(f"{obligation_id}: parent {o['parent_obligation_id']} missing")
        if o["redacted"]:
            if o["effective_terms"] is not None or o["effective_terms_digest"] is not None:
                lineage_problems.append(f"{obligation_id}: redacted obligation carries terms")
            continue
        if not o["effective_terms"] or not o["effective_terms_digest"]:
            lineage_problems.append(f"{obligation_id}: unredacted obligation without terms")
            continue
        if digest_of(o["effective_terms"]) != o["effective_terms_digest"]:
            lineage_problems.append(f"{obligation_id}: effective terms digest mismatch")
        accepted = any(
            e["payload"]["obligation_id"] == obligation_id
            and e["payload"]["event_type"] == "obligation.accepted"
            and _same_value(e["payload"]["data"].get("terms_digest", _MISSING), o["effective_terms_digest"])
            for e in body["events"]
        )
        if not accepted and o["state"] not in ("draft", "offered", "cancelled", "expired"):
            lineage_problems.append(f"{obligation_id}: no acceptance event for effective terms")
    parent_of = {o["obligation_id"]: o["parent_obligation_id"] for o in body["obligations"]}
    for obligation_id in parent_of:
        seen: set[str] = set()
        current = obligation_id
        while current:
            if current in seen:
                lineage_problems.append(f"cycle at {obligation_id}")
                break
            seen.add(current)
            current = parent_of.get(current)
    checks.append({"name": "obligation_lineage", "ok": not lineage_problems, "details": lineage_problems})

    # Decisions: inputs exist, digests recompute, automated decisions replay identically.
    evidence_digests = {e["content_digest"] for e in body["evidence"]}
    result_digests = {verifier_output_digest(r) for r in body["verifier_results"]}
    policies = {f"{p['policy_id']}@{p['policy_version']}": p for p in body["policies"]}
    contents = _attestation_contents(body)

    def resolve_key(key_id: str, key_version: int) -> Json | None:
        return keys.get(_key_ref(key_id, key_version))

    decision_problems = []
    for decision in body["decisions"]:
        decision_problems.extend(
            _check_decision(decision, body["events"], terms_by_digest, policies, body["verifier_results"], event_ids, evidence_digests, result_digests, contents, resolve_key)
        )
    checks.append({"name": "decision_inputs_and_replay", "ok": not decision_problems, "details": decision_problems})

    # Journal balance and references.
    decision_ids = {d["decision_id"] for d in body["decisions"]}
    batch_ids = {b["batch_id"] for b in body["posting_batches"]}
    journal_problems = []
    for batch in body["posting_batches"]:
        batch_id = batch["batch_id"]
        balance = check_balanced(batch["lines"])
        if not balance["balanced"]:
            journal_problems.append(f"{batch_id}: {'; '.join(balance['problems'])}")
        if batch["decision_id"] and batch["decision_id"] not in decision_ids:
            journal_problems.append(f"{batch_id}: decision {batch['decision_id']} missing")
        if batch["reverses_batch_id"] and batch["reverses_batch_id"] not in batch_ids:
            journal_problems.append(f"{batch_id}: reversed batch missing")
        journal_problems.extend(f"{batch_id}: source event {source} missing" for source in batch["source_event_ids"] if source not in event_ids)
    checks.append({"name": "journal_balance_and_references", "ok": not journal_problems, "details": journal_problems})

    # Settlement references.
    instruction_ids = {i["instruction_id"] for i in body["settlement_instructions"]}
    settlement_problems = []
    for instruction in body["settlement_instructions"]:
        if instruction["obligation_id"] not in obligation_ids:
            settlement_problems.append(f"{instruction['instruction_id']}: obligation missing")
        if instruction["decision_id"] not in decision_ids:
            settlement_problems.append(f"{instruction['instruction_id']}: decision missing")
    for event in body["settlement_events"]:
        if event["instruction_id"] and event["instruction_id"] not in instruction_ids:
            settlement_problems.append(f"{event['settlement_event_id']}: instruction {event['instruction_id']} missing")
    settlement_event_ids = {s["settlement_event_id"] for s in body["settlement_events"]}
    for batch in body["posting_batches"]:
        if batch["settlement_event_id"] and batch["settlement_event_id"] not in settlement_event_ids:
            settlement_problems.append(f"{batch['batch_id']}: settlement event {batch['settlement_event_id']} missing")
    checks.append({"name": "settlement_references", "ok": not settlement_problems, "details": settlement_problems})
    checks.append(_records_match_events_check(body))
    checks.append(_trace_evidence_check(body, traces or []))
    if body["package_version"] != "1.0":
        checks.append(_attestation_conflicts_check(body, contents, resolve_key))
    return {"valid": all(c["ok"] for c in checks), "checks": checks}


# ---------- Subledger closures backed by obligations (@atcn/subledger bridge.ts, verify.ts) ----------

_PAYEE_ROLES = ("payee_share", "child_cost", "parent_margin")
SETTLEMENT_REPORT_BASIS = {
    "manual": "settlement_reported_by_operator",
    "stripe": "settlement_relayed_from_stripe_by_operator_connector",
    "sandbox": "settlement_simulated_in_sandbox",
}


def _credited(lines: list[Json], match: Callable[[Json], bool]) -> int | float:
    return _js_sum(line["credit_minor"] for line in lines if match(line))


def _fact(batch: Json, kind: str, fact_type: str, amount: int | float) -> list[Json]:
    if amount <= 0:
        return []
    return [{"key": f"{batch['batch_id']}:{kind}", "type": fact_type, "amount_minor": amount, "currency": batch["lines"][0]["currency"], "reverses_key": None}]


def clearing_facts(batch: Json, undone: Json | None) -> list[Json]:
    """Financial facts of one journal batch, from the payer's side: a clearing batch gives a charge and a platform fee, a
    settlement a payment report, a refund a refund, and a reversal or return reverses the undone batch's facts."""
    entry_type = batch["entry_type"]
    lines = batch["lines"]
    if entry_type == "clearing":
        return [
            *_fact(batch, "charge", "charge", _credited(lines, lambda l: l["account_type"] == "payable" and l["allocation_role"] in _PAYEE_ROLES)),
            *_fact(batch, "fee", "fee", _credited(lines, lambda l: l["account_type"] == "platform_fee")),
        ]
    if entry_type == "settlement":
        return _fact(batch, "payment", "payment_reported", _credited(lines, lambda l: l["account_type"] == "settlement_reported"))
    if entry_type == "refund":
        return _fact(batch, "refund", "refund", _credited(lines, lambda l: l["account_type"] == "refund"))
    if entry_type in ("reversal", "return"):
        if undone is None:
            return []
        return [
            {
                "key": f"{batch['batch_id']}:{f['key'][f['key'].index(':') + 1 :]}",
                "type": "reversal",
                "amount_minor": f["amount_minor"],
                "currency": f["currency"],
                "reverses_key": f["key"],
            }
            for f in clearing_facts(undone, None)
        ]
    return []


def settlement_evidence(batch: Json, settlement_events: list[Json]) -> Json | None:
    """The settlement report behind a batch posted from one (its ID and digest, labeled with its basis), else None."""
    event = next((e for e in settlement_events if e["settlement_event_id"] == batch["settlement_event_id"]), None)
    if event is None:
        return None
    return {
        "uri": f"urn:atcn:settlement-event:{event['settlement_event_id']}",
        "digest": digest_of(event),
        "evidence_type": SETTLEMENT_REPORT_BASIS[event["provider"]],
    }


def undone_batch(batch: Json, batches: list[Json], settlement_events: list[Json]) -> Json | None:
    """The batch a reversal or return undoes: the reversed batch, or the settlement batch of the returned instruction."""
    if batch["entry_type"] == "reversal":
        return next((b for b in batches if b["batch_id"] == batch["reverses_batch_id"]), None)
    if batch["entry_type"] != "return":
        return None
    report = next((e for e in settlement_events if e["settlement_event_id"] == batch["settlement_event_id"]), None)
    instruction_id = report["instruction_id"] if report is not None else None
    if not instruction_id:
        return None
    settled = {e["settlement_event_id"] for e in settlement_events if e["instruction_id"] == instruction_id and e["normalized_status"] == "settled"}
    return next((b for b in batches if b["entry_type"] == "settlement" and b["settlement_event_id"] is not None and b["settlement_event_id"] in settled), None)


def obligation_link_problems(closure: Json, link: Json, packages: list[Any], trusted_keys: list[Json]) -> list[str]:
    """One obligation link of a subledger closure against the supplied closure packages: the package covering the
    obligation must verify and contain the linked decision, and its journal batches posted by the closure's
    generated_at must produce exactly the financial events the closure records from the clearing network."""
    obligation_id = link["obligation_id"]
    pkg = None
    for candidate in packages:
        parsed, issues = parse(CLOSURE_PACKAGE, candidate)
        if not issues and any(o["obligation_id"] == obligation_id and not o["redacted"] for o in parsed["payload"]["obligations"]):
            pkg = parsed
            break
    if pkg is None:
        return [f"no supplied closure package covers obligation {obligation_id}"]
    body = pkg["payload"]
    problems = []

    report = verify_closure_package(pkg, trusted_keys)
    if not report["valid"]:
        failed = ", ".join(c["name"] for c in report["checks"] if not c["ok"])
        problems.append(f"closure package for {obligation_id} does not verify ({failed})")
    if link["decision_id"] is not None:
        decision = next((d for d in body["decisions"] if d["decision_id"] == link["decision_id"] and d["obligation_id"] == obligation_id), None)
        if decision is None:
            problems.append(f"decision {link['decision_id']} is not in the package for {obligation_id}")
        elif decision["decision_digest"] != link["decision_digest"]:
            problems.append(f"decision {link['decision_id']} digest differs from the package")

    batches = [b for b in body["posting_batches"] if b["obligation_id"] == obligation_id]
    expected = [
        {**f, "evidence": settlement_evidence(b, body["settlement_events"])}
        for b in batches
        if b["posted_at"] <= closure["generated_at"]
        for f in clearing_facts(b, undone_batch(b, batches, body["settlement_events"]))
    ]
    recorded = [e["record"] for e in closure["financial_events"] if e["record"]["source"] == CLEARING_SOURCE and e["attributed_to"] == link["delegation_id"]]
    by_key = {e["source_event_id"]: e for e in recorded}
    for f in expected:
        e = by_key.get(f["key"])
        if e is None:
            problems.append(f"journal fact {f['key']} ({f['type']} {_js_number(f['amount_minor'])} {f['currency']}) is missing from the closure")
            continue
        if e["type"] != f["type"] or e["amount_minor"] != f["amount_minor"] or e["currency"] != f["currency"]:
            problems.append(f"event {e['financial_event_id']} does not match journal fact {f['key']}")
        if digest_of(e["evidence"]) != digest_of(f["evidence"]):
            problems.append(f"event {e['financial_event_id']} does not cite the settlement report and basis in the package")
        if f["reverses_key"] is not None:
            target = by_key.get(f["reverses_key"])
            if (target["financial_event_id"] if target is not None else _MISSING) != e["reverses_event_id"]:
                problems.append(f"reversal {e['financial_event_id']} does not undo the event for {f['reverses_key']}")
    expected_keys = {f["key"] for f in expected}
    problems.extend(
        f"event {e['financial_event_id']} ({e['source_event_id']}) has no matching fact in the package's journal" for e in recorded if e["source_event_id"] not in expected_keys
    )
    return problems
