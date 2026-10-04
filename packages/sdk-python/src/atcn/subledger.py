"""Agent Work Subledger (PRD v1.2) client, receipt-link client, capture queue, and signing helpers.

Mirrors the TypeScript SDK (@atcn/sdk): same idempotency keys, same canonical statements, same signatures.
"""

import json
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from typing import Any

from .canonical import canonicalize
from .client import AtcnApiError, AtcnClient
from .crypto import digest_of, sha256_digest, sign_bytes, verify_bytes

Json = dict[str, Any]

RESPONSE_STATEMENT_TYPE = "atcn.subledger.receipt_response"
EXPECTATION_STATEMENT_TYPE = "atcn.subledger.expectation"
OUTCOME_STATEMENT_TYPE = "atcn.subledger.outcome"
SIGNED_CLAIM_TYPES = ("completion", "partial_completion", "cancellation", "provider_failure")


def ext(external_ref: str) -> str:
    """Caller-supplied references address records before their server IDs are known: ext("job-42")."""
    return f"ext:{external_ref}"


def stable_key(kind: str, *parts: str) -> str:
    """Idempotency key derived from the caller's stable references; long references are hashed to fit 8-200 chars."""
    key = f"sl:{kind}:{':'.join(parts)}"
    return key if len(key) <= 200 else f"sl:{kind}:{sha256_digest(':'.join(parts))}"


def _path(ref: str) -> str:
    return urllib.parse.quote(ref, safe="")


# ---------- Statements and signatures ----------


def build_response_statement(
    receipt: Json,
    response_type: str,
    fields: list[str] | None = None,
    note: str | None = None,
    evidence: list[Json] | None = None,
    corrections: list[Json] | None = None,
    execution: Json | None = None,
    issued_at: str | None = None,
    expires_at: str | None = None,
    refs: list[Json] | None = None,
    role: str | None = None,
) -> Json:
    """The statement a provider responds with. receipt needs receipt_id, digest, revision, and issuer_operator_id.

    execution, issued_at, expires_at, and refs (schema 1.4) and role (schema 1.5, "witness" when an independent
    witness signs that it observed the run) are left out when None, so older statements keep their bytes.
    """
    statement: Json = {
        "document_type": RESPONSE_STATEMENT_TYPE,
        "receipt_id": receipt["receipt_id"],
        "receipt_digest": receipt["digest"],
        "receipt_revision": receipt["revision"],
        "issuer_operator_id": receipt["issuer_operator_id"],
        "response_type": response_type,
        "fields": sorted(set(fields or [])),
        "note": note,
        "evidence": evidence or [],
        "corrections": corrections or [],
    }
    optional = {"execution": execution, "issued_at": issued_at, "expires_at": expires_at, "refs": refs, "role": role}
    statement.update({key: value for key, value in optional.items() if value is not None})
    return statement


def execution_binding(descriptor: Json) -> Json:
    """Names one run: its execution_id and the digest of the full run descriptor recorded on the delegation."""
    return {"execution_id": descriptor["execution_id"], "execution_digest": digest_of(descriptor)}


def sign_statement(statement: Json, private_key: str) -> str:
    """Provider-side signing. The service never sees the private key."""
    return sign_bytes(canonicalize(statement).encode("utf-8"), private_key)


def verify_statement_signature(statement: Json, signature: str, public_key: str) -> bool:
    return verify_bytes(canonicalize(statement).encode("utf-8"), signature, public_key)


