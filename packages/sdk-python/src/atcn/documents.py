"""The shapes of signed subledger documents, checked the way the TypeScript verifier's zod schemas check them.

Parsing returns a copy. Unknown members of ordinary objects are dropped, as zod drops them; the TypeScript verifier
checks the signature over the parsed document, so such members are not covered by it. Strict objects refuse unknown
members. Issues read "path: message" with zod's English messages.
"""

import math
import re
from typing import Any, Callable

from .canonical import MAX_SAFE_INTEGER

Json = dict[str, Any]

SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS = ("1.2", "1.3", "1.4", "1.5")
SUBLEDGER_VERIFIER_VERSION = "1.5.0"
RECEIPT_DOCUMENT_TYPE = "atcn.subledger.receipt"
CLOSURE_DOCUMENT_TYPE = "atcn.subledger.closure"
RESPONSE_STATEMENT_TYPE = "atcn.subledger.receipt_response"
SIGNED_BY_HOSTED_SERVICE = "atcn-hosted-service"
SIGNED_BY_LOCAL_RUNNER = "atcn-local-runner"

FINANCIAL_EVENT_TYPES = ("quote", "invoice", "charge", "payment_reported", "refund", "reversal", "fee", "credit", "adjustment", "fx_rate", "estimate", "hold")
NORMALIZED_STATUSES = ("quoted", "issued", "pending", "reported_paid", "pending_finality", "failed", "refunded", "reversed", "void", "unknown")
EXPECTATION_ISSUERS = ("agent", "gateway", "operator")
HOLD_STATUSES = ("open", "captured", "released", "expired")
PAYERS = ("buyer", "provider", "other")
DELIVERY_EVENT_TYPES = ("acceptance", "completion", "partial_completion", "cancellation", "provider_failure", "terms_update", "correction")
SIGNED_CLAIM_TYPES = ("completion", "partial_completion", "cancellation", "provider_failure")
CLAIM_ASSERTERS = ("buyer", "provider", "clearing_policy", "dispute_reviewer", "clearing_network")
ASSURANCE_LABELS = (
    "issuer_signed",
    "buyer_recorded",
    "network_recorded",
    "recipient_viewed",
    "link_authenticated_response",
    "provider_identity_bound",
    "provider_key_signed",
    "contested",
    "superseded",
    "expired",
    "revoked",
    "gateway_signed",
    "rail_attested",
)
RESPONSE_TYPES = ("acknowledge_view", "acknowledge_delivery", "submit_evidence", "propose_correction", "signed_attestation")
ATTESTABLE_FIELDS = ("delivery.status", "delivery.evidence", "scope.terms_digest", "financial.amounts", "financial.status", "delivery.usage")
FIELD_STATES = ("missing", "imported", "buyer_asserted", "provider_reported", "contested")
USAGE_METERS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "model_call", "tool_call", "a2a_call")
MODEL_METERS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "model_call")
TRACE_STEP_KINDS = ("model_call", "tool_call", "a2a_call")


def attestable_fields_for(schema_version: str) -> tuple[str, ...]:
    """Schema 1.5 added "delivery.usage". Documents of earlier versions disclose exactly the other fields."""
    return ATTESTABLE_FIELDS[:-1] if schema_version in ("1.2", "1.3", "1.4") else ATTESTABLE_FIELDS


# ---------- A small zod-like schema language ----------

_MISSING = object()
# Each issue is (path, message, continues). As in zod, an issue with continues True lets the schema's later checks run;
# None stops them, except length checks, which still run; False stops every later check.
Issues = list[tuple[list[Any], str, Any]]


def _aborted(issues: Issues, start: int) -> bool:
    return any(continues is not True for _, _, continues in issues[start:])


def _explicitly_aborted(issues: Issues, start: int) -> bool:
    return any(continues is False for _, _, continues in issues[start:])


def _received(value: Any) -> str:
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _quoted(value: str) -> str:
    return f'"{value}"'


def _js_length(text: str) -> int:
    """String length in UTF-16 code units, as JavaScript counts it."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _type_issue(issues: Issues, path: list[Any], expected: str, value: Any) -> None:
    issues.append((path, f"Invalid input: expected {expected}, received {_received(value)}", None))


def _length_issues(issues: Issues, path: list[Any], value: Any, start: int, min_length: int | None, max_length: int | None) -> None:
    """zod's length checks run on any string or array, even after a type issue, unless an issue stopped every check."""
    if isinstance(value, str):
        length, origin, unit = _js_length(value), "string", "characters"
    elif isinstance(value, list):
        length, origin, unit = len(value), "array", "items"
    else:
        return
    if _explicitly_aborted(issues, start):
        return
    if min_length is not None and length < min_length:
        issues.append((path, f"Too small: expected {origin} to have >={min_length} {unit}", True))
    if max_length is not None and length > max_length:
        issues.append((path, f"Too big: expected {origin} to have <={max_length} {unit}", True))


