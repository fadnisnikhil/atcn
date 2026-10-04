"""The parts of a closure or receipt that follow from its own records, recomputed exactly as @atcn/subledger computes them.

Roll-up and receipt totals (rollup.ts, projection.ts), delivery status and disclosure, statement expiry, revocation and
conflicts (@atcn/schema attestation.ts), usage checks (usage.ts), the estimate and hold report (expectations.ts), and
the provider-signed outcome and expectation signature rules (outcome.ts, expectations.ts).
"""

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from .documents import ASSURANCE_LABELS, SIGNED_CLAIM_TYPES, TOTALS_FIELDS
from .subledger import build_expectation_statement, build_outcome_statement, verify_expectation_signature, verify_outcome_signature
from .trace import allowed_difference, expected_cost_from_usage

Json = dict[str, Any]

# ---------- Time ----------

_ISO_TEXT = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?\Z")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_MILLISECOND = timedelta(milliseconds=1)


def date_parse(text: Any) -> float:
    """Milliseconds since the epoch, like JavaScript's Date.parse for ISO 8601 text; NaN when it does not parse.
    Text without an offset is read as UTC."""
    match = _ISO_TEXT.match(text) if isinstance(text, str) else None
    if match is None:
        return math.nan
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    # Python dates start at year 1; JavaScript's go back further. The calendar repeats every 400 years (146097 days).
    shift = 400 if int(year) == 0 else 0
    try:
        moment = datetime(int(year) + shift, int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0), tzinfo=timezone.utc)
    except ValueError:
        return math.nan
    millis = (moment - _EPOCH) // _MILLISECOND - shift // 400 * 146097 * 86_400_000 + int((fraction or "0")[:3].ljust(3, "0"))
    if zone is None or zone == "Z":
        return millis
    offset_minutes = int(zone[1:3]) * 60 + int(zone[4:6])
    return millis - (1 if zone[0] == "+" else -1) * offset_minutes * 60_000

# ---------- Roll-up ----------

_TOTAL_BY_TYPE = {"invoice": "invoiced", "charge": "charged", "fee": "fees", "adjustment": "adjustments", "refund": "refunded", "credit": "credits"}


def cost_sign(event_type: str) -> int:
    """+1 adds to buyer cost, -1 reduces it, 0 carries no cost (quotes, estimates, holds, payment reports, reversals, rates)."""
    if event_type in ("invoice", "charge", "fee", "adjustment"):
        return 1
    if event_type in ("refund", "credit"):
        return -1
    return 0


def _sign(value: int) -> int:
    return (value > 0) - (value < 0)


def _bucket(totals: Json, currency: str) -> Json:
    return totals.setdefault(currency, {field: 0 for field in TOTALS_FIELDS})


def _add_into(target: Json, source: Json) -> None:
    for currency, values in source.items():
        into = _bucket(target, currency)
        for key, value in values.items():
            into[key] += value


def is_buyer_expense(event: Json) -> bool:
    return event["payer"] == "buyer" and event["included_in_event_id"] is None