def _iso_millis(value: str) -> str:
    """The same normalisation as JavaScript's Date.toISOString(): UTC, milliseconds, trailing Z."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S.") + f"{parsed.microsecond // 1000:03d}Z"


def build_expectation_statement(
    type: str,
    source: str,
    source_event_id: str,
    amount_minor: int,
    currency: str,
    issued_at: str,
    expectation: Json,
    provider_reference: str | None = None,
) -> Json:
    """What an agent or budget gateway signs for an estimate or hold (schema 1.5). Recorded only, never enforced.

    expectation has issued_by ("agent", "gateway" or "operator"), source_ref, basis, expires_at, supersedes and, for
    holds, hold_status. issued_at is the record's event_date.
    """
    expires_at = expectation.get("expires_at")
    return {
        "document_type": EXPECTATION_STATEMENT_TYPE,
        "type": type,
        "source": source,
        "source_event_id": source_event_id,
        "provider_reference": provider_reference,
        "amount_minor": amount_minor,
        "currency": currency,
        "issued_at": _iso_millis(issued_at),
        "issued_by": expectation["issued_by"],
        "source_ref": expectation.get("source_ref"),
        "basis": expectation.get("basis"),
        "expires_at": None if expires_at is None else _iso_millis(expires_at),
        "supersedes": expectation.get("supersedes"),
        "hold_status": expectation.get("hold_status"),
    }


def sign_expectation(statement: Json, private_key: str) -> str:
    """Agent- or gateway-side signing. The operator never holds the signer's private key."""
    return sign_bytes(canonicalize(statement).encode("utf-8"), private_key)


def verify_expectation_signature(statement: Json, signature: str, public_key: str) -> bool:
    return verify_bytes(canonicalize(statement).encode("utf-8"), signature, public_key)


def build_outcome_statement(type: str, provider_job_ref: str, occurred_at: str, note: str | None = None, evidence: list[Json] | None = None) -> Json:
    """What a provider signs about how its work ended (schema 1.5). type is one of SIGNED_CLAIM_TYPES;
    provider_job_ref is the delegation's job reference (for A2A, the task id); evidence lists {uri, digest, evidence_type}."""
    if type not in SIGNED_CLAIM_TYPES:
        raise ValueError(f"type must be one of {', '.join(SIGNED_CLAIM_TYPES)}, not {type}")
    return {
        "document_type": OUTCOME_STATEMENT_TYPE,
        "type": type,
        "provider_job_ref": provider_job_ref,
        "occurred_at": _iso_millis(occurred_at),
        "note": note,
        "evidence": evidence or [],
    }


def sign_outcome_statement(statement: Json, private_key: str) -> str:
    """Provider-side signing. The operator never holds the provider's private key."""
    return sign_bytes(canonicalize(statement).encode("utf-8"), private_key)


def verify_outcome_signature(statement: Json, signature: str, public_key: str) -> bool:
    return verify_bytes(canonicalize(statement).encode("utf-8"), signature, public_key)


def countersign_payload(payload: Any, private_key: str) -> str:
    """Operator-side countersignature over a closure or receipt payload, made with a key the operator holds."""
    return sign_bytes(canonicalize(payload).encode("utf-8"), private_key)


def verify_countersignature(payload: Any, signature: str, public_key: str) -> bool:
    return verify_bytes(canonicalize(payload).encode("utf-8"), signature, public_key)


# ---------- Operator client ----------