class Schema:
    def parse(self, value: Any, path: list[Any], issues: Issues) -> Any:
        raise NotImplementedError


class Unknown(Schema):
    def parse(self, value, path, issues):
        return value


class Str(Schema):
    """pattern is the JavaScript regex source; message replaces zod's default for a pattern mismatch."""

    def __init__(self, min_length: int | None = None, max_length: int | None = None, pattern: str | None = None, message: str | None = None):
        self.min_length = min_length
        self.max_length = max_length
        self.pattern = pattern
        # JavaScript's $ matches only at the very end; Python's also matches before a final newline. JavaScript's \d
        # matches only ASCII digits.
        self.regex = None if pattern is None else re.compile(pattern[:-1] + r"\Z" if pattern.endswith("$") else pattern, re.ASCII)
        self.message = message

    def parse(self, value, path, issues):
        start = len(issues)
        if not isinstance(value, str):
            _type_issue(issues, path, "string", value)
        _length_issues(issues, path, value, start, self.min_length, self.max_length)
        if self.regex is not None and not _aborted(issues, start) and not self.regex.search(value):
            issues.append((path, self.message or f"Invalid string: must match pattern /{self.pattern}/", True))
        return value


_DATE = (
    r"(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])"
    r"|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
)
_ISO_DATETIME = re.compile(rf"{_DATE}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z\Z")
_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:\S+\Z")


class Formatted(Schema):
    """A string in a named format: z.iso.datetime() (UTC, seconds required) or z.url()."""

    def __init__(self, regex: re.Pattern[str], message: str):
        self.regex = regex
        self.message = message

    def parse(self, value, path, issues):
        if not isinstance(value, str):
            _type_issue(issues, path, "string", value)
        elif not self.regex.match(value):
            issues.append((path, self.message, True))
        return value


class Int(Schema):
    """z.number().int() followed by checks in order: ("min", n) is .min(n) or .nonnegative(), ("gt", 0) is .positive(),
    ("max", n) is .max(n), and ("safe", message) is .refine(Number.isSafeInteger, message)."""

    def __init__(self, *checks: tuple[str, Any]):
        self.checks = checks

    def parse(self, value, path, issues):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            _type_issue(issues, path, "number", value)
            return value
        if isinstance(value, float) and not math.isfinite(value):
            issues.append((path, f"Invalid input: expected number, received {'NaN' if math.isnan(value) else 'Infinity' if value > 0 else '-Infinity'}", None))
            return value
        if isinstance(value, float) and not value.is_integer():
            issues.append((path, "Invalid input: expected int, received number", False))
            return value
        number = int(value)
        safe = -MAX_SAFE_INTEGER <= number <= MAX_SAFE_INTEGER
        if number > MAX_SAFE_INTEGER:
            issues.append((path, f"Too big: expected int to be <={MAX_SAFE_INTEGER}", True))
        if number < -MAX_SAFE_INTEGER:
            issues.append((path, f"Too small: expected int to be >={-MAX_SAFE_INTEGER}", True))
        # Every issue from here on lets later checks run, so each check runs.
        for kind, bound in self.checks:
            if kind == "min" and number < bound:
                issues.append((path, f"Too small: expected number to be >={bound}", True))
            elif kind == "gt" and number <= bound:
                issues.append((path, f"Too small: expected number to be >{bound}", True))
            elif kind == "max" and number > bound:
                issues.append((path, f"Too big: expected number to be <={bound}", True))
            elif kind == "safe" and not safe:
                issues.append((path, bound, True))
        return number


class Bool(Schema):
    def parse(self, value, path, issues):
        if not isinstance(value, bool):
            _type_issue(issues, path, "boolean", value)
        return value


class Literal(Schema):
    def __init__(self, expected: str):
        self.expected = expected

    def parse(self, value, path, issues):
        if not (isinstance(value, str) and value == self.expected):
            issues.append((path, f"Invalid input: expected {_quoted(self.expected)}", None))
        return value


class Enum(Schema):
    def __init__(self, values: tuple[str, ...]):
        self.values = values

    def parse(self, value, path, issues):
        if not (isinstance(value, str) and value in self.values):
            if len(self.values) == 1:
                issues.append((path, f"Invalid input: expected {_quoted(self.values[0])}", None))
            else:
                issues.append((path, "Invalid option: expected one of " + "|".join(_quoted(v) for v in self.values), None))
        return value


class Nullable(Schema):
    def __init__(self, inner: Schema):
        self.inner = inner

    def parse(self, value, path, issues):
        return None if value is None else self.inner.parse(value, path, issues)


class Optional(Schema):
    """A member that may be absent. Only meaningful inside Obj."""

    def __init__(self, inner: Schema):
        self.inner = inner

    def parse(self, value, path, issues):
        return self.inner.parse(value, path, issues)