def compute_rollup(root: Json, delegations: list[Json], events: list[Json], attribution: dict[str, str], allocations: dict[str, list[Json]]) -> Json:
    """Deterministic roll-up of one root task. Each event is attributed to exactly one node and counted once; parents show
    direct and descendant cost separately. Reversed events and the reversals themselves are excluded from all totals."""
    task_id = root["task_id"]
    reversed_ids = {e["reverses_event_id"] for e in events if e["type"] == "reversal" and e["reverses_event_id"]}
    node_ids = [task_id, *(d["delegation_id"] for d in delegations)]
    nodes: dict[str, Json] = {task_id: {"node_id": task_id, "parent_id": None, "direct": {}, "descendant": {}, "total": {}, "event_ids": []}}
    for d in delegations:
        parent_id = task_id if d["parent_delegation_id"] is None else d["parent_delegation_id"]
        nodes[d["delegation_id"]] = {"node_id": d["delegation_id"], "parent_id": parent_id, "direct": {}, "descendant": {}, "total": {}, "event_ids": []}

    latest_quote: dict[str, Json] = {}
    for event in events:
        event_id = event["financial_event_id"]
        node_id = attribution.get(event_id)
        if not node_id or node_id not in nodes:
            continue
        if event["type"] in ("fx_rate", "reversal") or event_id in reversed_ids:
            continue
        node = nodes[node_id]
        node["event_ids"].append(event_id)
        totals = _bucket(node["direct"], event["currency"])
        if event["type"] == "quote":
            previous = latest_quote.get(node_id)
            if previous is None or previous["event_date"] < event["event_date"] or (previous["event_date"] == event["event_date"] and previous["financial_event_id"] < event_id):
                latest_quote[node_id] = event
            continue
        if event["type"] in ("estimate", "hold"):
            continue
        if event["type"] == "payment_reported":
            totals["reported_paid"] += event["amount_minor"]
            continue
        sign = cost_sign(event["type"])
        if not is_buyer_expense(event):
            totals["downstream_reported"] += sign * event["amount_minor"]
            continue
        totals[_TOTAL_BY_TYPE[event["type"]]] += event["amount_minor"]
        allocated = sum(line["amount_minor"] for line in allocations.get(event_id, []) if line["target"]["type"] != "unallocated")
        totals["allocated"] += sign * _sign(event["amount_minor"] or 1) * allocated

    for d in delegations:
        direct = nodes[d["delegation_id"]]["direct"]
        quote = latest_quote.get(d["delegation_id"])
        if quote is not None:
            _bucket(direct, quote["currency"])["quoted"] += quote["amount_minor"]
        elif d["quoted_max_minor"] is not None:
            _bucket(direct, d["currency"])["quoted"] += d["quoted_max_minor"]
        if d["accepted_amount_minor"] is not None:
            _bucket(direct, d["currency"])["accepted"] += d["accepted_amount_minor"]
    root_quote = latest_quote.get(task_id)
    if root_quote is not None:
        _bucket(nodes[task_id]["direct"], root_quote["currency"])["quoted"] += root_quote["amount_minor"]

    for node in nodes.values():
        for t in node["direct"].values():
            t["net_cost"] = t["invoiced"] + t["charged"] + t["fees"] + t["adjustments"] - t["refunded"] - t["credits"]
            t["unresolved"] = t["invoiced"] + t["charged"] + t["fees"] + t["adjustments"] - t["credits"] - t["reported_paid"]
            t["unallocated"] = t["net_cost"] - t["allocated"]

    # A parent outside the task or a parent cycle ends the walk; the verifier's lineage check reports both.
    def depth(node_id: str) -> int:
        steps = 0
        seen = {node_id}
        current = nodes[node_id]
        while current["parent_id"] and current["parent_id"] in nodes and current["parent_id"] not in seen:
            steps += 1
            seen.add(current["parent_id"])
            current = nodes[current["parent_id"]]
        return steps

    # Children before parents: deepest first, so each subtree total is final when added to its parent.
    for node_id in sorted(node_ids, key=lambda i: -depth(i)):
        node = nodes[node_id]
        _add_into(node["total"], node["direct"])
        _add_into(node["total"], node["descendant"])
        if node["parent_id"] and node["parent_id"] in nodes:
            _add_into(nodes[node["parent_id"]]["descendant"], node["total"])

    return {
        "root_task_id": task_id,
        "nodes": [nodes[i] for i in node_ids],
        "root_total": nodes[task_id]["total"],
        "excluded_event_ids": {
            "reversed": sorted(reversed_ids),
            "reversals": sorted(e["financial_event_id"] for e in events if e["type"] == "reversal"),
            "fx_rates": sorted(e["financial_event_id"] for e in events if e["type"] == "fx_rate"),
        },
    }


def latest_allocations(allocations: list[Json]) -> dict[str, Json]:
    """Latest allocation version per financial event, the input the roll-up uses."""
    latest: dict[str, Json] = {}
    for a in allocations:
        current = latest.get(a["financial_event_id"])
        if current is None or current["version"] < a["version"]:
            latest[a["financial_event_id"]] = a
    return latest


