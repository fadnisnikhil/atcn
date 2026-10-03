"""Minimal ATCN API client using only the standard library for HTTP."""

import json
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .crypto import Signed

# Must equal the version in pyproject.toml (checked by a test).
SDK_VERSION = "1.3.0"
# Names the SDK and its version on every request, so the API operator can count SDK versions in use. Nothing else is sent.
SDK_HEADER = "atcn-sdk"


class AtcnApiError(Exception):
    def __init__(self, status: int, code: str, message: str, reason: str | None, retryable: bool, correlation_id: str | None):
        super().__init__(f"{code}{f' ({reason})' if reason else ''}: {message}")
        self.status = status
        self.code = code
        self.reason = reason
        self.retryable = retryable
        self.correlation_id = correlation_id


class AtcnClient:
    """Every mutating call carries an Idempotency-Key; signed events use event:<event_id>.

    With share_token, requests authenticate as a receipt-link holder (x-atcn-share-token) instead of with an API key.
    default_headers are sent on every request.
    """

    def __init__(self, base_url: str, api_key: str, retries: int = 2, timeout: float = 30.0, share_token: str | None = None, default_headers: dict[str, str] | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.retries = retries
        self.timeout = timeout
        self.share_token = share_token
        self.default_headers = default_headers or {}

    def request(self, method: str, path: str, body: Any = None, idempotency_key: str | None = None, query: dict[str, Any] | None = None, raw: bytes | None = None, headers: dict[str, str] | None = None, content_type: str = "application/octet-stream") -> Any:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        auth_header = {"x-atcn-share-token": self.share_token} if self.share_token else {"authorization": f"Bearer {self.api_key}"}
        all_headers = {SDK_HEADER: f"python/{SDK_VERSION}", **auth_header, **self.default_headers, **(headers or {})}
        data: bytes | None = None
        if method != "GET":
            all_headers["idempotency-key"] = idempotency_key or str(uuid.uuid4())
        if raw is not None:
            all_headers["content-type"] = content_type
            data = raw
        elif body is not None:
            all_headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        attempt = 0
        while True:
            attempt += 1
            request = urllib.request.Request(url, data=data, method=method, headers=all_headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    text = response.read().decode("utf-8")
                    return json.loads(text) if text and "json" in response.headers.get("content-type", "") else text
            except urllib.error.HTTPError as http_error:
                text = http_error.read().decode("utf-8")
                parsed = json.loads(text) if text.startswith("{") else {}
                err = parsed.get("error", {})
                api_error = AtcnApiError(http_error.code, err.get("code", "http_error"), err.get("message", text), err.get("reason"), bool(err.get("retryable")), parsed.get("correlation_id"))
                if api_error.retryable and attempt <= self.retries:
                    time.sleep(0.1 * 2**attempt)
                    continue
                raise api_error from None

    # Obligations
    def create_obligation(self, signed: Signed, subledger: dict[str, Any] | None = None) -> Any:
        """With subledger={"task_id": ..., "parent_delegation_id": ...}, the obligation also becomes a delegation of that task.

        The link is not part of the signed event and is never shared with the counterparty.
        """
        body = {**signed, "subledger": subledger} if subledger else signed
        return self.request("POST", "/v1/obligations", body, f"event:{signed['payload']['event_id']}")

    def accept_obligation(self, obligation_id: str, signed: Signed) -> Any:
        return self.request("POST", f"/v1/obligations/{obligation_id}/accept", signed, f"event:{signed['payload']['event_id']}")

    def append_event(self, obligation_id: str, signed: Signed) -> Any:
        return self.request("POST", f"/v1/obligations/{obligation_id}/events", signed, f"event:{signed['payload']['event_id']}")

    def get_obligation(self, obligation_id: str) -> Any:
        return self.request("GET", f"/v1/obligations/{obligation_id}")

    def list_events(self, obligation_id: str) -> Any:
        return self.request("GET", f"/v1/obligations/{obligation_id}/events")

    # Evidence and clearing
    def upload_blob(self, content: bytes, media_type: str = "application/octet-stream") -> Any:
        return self.request("POST", "/v1/blobs", raw=content, headers={"x-media-type": media_type})

    def submit_evidence(self, obligation_id: str, signed: Signed) -> Any:
        return self.request("POST", f"/v1/obligations/{obligation_id}/evidence", signed, f"event:{signed['payload']['event_id']}")

    def evaluate(self, obligation_id: str, policy_id: str, policy_version: str, idempotency_key: str | None = None) -> Any:
        return self.request("POST", f"/v1/obligations/{obligation_id}/evaluate", {"policy_id": policy_id, "policy_version": policy_version}, idempotency_key)

    def finalize(self, decision_id: str, idempotency_key: str | None = None) -> Any:
        return self.request("POST", f"/v1/decisions/{decision_id}/finalize", None, idempotency_key)

    # Journal, settlement, export
    def journal(self, **filters: Any) -> Any:
        return self.request("GET", "/v1/journal", query=filters)

    def report_settlement_event(self, event: dict[str, Any], idempotency_key: str | None = None) -> Any:
        return self.request("POST", "/v1/settlements/events", event, idempotency_key)

    def export_closure_package(self, obligation_id: str) -> Any:
        return self.request("GET", f"/v1/exports/{obligation_id}")

    def service_keys(self) -> Any:
        return self.request("GET", "/v1/service/keys")