class Refined(Schema):
    """Rules zod's .refine() adds, each (rule, message). They run unless an issue so far stopped later checks."""

    def __init__(self, inner: Schema, rules: list[tuple[Callable[[Any], bool], str]]):
        self.inner = inner
        self.rules = rules

    def parse(self, value, path, issues):
        start = len(issues)
        parsed = self.inner.parse(value, path, issues)
        if not _aborted(issues, start):
            issues.extend((path, message, True) for rule, message in self.rules if not rule(parsed))
        return parsed


class Array(Schema):
    def __init__(self, item: Schema, min_items: int | None = None, max_items: int | None = None):
        self.item = item
        self.min_items = min_items
        self.max_items = max_items

    def parse(self, value, path, issues):
        start = len(issues)
        parsed = value
        if isinstance(value, list):
            parsed = [self.item.parse(item, [*path, index], issues) for index, item in enumerate(value)]
        else:
            _type_issue(issues, path, "array", value)
        _length_issues(issues, path, value, start, self.min_items, self.max_items)
        return parsed


class Tuple(Schema):
    def __init__(self, items: list[Schema]):
        self.items = items

    def parse(self, value, path, issues):
        if not isinstance(value, list):
            _type_issue(issues, path, "tuple", value)
            return value
        if len(value) < len(self.items):
            issues.append((path, f"Too small: expected array to have >={len(self.items)} items", None))
            return value
        if len(value) > len(self.items):
            issues.append((path, f"Too big: expected array to have <={len(self.items)} items", None))
        return [schema.parse(item, [*path, index], issues) for index, (schema, item) in enumerate(zip(self.items, value))]


class Obj(Schema):
    """z.object (unknown members dropped) or, with strict, z.strictObject (unknown members refused)."""

    def __init__(self, fields: dict[str, Schema], strict: bool = False):
        self.fields = fields
        self.strict = strict

    def extend(self, fields: dict[str, Schema], omit: tuple[str, ...] = ()) -> "Obj":
        kept = {key: schema for key, schema in self.fields.items() if key not in omit}
        return Obj({**kept, **fields}, self.strict)

    def parse(self, value, path, issues):
        if not isinstance(value, dict):
            _type_issue(issues, path, "object", value)
            return value
        parsed: Json = {}
        for key, schema in self.fields.items():
            member = value.get(key, _MISSING)
            if member is _MISSING and isinstance(schema, Optional):
                continue
            parsed[key] = schema.parse(member, [*path, key], issues)
        unknown = [key for key in js_key_order(value) if key not in self.fields]
        if self.strict and unknown:
            issues.append((path, _unrecognized(unknown), True))
        return parsed


def _is_array_index(key: str) -> bool:
    return key.isascii() and key.isdigit() and (key == "0" or not key.startswith("0")) and int(key) < 2**32 - 1


def js_key_order(record: Json) -> list[str]:
    """An object's keys in JavaScript's order: array indices ("0", "7") ascending first, then the rest as inserted."""
    indices = sorted((key for key in record if _is_array_index(key)), key=int)
    return [*indices, *(key for key in record if not _is_array_index(key))]


def _unrecognized(keys: list[str]) -> str:
    return f"Unrecognized key{'s' if len(keys) > 1 else ''}: " + ", ".join(_quoted(k) for k in keys)


class Record(Schema):
    """z.record, or z.partialRecord when the key is an Enum: a key outside the enum is unrecognized, any other bad key invalid."""

    def __init__(self, key: Schema, value: Schema):
        self.key = key
        self.value = value

    def parse(self, value, path, issues):
        if not isinstance(value, dict):
            _type_issue(issues, path, "record", value)
            return value
        parsed: Json = {}
        unrecognized = []
        for key in js_key_order(value):
            member = value[key]
            key_issues: Issues = []
            self.key.parse(key, [], key_issues)
            if key_issues and isinstance(self.key, Enum):
                unrecognized.append(key)
            elif key_issues:
                issues.append(([*path, key], "Invalid key in record", None))
            else:
                parsed[key] = self.value.parse(member, [*path, key], issues)
        if unrecognized:
            issues.append((path, _unrecognized(unrecognized), True))
        return parsed


class Null(Schema):
    def parse(self, value, path, issues):
        if value is not None:
            _type_issue(issues, path, "null", value)
        return value


class Union(Schema):
    """z.union: the first option the value matches. Otherwise, when exactly one option's issues all let later checks
    run, that option's issues; else a single "Invalid input"."""

    def __init__(self, options: list[Schema]):
        self.options = options

    def parse(self, value, path, issues):
        results = []
        for option in self.options:
            option_issues: Issues = []
            parsed = option.parse(value, path, option_issues)
            if not option_issues:
                return parsed
            results.append((parsed, option_issues))
        continuing = [result for result in results if not _aborted(result[1], 0)]
        if len(continuing) == 1:
            issues.extend(continuing[0][1])
            return continuing[0][0]
        issues.append((path, "Invalid input", None))
        return value


