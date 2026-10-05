# @atcn/local-runner

`atcn-local` runs an [ATCN](https://github.com/fadnisnikhil/atcn) job end to end on your machine, so you can see what ATCN records and check the result yourself. It needs no account, API, database or payment details.

```bash
npx @atcn/local-runner demo                # a bundled USD 112 example job
npx @atcn/local-runner run job.json        # your own job, described in a JSON file
```

The demo shows a code change done by one agent (USD 100, accepted because its test report passed the agreed policy) and a charge from a search API (USD 12). It prints the totals, any exceptions and two `VALID` offline verifications, and saves every document with a command to re-verify them.

## What it does with a job

1. Generates a signing key, which stays on your machine.
2. Opens the task and any obligations (paid work with agreed terms).
3. Submits the provider's evidence files and evaluates them against the policy. It reads the evidence; it never runs the delivered code.
4. Posts the balanced journal and simulates payment. No money moves, and the payment is labelled `settlement_simulated_in_sandbox`.
5. Records the other work and charges on the task: delegations, claims, estimates, holds, invoices and refunds.
6. Signs the task closure and the obligations' closure packages, and verifies them offline.
7. For an obligation that names an `escrow`, signs a clearing verdict that the payment rail can read. The rail decides whether to pay.

## Bring your own bills

Add a provider's bill, or a gateway's estimate or hold log, to a job:

```bash
npx @atcn/local-runner import gamma-bill.csv --job job.json --source gamma-billing \
  --map source_event_id=charge_id --map provider_job_ref=a2a_task_id --map amount_minor=amount_cents --map event_date=created_at

npx @atcn/local-runner import gateway-holds.jsonl --job job.json --source cost-gateway --kind hold --key request_id \
  --map source_ref=request_id --map provider_job_ref=task_id --map amount_major=reserved_usd --map event_date=ts --currency USD
```

`--map` tells the importer which of your columns holds each field, so your export doesn't need reformatting. `--kind` is `charge` (the default), `invoice`, `estimate` or `hold`. Rows without an id column get one from the columns named by `--key`, so re-importing the same export doesn't double count, and a replayed row with altered amounts opens a `duplicate_event` exception. A worked example with sample files is in [Integrating your own bills](https://github.com/fadnisnikhil/atcn/blob/main/docs/INTEGRATE.md).

LiteLLM spend logs, OpenRouter analytics and Stripe balance reports need no `--map`:

```bash
npx @atcn/local-runner import litellm-spend.json --job job.json --preset litellm
npx @atcn/local-runner import openrouter-activity.json --job job.json --preset openrouter
npx @atcn/local-runner import stripe-balance.csv --job job.json --preset stripe
```

Send the delegation's `provider_job_ref` as the LLM request's `user` field, or as `atcn_job_ref` metadata on the Stripe PaymentIntent or transfer. LLM spend, which comes in fractions of a cent, is added up per job per UTC day and rounded to cents once. [Section 7 of the guide](https://github.com/fadnisnikhil/atcn/blob/main/docs/INTEGRATE.md#7-import-litellm-openrouter-or-stripe-exports-without-a-column-map) shows how to produce each export.

## Options

- **`--data-dir <dir>`:** where the key and the run outputs go (default `./.atcn-local`).
- **`--json`:** prints machine-readable output.

## Exit codes

- `0`: everything verifies.
- `1`: verification failed.
- `2`: usage or job file error.

## Learn more

- [Quickstart](https://github.com/fadnisnikhil/atcn/blob/main/docs/QUICKSTART.md)
- [Job file format](https://github.com/fadnisnikhil/atcn/blob/main/docs/JOB_FILE.md)
- [Integrating your own bills and gateway logs](https://github.com/fadnisnikhil/atcn/blob/main/docs/INTEGRATE.md)
- [Estimates and holds](https://github.com/fadnisnikhil/atcn/blob/main/docs/ESTIMATES.md)

Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
