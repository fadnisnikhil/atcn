"""Offline verification of signed subledger closures and receipts, check for check the same as @atcn/subledger.

No network calls and no service access: give it the document, the published service keys (GET /v1/service/keys) and,
optionally, the previous version, the operator's published keys, the trace files behind recorded usage and a time.
The report has the same check names, results and details as the TypeScript verifier and `npx @atcn/verify-cli`.
"""

import json
from datetime import datetime, timezone
from typing import Any

from .canonical import canonicalize
from .crypto import digest_of, verify_payload
from .documents import (
    AGENT_TRACE,
    CLOSURE_DOCUMENT_TYPE,
    RECEIPT_DOCUMENT_TYPE,
    SIGNED_BY_HOSTED_SERVICE,
    SIGNED_CLOSURE,
    SIGNED_RECEIPT,
    SUBLEDGER_VERIFIER_VERSION,
    SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS,
    _MISSING,
    attestable_fields_for,
    parse,
)
from .exceptions import closure_derived_exceptions, is_recomputable_exception
from .package import obligation_link_problems
from .projection import (
    build_expectation_report,
    closure_disclosure,
    date_parse,
    delivery_status,
    expectation_signature_problem,
    label_responses,
    outcome_signature_problem,
    receipt_totals,
    resolve_attestations,
    response_attestation,
    rollup_for,
    signer_key_bindings,
    usage_checks_for,
)
from .rails import _js_string, build_rail_attestation_report, rail_attestation_problem
from .subledger import execution_binding, verify_countersignature, verify_statement_signature
from .trace import summarize_trace, trace_digest, trace_problems

Json = dict[str, Any]

SERVICE_ACTOR = "svc_atcn"
CLEARING_SOURCE = "atcn-clearing"
_SCHEMA_1_2_ASSERTERS = ("buyer", "provider")
_SCHEMA_1_4_STATEMENT_FIELDS = ("execution", "issued_at", "expires_at", "refs")
_SCHEMA_1_4_LABELS = ("expired", "revoked")
_BEFORE_1_5 = ("1.2", "1.3", "1.4")


def _check(name: str, problems: list[str]) -> Json:
    return {"name": name, "ok": not problems, "details": problems}


def _passed(name: str, details: list[str]) -> Json:
    return {"name": name, "ok": True, "details": details}


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _payload_member(document: Any, key: str) -> Any:
    payload = document.get("payload") if isinstance(document, dict) else None
    return payload.get(key, _MISSING) if isinstance(payload, dict) else _MISSING


def _js_text(value: Any) -> str:
    """JavaScript's String(value), where a missing member is undefined."""
    return "undefined" if value is _MISSING else _js_string(value)


def verify_subledger_document(
    document: Any,
    trusted_keys: list[Json],
    previous: Any = None,
    operator_keys: list[Json] | None = None,
    require_operator_signature: bool = False,
    at: str | None = None,
    traces: list[bytes] | None = None,
    obligation_packages: list[Any] | None = None,
) -> Json:
    """Detects the document type and verifies it offline.

    trusted_keys are published service keys ({key_id, key_version, actor_id, public_key, valid_from, revoked_at}).
    previous is the previous closure version or receipt revision, to check the chain link. operator_keys are the issuing
    operator's published keys ({operator_id, key_id, public_key, created_at, revoked_at}), to check countersignatures;
    require_operator_signature fails unless one by the operator's own key verifies. at is the time to check a receipt's
    expires_at against (default now). traces are trace files (raw bytes) behind recorded usage. obligation_packages are
    the closure packages of obligations a closure links to; with them (an empty list counts as supplied) each link is
    cross-checked against its package and the package is verified with trusted_keys.

    Returns {"valid", "document_type", "checks": [{"name", "ok", "details", "state"?}], "unsupported_schema_version"?}.
    """
    options = {
        "trusted_keys": trusted_keys,
        "previous": previous,
        "operator_keys": operator_keys,
        "require_operator_signature": require_operator_signature,
        "at": at,
        "traces": traces,
        "obligation_packages": obligation_packages,
    }
    document_type = _payload_member(document, "document_type")
    if document_type == RECEIPT_DOCUMENT_TYPE:
        return _verify_receipt(document, options)
    if document_type == CLOSURE_DOCUMENT_TYPE:
        return _verify_closure(document, options)
    return {"valid": False, "document_type": None, "checks": [_check("document_type", [f"unknown document_type {_js_text(document_type)}"])]}


def _finish(document_type: str, checks: list[Json]) -> Json:
    return {"valid": all(c["ok"] for c in checks), "document_type": document_type, "checks": checks}


def _unsupported_version(document_type: str, document: Any) -> Json | None:
    """Runs before schema parsing, so a document from a newer schema does not fail with a misleading schema error."""
    version = _payload_member(document, "schema_version")
    if isinstance(version, str) and version in SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS:
        return None
    versions = list(SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS)
    detail = (
        f"unsupported schema_version {_js_text(version)}: this verifier (@atcn/subledger {SUBLEDGER_VERIFIER_VERSION}) supports "
        f"{', '.join(versions[:-1])} and {versions[-1]}. Upgrade @atcn/verify-cli (or @atcn/subledger) to the minimum "
        "version listed for this schema in packages/schema/COMPATIBILITY.md."
    )
    return {"valid": False, "document_type": document_type, "unsupported_schema_version": _js_text(version), "checks": [_check("schema_version", [detail])]}


