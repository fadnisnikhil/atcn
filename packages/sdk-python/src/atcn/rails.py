"""Rail attestations (schema 1.5): a payment rail's own record of a payment or refund, re-verified offline.

Mirrors @atcn/subledger rails.ts: A2A-SE escrow attestations (Merkle inclusion over Python-style canonical JSON) and
x402 exact EVM payments (the payer's EIP-3009 secp256k1 signature, recovered with keccak-256). keccak-256 and the
secp256k1 recovery are written out in plain Python so the SDK needs no further dependency; they are slow but only ever
run over a handful of records.
"""

import hashlib
import json
import math
import re
from typing import Any

from .canonical import MAX_SAFE_INTEGER

Json = dict[str, Any]

A2A_SE_RELEASE_SCHEME = "urn:a2a-se:escrow-release-attestation:v1"
A2A_SE_REFUND_SCHEME = "urn:a2a-se:escrow-refund-attestation:v1"
X402_EXACT_EVM_SCHEME = "x402:exact-evm:v2"

# USD stablecoins, by CAIP-2 network and token address (lowercase). ATCN records them as USD cents at 1:1.
X402_USD_ASSETS = {
    "eip155:84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e": {"name": "USDC", "decimals": 6},
    "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {"name": "USDC", "decimals": 6},
}


def _refuse(code: str, detail: str) -> Json:
    return {"ok": False, "code": code, "detail": detail}


def _js_number(value: int | float) -> str:
    """JavaScript's String(number): the shortest digits that round-trip, written out up to 21 digits, else exponent form."""
    if isinstance(value, int) and abs(value) <= MAX_SAFE_INTEGER:
        return str(value)
    number = float(value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    mantissa, _, exponent = repr(abs(number)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    all_digits = whole + fraction
    digits = all_digits.lstrip("0").rstrip("0")
    # n is where the decimal point sits relative to the first significant digit, as in ECMAScript's Number::toString.
    n = len(whole) + int(exponent or 0) - (len(all_digits) - len(all_digits.lstrip("0")))
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    return sign + digits[0] + ("." + digits[1:] if k > 1 else "") + f"e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"


def _js_string(value: Any) -> str:
    """JavaScript's String(value) for the JSON values rail records carry."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if item is None else _js_string(item) for item in value)
    return "[object Object]"


def _js_member(record: Json, key: str) -> str:
    """String(record[key]) in JavaScript, where a missing member is undefined."""
    return _js_string(record[key]) if key in record else "undefined"


def _is_hex64(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _is_currency(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[A-Z]{3}", value) is not None


def _is_amount(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INTEGER


# ---------- A2A-SE escrow attestations ----------


def _integers_only(value: Any) -> Any:
    if isinstance(value, float):
        if not value.is_integer() or abs(value) > MAX_SAFE_INTEGER:
            raise ValueError(f"number {value} is not an integer; A2A-SE records carry integers only")
        return int(value)
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > MAX_SAFE_INTEGER:
        raise ValueError(f"number {value} is not an integer; A2A-SE records carry integers only")
    if isinstance(value, list):
        return [_integers_only(item) for item in value]
    if isinstance(value, dict):
        return {key: _integers_only(item) for key, item in value.items()}
    return value


def python_canonical_json(value: Any) -> str:
    """json.dumps(value, sort_keys=True, separators=(",", ":")), which A2A-SE hashes: keys by code point, non-ASCII escaped."""
    return json.dumps(_integers_only(value), sort_keys=True, separators=(",", ":"))


def _leaf_hash(canonical: str) -> str:
    return hashlib.sha256(b"\x00" + canonical.encode("utf-8")).hexdigest()


def _node_hash(left: str, right: str) -> str:
    return hashlib.sha256(b"\x01" + bytes.fromhex(left) + bytes.fromhex(right)).hexdigest()


def _verify_a2a_se(scheme: str, record: Json) -> Json:
    """The payload's leaf hash must be data_hash, and folding the proof must give merkle_root. A2A-SE attestations are
    not signed; the anchor is the Merkle root of the exchange's append-only log."""
    payload = record.get("payload")
    data_hash = record.get("data_hash")
    merkle_root = record.get("merkle_root")
    proof = record.get("proof")
    schema_id = record.get("schema_id")
    if schema_id != scheme:
        return _refuse("malformed", f"schema_id {_js_member(record, 'schema_id')} is not the declared scheme {scheme}")
    if not isinstance(payload, dict) or not isinstance(payload.get("header"), dict) or payload["header"].get("schema_id") != scheme:
        return _refuse("malformed", "payload.header.schema_id must be the declared scheme")
    if not _is_hex64(data_hash) or not _is_hex64(merkle_root) or not isinstance(proof, list):
        return _refuse("malformed", "data_hash, merkle_root and proof are required")

    try:
        canonical = python_canonical_json(payload)
    except ValueError as error:
        return _refuse("malformed", str(error))
    if _leaf_hash(canonical) != data_hash:
        return _refuse("data_hash_mismatch", "the payload does not hash to data_hash")
    computed = data_hash
    for step in proof:
        if not isinstance(step, dict) or not _is_hex64(step.get("sibling_hash")) or step.get("side") not in ("left", "right"):
            return _refuse("malformed", "each proof step needs sibling_hash and side")
        computed = _node_hash(step["sibling_hash"], computed) if step["side"] == "left" else _node_hash(computed, step["sibling_hash"])
    if computed != merkle_root:
        return _refuse("merkle_proof_invalid", "the proof does not lead from data_hash to merkle_root")

    settlement = payload.get("settlement")
    amount = payload.get("amount_paid") if scheme == A2A_SE_RELEASE_SCHEME else payload.get("amount_returned")
    if not isinstance(settlement, dict) or not isinstance(settlement.get("escrow_id"), str) or not _is_currency(settlement.get("currency")) or not _is_amount(amount):
        return _refuse("malformed", "settlement.escrow_id, settlement.currency and the amount are required")
    return {
        "ok": True,
        "rail": "a2a-se",
        "anchor": f"A2A-SE log leaf {_js_member(record, 'leaf_index')} under Merkle root {merkle_root} (unsigned; compare the root with the one the exchange publishes)",
        "facts": {
            "type": "payment_reported" if scheme == A2A_SE_RELEASE_SCHEME else "refund",
            "amount_minor": amount,
            "currency": settlement["currency"],
            "rail_ref": settlement["escrow_id"],
            "job_ref": settlement["task_id"] if isinstance(settlement.get("task_id"), str) else None,
            "occurred_at": settlement["occurred_at"] if isinstance(settlement.get("occurred_at"), str) else None,
        },
    }


# ---------- keccak-256 (the original Keccak padding, not SHA3-256) ----------

_MASK_64 = (1 << 64) - 1
_ROUND_CONSTANTS = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]  # fmt: skip
# Rotation offset of lane (x, y), indexed [x][y].
_ROTATIONS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]


