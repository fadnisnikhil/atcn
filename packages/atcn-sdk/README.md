# atcn-sdk

[ATCN](https://github.com/fadnisnikhil/atcn) for TypeScript and JavaScript. ATCN keeps one cost record per AI agent job (what was handed out, what each provider says happened, what was charged, and what doesn't add up) and signs it as a closure that anyone can verify offline. It only records: it never blocks, holds or releases money.

This package re-exports [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk), so `import ... from "atcn-sdk"` and `import ... from "@atcn/sdk"` give you the same API.

```bash
npm install atcn-sdk
```

## Verify a closure someone sent you

```ts
import { readFileSync } from "node:fs";
import { verifySubledgerDocument } from "atcn-sdk";

const closure = JSON.parse(readFileSync("task-closure.json", "utf8"));
const trustedKeys = JSON.parse(readFileSync("keys.json", "utf8")).items;

const report = verifySubledgerDocument(closure, { trustedKeys });
console.log(report.valid ? "VALID" : report.checks.filter((c) => !c.ok));
```

No closure yet? `npx @atcn/local-runner demo` makes one on your machine, with no account, and prints where it saved the files.

The API clients need an ATCN API at `baseUrl`. The hosted API is not open for signup yet. Everything else works offline. See [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk) for everything the SDK includes.

## All ATCN packages

| Package | What it is |
| --- | --- |
| [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk) | TypeScript SDK: record tasks and charges, sign events, verify closures, receipts and closure packages |
| [`@atcn/mcp-server`](https://www.npmjs.com/package/@atcn/mcp-server) | `atcn-mcp`: lets agents in Claude, Cursor and other MCP hosts record jobs and costs and verify closures |
| [`@atcn/local-runner`](https://www.npmjs.com/package/@atcn/local-runner) | `atcn-local`: runs a job end to end on your machine (`npx @atcn/local-runner demo`) |
| [`@atcn/verify-cli`](https://www.npmjs.com/package/@atcn/verify-cli) | `atcn-verify`: offline verifier for closures, receipts, closure packages and clearing verdicts |
| [`@atcn/adapter-a2a`](https://www.npmjs.com/package/@atcn/adapter-a2a) | Records paid A2A tasks: signed task events, billing references, estimates, signed outcomes, sub-task lineage |
| [`@atcn/subledger`](https://www.npmjs.com/package/@atcn/subledger) | The task record: charge matching, exceptions, totals, signed receipts and closures |
| [`@atcn/core`](https://www.npmjs.com/package/@atcn/core) | Obligations: policy decisions, the balanced journal, closure packages and clearing verdicts |
| [`@atcn/verifiers`](https://www.npmjs.com/package/@atcn/verifiers) | Checks for submitted evidence (JUnit tests, ESLint, patch digest, attestations, agent traces) |
| [`@atcn/schema`](https://www.npmjs.com/package/@atcn/schema) | Data formats, canonical JSON (RFC 8785), Ed25519 signing, JSON Schemas and test vectors |
| [`@atcn/usage`](https://www.npmjs.com/package/@atcn/usage) | Opt-in usage reporting, off by default |
| [`atcn` (PyPI)](https://pypi.org/project/atcn/) | Python SDK: the same signing and offline verification, plus API clients and A2A helpers |

Source, docs and examples: [github.com/fadnisnikhil/atcn](https://github.com/fadnisnikhil/atcn). Apache-2.0.
