"""Ed25519 signing over canonical JSON, SHA-256 digests, and base64url encoding."""

import base64
import hashlib
from typing import Any, TypedDict

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .canonical import canonicalize

SIGNATURE_ALGORITHM = "Ed25519"


class Signature(TypedDict):
    key_id: str
    key_version: int
    algorithm: str
    value: str


class Signed(TypedDict):
    payload: Any
    signature: Signature


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sha256_digest(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def digest_of(value: Any) -> str:
    """Digest of the canonical JSON form of a value (terms digests, payload hashes)."""
    return sha256_digest(canonicalize(value))


def generate_key_pair() -> tuple[str, str]:
    """Returns (private_key, public_key) as base64url strings; the private key is the 32-byte seed."""
    private = Ed25519PrivateKey.generate()
    seed = private.private_bytes_raw()
    return b64url_encode(seed), public_key_from_private(b64url_encode(seed))


def public_key_from_private(private_key: str) -> str:
    private = Ed25519PrivateKey.from_private_bytes(b64url_decode(private_key))
    return b64url_encode(private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))


def sign_bytes(data: bytes, private_key: str) -> str:
    return b64url_encode(Ed25519PrivateKey.from_private_bytes(b64url_decode(private_key)).sign(data))


def verify_bytes(data: bytes, signature: str, public_key: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(b64url_decode(public_key)).verify(b64url_decode(signature), data)
        return True
    except (InvalidSignature, ValueError):
        return False


def sign_payload(payload: Any, key_id: str, key_version: int, private_key: str) -> Signed:
    value = sign_bytes(canonicalize(payload).encode("utf-8"), private_key)
    return {"payload": payload, "signature": {"key_id": key_id, "key_version": key_version, "algorithm": SIGNATURE_ALGORITHM, "value": value}}


def verify_payload(signed: Signed, public_key: str) -> bool:
    if signed["signature"].get("algorithm") != SIGNATURE_ALGORITHM:
        return False
    return verify_bytes(canonicalize(signed["payload"]).encode("utf-8"), signed["signature"]["value"], public_key)
