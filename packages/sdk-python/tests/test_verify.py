"""Offline verification of signed closures and receipts: the Python report equals the TypeScript report for every
signed document in the shared vectors, and tampering is caught the same way."""

import copy
import json
from pathlib import Path

import pytest

from atcn import verify_rail_attestation, verify_subledger_document
from atcn.rails import keccak256

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/subledger/test-vectors/vectors.json").read_text())
DOCUMENTS = VECTORS["documents"]
TRUSTED_KEYS = DOCUMENTS["trusted_keys"]


def case_named(name: str) -> dict:
    return next(c for c in DOCUMENTS["cases"] if c["name"] == name)


def verify_case(case: dict, document: dict | None = None) -> dict:
    options = dict(case["options"])
    if "traces" in options:
        options["traces"] = [trace.encode("utf-8") for trace in options["traces"]]
    return verify_subledger_document(case["document"] if document is None else document, TRUSTED_KEYS, **options)


def check_named(report: dict, name: str) -> dict:
    return next(c for c in report["checks"] if c["name"] == name)


def failed(report: dict) -> list[str]:
    return [c["name"] for c in report["checks"] if not c["ok"]]


@pytest.mark.parametrize("case", DOCUMENTS["cases"], ids=lambda c: c["name"])
def test_report_matches_typescript(case):
    assert verify_case(case) == case["report"]


def test_vectors_cover_valid_and_tampered_documents_of_both_types():
    reports = [c["report"] for c in DOCUMENTS["cases"]]
    for document_type in ("atcn.subledger.closure", "atcn.subledger.receipt"):
        assert any(r["valid"] and r["document_type"] == document_type for r in reports)
        assert any(not r["valid"] and r["document_type"] == document_type for r in reports)


def test_a_changed_generated_at_breaks_the_issuer_signature():
    case = case_named("plain closure, countersigned")
    document = copy.deepcopy(case["document"])
    document["payload"]["generated_at"] = "2026-10-02T00:00:01.000Z"
    report = verify_case(case, document)
    assert not report["valid"]
    assert check_named(report, "issuer_signature")["details"] == ["signature does not verify over the canonical payload"]


def test_an_untrusted_or_revoked_service_key_fails():
    case = case_named("plain closure, operator keys not supplied")
    other = [{**key, "key_id": "key_other"} for key in TRUSTED_KEYS]
    report = verify_subledger_document(case["document"], other)
    assert check_named(report, "issuer_signature")["details"] == ["signing key key_atcn_service#1 is not a trusted service key"]

    revoked = [{**key, "revoked_at": "2026-10-01T00:00:00.000Z"} for key in TRUSTED_KEYS]
    report = verify_subledger_document(case["document"], revoked)
    assert check_named(report, "issuer_signature")["details"] == ["signing key was not valid at signing time"]


def test_a_required_countersignature_needs_the_operator_keys():
    case = case_named("plain closure, countersigned")
    report = verify_subledger_document(case["document"], TRUSTED_KEYS, require_operator_signature=True)
    assert check_named(report, "operator_signatures") == {
        "name": "operator_signatures",
        "ok": False,
        "details": ["operator keys not supplied; 1 countersignature(s) not checked"],
    }


def test_a_tampered_rail_record_is_refused():
    case = case_named("A2A-SE escrow release and refund")
    document = copy.deepcopy(case["document"])
    record = next(e["record"] for e in document["payload"]["financial_events"] if "rail_attestation" in e["record"])
    assert verify_rail_attestation(record["rail_attestation"])["ok"]
    record["rail_attestation"]["record"]["payload"]["settlement"]["amount"] += 1
    assert not verify_rail_attestation(record["rail_attestation"])["ok"]
    assert "rail_attestations" in failed(verify_case(case, document))


def test_a_rail_record_with_a_float_is_a_schema_failure():
    case = case_named("A2A-SE escrow release and refund")
    document = copy.deepcopy(case["document"])
    record = next(e["record"] for e in document["payload"]["financial_events"] if "rail_attestation" in e["record"])
    record["rail_attestation"]["record"]["amount"] = 1.5
    assert verify_case(case, document) == {
        "valid": False,
        "document_type": "atcn.subledger.closure",
        "checks": [{"name": "schema", "ok": False, "details": ["payload is not canonical JSON: numbers must be safe integers"]}],
    }


def test_a_parent_cycle_is_reported_rather_than_looping():
    case = case_named("broken edge capture gap")
    document = copy.deepcopy(case["document"])
    delegations = document["payload"]["delegations"]
    delegations[0]["parent_delegation_id"] = delegations[-1]["delegation_id"]
    report = verify_case(case, document)
    assert any(detail.startswith("cycle through") for detail in check_named(report, "lineage")["details"])


def test_input_that_is_not_a_document():
    for value in (None, [], "closure", {"payload": {"document_type": 7}}):
        report = verify_subledger_document(value, TRUSTED_KEYS)
        assert report["valid"] is False and report["document_type"] is None
    report = verify_subledger_document({"payload": {"document_type": 7}}, TRUSTED_KEYS)
    assert report["checks"] == [{"name": "document_type", "ok": False, "details": ["unknown document_type 7"]}]


def test_a_receipt_is_checked_against_the_current_time_by_default():
    case = case_named("receipt")
    report = verify_subledger_document(case["document"], TRUSTED_KEYS)
    detail = check_named(report, "expiry")["details"][0]
    assert detail.startswith(("valid until 2026-12-01T00:00:00.000Z (checked at ", "receipt expired at 2026-12-01T00:00:00.000Z (checked at "))


def test_keccak256_matches_known_digests():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