# ---------- Signatures ----------


def _signature_check(doc: Json, at: str, trusted_keys: list[Json]) -> Json:
    signature = doc["signature"]
    key = next((k for k in trusted_keys if k["key_id"] == signature["key_id"] and k["key_version"] == signature["key_version"] and k["actor_id"] == SERVICE_ACTOR), None)
    if key is None:
        return _check("issuer_signature", [f"signing key {signature['key_id']}#{signature['key_version']} is not a trusted service key"])
    problems = []
    if not (key["valid_from"] <= at and (key["revoked_at"] is None or key["revoked_at"] > at)):
        problems.append("signing key was not valid at signing time")
    if not verify_payload(doc, key["public_key"]):
        problems.append("signature does not verify over the canonical payload")
    return _check("issuer_signature", problems)


def _operator_signature_check(payload: Json, operator_id: str, signatures: list[Json] | None, options: Json) -> Json:
    signatures = signatures or []
    required = options["require_operator_signature"]
    if not signatures:
        return _check("operator_signatures", ["no countersignature by the operator's own key"]) if required else _passed("operator_signatures", ["no operator countersignature"])
    operator_keys = options["operator_keys"]
    if operator_keys is None:
        note = f"operator keys not supplied; {len(signatures)} countersignature(s) not checked"
        return _check("operator_signatures", [note]) if required else _passed("operator_signatures", [note])
    problems = []
    for sig in signatures:
        key = next((k for k in operator_keys if k["operator_id"] == operator_id and k["key_id"] == sig["key_id"]), None)
        if key is None:
            problems.append(f"key {sig['key_id']} is not a published key of operator {operator_id}")
        elif key["created_at"] > sig["signed_at"] or (key["revoked_at"] is not None and key["revoked_at"] <= sig["signed_at"]):
            problems.append(f"key {sig['key_id']} was not valid when the countersignature was recorded")
        elif not verify_countersignature(payload, sig["value"], key["public_key"]):
            problems.append(f"countersignature by {sig['key_id']} does not verify over the canonical payload")
    return _check("operator_signatures", problems)


# ---------- Schema version features ----------


def _version_feature_problems(version: str, signed_by: str, claims: list[Json], has_obligation_links: bool) -> list[str]:
    """A document that declares 1.2 must not carry 1.3 fields, which 1.2 verifiers cannot read."""
    if version != "1.2":
        return []
    problems = [f"schema 1.2 does not allow asserted_by {c['asserted_by']}" for c in claims if c["asserted_by"] not in _SCHEMA_1_2_ASSERTERS]
    if any("network_recorded" in c["assurance"] for c in claims):
        problems.append("schema 1.2 does not allow assurance network_recorded")
    if has_obligation_links:
        problems.append("schema 1.2 does not allow obligation_links")
    if signed_by != SIGNED_BY_HOSTED_SERVICE:
        problems.append(f"schema 1.2 does not allow signed_by {signed_by}")
    return problems


def _schema14_problems(version: str, delegations: list[Json], responses: list[Json], claims: list[Json]) -> list[str]:
    """A document that declares 1.2 or 1.3 must not carry 1.4 fields, which those verifiers would drop before checking signatures."""
    if version not in ("1.2", "1.3"):
        return []
    problems = [f"schema {version} does not allow execution on delegation {d['delegation_id']}" for d in delegations if "execution" in d]
    for r in responses:
        problems.extend(f"schema {version} does not allow statement {field} (response {r['response_id']})" for field in _SCHEMA_1_4_STATEMENT_FIELDS if field in r["statement"])
    for item in [*responses, *claims]:
        problems.extend(f"schema {version} does not allow assurance {label}" for label in item["assurance"] if label in _SCHEMA_1_4_LABELS)
    return problems


def _schema15_problems(
    version: str,
    delegations: list[Json],
    claims: list[Json],
    events: list[Json],
    responses: list[Json],
    field_lists: list[list[str]],
    has_usage_checks: bool = False,
    has_expectation_report: bool = False,
    has_estimate_tolerance: bool = False,
    has_rail_attestations: bool = False,
    has_receipt_key_bindings: bool = False,
    has_resolved_exceptions: bool = False,
) -> list[str]:
    """A document that declares 1.2, 1.3 or 1.4 must not carry 1.5 fields, which those verifiers would drop before checking signatures."""
    if version not in _BEFORE_1_5:
        return []
    problems = []
    for d in delegations:
        for field in ("pricing", "refund_terms", "witness_policy"):
            if field in d:
                problems.append(f"schema {version} does not allow {field} on delegation {d['delegation_id']}")
        if "additional_models" in d.get("execution", {}).get("agent", {}):
            problems.append(f"schema {version} does not allow additional_models on delegation {d['delegation_id']}")
    for c in claims:
        for field in ("usage", "signer"):
            if field in c:
                problems.append(f"schema {version} does not allow {field} on delivery claim {c['event_id']}")
    for e in events:
        event_id = e["financial_event_id"]
        if "skill" in e:
            problems.append(f"schema {version} does not allow skill on financial event {event_id}")
        if e["normalized_status"] == "pending_finality":
            problems.append(f"schema {version} does not allow status pending_finality on financial event {event_id}")
        if e["type"] in ("estimate", "hold"):
            problems.append(f"schema {version} does not allow {e['type']} events (financial event {event_id})")
        for field in ("expectation", "rail_attestation"):
            if field in e:
                problems.append(f"schema {version} does not allow {field} on financial event {event_id}")
    if has_usage_checks:
        problems.append(f"schema {version} does not allow usage_checks")
    if has_expectation_report:
        problems.append(f"schema {version} does not allow expectation_report")
    if has_estimate_tolerance:
        problems.append(f"schema {version} does not allow task estimate_tolerance_bps")
    if has_rail_attestations:
        problems.append(f"schema {version} does not allow rail_attestations")
    if has_receipt_key_bindings:
        problems.append(f"schema {version} does not allow key_bindings on a receipt")
    if has_resolved_exceptions:
        problems.append(f"schema {version} does not allow resolved_exceptions")
    problems.extend(f"schema {version} does not allow statement role (response {r['response_id']})" for r in responses if "role" in r["statement"])
    usage_field_used = any("delivery.usage" in fields for fields in field_lists) or any(
        "delivery.usage" in r["statement"]["fields"] or any(c["field"] == "delivery.usage" for c in r["statement"]["corrections"]) for r in responses
    )
    if usage_field_used:
        problems.append(f"schema {version} does not allow the delivery.usage field")
    return problems


