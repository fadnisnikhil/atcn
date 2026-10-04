# atcn-sdk

ATCN for TypeScript. This package re-exports [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk), so `import ... from "atcn-sdk"` and `import ... from "@atcn/sdk"` give you the same API.

```bash
npm install atcn-sdk
```

```ts
import { verifySubledgerDocument } from "atcn-sdk";

const report = verifySubledgerDocument(closure, { trustedKeys });
console.log(report.valid ? "VALID" : report.checks.filter((c) => !c.ok));
```

The API clients need an ATCN API at `baseUrl`. The hosted API is not open for signup yet. Everything else works offline.

## All ATCN packages

| Package | What it is |
| --- | --- |
| [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk) | TypeScript SDK: event signing, API clients, capture queue, verifiers |
| [`@atcn/verify-cli`](https://www.npmjs.com/package/@atcn/verify-cli) | `atcn-verify`: offline verifier for closures, receipts and closure packages |
| [`@atcn/local-runner`](https://www.npmjs.com/package/@atcn/local-runner) | `atcn-local`: runs a job end to end on your machine (`npx @atcn/local-runner demo`) |
| [`@atcn/schema`](https://www.npmjs.com/package/@atcn/schema) | Wire schemas, RFC 8785 canonical JSON, Ed25519 signing, JSON Schemas and test vectors |
| [`@atcn/core`](https://www.npmjs.com/package/@atcn/core) | Clearing engine, balanced journal, closure packages and their verifier |
| [`@atcn/verifiers`](https://www.npmjs.com/package/@atcn/verifiers) | Evidence verifiers used by clearing policies (JUnit tests, ESLint, patch digest, attestations) |
| [`@atcn/subledger`](https://www.npmjs.com/package/@atcn/subledger) | Agent Work Subledger: charge matching, exceptions, roll-up, signed receipts and closures, offline verification |
| [`@atcn/usage`](https://www.npmjs.com/package/@atcn/usage) | Opt-in usage reporting, off by default |
| [`atcn` (PyPI)](https://pypi.org/project/atcn/) | Python SDK: canonical JSON, Ed25519 event signing, webhooks, API clients |

Source, docs and examples: [github.com/fadnisnikhil/atcn](https://github.com/fadnisnikhil/atcn). Apache-2.0.
