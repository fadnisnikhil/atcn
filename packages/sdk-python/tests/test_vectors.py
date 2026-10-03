"""Cross-language conformance: the Python SDK must reproduce the TypeScript-generated vectors byte for byte."""

import json
from pathlib import Path

import pytest

from atcn import canonicalize, digest_of, public_key_from_private, sign_payload, verify_payload, verify_webhook, sign_webhook, generate_key_pair
from atcn.crypto import Signed

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/schema/test-vectors/vectors.json").read_text())


def test_public_key_derivation():
    assert public_key_from_private(VECTORS["private_key"]) == VECTORS["public_key"]


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["digest"][:20])
def test_canonical_digest_and_signature(case):
    assert canonicalize(case["payload"]) == case["canonical"]
    assert digest_of(case["payload"]) == case["digest"]
    signed = sign_payload(case["payload"], VECTORS["key_id"], VECTORS["key_version"], VECTORS["private_key"])
    assert signed["signature"]["value"] == case["signature"]
    assert verify_payload(signed, VECTORS["public_key"])


def test_tampered_payload_fails_verification():
    case = VECTORS["cases"][0]
    signed: Signed = {"payload": {**case["payload"], "event_type": "obligation.cancelled"}, "signature": {"key_id": VECTORS["key_id"], "key_version": 1, "algorithm": "Ed25519", "value": case["signature"]}}
    assert not verify_payload(signed, VECTORS["public_key"])


def test_floats_and_unsafe_integers_are_rejected():
    with pytest.raises(ValueError):
        canonicalize({"amount": 1.5})
    with pytest.raises(ValueError):
        canonicalize({"amount": 2**53})


def test_webhook_vector_and_tolerance():
    hook = VECTORS["webhook"]
    assert sign_webhook(hook["body"], VECTORS["key_id"], 1, VECTORS["private_key"], hook["timestamp"]) == hook["header"]
    assert verify_webhook(hook["body"], hook["header"], VECTORS["public_key"], now=hook["timestamp"] + 10).valid
    assert verify_webhook(hook["body"], hook["header"], VECTORS["public_key"], now=hook["timestamp"] + 3600).reason == "timestamp_outside_tolerance"
    assert verify_webhook(hook["body"] + " ", hook["header"], VECTORS["public_key"], now=hook["timestamp"]).reason == "bad_signature"


def test_generated_keys_round_trip():
    private_key, public_key = generate_key_pair()
    signed = sign_payload({"hello": "world"}, "key_x", 1, private_key)
    assert verify_payload(signed, public_key)