# ---------- Traces ----------


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _parse_trace_file(data: bytes) -> Json | str:
    try:
        raw = json.loads(data.decode("utf-8-sig", errors="replace"), parse_constant=_reject_constant)
    except ValueError:
        return "not JSON"
    trace, issues = parse(AGENT_TRACE, raw)
    if issues:
        return f"not a trace: {issues[0]}"
    problems = trace_problems(trace)
    return f"malformed trace: {'; '.join(problems)}" if problems else trace


def _trace_summary_check(claims: list[Json], trace_files: list[bytes] | None) -> Json:
    """Recomputes each recorded usage summary from its trace file. Usage whose trace was not supplied is reported as not
    inspected; it neither passes nor fails. A supplied file that is not a well-formed trace fails."""
    name = "trace_summary"
    with_usage = [c for c in claims if "usage" in c]
    if not with_usage:
        return _passed(name, ["no usage recorded"])
    problems = []
    traces: dict[str, Json] = {}
    for index, data in enumerate(trace_files or []):
        trace = _parse_trace_file(data)
        if isinstance(trace, str):
            problems.append(f"trace file {index + 1}: {trace}")
        else:
            traces[trace_digest(trace)] = trace
    not_inspected = []
    used = set()
    for claim in with_usage:
        usage = claim["usage"]
        trace = traces.get(usage["trace_digest"])
        if trace is None:
            not_inspected.append(f"not inspected: delivery claim {claim['event_id']} (trace {usage['trace_digest']} not supplied)")
            continue
        used.add(usage["trace_digest"])
        if digest_of(summarize_trace(trace)) != digest_of(usage["summary"]):
            problems.append(f"delivery claim {claim['event_id']}: recorded usage does not match its trace {usage['trace_digest']}")
    if problems:
        return _check(name, problems)
    unused = [f"supplied trace {d} matches no recorded usage" for d in traces if d not in used]
    inspected = len(with_usage) - len(not_inspected)
    details = [*([f"{inspected} recorded usage summary(ies) match their traces"] if inspected > 0 else []), *not_inspected, *unused]
    if inspected == 0:
        return {"name": name, "ok": True, "details": details, "state": "not_inspected"}
    return _passed(name, details)


def _reversal_problems(events: list[Json]) -> list[str]:
    by_id = {e["financial_event_id"]: e for e in events}
    problems = []
    for e in events:
        if e["type"] != "reversal":
            continue
        original = by_id.get(e["reverses_event_id"]) if e["reverses_event_id"] else None
        if original is None:
            problems.append(f"reversal {e['financial_event_id']} references an event not in the document")
        elif original["amount_minor"] != e["amount_minor"] or original["currency"] != e["currency"]:
            problems.append(f"reversal {e['financial_event_id']} does not match the reversed amount and currency")
    return problems


_NOT_CANONICAL = "payload is not canonical JSON: numbers must be safe integers"


def _is_canonical(payload: Json) -> bool:
    """Free-form parts of a payload, such as an embedded rail record, can hold numbers that no signature could cover."""
    try:
        canonicalize(payload)
        return True
    except ValueError:
        return False


# ---------- Receipts ----------