def parse(schema: Schema, value: Any) -> tuple[Any, list[str]]:
    """The parsed copy and the issues as "path: message" (an empty list when the value matches)."""
    issues: Issues = []
    parsed = schema.parse(value, [], issues)
    return parsed, [f"{'.'.join(str(p) for p in path)}: {message}" for path, message, _ in issues]


# ---------- Shared shapes ----------

ISO = Str(min_length=1)
ISO_DATETIME = Formatted(_ISO_DATETIME, "Invalid ISO datetime")
DIGEST = Str(pattern=r"^sha256:[0-9a-f]{64}$")
CURRENCY = Str(pattern=r"^[A-Z]{3}$", message="ISO 4217 currency code")
_AMOUNT_SAFE = ("safe", "amount must be a safe integer")
MINOR = Int(_AMOUNT_SAFE)
NONNEGATIVE_MINOR = Int(_AMOUNT_SAFE, ("min", 0))
AMOUNT_MINOR = Int(("min", 0), _AMOUNT_SAFE)
SAFE_COUNT = Int(("min", 0), ("safe", "must be a safe integer"))
TRACE_COUNT = Int(("min", 0), ("safe", "count must be a safe integer"))
NONNEGATIVE = Int(("min", 0))
POSITIVE = Int(("gt", 0))
ASSURANCE = Array(Enum(ASSURANCE_LABELS))
# Values allowed inside signed payloads: strings, safe integers, booleans, null, arrays and objects of these.
CANONICAL_VALUE = Union([Str(), Int(), Bool(), Null()])
CANONICAL_VALUE.options += [Array(CANONICAL_VALUE), Record(Str(), CANONICAL_VALUE)]

EVIDENCE_REF = Obj(
    {
        "uri": Str(1, 2048, r"^(https:\/\/|urn:|s3:\/\/|gs:\/\/)", "evidence uri must use https, urn, s3, or gs"),
        "digest": Nullable(DIGEST),
        "evidence_type": Str(1, 100),
    }
)
SKILL_REF = Obj({"namespace": Str(pattern=r"^[a-z0-9_.-]+$"), "skill_id": Str(1, 200), "agent_card_url": Optional(Formatted(_URL, "Invalid URL"))})
EXECUTION_MODEL = Obj({"provider": Str(1, 100), "name": Str(1, 200), "version": Str(1, 100)})
EXECUTION_DESCRIPTOR = Obj(
    {
        "execution_id": Str(1, 200),
        "protocol": Optional(Obj({"name": Literal("a2a"), "task_id": Str(1, 200), "context_id": Optional(Str(1, 200))})),
        "agent": Refined(
            Obj(
                {
                    "agent_id": Str(1, 200),
                    "agent_version": Str(1, 100),
                    "card_digest": Optional(DIGEST),
                    "model": Optional(EXECUTION_MODEL),
                    "additional_models": Optional(Array(EXECUTION_MODEL, 1, 20)),
                    "config_digest": Optional(DIGEST),
                }
            ),
            [(lambda a: "additional_models" not in a or "model" in a, "additional_models requires model")],
        ),
        "skill": Optional(SKILL_REF),
    }
)
EXECUTION_BINDING = Obj({"execution_id": Str(1, 200), "execution_digest": DIGEST})
ATTESTATION_REF = Obj({"relation": Enum(("revokes", "disputes")), "attestation_digest": DIGEST, "reason": Str(1, 2000)})


def _rate_combination(rate: Json) -> tuple[Any, ...]:
    model = rate.get("model") or {}
    return (rate["meter"], model.get("provider"), model.get("name"), rate.get("tool_name"))


