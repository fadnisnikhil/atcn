# ATCN: capture agent work, reconcile its costs, verify the result offline

ATCN records what an AI agent's job cost and who stands behind each claim about it. It signs a task closure that anyone can check offline.

This repository holds the open-source parts: schemas and signing, reconciliation, roll-up and clearing logic, the TypeScript and Python SDKs, the offline verifier, and a local runner. The runner puts it all together on your machine. It needs no account, hosted API, database or payment credentials.

## Try it (about two minutes)

Requires Node.js 20 or later.

```bash
git clone https://github.com/fadnisnikhil/atcn.git
cd atcn
npm ci                                         # installs and builds every package
npx atcn-local demo
```

The demo runs a USD 100 code-change job and a USD 12 search charge through the real domain logic, then verifies both signed documents offline:

```text
roll-up
  net cost USD 112.00 (charged USD 102.00, fees USD 10.00)
  reported paid USD 90.00 (sandbox, simulated), unresolved USD 22.00

offline verification
  VALID   task closure (cross-checked against the obligation packages)
  VALID   closure package of obl_...
```

Without cloning, the same demo runs straight from npm: `npx @atcn/local-runner demo`. The packages are on npm under [`@atcn`](https://www.npmjs.com/org/atcn), and the Python SDK is `pip install atcn`.

Then run your own job file: `npx atcn-local run job.json`. See the [quickstart](docs/QUICKSTART.md) and the [job file format](docs/JOB_FILE.md).

**What the runner does not do.** It evaluates the evidence a provider submits (test, lint and patch reports) against the agreed policy. It does not run the delivered code. Settlement is simulated and labeled `settlement_simulated_in_sandbox`: no money moves and no payment is confirmed.

## Packages

| Package | What it is |
| --- | --- |
| [`@atcn/schema`](packages/schema) | Wire schemas, RFC 8785 canonical JSON, Ed25519 signing, JSON Schemas and test vectors |
| [`@atcn/core`](packages/core) | Clearing engine, balanced journal, closure packages and their verifier |
| [`@atcn/verifiers`](packages/verifiers) | Evidence verifiers used by clearing policies (JUnit tests, ESLint, patch digest, attestations) |
| [`@atcn/subledger`](packages/subledger) | Agent Work Subledger: charge matching, exceptions, roll-up, signed receipts and closures, offline verification |
| [`@atcn/usage`](packages/usage) | Opt-in usage reporting, off by default ([details](docs/USAGE_DATA.md)) |
| [`@atcn/sdk`](packages/sdk-ts) | TypeScript SDK: event signing, API clients, capture queue, verifiers |
| [`@atcn/verify-cli`](packages/verify-cli) | `atcn-verify`: offline verifier for closures, receipts and closure packages |
| [`@atcn/local-runner`](examples/local-runner) | `atcn-local`: runs a job end to end on your machine |
| [`atcn` (PyPI)](packages/sdk-python) | Python SDK: canonical JSON, Ed25519 event signing, webhooks, API clients |

The API clients in both SDKs (`AtcnClient`, `SubledgerClient`) talk to an ATCN API. The hosted API is not part of this repository and is not open for signup yet. Everything else here works without it.

## Develop

```bash
npm ci
npm run typecheck
npm test                       # TypeScript tests
npm run build                  # rebuilds dist/ for every package

cd packages/sdk-python
python3 -m venv .venv && .venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

## Documentation

- [Quickstart](docs/QUICKSTART.md)
- [Job file format](docs/JOB_FILE.md)
- [Schema versions and verifier compatibility](packages/schema/COMPATIBILITY.md)
- [Usage data](docs/USAGE_DATA.md)
- [Release notes](RELEASE_NOTES.md)

## License

[Apache License 2.0](LICENSE).