def _rotate_left(lane: int, bits: int) -> int:
    return ((lane << bits) | (lane >> (64 - bits))) & _MASK_64


def _keccak_f(state: list[int]) -> list[int]:
    """The Keccak-f[1600] permutation over 25 64-bit lanes; lane (x, y) is state[x + 5 * y]."""
    for round_constant in _ROUND_CONSTANTS:
        column = [state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20] for x in range(5)]
        theta = [column[(x - 1) % 5] ^ _rotate_left(column[(x + 1) % 5], 1) for x in range(5)]
        state = [lane ^ theta[i % 5] for i, lane in enumerate(state)]
        moved = [0] * 25
        for x in range(5):
            for y in range(5):
                moved[y + 5 * ((2 * x + 3 * y) % 5)] = _rotate_left(state[x + 5 * y], _ROTATIONS[x][y])
        state = [moved[x + 5 * y] ^ (~moved[(x + 1) % 5 + 5 * y] & moved[(x + 2) % 5 + 5 * y]) for y in range(5) for x in range(5)]
        state[0] ^= round_constant
    return state


def keccak256(data: bytes) -> bytes:
    rate = 136
    padded = bytearray(data) + b"\x01" + bytes(-(len(data) + 1) % rate)
    padded[-1] |= 0x80
    state = [0] * 25
    for offset in range(0, len(padded), rate):
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(padded[offset + 8 * i : offset + 8 * i + 8], "little")
        state = _keccak_f(state)
    return b"".join(lane.to_bytes(8, "little") for lane in state[:4])


# ---------- secp256k1 public key recovery ----------

_P = 2**256 - 2**32 - 977
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
Point = tuple[int, int] | None  # None is the point at infinity


def _point_add(a: Point, b: Point) -> Point:
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % _P == 0:
        return None
    if a == b:
        slope = 3 * a[0] * a[0] * pow(2 * a[1], -1, _P) % _P
    else:
        slope = (b[1] - a[1]) * pow(b[0] - a[0], -1, _P) % _P
    x = (slope * slope - a[0] - b[0]) % _P
    return x, (slope * (a[0] - x) - a[1]) % _P


def _point_multiply(point: Point, scalar: int) -> Point:
    result: Point = None
    while scalar:
        if scalar & 1:
            result = _point_add(result, point)
        point = _point_add(point, point)
        scalar >>= 1
    return result