def rollup_for(task: Json, delegations: list[Json], events: list[Json], allocations: list[Json]) -> Json:
    """events are the closure's {record, attributed_to} entries."""
    return compute_rollup(
        task,
        delegations,
        [e["record"] for e in events],
        {e["record"]["financial_event_id"]: e["attributed_to"] for e in events},
        {event_id: a["lines"] for event_id, a in latest_allocations(allocations).items()},
    )


def receipt_totals(delegation: Json, events: list[Json]) -> Json:
    """Totals for a single delegation's own events (no allocation detail, which may name other cost centers)."""
    rollup = compute_rollup(
        {"task_id": "receipt_scope"},
        [{**delegation, "parent_delegation_id": None}],
        events,
        {e["financial_event_id"]: delegation["delegation_id"] for e in events},
        {},
    )
    direct = next(n for n in rollup["nodes"] if n["node_id"] == delegation["delegation_id"])["direct"]
    return {currency: {key: value for key, value in t.items() if key not in ("allocated", "unallocated")} for currency, t in direct.items()}


# ---------- Delivery status ----------

_STATUS_BY_CLAIM = {
    "acceptance": "accepted",
    "completion": "completed",
    "partial_completion": "partially_completed",
    "cancellation": "cancelled",
    "provider_failure": "provider_failed",
}


def _superseded_ids(claims: list[Json]) -> set[str]:
    return {c["supersedes_event_id"] for c in claims if c["supersedes_event_id"] is not None}


def delivery_status(claims: list[Json]) -> str:
    """The latest non-superseded status claim. It is a recorded claim, not an adjudicated truth."""
    superseded = _superseded_ids(claims)
    active = [c for c in claims if c["type"] in _STATUS_BY_CLAIM and c["event_id"] not in superseded]
    return _STATUS_BY_CLAIM[active[-1]["type"]] if active else "delegated"


# ---------- Statement expiry, revocation and conflicts ----------

ATTESTATION_CLOCK_SKEW_MS = 5 * 60 * 1000


def attestation_time_status(item: Json, at: str) -> str:
    """"valid", "expired" or "not_yet_valid" at `at`. Without issued_at or expires_at, that bound does not apply."""
    at_ms = date_parse(at)
    if item.get("issued_at") is not None and date_parse(item["issued_at"]) > at_ms + ATTESTATION_CLOCK_SKEW_MS:
        return "not_yet_valid"
    if item.get("expires_at") is not None and at_ms >= date_parse(item["expires_at"]):
        return "expired"
    return "valid"


def resolve_attestations(items: list[Json], at: str) -> Json:
    """Applies expiry and revocation at `at`. A revocation takes effect only when its own signer signed the target.
    Items have digest, signer (None when no verified key stands behind it), issued_at, expires_at and refs."""
    by_digest = {item["digest"]: item for item in items}
    status = {item["digest"]: {"time": attestation_time_status(item, at), "revoked_by": None} for item in items}
    problems: list[Json] = []
    for item in items:
        if status[item["digest"]]["time"] == "not_yet_valid":
            continue
        for ref in item.get("refs") or []:
            target = by_digest.get(ref["attestation_digest"])
            if target is None:
                problems.append({"digest": item["digest"], "code": "unknown_reference", "target": ref["attestation_digest"]})
                continue
            if ref["relation"] != "revokes":
                continue
            if item["signer"] is None or target["signer"] != item["signer"]:
                problems.append({"digest": item["digest"], "code": "revocation_not_by_signer", "target": target["digest"]})
                continue
            if status[target["digest"]]["revoked_by"] is None:
                status[target["digest"]]["revoked_by"] = item["digest"]
    return {"status": status, "problems": problems}


def in_effect(resolution: Json, digest: str) -> bool:
    status = resolution["status"].get(digest)
    return status is not None and status["time"] == "valid" and status["revoked_by"] is None