def _verify_receipt(document: Any, options: Json) -> Json:
    unsupported = _unsupported_version(RECEIPT_DOCUMENT_TYPE, document)
    if unsupported is not None:
        return unsupported
    doc, issues = parse(SIGNED_RECEIPT, document)
    if issues:
        return _finish(RECEIPT_DOCUMENT_TYPE, [_check("schema", issues)])
    if not _is_canonical(doc["payload"]):
        return _finish(RECEIPT_DOCUMENT_TYPE, [_check("schema", [_NOT_CANONICAL])])
    r = doc["payload"]
    version = r["schema_version"]
    schema_problems = [
        *_version_feature_problems(version, r["issuer"]["signed_by"], r["delivery_claims"], False),
        *_schema14_problems(version, [r["delegation"]], [], r["delivery_claims"]),
        *_schema15_problems(
            version,
            delegations=[r["delegation"]],
            claims=r["delivery_claims"],
            events=r["financial_events"],
            responses=[],
            field_lists=[list(r["field_status"]), r["unverified_fields"], *(c["fields"] for c in r["corrections"])],
            has_receipt_key_bindings="key_bindings" in r,
        ),
    ]
    checks = [
        _check("schema", schema_problems),
        _signature_check(doc, r["issued_at"], options["trusted_keys"]),
        _operator_signature_check(r, r["issuer"]["operator_id"], doc.get("operator_signatures"), options),
    ]

    events = [
        {**{key: value for key, value in e.items() if key != "allocation_version"}, "liability_owner": None, "economic_event_id": None, "fx": None} for e in r["financial_events"]
    ]
    checks.append(_check("reversals", _reversal_problems(events)))

    recomputed = receipt_totals(r["delegation"], events)
    checks.append(_check("totals", [] if digest_of(recomputed) == digest_of(r["totals"]) else ["totals do not match the listed financial events"]))

    field_problems = []
    fields = attestable_fields_for(version)
    expected_unverified = [f for f in fields if r["field_status"].get(f) != "missing"]
    if digest_of(expected_unverified) != digest_of(r["unverified_fields"]):
        field_problems.append("unverified_fields must list every non-missing field")
    field_problems.extend(f"field_status is missing {f}" for f in fields if not r["field_status"].get(f))
    checks.append(_check("field_disclosure", field_problems))

    checks.append(_receipt_signed_records_check(r, events))
    checks.append(_receipt_chain_check(r, options))
    checks.append(_receipt_expiry_check(r, options["at"] or _now_iso()))
    checks.append(_trace_summary_check(r["delivery_claims"], options["traces"]))
    return _finish(RECEIPT_DOCUMENT_TYPE, checks)


def _receipt_signed_records_check(r: Json, events: list[Json]) -> Json:
    """Signed outcome claims, estimates and holds on a receipt must verify against the key bindings it lists, which must be
    exactly the bindings their signers name; only verified claims may be labelled provider_key_signed."""
    name = "signed_records"
    listed = r.get("key_bindings", [])
    problems = []
    if digest_of(signer_key_bindings(r["delivery_claims"], events, listed)) != digest_of(listed):
        problems.append("key_bindings must list exactly the bindings the receipt's signers name, in binding_id order")
    delegation = {"provider_id": r["provider"]["provider_id"], "provider_job_ref": r["delegation"]["provider_job_ref"]}
    for claim in r["delivery_claims"]:
        label = f"{claim['type']} claim {claim['event_id']}"
        labelled = "provider_key_signed" in claim["assurance"]
        if "signer" not in claim:
            if labelled:
                problems.append(f"{label} is labelled provider_key_signed without a signature")
            continue
        problem = outcome_signature_problem(claim, delegation, listed)
        if problem is not None:
            problems.append(problem)
        elif not labelled:
            problems.append(f"{label} is signed but not labelled provider_key_signed")
    for e in events:
        if "expectation" in e:
            problem = expectation_signature_problem(e, r["provider"]["provider_id"], listed)
            if problem is not None:
                problems.append(problem)
    if problems:
        return _check(name, problems)
    claims = len([c for c in r["delivery_claims"] if "signer" in c])
    estimates = len([e for e in events if "signer" in e.get("expectation", {})])
    if claims + estimates == 0:
        return _passed(name, ["no signed claims, estimates or holds"])
    return _passed(name, [f"{claims} provider-signed outcome claim(s) and {estimates} signed estimate/hold record(s) verify against the listed key bindings"])


def _receipt_expiry_check(r: Json, at: str) -> Json:
    """The issuer signed expires_at, so a receipt past it no longer stands, even though its signature still verifies."""
    if r["expires_at"] is None:
        return _passed("expiry", ["no expiry"])
    if date_parse(at) >= date_parse(r["expires_at"]):
        return _check("expiry", [f"receipt expired at {r['expires_at']} (checked at {at})"])
    return _passed("expiry", [f"valid until {r['expires_at']} (checked at {at})"])


def _receipt_chain_check(r: Json, options: Json) -> Json:
    name = "revision_chain"
    if r["revision"] == 1:
        return _check(name, [] if r["previous_receipt_digest"] is None and r["previous_receipt_id"] is None else ["revision 1 must not reference a previous receipt"])
    if r["previous_receipt_digest"] is None or r["previous_receipt_id"] is None:
        return _check(name, [f"revision {r['revision']} must reference its previous receipt"])
    if options["previous"] is None:
        return _passed(name, ["previous revision not supplied; link digest not checked"])
    previous, issues = parse(SIGNED_RECEIPT, options["previous"])
    if issues:
        return _check(name, ["supplied previous receipt is not a valid receipt"])
    p = previous["payload"]
    problems = []
    if p["receipt_id"] != r["previous_receipt_id"]:
        problems.append("previous_receipt_id does not match the supplied receipt")
    if digest_of(p) != r["previous_receipt_digest"]:
        problems.append("previous_receipt_digest does not match the supplied receipt")
    if p["revision"] + 1 != r["revision"]:
        problems.append("revision is not the next after the supplied receipt")
    if p["delegation"]["delegation_id"] != r["delegation"]["delegation_id"]:
        problems.append("previous receipt covers a different delegation")
    if not _signature_check(previous, p["issued_at"], options["trusted_keys"])["ok"]:
        problems.append("previous receipt signature does not verify")
    return _check(name, problems)


# ---------- Closures ----------