def recover_address(digest: bytes, signature: str) -> str:
    """The address that made a 65-byte (r, s, v) secp256k1 signature over a digest. Raises ValueError when none can."""
    raw = bytes.fromhex(signature[2:])
    r = int.from_bytes(raw[:32], "big")
    s = int.from_bytes(raw[32:64], "big")
    recovery = raw[64] - 27 if raw[64] >= 27 else raw[64]
    if not (1 <= r < _N and 1 <= s < _N):
        raise ValueError("r and s must be between 1 and the curve order")
    if recovery not in (0, 1, 2, 3):
        raise ValueError("recovery id invalid")
    x = r + _N if recovery >= 2 else r
    if x >= _P:
        raise ValueError("recovery id 2 or 3 invalid")
    y_squared = (pow(x, 3, _P) + 7) % _P
    y = pow(y_squared, (_P + 1) // 4, _P)
    if y * y % _P != y_squared:
        raise ValueError("r is not the x coordinate of a curve point")
    if y % 2 != recovery % 2:
        y = _P - y
    e = int.from_bytes(digest, "big") % _N
    x_inverse = pow(x, -1, _N)
    public = _point_add(_point_multiply(_G, -e * x_inverse % _N), _point_multiply((x, y), s * x_inverse % _N))
    if public is None:
        raise ValueError("point at infinity")
    return "0x" + keccak256(public[0].to_bytes(32, "big") + public[1].to_bytes(32, "big"))[-20:].hex()


# ---------- x402 exact (EVM) payments ----------


def _keccak_text(text: str) -> bytes:
    return keccak256(text.encode("utf-8"))


def _js_bigint(value: Any) -> int:
    """JavaScript's BigInt(value) for JSON values: booleans and integral numbers convert, as do decimal, 0x, 0o and 0b
    strings; anything else raises ValueError where JavaScript throws."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0
        for prefix, digits, base in (("0x", "[0-9a-f]", 16), ("0o", "[0-7]", 8), ("0b", "[01]", 2)):
            if re.fullmatch(f"{prefix}{digits}+", text, re.IGNORECASE):
                return int(text[2:], base)
        if re.fullmatch(r"[+-]?[0-9]+", text):
            return int(text)
    raise ValueError(f"cannot convert {value!r} to a BigInt")


def _word(value: int) -> bytes:
    """A 32-byte big-endian word; raises ValueError like the TypeScript hex conversion for a negative value."""
    return bytes.fromhex(format(value, "x").rjust(64, "0"))


_TRANSFER_TYPEHASH = _keccak_text("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
_DOMAIN_TYPEHASH = _keccak_text("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")


def eip3009_digest(authorization: Json, domain: Json) -> bytes:
    """The EIP-712 digest a payer signs for an EIP-3009 transferWithAuthorization (the x402 "exact" EVM scheme).
    domain has name, version, chainId (int) and verifyingContract."""
    domain_separator = keccak256(
        _DOMAIN_TYPEHASH
        + _keccak_text(domain["name"])
        + _keccak_text(domain["version"])
        + _word(domain["chainId"])
        + _word(_js_bigint(domain["verifyingContract"]))
    )
    struct_hash = keccak256(
        _TRANSFER_TYPEHASH
        + _word(_js_bigint(authorization.get("from")))
        + _word(_js_bigint(authorization.get("to")))
        + _word(_js_bigint(authorization.get("value")))
        + _word(_js_bigint(authorization.get("validAfter")))
        + _word(_js_bigint(authorization.get("validBefore")))
        + bytes.fromhex(authorization["nonce"][2:])
    )
    return keccak256(b"\x19\x01" + domain_separator + struct_hash)


def _is_address(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", value) is not None


def _verify_x402(record: Json) -> Json:
    """The payer's EIP-3009 authorization signature must recover its `from` address and authorize exactly the required
    amount to payTo. The facilitator's settlement response supplies success and the transaction hash; on-chain
    inclusion is not checked offline."""
    requirements = record.get("requirements")
    payload = record.get("payload")
    settlement = record.get("settlement")
    if (
        not isinstance(requirements, dict)
        or not isinstance(payload, dict)
        or not isinstance(settlement, dict)
        or not isinstance(payload.get("authorization"), dict)
        or not isinstance(payload.get("signature"), str)
    ):
        return _refuse("malformed", "requirements, payload.authorization, payload.signature and settlement are required")
    authorization = payload["authorization"]
    extra = requirements.get("extra") if isinstance(requirements.get("extra"), dict) else {}
    network = _js_member(requirements, "network")
    chain = re.fullmatch(r"eip155:(\d+)", network)
    addresses = [authorization.get("from"), authorization.get("to"), requirements.get("asset"), requirements.get("payTo")]
    if requirements.get("scheme") != "exact" or not chain or not isinstance(extra.get("name"), str) or not isinstance(extra.get("version"), str) or not all(_is_address(a) for a in addresses):
        return _refuse("malformed", "requirements must be the exact scheme on an eip155 network, with extra.name, extra.version and EVM addresses")
    nonce = authorization.get("nonce")
    if not (isinstance(nonce, str) and re.fullmatch(r"0x[0-9a-fA-F]{64}", nonce)) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", payload["signature"]):
        return _refuse("malformed", "nonce must be 32 bytes and signature 65 bytes, hex")
    if authorization["to"].lower() != requirements["payTo"].lower() or authorization.get("value") != _js_member(requirements, "amount"):
        return _refuse("malformed", "the authorization must pay exactly the required amount to payTo")
    try:
        domain = {"name": extra["name"], "version": extra["version"], "chainId": int(chain.group(1)), "verifyingContract": requirements["asset"]}
        signer = recover_address(eip3009_digest(authorization, domain), payload["signature"])
    except ValueError:
        return _refuse("signature_invalid", "the authorization signature cannot be recovered")
    if signer != authorization["from"].lower():
        return _refuse("signature_invalid", f"the authorization was signed by {signer}, not the payer {authorization['from']}")
    transaction = settlement.get("transaction")
    if settlement.get("success") is not True or not isinstance(transaction, str) or transaction == "" or settlement.get("network") != network:
        return _refuse("settlement_not_successful", "the facilitator did not report a successful settlement on the required network")
    asset = X402_USD_ASSETS.get(f"{network}:{requirements['asset']}".lower())
    value = _js_bigint(authorization["value"])
    if asset is None or value % 10 ** (asset["decimals"] - 2) != 0:
        return _refuse("unsupported_asset", f"no whole-cent USD conversion for {requirements['asset']} on {network}")
    return {
        "ok": True,
        "rail": "x402",
        "anchor": f"payer {authorization['from']} signed the EIP-3009 authorization; transaction {transaction} as reported by the facilitator (on-chain inclusion not checked offline)",
        "facts": {
            "type": "payment_reported",
            "amount_minor": value // 10 ** (asset["decimals"] - 2),
            "currency": "USD",
            "rail_ref": transaction,
            "job_ref": nonce,
            "occurred_at": None,
        },
    }


# ---------- Registry, consistency and the closure report ----------

def verify_rail_attestation(attestation: Json) -> Json:
    """{"ok": True, "rail", "facts", "anchor"} when the record verifies offline, else {"ok": False, "code", "detail"}."""
    scheme = attestation["scheme"]
    if scheme in (A2A_SE_RELEASE_SCHEME, A2A_SE_REFUND_SCHEME):
        return _verify_a2a_se(scheme, attestation["record"])
    if scheme == X402_EXACT_EVM_SCHEME:
        return _verify_x402(attestation["record"])
    return _refuse("unsupported_scheme", f"no importer for scheme {scheme}")


def rail_attestation_problem(event: Json) -> Json | None:
    """Why a financial event's rail attestation does not support it ({"code", "detail"}), or None when it verifies and agrees."""
    if "rail_attestation" not in event:
        return None
    result = verify_rail_attestation(event["rail_attestation"])
    if not result["ok"]:
        return {"code": result["code"], "detail": result["detail"]}
    facts = result["facts"]
    mismatches = []
    if facts["type"] != event["type"]:
        mismatches.append(f"type {event['type']} (the rail recorded {facts['type']})")
    if facts["amount_minor"] != event["amount_minor"]:
        mismatches.append(f"amount {event['amount_minor']} (the rail recorded {facts['amount_minor']})")
    if facts["currency"] != event["currency"]:
        mismatches.append(f"currency {event['currency']} (the rail recorded {facts['currency']})")
    if facts["rail_ref"] != event["provider_reference"]:
        mismatches.append(f"provider_reference {_js_string(event['provider_reference'])} (the rail recorded {facts['rail_ref']})")
    if mismatches:
        return {"code": "attestation_mismatch", "detail": f"the event does not match its rail attestation: {'; '.join(mismatches)}"}
    return None


def build_rail_attestation_report(events: list[Json]) -> list[Json] | None:
    """The closure's rail_attestations: one entry per event whose embedded attestation verifies and agrees with it; None when none carry one."""
    attested = [e["record"] for e in events if "rail_attestation" in e["record"]]
    if not attested:
        return None
    report = []
    for record in attested:
        result = verify_rail_attestation(record["rail_attestation"])
        if not result["ok"] or rail_attestation_problem(record) is not None:
            continue
        report.append(
            {
                "financial_event_id": record["financial_event_id"],
                "scheme": record["rail_attestation"]["scheme"],
                "rail": result["rail"],
                "rail_ref": result["facts"]["rail_ref"],
                "anchor": result["anchor"],
                "assurance": ["rail_attested"],
            }
        )
    return report