def find_conflicts(claims: list[Json], disputes: list[Json]) -> list[Json]:
    """Conflicts among claims in effect: one signer saying two things is equivocation, different signers disagree, and
    different cited runs are an execution_mismatch. Each dispute gives a disputed conflict on every subject of its target."""
    found: dict[tuple[str, str], Json] = {}

    def add(kind: str, subject: str, members: list[Json]) -> None:
        entry = found.setdefault((kind, subject), {"kind": kind, "subject": subject, "digests": set(), "signers": set()})
        for member in members:
            entry["digests"].add(member["digest"])
            if member["signer"] is not None:
                entry["signers"].add(member["signer"])

    for i, a in enumerate(claims):
        for b in claims[i + 1 :]:
            if a["subject"] != b["subject"] or a["digest"] == b["digest"]:
                continue
            different_run = a.get("execution_digest") is not None and b.get("execution_digest") is not None and a["execution_digest"] != b["execution_digest"]
            if a["signer"] is not None and a["signer"] == b["signer"]:
                if a["status"] != b["status"] or different_run:
                    add("equivocation", a["subject"], [a, b])
                continue
            if a["status"] != b["status"]:
                add("disagreement", a["subject"], [a, b])
            if different_run:
                add("execution_mismatch", a["subject"], [a, b])
    for dispute in disputes:
        disputer = next((c for c in claims if c["digest"] == dispute["by"]), None)
        for target in (c for c in claims if c["digest"] == dispute["target"]):
            add("disputed", target["subject"], [disputer, target] if disputer else [target])

    conflicts = [
        {"kind": e["kind"], "subject": e["subject"], "attestation_digests": sorted(e["digests"]), "signers": sorted(e["signers"])} for e in found.values()
    ]
    return sorted(conflicts, key=lambda c: (c["subject"], c["kind"]))


def disputes_in_effect(items: list[Json], resolution: Json) -> list[Json]:
    return [
        {"by": item["digest"], "target": ref["attestation_digest"]}
        for item in items
        if in_effect(resolution, item["digest"])
        for ref in item.get("refs") or []
        if ref["relation"] == "disputes" and in_effect(resolution, ref["attestation_digest"])
    ]


def response_attestation(response: Json) -> Json:
    """A response as an attestation. Only a key-signed statement has a signer, so only it can revoke or be revoked."""
    statement = response["statement"]
    return {
        "digest": response["statement_digest"],
        "signer": response["provider_id"] if "provider_key_signed" in response["assurance"] else None,
        "issued_at": statement.get("issued_at"),
        "expires_at": statement.get("expires_at"),
        "refs": statement.get("refs"),
    }


def statement_conflicts(responses: list[Json], at: str) -> list[Json]:
    """Conflicts among key-signed statements in effect at `at`, per receipt revision and field."""
    signed = [r for r in responses if "provider_key_signed" in r["assurance"]]
    items = [response_attestation(r) for r in signed]
    resolution = resolve_attestations(items, at)
    claims: list[Json] = []
    for r in signed:
        if not in_effect(resolution, r["statement_digest"]):
            continue
        statement = r["statement"]

        def claim(field: str, status: str) -> Json:
            result = {"digest": r["statement_digest"], "signer": r["provider_id"], "subject": f"receipt:{r['receipt_id']}@{r['receipt_revision']}.{field}", "status": status}
            if "execution" in statement:
                result["execution_digest"] = statement["execution"]["execution_digest"]
            return result

        if statement["response_type"] == "signed_attestation":
            claims.extend(claim(f, "confirmed") for f in statement["fields"])
        elif statement["response_type"] == "propose_correction":
            claims.extend(claim(c["field"], "corrected") for c in statement["corrections"])
    return find_conflicts(claims, disputes_in_effect(items, resolution))


def label_responses(responses: list[Json], at: str) -> list[Json]:
    """Recomputes the "expired" and "revoked" labels as of `at`."""
    status = resolve_attestations([response_attestation(r) for r in responses], at)["status"]
    labelled = []
    for r in responses:
        assurance = [label for label in r["assurance"] if label not in ("expired", "revoked")]
        if status[r["statement_digest"]]["time"] == "expired":
            assurance.append("expired")
        if status[r["statement_digest"]]["revoked_by"] is not None:
            assurance.append("revoked")
        labelled.append({**r, "assurance": assurance})
    return labelled