def _verify_closure(document: Any, options: Json) -> Json:
    unsupported = _unsupported_version(CLOSURE_DOCUMENT_TYPE, document)
    if unsupported is not None:
        return unsupported
    doc, issues = parse(SIGNED_CLOSURE, document)
    if issues:
        return _finish(CLOSURE_DOCUMENT_TYPE, [_check("schema", issues)])
    if not _is_canonical(doc["payload"]):
        return _finish(CLOSURE_DOCUMENT_TYPE, [_check("schema", [_NOT_CANONICAL])])
    c = doc["payload"]
    version = c["schema_version"]
    schema_problems = [
        *_version_feature_problems(version, c["issuer"]["signed_by"], c["delivery_claims"], "obligation_links" in c),
        *_schema14_problems(version, c["delegations"], c["responses"], c["delivery_claims"]),
        *_schema15_problems(
            version,
            delegations=c["delegations"],
            claims=c["delivery_claims"],
            events=[e["record"] for e in c["financial_events"]],
            responses=c["responses"],
            field_lists=[],
            has_usage_checks="usage_checks" in c,
            has_expectation_report="expectation_report" in c,
            has_estimate_tolerance="estimate_tolerance_bps" in c["task"],
            has_rail_attestations="rail_attestations" in c,
            has_resolved_exceptions="resolved_exceptions" in c,
        ),
    ]
    checks = [
        _check("schema", schema_problems),
        _signature_check(doc, c["generated_at"], options["trusted_keys"]),
        _operator_signature_check(c, c["issuer"]["operator_id"], doc.get("operator_signatures"), options),
    ]

    digest_problems = [f"event {e['record']['financial_event_id']} digest mismatch" for e in c["financial_events"] if digest_of(e["record"]) != e["event_digest"]]
    ids = [e["record"]["financial_event_id"] for e in c["financial_events"]]
    if len(set(ids)) != len(ids):
        digest_problems.append("a financial event appears more than once")
    checks.append(_check("event_digests", digest_problems))

    checks.append(_check("lineage", _lineage_problems(c)))
    checks.append(_check("reversals", _reversal_problems([e["record"] for e in c["financial_events"]])))
    checks.append(_check("allocations", _allocation_problems(c)))

    recomputed = rollup_for(c["task"], c["delegations"], c["financial_events"], c["allocations"])
    checks.append(_check("totals", [] if digest_of(recomputed) == digest_of(c["rollup"]) else ["roll-up does not match events, attribution, and allocations"]))

    checks.append(_derived_fields_check(c))
    checks.append(_provider_responses_check(c))
    checks.append(_closure_chain_check(c, options))
    checks.append(_obligation_link_check(c, options))
    checks.append(_usage_checks_check(c, recomputed))
    checks.append(_expectations_check(c, recomputed))
    checks.append(_open_exceptions_check(c))
    checks.append(_signed_claims_check(c))
    checks.append(_rail_attestations_check(c))
    checks.append(_trace_summary_check(c["delivery_claims"], options["traces"]))
    return _finish(CLOSURE_DOCUMENT_TYPE, checks)


def _lineage_problems(c: Json) -> list[str]:
    problems = []
    by_id = {d["delegation_id"]: d for d in c["delegations"]}
    if len(by_id) != len(c["delegations"]):
        problems.append("duplicate delegation IDs")
    for d in c["delegations"]:
        if d["parent_delegation_id"] is None:
            if d["depth"] != 1:
                problems.append(f"delegation {d['delegation_id']} is a direct child of the task but has depth {d['depth']}")
            continue
        parent = by_id.get(d["parent_delegation_id"])
        if parent is None:
            problems.append(f"delegation {d['delegation_id']} references a parent outside the task")
        elif parent["depth"] + 1 != d["depth"]:
            problems.append(f"delegation {d['delegation_id']} depth does not follow its parent")
        seen = {d["delegation_id"]}
        current = parent
        while current is not None:
            if current["delegation_id"] in seen:
                problems.append(f"cycle through {d['delegation_id']}")
                break
            seen.add(current["delegation_id"])
            current = by_id.get(current["parent_delegation_id"]) if current["parent_delegation_id"] else None
    nodes = {c["task"]["task_id"], *by_id}
    problems.extend(f"event {e['record']['financial_event_id']} is attributed outside the task tree" for e in c["financial_events"] if e["attributed_to"] not in nodes)
    problems.extend(f"delivery claim {claim['event_id']} references a delegation outside the task" for claim in c["delivery_claims"] if claim["delegation_id"] not in by_id)
    return problems


def _allocation_problems(c: Json) -> list[str]:
    problems = []
    events = {e["record"]["financial_event_id"]: e for e in c["financial_events"]}
    versions: dict[str, list[int]] = {}
    for a in c["allocations"]:
        event = events.get(a["financial_event_id"])
        if event is None:
            problems.append(f"allocation {a['allocation_id']} references an event not in the closure")
            continue
        if a["source_event_digest"] != event["event_digest"]:
            problems.append(f"allocation {a['allocation_id']} source digest does not match the event")
        if a["currency"] != event["record"]["currency"]:
            problems.append(f"allocation {a['allocation_id']} currency differs from its source")
        if a["source_amount_minor"] != abs(event["record"]["amount_minor"]):
            problems.append(f"allocation {a['allocation_id']} source amount differs from its event")
        total = sum(line["amount_minor"] for line in a["lines"])
        if total != a["source_amount_minor"]:
            problems.append(f"allocation {a['allocation_id']} lines sum to {total}, source is {a['source_amount_minor']}")
        versions.setdefault(a["financial_event_id"], []).append(a["version"])
    for event_id, listed in versions.items():
        if sorted(listed) != list(range(1, len(listed) + 1)):
            problems.append(f"allocation versions for {event_id} are not contiguous from 1")
    return problems