PRICING_RATE = Refined(
    Obj(
        {
            "meter": Enum(USAGE_METERS),
            "model": Optional(Obj({"provider": Str(1, 100), "name": Str(1, 200)}, strict=True)),
            "tool_name": Optional(Str(1, 200)),
            "price_numerator": SAFE_COUNT,
            "price_denominator": Refined(SAFE_COUNT, [(lambda n: n > 0, "must be positive")]),
        },
        strict=True,
    ),
    [
        (lambda r: "model" not in r or r["meter"] in MODEL_METERS, "model applies only to token and model_call meters"),
        (lambda r: "tool_name" not in r or r["meter"] == "tool_call", "tool_name applies only to the tool_call meter"),
    ],
)
PRICING = Refined(
    Obj({"rates": Array(PRICING_RATE, 1, 200), "fixed_minor": Optional(AMOUNT_MINOR), "tolerance_bps": Int(("min", 0), ("max", 10000))}, strict=True),
    [(lambda p: len({_rate_combination(r) for r in p["rates"]}) == len(p["rates"]), "each meter, model and tool combination may have only one rate")],
)
REFUND_TERMS = Obj(
    {
        "on_failure": Enum(("refund", "dispute")),
        "on_timeout": Enum(("refund", "dispute")),
        "after_settlement": Obj({"cap_minor": AMOUNT_MINOR, "window_seconds": Int(("gt", 0), ("max", 31_536_000))}, strict=True),
    },
    strict=True,
)
WITNESS_POLICY = Obj(
    {
        "min_independent_witnesses": Int(("min", 1), ("max", 10)),
        "witness_provider_ids": Optional(Array(Str(min_length=1), 1, 20)),
        "independence": Literal("distinct_verified_domain"),
    },
    strict=True,
)
KEY_SIGNER = Obj({"provider_id": Str(min_length=1), "binding_id": Str(min_length=1), "key_id": Str(min_length=1), "value": Str(min_length=1)}, strict=True)
EXPECTATION = Obj(
    {
        "issued_by": Enum(EXPECTATION_ISSUERS),
        "source_ref": Nullable(Str(max_length=200)),
        "basis": Nullable(Str(max_length=500)),
        "expires_at": Nullable(ISO_DATETIME),
        "supersedes": Nullable(Str(max_length=200)),
        "hold_status": Optional(Enum(HOLD_STATUSES)),
        "signer": Optional(KEY_SIGNER),
    },
    strict=True,
)
RAIL_ATTESTATION = Obj({"scheme": Str(1, 200), "record": Record(Str(), Unknown())}, strict=True)
USAGE_SUMMARY = Obj(
    {
        "models": Array(
            Obj(
                {"provider": Str(1, 100), "name": Str(1, 200), "calls": TRACE_COUNT, "input_tokens": TRACE_COUNT, "output_tokens": TRACE_COUNT, "cache_read_input_tokens": TRACE_COUNT},
                strict=True,
            )
        ),
        "tools": Array(Obj({"name": Str(1, 200), "calls": TRACE_COUNT}, strict=True)),
        "a2a_calls": TRACE_COUNT,
    },
    strict=True,
)
USAGE_RECORD = Obj({"trace_digest": DIGEST, "summary": USAGE_SUMMARY}, strict=True)
FX = Obj({"base_currency": CURRENCY, "quote_currency": CURRENCY, "rate_numerator": POSITIVE, "rate_denominator": POSITIVE})

SIGNATURE = Obj({"key_id": Str(), "key_version": POSITIVE, "algorithm": Literal("Ed25519"), "value": Str()})
OPERATOR_SIGNATURE = Obj({"key_id": Str(), "algorithm": Literal("Ed25519"), "value": Str(), "signed_at": ISO})
ISSUER = Obj({"operator_id": Str(), "operator_name": Str(), "signed_by": Enum((SIGNED_BY_HOSTED_SERVICE, SIGNED_BY_LOCAL_RUNNER))})

TOTALS_FIELDS = (
    "quoted",
    "accepted",
    "invoiced",
    "charged",
    "fees",
    "adjustments",
    "refunded",
    "credits",
    "reported_paid",
    "net_cost",
    "unresolved",
    "downstream_reported",
    "allocated",
    "unallocated",
)
CURRENCY_TOTALS = Record(CURRENCY, Obj({field: MINOR for field in TOTALS_FIELDS}))
RECEIPT_TOTALS = Record(CURRENCY, Obj({field: MINOR for field in TOTALS_FIELDS[:-2]}))

