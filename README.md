# ATCN: a cost record for AI agent jobs that anyone can verify

When an AI agent does a job, it often hands parts of it to other agents and pays for APIs along the way. The bills arrive separately, in different formats, and afterwards nobody can say for sure what the whole job cost, or whether each provider delivered what it charged for.

ATCN keeps one record per job:

- **What was handed out:** every delegation to another agent or paid service.
- **What each provider says happened:** delivered, partly delivered, failed or cancelled, signed by the provider when it has a key.
- **What was charged:** invoices, fees, refunds and payments, each matched to the work that caused it. Estimates and budget holds are kept alongside, so you can see how far the actual cost moved from them.
- **What doesn't add up:** charges that match no work, duplicate charges, billing after a cancellation, costs over budget or over the estimate. These are called exceptions.

When the job is done, ATCN signs a **closure**: one JSON document with the totals, who stands behind each number, and every open exception. Anyone can check a closure offline with the free verifier, without trusting ATCN or calling a server.

**ATCN only records.** It never blocks a payment, holds money or decides whether to pay. Estimates and holds are shown next to the actual cost and never counted as cost.

## Try it in two minutes

You need Node.js 20 or later. No account, API key, database or payment details.

```bash
npx @atcn/local-runner demo
```

The demo runs a small job: a USD 100 code change done by one agent and a USD 12 charge from a search API. It then verifies both signed documents offline:

```text
roll-up
  net cost USD 112.00 (charged USD 102.00, fees USD 10.00)
  reported paid USD 90.00 (sandbox, simulated), unresolved USD 22.00

offline verification
  VALID   task closure (cross-checked against the obligation packages)
  VALID   closure package of obl_...
```

No money moves: payment is simulated and labelled as such. The output files and a command to re-verify them yourself are printed at the end.

Next, describe your own job in a file and run it: `npx @atcn/local-runner run job.json`. See the [quickstart](docs/QUICKSTART.md) and the [job file format](docs/JOB_FILE.md).

## Pick your starting point

| You want to | Use |
| --- | --- |
| Let an agent in Claude, Cursor or another MCP host record its own jobs and costs | [`@atcn/mcp-server`](packages/mcp-server) |
| Record jobs from TypeScript or JavaScript | [`atcn-sdk`](packages/atcn-sdk) (same as [`@atcn/sdk`](packages/sdk-ts)) |
| Record jobs or verify documents from Python | [`pip install atcn`](packages/sdk-python) |
| Check a closure or receipt that someone sent you | [`npx @atcn/verify-cli`](packages/verify-cli) |
| Track paid work delegated between A2A agents | [`@atcn/adapter-a2a`](packages/adapter-a2a) |
| Run a job described in a file, or import a provider's bill or a gateway's log | [`@atcn/local-runner`](examples/local-runner), then [Integrating your own bills](docs/INTEGRATE.md) |

## Words you'll see

- **Task:** one job, the root of its cost record.
- **Delegation:** a piece of the task handed to a provider, which may be another agent or a paid API.
- **Financial event:** a charge, fee, refund, credit, reported payment, estimate or hold.
- **Exception:** something that doesn't add up and needs a person to look at it.
- **Closure:** the signed summary of a task. A new version is signed whenever the record changes.
- **Receipt:** what one provider sees of a task: only its own delegations and charges.
- **Obligation and closure package:** paid work with agreed terms, accepted or rejected against a policy (for example "tests pass"); the closure package is its signed record.
- **Assurance label:** who stands behind a claim. Examples: `provider_key_signed` (the provider signed it), `buyer_recorded` (only the buyer says so) and `settlement_simulated_in_sandbox`. Labels are never merged, so a weaker claim can't pass for a stronger one.

A valid signature shows who stated something and that it hasn't changed since. It doesn't prove the work or payment really happened.

## Examples in agent ecosystems

Each example runs locally and ends with a signed closure that verifies offline.

| Example | Run | What it shows |
| --- | --- | --- |
| [A2A delegation](examples/a2a-delegation) | `npm run demo:a2a` | An orchestrator hands work to two A2A v1.0 agents over HTTP: one paid through an obligation whose events the agent signs, one that bills by A2A task id. |
| [LangGraph paid services](examples/langgraph-paid-services) | `python graph.py` | One customer job in a LangGraph graph calls three paid services; each bill is matched to the node that caused it. |
| [x402 payments](examples/x402-payments) | `npm run demo:x402` | Three x402 v2 purchases; each payment record is linked to the work it bought, and a pending settlement stays unresolved. |

The examples run from a clone of this repository (see [Develop](#develop)).

## Packages

| Package | What it is |
| --- | --- |
| [`atcn-sdk`](packages/atcn-sdk) / [`@atcn/sdk`](packages/sdk-ts) | TypeScript SDK: record tasks and charges, sign events, verify closures, receipts and closure packages |
| [`atcn` (PyPI)](packages/sdk-python) | Python SDK: the same signing and offline verification, plus API clients and A2A helpers |
| [`@atcn/mcp-server`](packages/mcp-server) | `atcn-mcp`: lets agents in MCP hosts record jobs and costs and verify closures |
| [`@atcn/local-runner`](examples/local-runner) | `atcn-local`: runs a job end to end on your machine and imports bills and gateway logs |
| [`@atcn/verify-cli`](packages/verify-cli) | `atcn-verify`: offline verifier for closures, receipts, closure packages and clearing verdicts |
| [`@atcn/adapter-a2a`](packages/adapter-a2a) | Records paid A2A tasks: signed task events, billing references, estimates, signed outcomes, sub-task lineage |
| [`@atcn/subledger`](packages/subledger) | The task record itself: charge matching, exceptions, totals, signed receipts and closures |
| [`@atcn/core`](packages/core) | Obligations: policy decisions, the balanced journal, closure packages and clearing verdicts |
| [`@atcn/verifiers`](packages/verifiers) | Checks for submitted evidence (JUnit tests, ESLint, patch digest, attestations, agent traces) |
| [`@atcn/schema`](packages/schema) | Data formats, canonical JSON (RFC 8785), Ed25519 signing, JSON Schemas and test vectors |
| [`@atcn/usage`](packages/usage) | Opt-in usage reporting, off by default ([details](docs/USAGE_DATA.md)) |

The SDKs' API clients (`AtcnClient`, `SubledgerClient`) talk to a hosted ATCN API, which is not part of this repository and is not open for signup yet. Everything else here works without it.

## What ATCN does not do

- It does not move, hold or release money. Payment in the runner is simulated; a clearing verdict is a signed statement that a payment rail may read, and the rail decides.
- It does not run the delivered work. It checks the evidence a provider submits (test, lint and patch reports, attestations) against the agreed policy.
- It does not make a claim true by signing it. Every claim carries a label saying who stands behind it.

## Documentation

- [Quickstart](docs/QUICKSTART.md)
- [Job file format](docs/JOB_FILE.md)
- [Integrating your own bills and gateway logs](docs/INTEGRATE.md)
- [Estimates and holds](docs/ESTIMATES.md)
- [A2A billing reference extension](docs/extensions/billing-ref-v1.md)
- [Schema versions and verifier compatibility](packages/schema/COMPATIBILITY.md)
- [Usage data](docs/USAGE_DATA.md)
- [Release notes](RELEASE_NOTES.md)

## Develop

```bash
git clone https://github.com/fadnisnikhil/atcn.git
cd atcn
npm ci                         # installs and builds every package
npm run typecheck
npm test                       # TypeScript tests
npx atcn-local demo            # the demo, from your clone

cd packages/sdk-python
python3 -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

## License

[Apache License 2.0](LICENSE).
