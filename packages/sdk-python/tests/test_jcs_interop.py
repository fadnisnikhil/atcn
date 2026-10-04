"""RFC 8785 vectors shared with other implementations (A2A discussion #2038), reproduced byte for byte."""

import base64
import hashlib
import json
from pathlib import Path

import pytest

from atcn import canonicalize

VECTOR_DIR = Path(__file__).resolve().parents[3] / "packages/schema/test-vectors"
ALGOVOI_EDGE = json.loads((VECTOR_DIR / "external/jcs_edge_v1.json").read_text())
ATCN_JCS = json.loads((VECTOR_DIR / "atcn_jcs_v1.json").read_text())


def _check(vector: dict) -> None:
    canonical = canonicalize(vector["preimage"]).encode("utf-8")
    assert base64.b64encode(canonical).decode("ascii") == vector["expected_jcs_bytes_b64"]
    assert hashlib.sha256(canonical).hexdigest() == vector["expected_sha256"]


@pytest.mark.parametrize("vector", ALGOVOI_EDGE["vectors"], ids=lambda v: v["vector_id"])
def test_algovoi_jcs_edge_vectors(vector):
    _check(vector)


@pytest.mark.parametrize("vector", ATCN_JCS["vectors"], ids=lambda v: v["vector_id"])
def test_atcn_published_vectors(vector):
    _check(vector)


def test_integral_float_matches_integer_but_fractions_are_rejected():
    assert canonicalize({"n": 1.0}) == canonicalize({"n": 1}) == '{"n":1}'
    with pytest.raises(ValueError):
        canonicalize({"n": 1.5})
    with pytest.raises(ValueError):
        canonicalize({"n": float(2**53)})