def _derived_fields_check(c: Json) -> Json:
    """Each delegation's delivery status, the lineage summary and the disclosure lists must be exactly what the closure's records produce."""
    problems = []
    for d in c["delegations"]:
        expected = delivery_status([claim for claim in c["delivery_claims"] if claim["delegation_id"] == d["delegation_id"]])
        if d["delivery_status"] != expected:
            problems.append(f"delegation {d['delegation_id']} delivery status {d['delivery_status']} does not follow from its claims ({expected})")
    if c["lineage"]["complete"] != (len(c["lineage"]["capture_gaps"]) == 0):
        problems.append("lineage.complete does not match the capture gaps")
    unknown_downstream = [d["delegation_id"] for d in c["delegations"] if d["downstream_visibility"] == "unknown"]
    if digest_of(unknown_downstream) != digest_of(c["lineage"]["unknown_downstream"]):
        problems.append("lineage.unknown_downstream does not match the delegations")
    disclosure = closure_disclosure(
        c["task"],
        c["delegations"],
        c["delivery_claims"],
        c["financial_events"],
        c["responses"],
        None if c["schema_version"] in _BEFORE_1_5 else c["generated_at"],
    )
    if digest_of(disclosure) != digest_of(c["disclosure"]):
        problems.append("disclosure lists do not match the closure's records")
    return _check("derived_fields", problems)


def _provider_responses_check(c: Json) -> Json:
    problems = _response_problems(c)
    notes = []
    resolution = resolve_attestations([response_attestation(r) for r in c["responses"]], c["generated_at"])
    response_id_of = {r["statement_digest"]: r["response_id"] for r in c["responses"]}
    for p in resolution["problems"]:
        response_id = response_id_of[p["digest"]]
        if p["code"] == "revocation_not_by_signer":
            problems.append(f"response {response_id} revokes {p['target']}, which its provider key did not sign")
        else:
            notes.append(f"response {response_id} references {p['target']}, which is not in this closure")
    for r in c["responses"]:
        if resolution["status"][r["statement_digest"]]["time"] == "not_yet_valid":
            problems.append(f"response {r['response_id']} was issued after the closure was generated")
    expected = {r["response_id"]: r["assurance"] for r in label_responses(c["responses"], c["generated_at"])}
    for r in c["responses"]:
        for label in _SCHEMA_1_4_LABELS:
            should_have = label in expected[r["response_id"]]
            if should_have != (label in r["assurance"]):
                problems.append(
                    f"response {r['response_id']} {'lacks' if should_have else 'carries'} assurance {label}, which does not match its expiry and revocations at {c['generated_at']}"
                )
    return _check("provider_responses", problems) if problems else _passed("provider_responses", notes)


def _response_problems(c: Json) -> list[str]:
    problems = []
    receipts = {r["receipt_id"]: r for r in c["receipts"]}
    delegations = {d["delegation_id"]: d for d in c["delegations"]}
    problems.extend(f"receipt {r['receipt_id']} covers a delegation outside the task" for r in c["receipts"] if r["delegation_id"] not in delegations)
    for response in c["responses"]:
        response_id = response["response_id"]
        receipt = receipts.get(response["receipt_id"])
        s = response["statement"]
        if digest_of(s) != response["statement_digest"]:
            problems.append(f"response {response_id} statement digest mismatch")
        if receipt is None:
            problems.append(f"response {response_id} references an unknown receipt")
            continue
        if (
            s["receipt_id"] != receipt["receipt_id"]
            or s["receipt_digest"] != receipt["digest"]
            or s["receipt_revision"] != receipt["revision"]
            or s["receipt_revision"] != response["receipt_revision"]
        ):
            problems.append(f"response {response_id} is not bound to receipt {receipt['receipt_id']} revision {receipt['revision']}")
        if s["issuer_operator_id"] != c["issuer"]["operator_id"]:
            problems.append(f"response {response_id} names another issuer")
        if "issued_at" not in s and ("expires_at" in s or "refs" in s):
            problems.append(f"response {response_id} needs issued_at with expires_at or refs")
        if "issued_at" in s and "expires_at" in s and date_parse(s["expires_at"]) <= date_parse(s["issued_at"]):
            problems.append(f"response {response_id} expires before it was issued")
        delegation = delegations.get(receipt["delegation_id"])
        if "execution" in s:
            declared = None if delegation is None else delegation.get("execution")
            if declared is None:
                problems.append(f"response {response_id} cites run {s['execution']['execution_id']}, but delegation {receipt['delegation_id']} records none")
            elif digest_of(execution_binding(declared)) != digest_of(s["execution"]):
                problems.append(f"response {response_id} cites run {s['execution']['execution_id']}, which is not the run recorded on delegation {receipt['delegation_id']}")
        claims_key_signed = "provider_key_signed" in response["assurance"]
        sig = response["provider_signature"]
        binding = None if sig is None else next((b for b in c["key_bindings"] if b["binding_id"] == sig["binding_id"] and b["key_id"] == sig["key_id"]), None)
        if s.get("role") == "witness":
            delegation_provider_id = None if delegation is None else delegation["provider_id"]
            problems.extend(_witness_statement_problems(response, delegation_provider_id, binding if claims_key_signed else None))
        if not claims_key_signed:
            continue
        if sig is None or binding is None:
            problems.append(f"response {response_id} claims provider_key_signed without a listed key binding")
        elif binding["provider_id"] != response["provider_id"]:
            problems.append(f"response {response_id} key binding belongs to another provider")
        elif binding["created_at"] > response["created_at"] or (binding["revoked_at"] is not None and binding["revoked_at"] <= response["created_at"]):
            problems.append(f"response {response_id} signed outside the key binding's validity")
        elif not verify_statement_signature(s, sig["value"], binding["public_key"]):
            problems.append(f"response {response_id} provider signature does not verify")
    return problems


