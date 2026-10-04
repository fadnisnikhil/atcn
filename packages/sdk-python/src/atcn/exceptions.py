"""The derived exceptions a closure's own records imply at close, recomputed exactly as @atcn/subledger exceptions.ts
and expectations.ts derive them. Witness quorum is left out: it needs the domains the service verified."""

from datetime import timedelta
from typing import Any

from .projection import _EPOCH, billed_minor, build_expectation_report, date_parse, delivery_status, rollup_for, statement_conflicts, usage_check_for

Json = dict[str, Any]

DERIVED_EXCEPTION_KINDS = [
    "budget_overrun",
    "missing_receipt",
    "amount_mismatch",
    "stale_quote",
    "usage_unpriced",
    "usage_cost_mismatch",
    "refund_terms_breach",
    "skill_price_mismatch",
    "witness_quorum_not_met",
    "conflicting_statements",
    "actual_exceeds_estimate",
    "actual_exceeds_hold",
    "hold_not_released",
    "estimate_after_charge",
    "charge_after_cancellation",
]
SERVICE_ONLY_EXCEPTION_KINDS = ["witness_quorum_not_met"]
SKILL_BILLED_EVENT_TYPES = ["quote", "invoice", "charge"]


def is_recomputable_exception(kind: str) -> bool:
    return kind in DERIVED_EXCEPTION_KINDS and kind not in SERVICE_ONLY_EXCEPTION_KINDS


