"""Clearing verdicts made by the TypeScript local runner verify in Python with the same check names."""

import copy
import json
from pathlib import Path

from atcn import verify_clearing_verdict

FIXTURE = json.loads((Path(__file__).parent / "fixtures/clearing-verdict.json").read_text())
KEYS = FIXTURE["trusted_keys"]


def checks(report: dict) -> list[tuple[str, bool]]:
    return [(c["name"], c["ok"]) for c in report["checks"]]


def test_a_verdict_verifies_against_the_package_it_was_read_from():
    report = verify_clearing_verdict(FIXTURE["verdict"], KEYS, FIXTURE["closure_package"])
    assert report["valid"] is True
    assert checks(report) == [("schema", True), ("verdict_signature", True), ("closure_package", True), ("package_digest", True), ("decision", True)]
    assert report["checks"][2] == {"name": "closure_package", "ok": True, "details": []}


def test_the_package_is_verified_in_full():
    package = copy.deepcopy(FIXTURE["closure_package"])
    package["payload"]["events"][0]["payload"]["actor_id"] = "svc_atcn"
    details = verify_clearing_verdict(FIXTURE["verdict"], KEYS, package)["checks"][-1]["details"]
    assert details[0] == "package_signature: signature does not verify"
    assert any(d.startswith("event_signatures_and_references: ") for d in details)


def test_without_the_package_the_decision_is_not_inspected():
    report = verify_clearing_verdict(FIXTURE["verdict"], KEYS)
    assert report["valid"] is True
    assert report["checks"][-1] == {
        "name": "decision",
        "ok": True,
        "state": "not_inspected",
        "details": ["no closure package supplied; the decision was not compared with its evidence"],
    }


def test_a_changed_amount_breaks_the_signature_and_disagrees_with_the_package():
    verdict = copy.deepcopy(FIXTURE["verdict"])
    verdict["payload"]["decision"]["accepted_amount_minor"] += 1
    report = verify_clearing_verdict(verdict, KEYS, FIXTURE["closure_package"])
    assert report["valid"] is False
    assert dict(checks(report))["verdict_signature"] is False
    assert next(c for c in report["checks"] if c["name"] == "decision")["details"] == ["decision.accepted_amount_minor differs from the package"]


def test_another_package_or_an_untrusted_key_fails():
    package = copy.deepcopy(FIXTURE["closure_package"])
    package["payload"]["generated_at"] = "2030-01-01T00:00:00.000Z"
    assert verify_clearing_verdict(FIXTURE["verdict"], KEYS, package)["checks"][-1] == {
        "name": "closure_package",
        "ok": False,
        "details": ["package_signature: signature does not verify"],
    }
    other_keys = [{**key, "key_id": "key_atcn_service"} for key in KEYS]
    report = verify_clearing_verdict(FIXTURE["verdict"], other_keys)
    assert report["checks"][1] == {"name": "verdict_signature", "ok": False, "details": ["service key not among trusted keys"]}


def test_a_verdict_that_is_not_record_only_is_a_schema_failure():
    verdict = copy.deepcopy(FIXTURE["verdict"])
    verdict["payload"]["stance"] = "release_authority"
    report = verify_clearing_verdict(verdict, KEYS)
    assert report["valid"] is False
    assert report["checks"][0]["name"] == "schema"