# ---------- Disclosure ----------


def closure_disclosure(task: Json, delegations: list[Json], claims: list[Json], events: list[Json], responses: list[Json], generated_at: str | None) -> Json:
    """What the closure discloses as missing, unverified, contested, provider-reported and retrospective. With
    generated_at (schema 1.5), fields with conflicting signed statements at that time are contested too."""
    missing: list[str] = []
    unverified: list[str] = []
    contested: list[str] = []
    provider_reported: list[str] = []
    retrospective: list[str] = []
    if task["retrospective"]:
        retrospective.append(f"task:{task['task_id']}")
    for d in delegations:
        if not d["provider_id"]:
            missing.append(f"delegation:{d['delegation_id']}.provider")
        if not d["terms_digest"]:
            missing.append(f"delegation:{d['delegation_id']}.terms_digest")
        if not any(c["delegation_id"] == d["delegation_id"] and c["type"] in _STATUS_BY_CLAIM for c in claims):
            missing.append(f"delegation:{d['delegation_id']}.delivery_status")
        if d["downstream_visibility"] == "unknown":
            missing.append(f"delegation:{d['delegation_id']}.downstream_work")
        if d["retrospective"]:
            retrospective.append(f"delegation:{d['delegation_id']}")
    for c in claims:
        if not c["evidence"]:
            unverified.append(f"delivery_claim:{c['event_id']}.evidence")
        if c["asserted_by"] == "provider":
            provider_reported.append(f"delivery_claim:{c['event_id']}")
        if c["retrospective"]:
            retrospective.append(f"delivery_claim:{c['event_id']}")
    for e in events:
        record = e["record"]
        if not record["evidence"]:
            unverified.append(f"financial_event:{record['financial_event_id']}.evidence")
        if record["retrospective"]:
            retrospective.append(f"financial_event:{record['financial_event_id']}")
    for r in responses:
        response_type = r["statement"]["response_type"]
        if response_type == "submit_evidence":
            provider_reported.append(f"response:{r['response_id']}")
        if response_type == "propose_correction" and (r["decision"] or {}).get("status") != "accepted":
            contested.extend(f"receipt:{r['receipt_id']}.{c['field']}" for c in r["statement"]["corrections"])
    if generated_at is not None:
        for conflict in statement_conflicts(responses, generated_at):
            field = re.sub(r"@\d+\.", ".", conflict["subject"], count=1)
            if field not in contested:
                contested.append(field)
    return {"missing": missing, "unverified": unverified, "contested": contested, "provider_reported": provider_reported, "retrospective": retrospective}


# ---------- Usage checks ----------


def billed_minor(totals: Json | None) -> int:
    """What a delegation was billed: invoices, charges, fees and adjustments, less credits and refunds."""
    if totals is None:
        return 0
    return totals["invoiced"] + totals["charged"] + totals["fees"] + totals["adjustments"] - totals["credits"] - totals["refunded"]


def counted_usage_claims(claims: list[Json]) -> list[Json]:
    """Completion and partial_completion claims with usage that no correction superseded; a trace recorded more than
    once counts once, from its latest claim."""
    superseded = _superseded_ids(claims)
    by_trace: dict[str, Json] = {}
    for c in claims:
        if "usage" not in c or c["event_id"] in superseded or c["type"] not in ("completion", "partial_completion"):
            continue
        by_trace[c["usage"]["trace_digest"]] = c
    return list(by_trace.values())