def _witness_statement_problems(response: Json, delegation_provider_id: str | None, binding: Json | None) -> list[str]:
    """A witness statement is a signed_attestation that cites the run and at least one evidence item, signed with a
    domain-challenged key of a provider other than the delegation's own."""
    s = response["statement"]
    label = f"witness response {response['response_id']}"
    problems = []
    if s["response_type"] != "signed_attestation":
        problems.append(f"{label} must be a signed_attestation")
    if "execution" not in s:
        problems.append(f"{label} must cite the run it observed")
    if not s["evidence"]:
        problems.append(f"{label} must cite the evidence it saw")
    if binding is None:
        problems.append(f"{label} must be signed with a listed key binding")
    elif binding["method"] != "domain_challenge":
        problems.append(f"{label} must be signed with a domain-challenged key")
    if response["provider_id"] is not None and response["provider_id"] == delegation_provider_id:
        problems.append(f"{label} is from the delegation's own provider")
    return problems


def _closure_chain_check(c: Json, options: Json) -> Json:
    name = "version_chain"
    if c["version"] == 1:
        return _check(name, [] if c["previous_closure_digest"] is None and c["previous_closure_id"] is None else ["version 1 must not reference a previous closure"])
    if c["previous_closure_digest"] is None or c["previous_closure_id"] is None:
        return _check(name, [f"version {c['version']} must reference its previous closure"])
    if options["previous"] is None:
        return _passed(name, ["previous version not supplied; link digest not checked"])
    previous, issues = parse(SIGNED_CLOSURE, options["previous"])
    if issues:
        return _check(name, ["supplied previous closure is not a valid closure"])
    p = previous["payload"]
    problems = []
    if p["closure_id"] != c["previous_closure_id"]:
        problems.append("previous_closure_id does not match the supplied closure")
    if digest_of(p) != c["previous_closure_digest"]:
        problems.append("previous_closure_digest does not match the supplied closure")
    if p["version"] + 1 != c["version"]:
        problems.append("version is not the next after the supplied closure")
    if p["task"]["task_id"] != c["task"]["task_id"]:
        problems.append("previous closure covers a different task")
    if not _signature_check(previous, p["generated_at"], options["trusted_keys"])["ok"]:
        problems.append("previous closure signature does not verify")
    return _check(name, problems)


def _obligation_link_check(c: Json, options: Json) -> Json:
    """Every event recorded from the clearing journal must sit on a delegation linked to an obligation. With the
    obligations' closure packages, each package must verify, contain the linked decision, and its journal batches posted
    before the closure must produce exactly the recorded events."""
    name = "obligation_links"
    links = c.get("obligation_links", [])
    delegation_ids = {d["delegation_id"] for d in c["delegations"]}
    problems = [f"linked delegation {link['delegation_id']} is not in the task" for link in links if link["delegation_id"] not in delegation_ids]
    if len({link["obligation_id"] for link in links}) != len(links):
        problems.append("an obligation is linked more than once")
    linked = {link["delegation_id"] for link in links}
    problems.extend(
        f"clearing-network event {e['record']['financial_event_id']} is attributed to a node without a linked obligation"
        for e in c["financial_events"]
        if e["record"]["source"] == CLEARING_SOURCE and e["attributed_to"] not in linked
    )
    if problems:
        return _check(name, problems)
    if not links:
        return _passed(name, ["no delegation is backed by an obligation"])
    packages = options["obligation_packages"]
    if packages is None:
        return _passed(name, [f"{len(links)} linked obligation(s); closure packages not supplied; not cross-checked"])
    for link in links:
        problems.extend(obligation_link_problems(c, link, packages, options["trusted_keys"]))
    if problems:
        return _check(name, problems)
    return _passed(name, [f"{len(links)} linked obligation(s) match their closure packages"])


def _usage_checks_check(c: Json, rollup: Json) -> Json:
    """The closure's usage checks must be exactly what its pricing, usage claims, roll-up and responses produce."""
    name = "usage_checks"
    expected = usage_checks_for(c["delegations"], c["delivery_claims"], rollup, c["responses"], c["receipts"])
    recorded = c.get("usage_checks", [])
    if digest_of(expected) != digest_of(recorded):
        return _check(name, ["usage_checks do not match the delegations' pricing, recorded usage and billed amounts"])
    if not recorded:
        return _passed(name, ["no delegation has both pricing and recorded usage"])
    outside = [u["delegation_id"] for u in recorded if u["within_tolerance"] is False or u["expected_minor"] is None]
    return _passed(name, [f"{len(recorded)} usage check(s) recomputed", *([f"outside tolerance or unpriced: {', '.join(outside)}"] if outside else [])])


