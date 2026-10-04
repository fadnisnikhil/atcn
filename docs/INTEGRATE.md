# Wire ATCN into your project in 30 minutes

You have an orchestrator that delegates work to other agents over A2A. You also have a bill export from a
provider, and maybe a budget gateway's log of the holds it took. This guide takes you from there to a signed task
closure that anyone can verify offline. You don't need an account, the hosted API, or payment credentials.

ATCN records and reconciles. It never blocks a request, reserves budget or moves money. Budget gateways enforce
limits; ATCN records their estimates and holds and shows the gap against what was actually billed.

The files used below are in [`docs/integrate/`](integrate/). CI runs every `atcn-local` command in this guide, in
order, against those files (`examples/local-runner/test/integrate.test.ts`).

## 1. Install

```sh
npm i -D @atcn/local-runner @atcn/verify-cli
```

## 2. Describe the task and its delegations

[`job.json`](integrate/job.json) holds one task with a USD 1.00 budget and five A2A hand-offs to a search agent.
Each delegation's `provider_job_ref` is the A2A task id, which is the reference the provider's bills carry.

If the agent's card declares the [billing-reference extension](extensions/billing-ref-v1.md), you don't pick the
reference yourself. `delegationFromA2A` in `@atcn/adapter-a2a` reads it from the card and the A2A task (step 6).

## 3. Import the provider's bill

[`gamma-bill.csv`](integrate/gamma-bill.csv) is the provider's export. Map its columns to ATCN fields:

```sh
npx atcn-local import gamma-bill.csv --job job.json --source gamma-billing --map source_event_id=charge_id --map provider_job_ref=a2a_task_id --map amount_minor=amount_cents --map event_date=created_at
```

Each row becomes a charge in `job.json`. A charge whose reference matches exactly one delegation is attributed to
it. A charge that matches none (the bill has one from another job) opens `unmatched_charge`; it is never dropped
silently.

## 4. Import the gateway's holds

[`gateway-holds.jsonl`](integrate/gateway-holds.jsonl) is a budget gateway's per-hand-off log, with one hold of
USD 1.00 per request. The rows have no event id, so `--key request_id` names the column that identifies a row:

```sh
npx atcn-local import gateway-holds.jsonl --job job.json --source cost-gateway --kind hold --key request_id --map source_ref=request_id --map provider_job_ref=task_id --map amount_major=reserved_usd --map event_date=ts --currency USD
```

The key is a hash of the canonical JSON of the key columns. Importing the same log again adds nothing. A row that
comes back with the same key but changed content is not added (`changed and not added`), and the runner or API
records a `duplicate_event` exception for it. Use `--kind estimate` for estimate logs. Imported records are
`buyer_recorded`; to get `gateway_signed`, the gateway signs each record (`signExpectation` in `@atcn/sdk`,
`sign_expectation` in the Python SDK) with a key bound to its provider record.

## 5. Close and verify

```sh
npx atcn-local run job.json --data-dir .atcn-local
```

The runner records everything, closes the task, signs the closure and verifies it offline. Expected output:

- net cost USD 5.00, held USD 5.00, variance USD 0.00 against the holds;
- `budget_overrun`: five holds of USD 1.00 against a USD 1.00 budget were all recorded, and nothing was blocked;
- `unmatched_charge` for the other job's charge;
- `VALID task closure`.

Re-verify the files anywhere, with only the public key:

```sh
npx atcn-verify .atcn-local/runs/<run>/task-closure.json --keys .atcn-local/runs/<run>/keys.json
```

## 6. Record live from your orchestrator

Instead of a job file, record as work happens. With `@atcn/adapter-a2a` and the local runner (or the hosted API
through `@atcn/sdk`):

```ts
import { delegationFromA2A, estimateEventFromA2A, estimateFromMetadata } from "@atcn/adapter-a2a";

// After the A2A task starts: provider_job_ref comes from the card's billing reference.
const delegation = subledger.createDelegation(taskId, delegationFromA2A({ card, task, currency: "USD", externalRef: "search" }));

// If the agent published an estimate in metadata.atcn.estimate, record it (signed when you bound the agent's key).
const estimate = estimateFromMetadata(task.metadata);
if (estimate) subledger.recordFinancialEvent(estimateEventFromA2A(estimate, { match: { delegation_id: delegation.delegation_id } }));
```

[`examples/a2a-delegation`](../examples/a2a-delegation) runs this against two real A2A agents on localhost. Add
`--with-estimates` to also record a signed agent estimate and compare it with the bill.

## What you get, and what you don't

You get a signed closure that lists every delegation, charge, estimate and hold, the roll-up, the gap between
expected and actual cost, and the exceptions to review. Any change to it is detected offline.

You don't get enforcement. ATCN reports `budget_overrun`, `actual_exceeds_estimate` and `actual_exceeds_hold` after
the fact. It does not prevent them, and a valid signature attests to what was recorded, not to the truth of the
underlying work or payment.