def usage_check_for(delegation_id: str, currency: str, pricing: Json | None, claims: list[Json], billed: int, provider_attested: bool) -> Json | None:
    """A delegation's usage priced at its agreed rates, compared with what was billed. None without pricing or counted usage."""
    if pricing is None:
        return None
    counted = counted_usage_claims(claims)
    if not counted:
        return None
    cost = expected_cost_from_usage(pricing, [c["usage"]["summary"] for c in counted])
    expected = cost["expected_minor"]
    allowed = None if expected is None else allowed_difference(expected, pricing["tolerance_bps"])
    difference = None if expected is None else billed - expected
    labels = {label for c in counted for label in c["assurance"] if label != "superseded"}
    if provider_attested:
        labels.add("provider_key_signed")
    return {
        "delegation_id": delegation_id,
        "currency": currency,
        "expected_minor": expected,
        "lines": cost["lines"],
        "billed_minor": billed,
        "difference_minor": difference,
        "allowed_difference_minor": allowed,
        "within_tolerance": None if difference is None or allowed is None else abs(difference) <= allowed,
        "unpriced": cost["unpriced"],
        "trace_digests": sorted(c["usage"]["trace_digest"] for c in counted),
        "assurance": [label for label in ASSURANCE_LABELS if label in labels],
    }


def usage_attested_delegations(responses: list[Json], receipts: list[Json]) -> set[str]:
    """Delegations whose receipts carry an in-force provider key-signed attestation of delivery.usage."""
    delegation_of = {r["receipt_id"]: r["delegation_id"] for r in receipts}
    attested: set[str] = set()
    for r in responses:
        in_force = "provider_key_signed" in r["assurance"] and "expired" not in r["assurance"] and "revoked" not in r["assurance"]
        statement = r["statement"]
        if in_force and statement["response_type"] == "signed_attestation" and "delivery.usage" in statement["fields"]:
            delegation_id = delegation_of.get(r["receipt_id"])
            if delegation_id:
                attested.add(delegation_id)
    return attested


def usage_checks_for(delegations: list[Json], claims: list[Json], rollup: Json, responses: list[Json], receipts: list[Json]) -> list[Json]:
    """Usage checks for every delegation with pricing and counted usage, in delegation order."""
    attested = usage_attested_delegations(responses, receipts)
    checks = []
    for d in delegations:
        node = next((n for n in rollup["nodes"] if n["node_id"] == d["delegation_id"]), None)
        check = usage_check_for(
            d["delegation_id"],
            d["currency"],
            d.get("pricing"),
            [c for c in claims if c["delegation_id"] == d["delegation_id"]],
            billed_minor(None if node is None else node["direct"].get(d["currency"])),
            d["delegation_id"] in attested,
        )
        if check is not None:
            checks.append(check)
    return checks


# ---------- Signed outcome claims ----------


def signer_key_bindings(claims: list[Json], events: list[Json], key_bindings: list[Json]) -> list[Json]:
    """The key bindings named by the signers of these claims and events, each once, in binding_id order."""
    signers = [c["signer"] for c in claims if "signer" in c] + [e["expectation"]["signer"] for e in events if "signer" in e.get("expectation", {})]
    named = [b for b in key_bindings if any(s["binding_id"] == b["binding_id"] and s["key_id"] == b["key_id"] for s in signers)]
    return sorted(named, key=lambda b: b["binding_id"])


def outcome_signature_problem(claim: Json, delegation: Json, key_bindings: list[Json]) -> str | None:
    """Why a signed outcome claim does not verify, or None when it does (or carries no signature)."""
    signer = claim.get("signer")
    if signer is None:
        return None
    label = f"{claim['type']} claim {claim['event_id']}"
    if claim["type"] not in SIGNED_CLAIM_TYPES:
        return f"{label} is signed, but only {', '.join(SIGNED_CLAIM_TYPES)} claims may be"
    if delegation["provider_job_ref"] is None:
        return f"{label} is signed, but its delegation has no provider_job_ref to sign over"
    if signer["provider_id"] != delegation["provider_id"]:
        return f"{label} is signed by a provider other than the delegation's"
    binding = next((b for b in key_bindings if b["binding_id"] == signer["binding_id"] and b["key_id"] == signer["key_id"]), None)
    if binding is None:
        return f"{label} is signed with a key binding that is not listed"
    if binding["provider_id"] != signer["provider_id"]:
        return f"{label} key binding belongs to another provider"
    if binding["revoked_at"] is not None and binding["revoked_at"] <= claim["occurred_at"]:
        return f"{label} was signed after its key binding was revoked"
    try:
        statement = build_outcome_statement(claim["type"], delegation["provider_job_ref"], claim["occurred_at"], claim["note"], claim["evidence"])
    except ValueError:
        return f"{label} signature does not verify"
    if not verify_outcome_signature(statement, signer["value"], binding["public_key"]):
        return f"{label} signature does not verify"
    return None