def _expectations_check(c: Json, rollup: Json) -> Json:
    """Signed estimates and holds must verify, and the expectation report must be exactly what the closure's records produce."""
    name = "expectations"
    provider_of = {d["delegation_id"]: d["provider_id"] for d in c["delegations"]}
    problems = []
    for e in c["financial_events"]:
        if "expectation" not in e["record"]:
            continue
        problem = expectation_signature_problem(e["record"], provider_of.get(e["attributed_to"]), c["key_bindings"])
        if problem is not None:
            problems.append(problem)
    expected = build_expectation_report(c["task"], c["delegations"], c["delivery_claims"], c["financial_events"], rollup, c["key_bindings"])
    if digest_of(expected) != digest_of(c.get("expectation_report")):
        problems.append("expectation_report does not match the closure's estimates, holds and costs")
    if problems:
        return _check(name, problems)
    if expected is None:
        return _passed(name, ["no estimates or holds"])
    signed = len([r for r in expected["records"] if "buyer_recorded" not in r["assurance"]])
    return _passed(
        name,
        [f"{len(expected['records'])} estimate/hold record(s), {signed} signed by the agent or a gateway; report recomputed", "recorded only: nothing was enforced, blocked or reserved"],
    )


def _open_exceptions_check(c: Json) -> Json:
    """Schema 1.5: the derived exceptions recomputed from the closure's own records, as of generated_at and at close, must
    each be open or listed as resolved by a person, and no open derived exception may lack its condition."""
    name = "open_exceptions"
    version = c["schema_version"]
    if version in _BEFORE_1_5:
        return _passed(name, [f"schema {version}: open exceptions are not recomputed"])
    derived = closure_derived_exceptions(c)

    def same_condition(x: Json, d: Json) -> bool:
        return x["kind"] == d["kind"] and x["delegation_id"] == d["delegation_id"] and x["detail"] == d["detail"]

    open_exceptions = [x for x in c["open_exceptions"] if is_recomputable_exception(x["kind"])]
    resolved = c.get("resolved_exceptions", [])
    problems = [f"open_exceptions lists {x['kind']} exception {x['exception_id']} with status {x['status']}" for x in c["open_exceptions"] if x["status"] != "open"]
    for d in derived:
        if not any(same_condition(x, d) for x in open_exceptions) and not any(same_condition(x, d) for x in resolved):
            problems.append(f"{d['kind']} on {d['delegation_id'] or c['task']['task_id']} holds but is neither open nor resolved: {d['detail']}")
    for x in open_exceptions:
        if not any(same_condition(x, d) for d in derived):
            problems.append(f"{x['kind']} exception {x['exception_id']} is open but its condition does not hold at generated_at")
    for x in resolved:
        if x["status"] == "open" or x["resolved_by"] == "system":
            problems.append(f"resolved exception {x['exception_id']} must be resolved or dismissed by a person")
        if not any(same_condition(x, d) for d in derived):
            problems.append(f"resolved exception {x['exception_id']} ({x['kind']}) does not match a condition that holds at generated_at")
    if problems:
        return _check(name, problems)
    return _passed(
        name,
        [
            f"{len(derived)} derived exception(s) recomputed as of generated_at: {len(derived) - len(resolved)} open, {len(resolved)} resolved by a person",
            "not recomputed: witness_quorum_not_met (needs the service's verified domains) and exceptions raised at intake",
        ],
    )


def _signed_claims_check(c: Json) -> Json:
    """Provider-signed outcome claims must verify against the listed key bindings, and only they may be labelled provider_key_signed."""
    name = "signed_claims"
    delegation_of = {d["delegation_id"]: d for d in c["delegations"]}
    problems = []
    for claim in c["delivery_claims"]:
        label = f"{claim['type']} claim {claim['event_id']}"
        labelled = "provider_key_signed" in claim["assurance"]
        if "signer" not in claim:
            if labelled:
                problems.append(f"{label} is labelled provider_key_signed without a signature")
            continue
        delegation = delegation_of.get(claim["delegation_id"])
        problem = f"{label} names a delegation not in the closure" if delegation is None else outcome_signature_problem(claim, delegation, c["key_bindings"])
        if problem is not None:
            problems.append(problem)
        elif not labelled:
            problems.append(f"{label} is signed but not labelled provider_key_signed")
    if problems:
        return _check(name, problems)
    signed = len([claim for claim in c["delivery_claims"] if "signer" in claim])
    return _passed(name, [f"{signed} provider-signed outcome claim(s) verify" if signed > 0 else "no provider-signed outcome claims"])


def _rail_attestations_check(c: Json) -> Json:
    """Each embedded rail attestation must verify offline (Merkle inclusion for A2A-SE, the payer's signature for x402)
    and agree with its event, and rail_attestations must list exactly those events."""
    name = "rail_attestations"
    problems = []
    for e in c["financial_events"]:
        record = e["record"]
        problem = rail_attestation_problem(record)
        if problem is not None:
            problems.append(f"{record['type']} {record['financial_event_id']}: rail attestation refused ({problem['code']}): {problem['detail']}")
    expected = build_rail_attestation_report(c["financial_events"])
    if digest_of(expected) != digest_of(c.get("rail_attestations")):
        problems.append("rail_attestations do not match the closure's payment and refund records")
    if problems:
        return _check(name, problems)
    if expected is None:
        return _passed(name, ["no rail attestations"])
    return _passed(name, [f"{len(expected)} payment/refund record(s) rail_attested, re-verified offline without contacting the rail", *(e["anchor"] for e in expected)])
