# atcn

The Python SDK for [ATCN](https://github.com/fadnisnikhil/atcn), a cost record for AI agent jobs that anyone can verify.

When an AI agent does a job, it often hands parts of it to other agents and pays for APIs along the way. ATCN keeps one record per job (what was handed out, what each provider says happened, what was charged, and what doesn't add up) and signs it as a **closure**: a JSON document anyone can check offline. ATCN only records: it never blocks, holds or releases money.

With this package you can:

- **verify signed ATCN documents offline:** task closures, provider receipts, closure packages and clearing verdicts, with the same checks and reports as the TypeScript verifier;
- **record jobs** through a hosted ATCN API (`SubledgerClient`, `CaptureQueue`); the hosted API is not open for signup yet;
- **sign** events, provider response statements and webhooks with Ed25519 over canonical JSON (RFC 8785);
- **connect A2A agents** with `atcn.a2a`: billing references, signed estimates and outcomes, and sub-task lineage.

```bash
pip install atcn
```

Requires Python 3.10 or later.

## Quick start: check a closure

You need a closure and the public keys that signed it. To make one on your machine with no account, run `npx @atcn/local-runner demo` (Node.js 20 or later); it prints the folder holding `task-closure.json` and `keys.json`.

```python
import json
from atcn import verify_subledger_document

closure = json.load(open("task-closure.json"))
trusted_keys = json.load(open("keys.json"))["items"]

report = verify_subledger_document(closure, trusted_keys)
print("VALID" if report["valid"] else [c for c in report["checks"] if not c["ok"]])
```

Each entry in `report["checks"]` names one check (signatures, totals, exceptions, estimates against actual cost, and more) with its result and details, so a failure says exactly what doesn't add up.

A valid signature shows who stated something and that it hasn't changed since. It doesn't prove the work or payment really happened; each claim carries a label saying who stands behind it.

## Signing

```python
from atcn import canonicalize, generate_key_pair, sign_payload, verify_payload

canonicalize({"b": 1, "a": 2})  # '{"a":2,"b":1}'
private_key, public_key = generate_key_pair()
signed = sign_payload({"hello": "world"}, "key_1", 1, private_key)
assert verify_payload(signed, public_key)
```

`EventSigner` signs obligation events, `verify_webhook` and `sign_webhook` handle webhook signatures, and `build_response_statement`, `sign_statement` and `verify_statement_signature` handle provider response statements. The package passes the same signing test vectors as the TypeScript SDK.

## API clients

`SubledgerClient` and `CaptureQueue` record tasks, delegations and charges, `AtcnClient` is for obligations, and `ReceiptLinkClient` is for providers. They need an ATCN API at `base_url`. The hosted API is not open for signup yet.

## Verifying closures and receipts

`verify_subledger_document` verifies a signed task closure or receipt offline, with no network calls. It runs the same checks as `npx @atcn/verify-cli` and the TypeScript SDK, and gives the same report: check names, results and details. The shared test vectors keep the two in step.

```python
import json
from atcn import verify_subledger_document

report = verify_subledger_document(
    json.load(open("closure.json")),
    trusted_keys,                       # GET /v1/service/keys
    operator_keys=operator_keys,        # GET /v1/operators/{operator_id}/keys, to check countersignatures
    traces=[open("trace.json", "rb").read()],
)
assert report["valid"], [c for c in report["checks"] if not c["ok"]]
```

You can also pass `previous` (the previous closure version or receipt revision), `require_operator_signature=True`, and `at` (the time to check a receipt's expiry against, which defaults to now).

To cross-check obligation-backed delegations, pass `obligation_packages`, a list of the obligations' closure packages, as `npx @atcn/verify-cli --obligation-package` does. Each package is verified, it must contain the linked decision, and its journal batches posted before the closure must produce exactly the clearing events the closure recorded (check `obligation_links`). Without `obligation_packages` the links are reported as not cross-checked. An empty list counts as supplied.

## Verifying closure packages

A closure package is the clearing network's signed record of an obligation: its events, keys, policies, evidence envelopes, verifier results, decisions, journal and settlement. `verify_closure_package` runs the same checks as `verifyClosurePackage` in `@atcn/core` and `npx @atcn/verify-cli package.json`, and gives the same report. It checks the signatures, event references and lineage, replays the clearing engine for every automated decision, and checks the journal, the settlement references and the trace evidence. For package `1.1` it also recomputes the attestation conflicts.

```python
import json
from atcn import verify_closure_package

report = verify_closure_package(
    json.load(open("obligation.json")),
    trusted_keys,                           # GET /v1/service/keys
    traces=[open("trace.json", "rb").read()],  # optional: the files behind agent_trace evidence
)
assert report["valid"], [c for c in report["checks"] if not c["ok"]]
```

A check whose `state` is `"not_inspected"` had nothing it could inspect, for example trace evidence whose files were not supplied. That is not a pass. A package version this SDK does not know sets `unsupported_schema_version`. The shared vectors (`packages/core/test-vectors/closure-packages.json`) keep the reports in step with TypeScript.

The Python verifier differs from TypeScript only on hostile input:

- **Ed25519.** Python verifies with strict RFC 8032 rules. TypeScript uses ZIP-215, which also accepts some non-canonical encodings, so a signature crafted for that gap verifies in TypeScript and fails here.
- **Skill `agent_card_url`.** It is checked by its scheme only, an approximation of zod's `z.url()`.
- **Tied candidates.** When the newest evidence or verifier result is picked from 64 or more candidates that tie on both sort keys, Python may pick a different one than V8.
- **`__proto__` keys.** A key named `"__proto__"` is kept as an ordinary key, where JavaScript drops it.

## Verifying clearing verdicts

A clearing verdict is an obligation's decision in effect, signed by the ATCN service for an escrow rail to read. It is record only: ATCN holds no funds and releases nothing. Fetch it with `AtcnClient.clearing_verdict(obligation_id, rail=..., escrow_ref=...)`, which returns the verdict and the closure package it was read from.

```python
from atcn import verify_clearing_verdict

response = client.clearing_verdict(obligation_id, rail="a2a-se", escrow_ref="esc-1")
report = verify_clearing_verdict(response["verdict"], trusted_keys, response["closure_package"])
assert report["valid"], report["checks"]
```

This checks the verdict's signature and verifies the whole package with `verify_closure_package`. The `closure_package` check lists each failed package check as `"<check>: <details>"`. It then checks that the package is the one the verdict names and that the verdict states the decision in effect. Without a package (`None`) the decision is reported as not inspected. TypeScript treats only an omitted package that way and verifies a JSON `null` as a package.

## A2A helpers

`atcn.a2a` mirrors `@atcn/adapter-a2a`, and its metadata shapes match the TypeScript ones. An agent calls `signed_outcome_metadata`, `lineage_metadata` and `downstream_metadata` to put a signed outcome, the chain of tasks above it, or its sub-tasks under `metadata.atcn`. The buyer calls `delegation_from_a2a`, `outcome_claim_from_a2a`, `child_delegation_from_a2a` and `broken_edge_gap` to turn them into subledger records. A signature counts only when the buyer has a key binding for the agent's key.

```python
from atcn.a2a import outcome_claim_from_a2a, outcome_from_metadata, signed_outcome_metadata

metadata = signed_outcome_metadata(
    {"type": "completion", "task_id": task["id"], "occurred_at": "2026-10-01T12:06:00Z", "note": None, "evidence": []},
    "agent-key-1",
    agent_private_key,
)
claim = outcome_claim_from_a2a(outcome_from_metadata(metadata), {"provider_id": "prv_1", "binding_id": "kb_1", "key_id": "agent-key-1"})
```

`python -m atcn init` records whether this machine shares anonymous usage metrics. Reporting is off by default and needs `ATCN_USAGE_URL`; see the [usage data documentation](https://github.com/fadnisnikhil/atcn/blob/main/docs/USAGE_DATA.md).

Apache-2.0.