# ---------- Estimates and holds ----------


def expectation_signature_problem(record: Json, delegation_provider_id: str | None, key_bindings: list[Json]) -> str | None:
    """Why a signed estimate or hold does not verify, or None when it does (or carries no signature)."""
    expectation = record.get("expectation") or {}
    signer = expectation.get("signer")
    if signer is None:
        return None
    label = f"{record['type']} {record['financial_event_id']}"
    binding = next((b for b in key_bindings if b["binding_id"] == signer["binding_id"] and b["key_id"] == signer["key_id"]), None)
    if binding is None:
        return f"{label} is signed with a key binding that is not listed"
    if binding["provider_id"] != signer["provider_id"]:
        return f"{label} key binding belongs to another provider"
    if binding["revoked_at"] is not None and binding["revoked_at"] <= record["event_date"]:
        return f"{label} was signed after its key binding was revoked"
    if expectation["issued_by"] == "agent" and signer["provider_id"] != delegation_provider_id:
        return f"{label} is an agent estimate signed by a provider other than the delegation's"
    try:
        statement = build_expectation_statement(
            record["type"], record["source"], record["source_event_id"], record["amount_minor"], record["currency"], record["event_date"], expectation, record["provider_reference"]
        )
    except ValueError:
        return f"{label} signature does not verify"
    if not verify_expectation_signature(statement, signer["value"], binding["public_key"]):
        return f"{label} signature does not verify"
    return None


def expectation_assurance(record: Json, delegation_provider_id: str | None, key_bindings: list[Json]) -> list[str]:
    """A verified agent signature is provider_key_signed, a gateway's is gateway_signed, anything else is buyer_recorded."""
    expectation = record["expectation"]
    if "signer" not in expectation or expectation_signature_problem(record, delegation_provider_id, key_bindings) is not None:
        return ["buyer_recorded"]
    return ["gateway_signed" if expectation["issued_by"] == "gateway" else "provider_key_signed"]