FINANCIAL_EVENT_RECORD = Obj(
    {
        "financial_event_id": Str(),
        "type": Enum(FINANCIAL_EVENT_TYPES),
        "source": Str(),
        "source_event_id": Str(),
        "provider_id": Nullable(Str()),
        "provider_reference": Nullable(Str()),
        "amount_minor": MINOR,
        "currency": CURRENCY,
        "event_date": ISO,
        "imported_at": ISO,
        "provider_status": Nullable(Str()),
        "normalized_status": Enum(NORMALIZED_STATUSES),
        "evidence": Nullable(EVIDENCE_REF),
        "retrospective": Bool(),
        "payer": Enum(PAYERS),
        "liability_owner": Nullable(Str()),
        "economic_event_id": Nullable(Str()),
        "included_in_event_id": Nullable(Str()),
        "reverses_event_id": Nullable(Str()),
        "settles_event_id": Nullable(Str()),
        "fx": Nullable(FX),
        "reason": Nullable(Str()),
        "skill": Optional(SKILL_REF),
        "expectation": Optional(EXPECTATION),
        "rail_attestation": Optional(RAIL_ATTESTATION),
    }
)
DELIVERY_CLAIM = Obj(
    {
        "event_id": Str(),
        "delegation_id": Str(),
        "type": Enum(DELIVERY_EVENT_TYPES),
        "asserted_by": Enum(CLAIM_ASSERTERS),
        "assurance": ASSURANCE,
        "note": Nullable(Str()),
        "evidence": Array(EVIDENCE_REF),
        "supersedes_event_id": Nullable(Str()),
        "reason": Nullable(Str()),
        "retrospective": Bool(),
        "occurred_at": ISO,
        "recorded_at": ISO,
        "usage": Optional(USAGE_RECORD),
        "signer": Optional(KEY_SIGNER),
    }
)
CORRECTION = Obj({"field": Enum(ATTESTABLE_FIELDS), "proposed_value": Str(max_length=1000), "reason": Str(max_length=2000)})
RESPONSE_STATEMENT = Obj(
    {
        "document_type": Literal(RESPONSE_STATEMENT_TYPE),
        "receipt_id": Str(),
        "receipt_digest": DIGEST,
        "receipt_revision": POSITIVE,
        "issuer_operator_id": Str(),
        "response_type": Enum(RESPONSE_TYPES),
        "fields": Array(Enum(ATTESTABLE_FIELDS)),
        "note": Nullable(Str(max_length=2000)),
        "evidence": Array(EVIDENCE_REF, max_items=20),
        "corrections": Array(CORRECTION, max_items=20),
        "execution": Optional(EXECUTION_BINDING),
        "issued_at": Optional(ISO),
        "expires_at": Optional(ISO),
        "refs": Optional(Array(ATTESTATION_REF, max_items=20)),
        "role": Optional(Literal("witness")),
    }
)
RESPONSE_RECORD = Obj(
    {
        "response_id": Str(),
        "receipt_id": Str(),
        "receipt_revision": POSITIVE,
        "provider_id": Nullable(Str()),
        "statement": RESPONSE_STATEMENT,
        "statement_digest": DIGEST,
        "provider_signature": Nullable(Obj({"key_id": Str(), "binding_id": Str(), "value": Str()})),
        "assurance": ASSURANCE,
        "decision": Nullable(Obj({"status": Enum(("accepted", "rejected")), "reason": Str(), "decided_by": Str(), "decided_at": ISO})),
        "created_at": ISO,
    }
)
KEY_BINDING = Obj(
    {
        "binding_id": Str(),
        "provider_id": Str(),
        "key_id": Str(),
        "public_key": Str(),
        "method": Enum(("operator_configured", "domain_challenge")),
        "domain": Optional(Nullable(Str())),
        "created_by": Str(),
        "created_at": ISO,
        "revoked_at": Nullable(ISO),
    }
)
CAPTURE_GAP = Obj({"gap_id": Str(), "delegation_id": Nullable(Str()), "kind": Str(), "detail": Str(), "reported_at": ISO})

# ---------- Provider receipt ----------

DOWNSTREAM_VISIBILITY = Enum(("unknown", "disclosed", "none"))
RECEIPT_PAYLOAD = Obj(
    {
        "document_type": Literal(RECEIPT_DOCUMENT_TYPE),
        "schema_version": Enum(SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS),
        "receipt_id": Str(),
        "revision": POSITIVE,
        "previous_receipt_id": Nullable(Str()),
        "previous_receipt_digest": Nullable(DIGEST),
        "issued_at": ISO,
        "expires_at": Nullable(ISO),
        "issuer": ISSUER,
        "delegation": Obj(
            {
                "delegation_id": Str(),
                "root_task_id": Str(),
                "external_ref": Nullable(Str()),
                "provider_job_ref": Nullable(Str()),
                "shared_description": Nullable(Str()),
                "terms_digest": Nullable(DIGEST),
                "currency": CURRENCY,
                "quoted_max_minor": Nullable(MINOR),
                "quote_basis": Nullable(Str()),
                "accepted_amount_minor": Nullable(MINOR),
                "expected_delivery": Nullable(ISO),
                "retrospective": Bool(),
                "downstream_visibility": DOWNSTREAM_VISIBILITY,
                "execution": Optional(EXECUTION_DESCRIPTOR),
                "pricing": Optional(PRICING),
                "refund_terms": Optional(REFUND_TERMS),
                "witness_policy": Optional(WITNESS_POLICY),
            }
        ),
        "provider": Obj(
            {
                "provider_id": Nullable(Str()),
                "name_stated": Nullable(Str()),
                "provider_own_id": Nullable(Str()),
                "identity_binding": Enum(("key_bound", "not_bound")),
            }
        ),
        "delivery_claims": Array(DELIVERY_CLAIM.extend({}, omit=("delegation_id",))),
        "financial_events": Array(FINANCIAL_EVENT_RECORD.extend({"allocation_version": NONNEGATIVE}, omit=("liability_owner", "economic_event_id", "fx"))),
        "totals": RECEIPT_TOTALS,
        "field_status": Record(Enum(ATTESTABLE_FIELDS), Enum(FIELD_STATES)),
        "unverified_fields": Array(Enum(ATTESTABLE_FIELDS)),
        "corrections": Array(
            Obj(
                {
                    "response_id": Str(),
                    "receipt_revision": POSITIVE,
                    "fields": Array(Enum(ATTESTABLE_FIELDS)),
                    "decision": Enum(("accepted", "rejected", "open")),
                }
            )
        ),
        "lineage": Obj({"complete": Bool(), "capture_gaps": Array(CAPTURE_GAP.extend({}, omit=("delegation_id",)))}),
        "key_bindings": Optional(Array(KEY_BINDING)),
    }
)
SIGNED_RECEIPT = Obj({"payload": RECEIPT_PAYLOAD, "signature": SIGNATURE, "operator_signatures": Optional(Array(OPERATOR_SIGNATURE))})

