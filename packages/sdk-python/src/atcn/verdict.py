"""Offline verification of a clearing verdict (atcn.clearing.verdict 1.0), as @atcn/core's verifyClearingVerdict does it.

A verdict is the obligation's decision in effect, signed by the ATCN service for an escrow rail to read. It is record
only: ATCN holds no funds and releases nothing. Given the closure package the verdict was read from, this verifies the
whole package (verify_closure_package: signatures, events, decisions replayed, journal), checks that the package is the
one the verdict names, and that the verdict states the decision in effect in it.
"""

from typing import Any

from .crypto import digest_of, verify_payload
from .documents import AMOUNT_MINOR, DIGEST, ISO_DATETIME, Bool, Enum, Literal, Nullable, Obj, Str, parse
from .package import CURRENCY, SIGNATURE, verify_closure_package

Json = dict[str, Any]

CLEARING_VERDICT_TYPE = "atcn.clearing.verdict"
CLEARING_OUTCOMES = ("accepted", "partially_accepted", "rejected", "insufficient_evidence", "disputed", "cancelled", "expired")
SERVICE_ACTOR = "svc_atcn"
_ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}"

CLEARING_VERDICT = Obj(
    {
        "payload": Obj(
            {
                "document_type": Literal(CLEARING_VERDICT_TYPE),
                "verdict_version": Literal("1.0"),
                "issued_at": ISO_DATETIME,
                "obligation_id": Str(pattern=f"^obl_{_ULID_BODY}$", message="expected obl_<ULID>"),
                "decision": Obj(
                    {
                        "decision_id": Str(pattern=f"^dec_{_ULID_BODY}$", message="expected dec_<ULID>"),
                        "decision_digest": DIGEST,
                        "decided_at": ISO_DATETIME,
                        "outcome": Enum(CLEARING_OUTCOMES),
                        "currency": CURRENCY,
                        "accepted_amount_minor": AMOUNT_MINOR,
                        "rejected_amount_minor": AMOUNT_MINOR,
                        "disputed_amount_minor": AMOUNT_MINOR,
                        "pending_amount_minor": AMOUNT_MINOR,
                    },
                    strict=True,
                ),
                "final": Bool(),
                "escrow": Nullable(Obj({"rail": Str(1, 100), "escrow_ref": Str(1, 200)}, strict=True)),
                "package_digest": DIGEST,
                "stance": Literal("record_only"),
            },
            strict=True,
        ),
        "signature": SIGNATURE,
    }
)


def _service_key(trusted_keys: list[Json], signature: Json) -> Json | None:
    return next((k for k in trusted_keys if k["key_id"] == signature["key_id"] and k["key_version"] == signature["key_version"] and k["actor_id"] == SERVICE_ACTOR), None)


def current_decision(closure_package: Json, obligation_id: str) -> Json | None:
    """The obligation's decision in effect: not superseded by another, and the latest of those."""
    decisions = [d for d in closure_package["payload"]["decisions"] if d["obligation_id"] == obligation_id]
    superseded = {d["supersedes_decision_id"] for d in decisions if d["supersedes_decision_id"] is not None}
    latest = None
    for d in decisions:
        if d["decision_id"] not in superseded and (latest is None or d["decided_at"] > latest["decided_at"]):
            latest = d
    return latest


def _is_final(decision: Json) -> bool:
    return decision["outcome"] not in ("disputed", "insufficient_evidence") and decision["disputed_amount_minor"] == 0 and decision["pending_amount_minor"] == 0


def _package_digest_matches(closure_package: Json, package_digest: str) -> bool:
    # Unknown members are not signed, so a valid package can still hold values canonical JSON refuses.
    try:
        return digest_of(closure_package["payload"]) == package_digest
    except ValueError:
        return False


def verify_clearing_verdict(verdict: Any, trusted_keys: list[Json], closure_package: Any = None) -> Json:
    """Checks a clearing verdict offline and returns {"valid", "checks"}, with the TypeScript check names and details.

    Given the closure package, the package is verified in full (closure_package lists each failed package check as
    "<check>: <details>") before the verdict is compared with the decision in effect in it. Without the closure package
    (None) the decision is not compared with its evidence (reported as not inspected); the TypeScript verifier treats
    only an omitted package that way and verifies a JSON null as a package.
    """
    doc, issues = parse(CLEARING_VERDICT, verdict)
    if issues:
        return {"valid": False, "checks": [{"name": "schema", "ok": False, "details": issues}]}
    payload = doc["payload"]
    checks: list[Json] = [{"name": "schema", "ok": True, "details": []}]

    key = _service_key(trusted_keys, doc["signature"])
    key_valid = key is not None and key["valid_from"] <= payload["issued_at"] and (key["revoked_at"] is None or key["revoked_at"] > payload["issued_at"])
    signature_ok = key_valid and verify_payload(doc, key["public_key"])
    if key is None:
        problem = "service key not among trusted keys"
    elif not key_valid:
        problem = "service key was not valid when the verdict was issued"
    else:
        problem = "signature does not verify"
    checks.append({"name": "verdict_signature", "ok": signature_ok, "details": [] if signature_ok else [problem]})

    if closure_package is None:
        checks.append({"name": "decision", "ok": True, "state": "not_inspected", "details": ["no closure package supplied; the decision was not compared with its evidence"]})
        return {"valid": all(c["ok"] for c in checks), "checks": checks}

    package_report = verify_closure_package(closure_package, trusted_keys)
    package_problems = [f"{c['name']}: {'; '.join(c['details'])}" for c in package_report["checks"] if not c["ok"]]
    checks.append({"name": "closure_package", "ok": package_report["valid"], "details": package_problems})
    if not package_report["valid"]:
        return {"valid": False, "checks": checks}

    digest_ok = _package_digest_matches(closure_package, payload["package_digest"])
    checks.append({"name": "package_digest", "ok": digest_ok, "details": [] if digest_ok else ["the closure package is not the one the verdict was read from"]})

    decision = current_decision(closure_package, payload["obligation_id"])
    decision_problems = []
    if decision is None:
        decision_problems.append(f"the package holds no decision for {payload['obligation_id']}")
    else:
        if decision["decision_id"] != payload["decision"]["decision_id"]:
            decision_problems.append(f"the decision in effect is {decision['decision_id']}, not {payload['decision']['decision_id']}")
        for field, value in payload["decision"].items():
            if decision.get(field) != value:
                decision_problems.append(f"decision.{field} differs from the package")
        if _is_final(decision) != payload["final"]:
            decision_problems.append("final differs from the decision's amounts and outcome")
    checks.append({"name": "decision", "ok": not decision_problems, "details": decision_problems})
    return {"valid": all(c["ok"] for c in checks), "checks": checks}