def variance_bps(difference: int, base: int | None) -> int | None:
    """Variance in basis points of base, rounded half away from zero, using integers only. None without a base."""
    if base is None or base == 0:
        return None
    sign = -1 if difference < 0 else 1
    return sign * ((abs(difference) * 10_000 * 2 + base) // (2 * base))


def _variance(estimated: int | None, held: int | None, actual: int) -> Json:
    return {
        "estimated_minor": estimated,
        "held_minor": held or 0,
        "actual_minor": actual,
        "variance_vs_estimate_minor": None if estimated is None else actual - estimated,
        "variance_vs_estimate_bps": None if estimated is None else variance_bps(actual - estimated, estimated),
        "variance_vs_hold_minor": None if held is None else actual - held,
        "variance_vs_hold_bps": None if held is None else variance_bps(actual - held, held),
    }


def build_expectation_report(task: Json, delegations: list[Json], claims: list[Json], events: list[Json], rollup: Json, key_bindings: list[Json]) -> Json | None:
    """Estimates and holds compared with actual cost, per node and for the task, in the task's currency. None when the
    task has none. Recorded only: nothing was enforced, blocked or reserved."""
    currency = task["currency"]
    expectations = [e for e in events if "expectation" in e["record"]]
    if not expectations:
        return None

    provider_of = {d["delegation_id"]: d["provider_id"] for d in delegations}
    superseded_keys = {
        (e["record"]["source"], e["record"]["type"], e["record"]["expectation"]["supersedes"]) for e in expectations if e["record"]["expectation"]["supersedes"] is not None
    }
    reversed_ids = rollup["excluded_event_ids"]["reversed"]

    def direct_net_cost(node_id: str) -> int:
        node = next((n for n in rollup["nodes"] if n["node_id"] == node_id), None)
        return 0 if node is None or currency not in node["direct"] else node["direct"][currency]["net_cost"]

    def charges_on(node_id: str) -> list[Json]:
        return [
            e["record"]
            for e in events
            if e["attributed_to"] == node_id and e["record"]["currency"] == currency and cost_sign(e["record"]["type"]) == 1 and e["record"]["financial_event_id"] not in reversed_ids
        ]

    def is_after_charge(record: Json, node_id: str) -> bool:
        """An estimate dated before the first charge but recorded after it was back-dated, unless the import says it is retrospective."""
        charges = charges_on(node_id)
        if not charges:
            return False
        first_charge_at = min(r["event_date"] for r in charges)
        first_charge_recorded_at = min(r["imported_at"] for r in charges)
        return record["event_date"] > first_charge_at or (not record["retrospective"] and record["imported_at"] > first_charge_recorded_at)

    records: list[Json] = []
    for e in expectations:
        record, node_id = e["record"], e["attributed_to"]
        expectation = record["expectation"]
        status = "current"
        if record["currency"] != currency:
            status = "other_currency"
        elif (record["source"], record["type"], record["source_event_id"]) in superseded_keys:
            status = "superseded"
        elif record["type"] == "estimate" and is_after_charge(record, node_id):
            status = "after_charge"
        hold_status = expectation.get("hold_status")
        if hold_status == "open" and delivery_status([c for c in claims if c["delegation_id"] == node_id]) in ("cancelled", "provider_failed"):
            hold_status = "released"
        assurance = expectation_assurance(record, provider_of.get(node_id), key_bindings)
        records.append(
            {
                "financial_event_id": record["financial_event_id"],
                "node_id": node_id,
                "type": record["type"],
                "issued_by": expectation["issued_by"],
                "status": status,
                "hold_status": hold_status,
                "assurance": [*assurance, "superseded"] if status == "superseded" else assurance,
            }
        )

    # Of several current estimates on a node, the latest issued is used; the others stay listed as not_latest.
    record_by_id = {e["record"]["financial_event_id"]: e["record"] for e in expectations}
    node_ids = list(dict.fromkeys(r["node_id"] for r in records))
    used_estimate: dict[str, Json] = {}
    for node_id in node_ids:
        for r in records:
            if r["node_id"] == node_id and r["type"] == "estimate" and r["status"] == "current":
                estimate = record_by_id[r["financial_event_id"]]
                if node_id not in used_estimate or estimate["event_date"] >= used_estimate[node_id]["event_date"]:
                    used_estimate[node_id] = estimate
    for r in records:
        if r["type"] == "estimate" and r["status"] == "current" and used_estimate[r["node_id"]]["financial_event_id"] != r["financial_event_id"]:
            r["status"] = "not_latest"

    nodes: list[Json] = []
    for node_id in node_ids:
        estimate = used_estimate.get(node_id)
        current_holds = [r for r in records if r["node_id"] == node_id and r["type"] == "hold" and r["status"] == "current"]
        held = sum(record_by_id[r["financial_event_id"]]["amount_minor"] for r in current_holds if r["hold_status"] in ("open", "captured"))
        variance = _variance(None if estimate is None else estimate["amount_minor"], held if current_holds else None, direct_net_cost(node_id))
        nodes.append({"node_id": node_id, "estimate_event_id": None if estimate is None else estimate["financial_event_id"], **variance})

    estimated_nodes = {n["node_id"] for n in nodes if n["estimated_minor"] is not None}
    estimated = sum(n["estimated_minor"] for n in nodes if n["estimated_minor"] is not None) if estimated_nodes else None
    any_hold = any(r["type"] == "hold" and r["status"] == "current" for r in records)
    held = sum(n["held_minor"] for n in nodes)
    actual = rollup["root_total"][currency]["net_cost"] if currency in rollup["root_total"] else 0
    unestimated = sum(n["direct"][currency]["net_cost"] for n in rollup["nodes"] if n["node_id"] not in estimated_nodes and currency in n["direct"])
    return {"currency": currency, "task": {**_variance(estimated, held if any_hold else None, actual), "unestimated_minor": unestimated}, "nodes": nodes, "records": records}