class SubledgerClient:
    """Small, independent subledger operations. Default idempotency keys derive from the caller's stable references."""

    def __init__(self, base_url: str, api_key: str, retries: int = 2, timeout: float = 30.0, default_headers: dict[str, str] | None = None):
        self.http = AtcnClient(base_url, api_key, retries=retries, timeout=timeout, default_headers=default_headers)

    # Tasks, delegations, delivery claims
    def create_task(self, task: Json, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", "/v1/tasks", task, idempotency_key or stable_key("task", task["external_ref"]))

    def get_task(self, task_id: str) -> Json:
        return self.http.request("GET", f"/v1/tasks/{_path(task_id)}")

    def list_tasks(self, status: str | None = None, external_ref: str | None = None) -> Json:
        return self.http.request("GET", "/v1/tasks", query={"status": status, "external_ref": external_ref})

    def get_task_access(self, task_id: str) -> Json:
        """Admin only. Principals are "user:<id>" or "api_key:<id>"."""
        return self.http.request("GET", f"/v1/tasks/{_path(task_id)}/access")

    def update_task_access(self, task_id: str, restricted: bool | None = None, grant: list[str] | None = None, revoke: list[str] | None = None, idempotency_key: str | None = None) -> Json:
        body: Json = {"grant": grant or [], "revoke": revoke or []}
        if restricted is not None:
            body["restricted"] = restricted
        return self.http.request("POST", f"/v1/tasks/{_path(task_id)}/access", body, idempotency_key)

    def create_delegation(self, task_id: str, delegation: Json, idempotency_key: str | None = None) -> Json:
        key = idempotency_key or (stable_key("delegation", delegation["external_ref"]) if delegation.get("external_ref") else None)
        return self.http.request("POST", f"/v1/tasks/{_path(task_id)}/delegations", delegation, key)

    def assign_provider(self, delegation_id: str, provider_id: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/delegations/{_path(delegation_id)}/provider", {"provider_id": provider_id}, idempotency_key)

    def append_delegation_event(self, delegation_id: str, event: Json, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/delegations/{_path(delegation_id)}/events", event, idempotency_key)

    def report_capture_gap(self, task_id: str, kind: str, detail: str, delegation_id: str | None = None, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/tasks/{_path(task_id)}/capture-gaps", {"kind": kind, "detail": detail, "delegation_id": delegation_id}, idempotency_key)

    # Financial events, matching, allocation
    def record_financial_event(self, event: Json, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", "/v1/financial-events", event, idempotency_key or stable_key("financial", event["source"], event["source_event_id"]))

    def record_rail_attestation(self, attestation: Json, source: str, match: dict[str, str] | None = None, event_date: str | None = None, idempotency_key: str | None = None) -> Json:
        """Records a payment rail's own record (A2A-SE escrow record or x402 payment) after the service verifies it offline."""
        body: Json = {"attestation": attestation, "source": source}
        if match is not None:
            body["match"] = match
        if event_date is not None:
            body["event_date"] = event_date
        return self.http.request("POST", "/v1/financial-events/rail-attestations", body, idempotency_key)

    def import_csv(
        self,
        csv_text: str,
        idempotency_key: str | None = None,
        kind: str | None = None,
        source: str | None = None,
        key_columns: list[str] | None = None,
        currency: str | None = None,
        issued_by: str | None = None,
        column_map: dict[str, str] | None = None,
        minor_digits: int | None = None,
    ) -> Json:
        """Without options, the CSV uses the import template. With them, it is a gateway's or provider's own export:
        key_columns identify a row, column_map names the export's column for an import field (for example
        {"amount_major": "Total"}), and minor_digits is the decimal places of amount_major (default 2)."""
        query = {
            "kind": kind,
            "source": source,
            "key_columns": None if key_columns is None else ",".join(key_columns),
            "currency": currency,
            "issued_by": issued_by,
            "map": None if column_map is None else json.dumps(column_map),
            "minor_digits": None if minor_digits is None else str(minor_digits),
        }
        return self.http.request("POST", "/v1/financial-events/import", idempotency_key=idempotency_key, query=query, raw=csv_text.encode("utf-8"), content_type="text/csv")

    def list_financial_events(self, unattributed: bool | None = None, source: str | None = None) -> Json:
        return self.http.request("GET", "/v1/financial-events", query={"unattributed": None if unattributed is None else str(unattributed).lower(), "source": source})

    def allocate(self, financial_event_id: str, allocation: Json, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/financial-events/{financial_event_id}/allocations", allocation, idempotency_key)

    def create_allocation_rule(self, rule: Json, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", "/v1/allocation-rules", rule, idempotency_key)

    def list_matches(self, status: str | None = None) -> Json:
        return self.http.request("GET", "/v1/matches", query={"status": status})

    def confirm_match(self, match_id: str, task_id: str, delegation_id: str | None = None, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/matches/{match_id}/confirm", {"task_id": task_id, "delegation_id": delegation_id}, idempotency_key)

    def financial_summary(self, task_id: str, report_currency: str | None = None, as_of: str | None = None) -> Json:
        return self.http.request("GET", f"/v1/tasks/{_path(task_id)}/financial-summary", query={"report_currency": report_currency, "as_of": as_of})

    def list_exceptions(self, task_id: str | None = None, status: str | None = None) -> Json:
        return self.http.request("GET", "/v1/subledger-exceptions", query={"task_id": task_id, "status": status})

    def resolve_exception(self, exception_id: str, status: str, resolution: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/subledger-exceptions/{exception_id}/resolve", {"status": status, "resolution": resolution}, idempotency_key)

    # Closures and receipts
    def close_task(self, task_id: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/tasks/{_path(task_id)}/close", {}, idempotency_key)

    def get_closure(self, task_id: str, version: int | None = None) -> Json:
        return self.http.request("GET", f"/v1/tasks/{_path(task_id)}/closure", query={"version": version})

    def create_receipt(self, task_id: str, delegation_id: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/tasks/{_path(task_id)}/receipts", {"delegation_id": delegation_id}, idempotency_key)

    def get_receipt(self, receipt_id: str) -> Json:
        return self.http.request("GET", f"/v1/receipts/{receipt_id}")

    def mark_receipt_delivered(self, receipt_id: str, channel: str, reference: str | None = None, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/receipts/{receipt_id}/delivered", {"channel": channel, "reference": reference}, idempotency_key)

    def create_receipt_share(self, receipt_id: str, allowed_actions: list[str] | None = None, ttl_hours: int | None = None, idempotency_key: str | None = None) -> Json:
        body: Json = {"receipt_id": receipt_id, "allowed_actions": allowed_actions or ["view"]}
        if ttl_hours is not None:
            body["ttl_hours"] = ttl_hours
        return self.http.request("POST", "/v1/receipt-shares", body, idempotency_key)

    def create_witness_share(self, receipt_id: str, witness_provider_id: str, ttl_hours: int | None = None, idempotency_key: str | None = None) -> Json:
        """A witness link: lets another provider (not the delegation's own) sign that it observed the run. It allows only viewing and witnessing."""
        body: Json = {"receipt_id": receipt_id, "allowed_actions": ["view", "witness_attestation"], "witness_provider_id": witness_provider_id}
        if ttl_hours is not None:
            body["ttl_hours"] = ttl_hours
        return self.http.request("POST", "/v1/receipt-shares", body, idempotency_key)

    def revoke_receipt_share(self, share_id: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("DELETE", f"/v1/receipt-shares/{share_id}", None, idempotency_key)

    def list_responses(self, receipt_id: str) -> Json:
        return self.http.request("GET", f"/v1/receipts/{receipt_id}/responses")

    def decide_correction(self, response_id: str, status: str, reason: str, financial_events: list[Json] | None = None, idempotency_key: str | None = None) -> Json:
        """Accepting appends the corrected records. A correction of financial fields needs the corrected events."""
        body = {"status": status, "reason": reason, "financial_events": financial_events or []}
        return self.http.request("POST", f"/v1/receipt-responses/{response_id}/decision", body, idempotency_key)

    # Provider identity
    def create_provider(self, provider: Json, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", "/v1/provider-identities", provider, idempotency_key or stable_key("provider", provider["name"]))

    def bind_provider_key(self, provider_id: str, key_id: str, public_key: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/provider-identities/{provider_id}/key-bindings", {"key_id": key_id, "public_key": public_key}, idempotency_key)

    def start_domain_challenge(self, provider_id: str, key_id: str, public_key: str, domain: str | None = None, idempotency_key: str | None = None) -> Json:
        """Admin only. The provider publishes the returned txt_value at txt_name; then call verify_domain_challenge."""
        body: Json = {"key_id": key_id, "public_key": public_key}
        if domain is not None:
            body["domain"] = domain
        return self.http.request("POST", f"/v1/provider-identities/{provider_id}/domain-challenges", body, idempotency_key)

    def verify_domain_challenge(self, challenge_id: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/domain-challenges/{challenge_id}/verify", {}, idempotency_key)

    # Operator-held signing keys
    def register_operator_key(self, key_id: str, public_key: str, idempotency_key: str | None = None) -> Json:
        """Admin only. Registers the public half of a key the operator holds; the private key stays with the operator."""
        return self.http.request("POST", "/v1/operator-keys", {"key_id": key_id, "public_key": public_key}, idempotency_key)

    def revoke_operator_key(self, key_id: str, reason: str, idempotency_key: str | None = None) -> Json:
        return self.http.request("POST", f"/v1/operator-keys/{_path(key_id)}/revoke", {"reason": reason}, idempotency_key)

    def operator_keys(self, operator_id: str) -> Json:
        return self.http.request("GET", f"/v1/operators/{operator_id}/keys")

    def countersign(self, signed: Json, key_id: str, private_key: str, idempotency_key: str | None = None) -> Json:
        """Signs a closure or receipt payload locally with the operator's private key and records the countersignature."""
        payload = signed["payload"]
        path = f"closures/{payload['closure_id']}" if "closure_id" in payload else f"receipts/{payload['receipt_id']}"
        return self.http.request("POST", f"/v1/{path}/countersign", {"key_id": key_id, "signature": countersign_payload(payload, private_key)}, idempotency_key)

    # Metrics and keys
    def product_metrics(self) -> Json:
        return self.http.request("GET", "/v1/metrics/product")

    def service_keys(self) -> Json:
        return self.http.request("GET", "/v1/service/keys")


# ---------- Provider-side client ----------


class ReceiptLinkClient:
    """Provider-side access through a receipt link: no account, no API key, only the link's scope."""

    def __init__(self, base_url: str, share_token: str, retries: int = 2, timeout: float = 30.0):
        self.http = AtcnClient(base_url, "", retries=retries, timeout=timeout, share_token=share_token)

    def current(self) -> Json:
        return self.http.request("GET", "/v1/receipt-shares/current")

    def verification(self, receipt_id: str) -> Json:
        return self.http.request("GET", f"/v1/receipts/{receipt_id}/verification")

    def respond(
        self,
        receipt: Json,
        response_type: str,
        fields: list[str] | None = None,
        note: str | None = None,
        evidence: list[Json] | None = None,
        corrections: list[Json] | None = None,
        signing: Json | None = None,
        idempotency_key: str | None = None,
        execution: Json | None = None,
        issued_at: str | None = None,
        expires_at: str | None = None,
        refs: list[Json] | None = None,
        role: str | None = None,
    ) -> Json:
        """receipt needs receipt_id, digest, and revision. signing needs binding_id, key_id, private_key, issuer_operator_id.
        role="witness" sends a witness statement (schema 1.5) through a witness link."""
        provider_signature = None
        if signing:
            statement = build_response_statement(
                {**receipt, "issuer_operator_id": signing["issuer_operator_id"]},
                response_type,
                fields,
                note,
                evidence,
                corrections,
                execution=execution,
                issued_at=issued_at,
                expires_at=expires_at,
                refs=refs,
                role=role,
            )
            provider_signature = {"binding_id": signing["binding_id"], "key_id": signing["key_id"], "value": sign_statement(statement, signing["private_key"])}
        body = {
            "receipt_digest": receipt["digest"],
            "receipt_revision": receipt["revision"],
            "response_type": response_type,
            "fields": fields or [],
            "note": note,
            "evidence": evidence or [],
            "corrections": corrections or [],
            "provider_signature": provider_signature,
        }
        optional = {"execution": execution, "issued_at": issued_at, "expires_at": expires_at, "refs": refs, "role": role}
        body.update({key: value for key, value in optional.items() if value is not None})
        return self.http.request("POST", f"/v1/receipts/{receipt['receipt_id']}/responses", body, idempotency_key)


# ---------- Capture queue ----------


class CaptureQueue:
    """Bounded local capture queue. enqueue() and flush() never raise, so a capture outage never stops the work.

    Each operation keeps one idempotency key for its lifetime, so replays and retries create exactly one record.
    Overflow policy: reject the newest operation and count it in `dropped`; older operations keep their order,
    because later events (completions, charges) depend on earlier ones (tasks, delegations).
    """

    def __init__(self, client: SubledgerClient, max_size: int = 1000, max_attempts: int = 5):
        self.client = client
        self.max_size = max_size
        self.max_attempts = max_attempts
        self._pending: list[Json] = []
        self._failed: list[Json] = []
        self._dropped = 0
        self._sequence = 0

    @property
    def dropped(self) -> int:
        return self._dropped

    @property
    def size(self) -> int:
        return len(self._pending)

    def enqueue(self, path: str, body: Any, idempotency_key: str | None = None) -> bool:
        """Queues one mutation. Returns False (and counts a drop) when the queue is full; never raises."""
        if len(self._pending) >= self.max_size:
            self._dropped += 1
            return False
        self._sequence += 1
        self._pending.append(
            {
                "id": f"op_{int(time.time() * 1000)}_{self._sequence}",
                "method": "POST",
                "path": path,
                "body": body,
                "idempotencyKey": idempotency_key or stable_key("capture", str(uuid.uuid4())),
                "enqueued_at": datetime.now(timezone.utc).isoformat(),
                "attempts": 0,
                "last_error": None,
            }
        )
        return True

    def task(self, task: Json) -> bool:
        return self.enqueue("/v1/tasks", task, stable_key("task", task["external_ref"]))

    def delegation(self, task_ref: str, delegation: Json) -> bool:
        key = stable_key("delegation", delegation["external_ref"]) if delegation.get("external_ref") else None
        return self.enqueue(f"/v1/tasks/{_path(task_ref)}/delegations", delegation, key)

    def delegation_event(self, delegation_ref: str, event: Json, idempotency_key: str | None = None) -> bool:
        return self.enqueue(f"/v1/delegations/{_path(delegation_ref)}/events", event, idempotency_key)

    def financial_event(self, event: Json) -> bool:
        return self.enqueue("/v1/financial-events", event, stable_key("financial", event["source"], event["source_event_id"]))

    def flush(self) -> Json:
        """Sends queued operations in order. A retryable failure (network, 5xx, 429) stops the flush and keeps the
        operation; a non-retryable rejection moves it to the failed list. Never raises."""
        sent = 0
        failed = 0
        while self._pending:
            op = self._pending[0]
            op["attempts"] += 1
            try:
                self.client.http.request(op["method"], op["path"], op["body"], op["idempotencyKey"])
                self._pending.pop(0)
                sent += 1
            except Exception as error:  # noqa: BLE001 - a capture failure must never stop the caller's work
                op["last_error"] = str(error)
                retryable = not isinstance(error, AtcnApiError) or error.retryable
                if retryable and op["attempts"] < self.max_attempts:
                    break
                self._failed.append(self._pending.pop(0))
                failed += 1
        return {"sent": sent, "failed": failed, "remaining": len(self._pending)}

    def failed_operations(self) -> list[Json]:
        return list(self._failed)

    def export_failed(self) -> str:
        """Failed operations as JSON lines (same format as the TypeScript SDK), for replay after the cause is fixed."""
        return "\n".join(json.dumps(op) for op in self._failed)

    def replay(self, json_lines: str) -> int:
        """Puts exported operations back in the queue with their original idempotency keys."""
        replayed: set[str] = set()
        for line in json_lines.splitlines():
            if not line.strip():
                continue
            op = json.loads(line)
            if self.enqueue(op["path"], op["body"], op["idempotencyKey"]):
                replayed.add(op["idempotencyKey"])
        self._failed = [op for op in self._failed if op["idempotencyKey"] not in replayed]
        return len(replayed)

    def report_gaps(self, task_ref: str) -> bool:
        """Reports drops and permanent failures for a task as capture gaps (marks its lineage incomplete). Never raises."""
        if self._dropped == 0 and not self._failed:
            return True
        detail = f"{self._dropped} capture operation(s) dropped by queue overflow; {len(self._failed)} failed permanently"
        try:
            self.client.report_capture_gap(task_ref, "queue_overflow" if self._dropped > 0 else "capture_failed", detail)
            return True
        except Exception:  # noqa: BLE001
            return False