# ---------- Private closure snapshot ----------

CLOSURE_DELEGATION = Obj(
    {
        "delegation_id": Str(),
        "parent_delegation_id": Nullable(Str()),
        "depth": POSITIVE,
        "provider_id": Nullable(Str()),
        "provider_name_stated": Nullable(Str()),
        "provider_own_id": Nullable(Str()),
        "external_ref": Nullable(Str()),
        "provider_job_ref": Nullable(Str()),
        "scope_ref": Nullable(Str()),
        "currency": CURRENCY,
        "quoted_max_minor": Nullable(MINOR),
        "quote_basis": Nullable(Str()),
        "quote_valid_until": Nullable(ISO),
        "accepted_amount_minor": Nullable(MINOR),
        "terms_digest": Nullable(DIGEST),
        "expected_delivery": Nullable(ISO),
        "downstream_visibility": DOWNSTREAM_VISIBILITY,
        "delivery_status": Str(),
        "retrospective": Bool(),
        "created_at": ISO,
        "execution": Optional(EXECUTION_DESCRIPTOR),
        "pricing": Optional(PRICING),
        "refund_terms": Optional(REFUND_TERMS),
        "witness_policy": Optional(WITNESS_POLICY),
    }
)
USAGE_CHECK = Obj(
    {
        "delegation_id": Str(),
        "currency": CURRENCY,
        "expected_minor": Nullable(MINOR),
        "lines": Array(
            Obj(
                {
                    "meter": Enum(USAGE_METERS),
                    "model": Optional(Obj({"provider": Str(), "name": Str()})),
                    "tool_name": Optional(Str()),
                    "units": MINOR,
                    "cost_minor": MINOR,
                }
            )
        ),
        "billed_minor": MINOR,
        "difference_minor": Nullable(MINOR),
        "allowed_difference_minor": Nullable(MINOR),
        "within_tolerance": Nullable(Bool()),
        "unpriced": Array(Str()),
        "trace_digests": Array(DIGEST),
        "assurance": ASSURANCE,
    }
)
RAIL_ATTESTATION_ENTRY = Obj(
    {"financial_event_id": Str(), "scheme": Str(), "rail": Str(), "rail_ref": Str(), "anchor": Str(), "assurance": Tuple([Literal("rail_attested")])}
)
EXPECTATION_VARIANCE = Obj(
    {
        "estimated_minor": Nullable(MINOR),
        "held_minor": MINOR,
        "actual_minor": MINOR,
        "variance_vs_estimate_minor": Nullable(MINOR),
        "variance_vs_estimate_bps": Nullable(Int()),
        "variance_vs_hold_minor": Nullable(MINOR),
        "variance_vs_hold_bps": Nullable(Int()),
    }
)
EXPECTATION_REPORT = Obj(
    {
        "currency": CURRENCY,
        "task": EXPECTATION_VARIANCE.extend({"unestimated_minor": MINOR}),
        "nodes": Array(EXPECTATION_VARIANCE.extend({"node_id": Str(), "estimate_event_id": Nullable(Str())})),
        "records": Array(
            Obj(
                {
                    "financial_event_id": Str(),
                    "node_id": Str(),
                    "type": Enum(("estimate", "hold")),
                    "issued_by": Enum(EXPECTATION_ISSUERS),
                    "status": Enum(("current", "not_latest", "superseded", "after_charge", "other_currency")),
                    "hold_status": Nullable(Enum(HOLD_STATUSES)),
                    "assurance": ASSURANCE,
                }
            )
        ),
    }
)
ALLOCATION_RECORD = Obj(
    {
        "allocation_id": Str(),
        "financial_event_id": Str(),
        "version": POSITIVE,
        "source_event_digest": DIGEST,
        "source_amount_minor": MINOR,
        "currency": CURRENCY,
        "lines": Array(
            Obj(
                {
                    "target": Obj({"type": Enum(("task", "delegation", "cost_center", "unallocated")), "id": Nullable(Str())}),
                    "amount_minor": NONNEGATIVE_MINOR,
                }
            )
        ),
        "rounding": Obj(
            {
                "method": Enum(("largest_remainder", "none")),
                "remainder_units": Array(Obj({"line_index": NONNEGATIVE, "units": POSITIVE})),
            }
        ),
        "rule": Nullable(Obj({"rule_id": Str(), "version": POSITIVE})),
        "reason": Str(),
        "after_close": Bool(),
        "created_by": Str(),
        "created_at": ISO,
    }
)
EXCEPTION_RECORD = Obj(
    {
        "exception_id": Str(),
        "kind": Str(),
        "status": Enum(("open", "resolved", "dismissed")),
        "delegation_id": Nullable(Str()),
        "financial_event_id": Nullable(Str()),
        "detail": Str(),
        "created_at": ISO,
    }
)
RESOLVED_EXCEPTION = EXCEPTION_RECORD.extend({"resolved_by": Str(), "resolved_at": ISO, "resolution": Nullable(Str())})
ROLLUP = Obj(
    {
        "root_task_id": Str(),
        "nodes": Array(
            Obj(
                {
                    "node_id": Str(),
                    "parent_id": Nullable(Str()),
                    "direct": CURRENCY_TOTALS,
                    "descendant": CURRENCY_TOTALS,
                    "total": CURRENCY_TOTALS,
                    "event_ids": Array(Str()),
                }
            )
        ),
        "root_total": CURRENCY_TOTALS,
        "excluded_event_ids": Obj({"reversed": Array(Str()), "reversals": Array(Str()), "fx_rates": Array(Str())}),
    }
)
DISCLOSURE = Obj({key: Array(Str()) for key in ("missing", "unverified", "contested", "provider_reported", "retrospective")})
OBLIGATION_LINK = Obj({"delegation_id": Str(), "obligation_id": Str(), "decision_id": Nullable(Str()), "decision_digest": Nullable(DIGEST)})
CLOSURE_PAYLOAD = Obj(
    {
        "document_type": Literal(CLOSURE_DOCUMENT_TYPE),
        "schema_version": Enum(SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS),
        "closure_id": Str(),
        "version": POSITIVE,
        "previous_closure_id": Nullable(Str()),
        "previous_closure_digest": Nullable(DIGEST),
        "generated_at": ISO,
        "issuer": ISSUER,
        "task": Obj(
            {
                "task_id": Str(),
                "external_ref": Str(),
                "currency": CURRENCY,
                "budget_minor": Nullable(MINOR),
                "customer_ref": Nullable(Str()),
                "project_ref": Nullable(Str()),
                "cost_center": Nullable(Str()),
                "scope_ref": Nullable(Str()),
                "retrospective": Bool(),
                "created_at": ISO,
                "estimate_tolerance_bps": Optional(NONNEGATIVE),
            }
        ),
        "delegations": Array(CLOSURE_DELEGATION),
        "delivery_claims": Array(DELIVERY_CLAIM),
        "financial_events": Array(Obj({"record": FINANCIAL_EVENT_RECORD, "event_digest": DIGEST, "attributed_to": Str()})),
        "allocations": Array(ALLOCATION_RECORD),
        "rollup": ROLLUP,
        "open_exceptions": Array(EXCEPTION_RECORD),
        "resolved_exceptions": Optional(Array(RESOLVED_EXCEPTION)),
        "receipts": Array(Obj({"receipt_id": Str(), "delegation_id": Str(), "revision": POSITIVE, "digest": DIGEST})),
        "responses": Array(RESPONSE_RECORD),
        "key_bindings": Array(KEY_BINDING),
        "lineage": Obj({"complete": Bool(), "capture_gaps": Array(CAPTURE_GAP), "unknown_downstream": Array(Str())}),
        "disclosure": DISCLOSURE,
        "obligation_links": Optional(Array(OBLIGATION_LINK)),
        "usage_checks": Optional(Array(USAGE_CHECK)),
        "expectation_report": Optional(EXPECTATION_REPORT),
        "rail_attestations": Optional(Array(RAIL_ATTESTATION_ENTRY)),
    }
)
SIGNED_CLOSURE = Obj({"payload": CLOSURE_PAYLOAD, "signature": SIGNATURE, "operator_signatures": Optional(Array(OPERATOR_SIGNATURE))})

# ---------- Agent trace files ----------

AGENT_TRACE = Obj(
    {
        "trace_version": Literal("1.0"),
        "execution": EXECUTION_BINDING,
        "steps": Array(
            Obj(
                {
                    "seq": TRACE_COUNT,
                    "kind": Enum(TRACE_STEP_KINDS),
                    "started_at": ISO_DATETIME,
                    "ended_at": ISO_DATETIME,
                    "model": Optional(Obj({"provider": Str(1, 100), "name": Str(1, 200)}, strict=True)),
                    "tool": Optional(Obj({"name": Str(1, 200)}, strict=True)),
                    "remote": Optional(Obj({"agent_id": Optional(Str(1, 200)), "task_id": Str(1, 200)}, strict=True)),
                    "usage": Optional(Obj({"input_tokens": TRACE_COUNT, "output_tokens": TRACE_COUNT, "cache_read_input_tokens": Optional(TRACE_COUNT)}, strict=True)),
                    "upstream_ref": Optional(Str(1, 200)),
                    "io_digest": Optional(DIGEST),
                },
                strict=True,
            ),
            1,
            10000,
        ),
    },
    strict=True,
)