def _iso_from_millis(millis: float) -> str:
    """Like JavaScript's Date.prototype.toISOString."""
    return (_EPOCH + timedelta(milliseconds=millis)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _active_claims(claims: list[Json]) -> list[Json]:
    superseded = {c["supersedes_event_id"] for c in claims if c["supersedes_event_id"] is not None}
    return [c for c in claims if c["event_id"] not in superseded]


def _active_events_of(events: list[Json], delegation_id: str) -> list[Json]:
    """A delegation's events that count: attributed to it, not reversed, and not reversals themselves."""
    reversed_ids = {e["record"]["reverses_event_id"] for e in events if e["record"]["reverses_event_id"] is not None}
    return [
        e["record"]
        for e in events
        if e["attributed_to"] == delegation_id and e["record"]["type"] != "reversal" and e["record"]["financial_event_id"] not in reversed_ids
    ]


def _skill_name(skill: Json) -> str:
    return f"{skill['namespace']}/{skill['skill_id']}"


def _refund_terms_problems(terms: Json, expected_delivery: str | None, currency: str, events: list[Json], claims: list[Json], now: str) -> list[str]:
    """Where the recorded refunds break the agreed refund terms."""
    problems: list[str] = []
    window_ms = terms["after_settlement"]["window_seconds"] * 1000
    cap = terms["after_settlement"]["cap_minor"]
    payments = sorted((e for e in events if e["type"] == "payment_reported"), key=lambda e: date_parse(e["event_date"]))
    refunds = [e for e in events if e["type"] == "refund"]
    paid = sum(e["amount_minor"] for e in payments)
    refunded = sum(e["amount_minor"] for e in refunds)
    if refunded > cap:
        problems.append(f"refunded {refunded} {currency}, more than the agreed cap of {cap}")

    active = _active_claims(claims)
    status = delivery_status(claims)
    delivered = any(c["type"] in ("completion", "partial_completion") for c in active)
    trigger: Json | None = None
    if status in ("provider_failed", "cancelled") and terms["on_failure"] == "refund":
        failure = [c for c in active if c["type"] in ("provider_failure", "cancellation")][-1]
        trigger = {"reason": "failure", "at": failure["occurred_at"]}
    elif not delivered and expected_delivery is not None and expected_delivery < now and terms["on_timeout"] == "refund":
        trigger = {"reason": "timeout", "at": expected_delivery}

    if payments:
        window_start = max(date_parse(payments[0]["event_date"]), date_parse(trigger["at"]) if trigger else 0)
        window_end = _iso_from_millis(window_start + window_ms)
        for r in refunds:
            if date_parse(r["event_date"]) > window_start + window_ms:
                problems.append(f"refund {r['financial_event_id']} on {r['event_date']} is after the refund window ended at {window_end}")
    if trigger and paid > 0:
        required = min(paid, cap)
        deadline = _iso_from_millis(date_parse(trigger["at"]) + window_ms)
        if now > deadline and refunded < required:
            problems.append(f"the terms require a refund on {trigger['reason']}: {required} {currency} was due by {deadline}, {refunded} was refunded")
    return problems


def _expectation_exceptions(report: Json, task: Json, events: list[Json], now: str, closing: bool) -> list[Json]:
    result: list[Json] = []
    tolerance = task.get("estimate_tolerance_bps", 0)
    record_by_id = {e["record"]["financial_event_id"]: e["record"] for e in events}

    def delegation_of(node_id: str) -> str | None:
        return None if node_id == task["task_id"] else node_id

    for node in report["nodes"]:
        if node["estimated_minor"] is not None and node["actual_minor"] * 10_000 > node["estimated_minor"] * (10_000 + tolerance):
            result.append({
                "kind": "actual_exceeds_estimate",
                "delegation_id": delegation_of(node["node_id"]),
                "detail": f"actual {node['actual_minor']} {report['currency']} exceeds estimate {node['estimated_minor']} by {node['variance_vs_estimate_minor']} "
                f"({node['variance_vs_estimate_bps']} bps, tolerance {tolerance} bps); recorded, not prevented",
            })
        if node["variance_vs_hold_minor"] is not None and node["variance_vs_hold_minor"] > 0:
            result.append({
                "kind": "actual_exceeds_hold",
                "delegation_id": delegation_of(node["node_id"]),
                "detail": f"actual {node['actual_minor']} {report['currency']} exceeds held {node['held_minor']} by {node['variance_vs_hold_minor']}; recorded, not prevented",
            })
    for r in report["records"]:
        record = record_by_id[r["financial_event_id"]]
        if r["status"] == "after_charge":
            result.append({
                "kind": "estimate_after_charge",
                "delegation_id": delegation_of(r["node_id"]),
                "detail": f"estimate {r['financial_event_id']} issued {record['event_date']} and recorded {record['imported_at']}, after the first charge on its node; kept, not used as the estimate",
            })
        if r["type"] != "hold" or r["status"] != "current" or r["hold_status"] != "open":
            continue
        expires_at = record["expectation"]["expires_at"]
        expired = expires_at is not None and expires_at < now
        nothing_charged = next(n for n in report["nodes"] if n["node_id"] == r["node_id"])["actual_minor"] == 0
        if expired or (closing and nothing_charged):
            held = f"hold {r['financial_event_id']} of {record['amount_minor']} {record['currency']} is still open"
            result.append({
                "kind": "hold_not_released",
                "delegation_id": delegation_of(r["node_id"]),
                "detail": f"{held} past its expiry {expires_at}" if expired else f"{held} at close with nothing charged",
            })
    return result


def closure_derived_exceptions(c: Json) -> list[Json]:
    """The derived exceptions a closure payload's own records imply at close, as of generated_at, each as
    {kind, delegation_id, detail}; the service must list each as open or resolved."""
    task, events, claims, now = c["task"], c["financial_events"], c["delivery_claims"], c["generated_at"]
    rollup = rollup_for(task, c["delegations"], events, c["allocations"])
    result: list[Json] = []
    root_totals = rollup["root_total"].get(task["currency"])
    if task["budget_minor"] is not None and root_totals and root_totals["net_cost"] > task["budget_minor"]:
        result.append({
            "kind": "budget_overrun",
            "delegation_id": None,
            "detail": f"net cost {root_totals['net_cost']} {task['currency']} exceeds budget {task['budget_minor']}; recorded after the fact, not prevented",
        })
    for d in c["delegations"]:
        delegation_id, currency = d["delegation_id"], d["currency"]
        node = next((n for n in rollup["nodes"] if n["node_id"] == delegation_id), None)
        billed = billed_minor(None if node is None else node["direct"].get(currency))
        own_claims = [x for x in claims if x["delegation_id"] == delegation_id]
        active = _active_claims(own_claims)
        if billed > 0 and not any(x["type"] in ("completion", "partial_completion") for x in active):
            result.append({"kind": "missing_receipt", "delegation_id": delegation_id, "detail": f"billed {billed} {currency} with no completion receipt recorded"})
        status = delivery_status(own_claims)
        if status in ("cancelled", "provider_failed") and billed > 0:
            result.append({
                "kind": "charge_after_cancellation",
                "delegation_id": delegation_id,
                "detail": f"the delegation is {status.replace('_', ' ', 1)} but {billed} {currency} is still billed; a refund, credit or reversal of it would net it to zero",
            })
        agreed = d["accepted_amount_minor"] if d["accepted_amount_minor"] is not None else d["quoted_max_minor"]
        if agreed is not None and billed > agreed:
            basis = "accepted amount" if d["accepted_amount_minor"] is not None else "quoted maximum"
            result.append({"kind": "amount_mismatch", "delegation_id": delegation_id, "detail": f"billed {billed} {currency} exceeds {basis} {agreed}"})
        accepted = any(x["type"] == "acceptance" for x in active)
        if d["quote_valid_until"] is not None and d["quote_valid_until"] < now and not accepted:
            result.append({"kind": "stale_quote", "delegation_id": delegation_id, "detail": f"quote expired at {d['quote_valid_until']} without a recorded acceptance"})
        usage = usage_check_for(delegation_id, currency, d.get("pricing"), own_claims, billed, False)
        if usage and usage["expected_minor"] is None:
            result.append({"kind": "usage_unpriced", "delegation_id": delegation_id, "detail": f"usage has no agreed rate: {', '.join(usage['unpriced'])}"})
        elif usage and usage["within_tolerance"] is False:
            direction = "above" if usage["difference_minor"] > 0 else "below"
            result.append({
                "kind": "usage_cost_mismatch",
                "delegation_id": delegation_id,
                "detail": f"billed {billed} {currency} is {direction} usage cost {usage['expected_minor']} by {abs(usage['difference_minor'])}, "
                f"more than the allowed {usage['allowed_difference_minor']}; traces {', '.join(usage['trace_digests'])}",
            })
        own_events = _active_events_of(events, delegation_id)
        refund_terms = d.get("refund_terms")
        refund_problems = _refund_terms_problems(refund_terms, d["expected_delivery"], currency, own_events, own_claims, now) if refund_terms else []
        if refund_problems:
            result.append({"kind": "refund_terms_breach", "delegation_id": delegation_id, "detail": "; ".join(refund_problems)})
        agreed_skill = (d.get("execution") or {}).get("skill")
        off_skill = (
            [e for e in own_events if e["type"] in SKILL_BILLED_EVENT_TYPES and e.get("skill") and (e["skill"]["namespace"], e["skill"]["skill_id"]) != (agreed_skill["namespace"], agreed_skill["skill_id"])]
            if agreed_skill
            else []
        )
        if off_skill:
            billed_lines = [f"{e['type']} {e['financial_event_id']} bills {_skill_name(e['skill'])} for {e['amount_minor']} {e['currency']}" for e in off_skill]
            price = f" at {agreed} {currency}" if agreed is not None else ""
            result.append({"kind": "skill_price_mismatch", "delegation_id": delegation_id, "detail": f"{'; '.join(billed_lines)}; the delegation agreed {_skill_name(agreed_skill)}{price}"})
    conflicts = statement_conflicts(c["responses"], now)
    for d in c["delegations"]:
        receipt_ids = {r["receipt_id"] for r in c["receipts"] if r["delegation_id"] == d["delegation_id"]}
        on_delegation = [x for x in conflicts if x["subject"][len("receipt:") : x["subject"].index("@")] in receipt_ids]
        if on_delegation:
            result.append({
                "kind": "conflicting_statements",
                "delegation_id": d["delegation_id"],
                "detail": "; ".join(f"{x['kind']} on {x['subject']} between {', '.join(x['signers'])}" for x in on_delegation),
            })
    report = build_expectation_report(task, c["delegations"], claims, events, rollup, c["key_bindings"])
    if report:
        result.extend(_expectation_exceptions(report, task, events, now, closing=True))
    return result
