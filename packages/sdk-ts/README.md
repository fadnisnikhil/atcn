# @atcn/sdk

The TypeScript SDK for [ATCN](https://github.com/fadnisnikhil/atcn), a cost record for AI agent jobs that anyone can verify. Use it to:

- **check signed documents offline:** task closures, provider receipts and closure packages, with no network calls;
- **record jobs** (tasks, delegations, charges, estimates, holds) through a hosted ATCN API;
- **sign** obligation events, provider response statements and webhooks.

The same package is also published as [`atcn-sdk`](https://www.npmjs.com/package/atcn-sdk).

```bash
npm install @atcn/sdk
```

## Verify a closure someone sent you

```ts
import { readFileSync } from "node:fs";
import { verifySubledgerDocument } from "@atcn/sdk";

const closure = JSON.parse(readFileSync("task-closure.json", "utf8"));
const trustedKeys = JSON.parse(readFileSync("keys.json", "utf8")).items;

const report = verifySubledgerDocument(closure, { trustedKeys });
console.log(report.valid ? "VALID" : report.checks.filter((c) => !c.ok));
```

`report.checks` lists every check by name with its details, so a failure says exactly what doesn't add up. To try it without writing a closure first, run `npx @atcn/local-runner demo` and point this at the files it prints.

## What's inside

- **Offline verifiers.** `verifySubledgerDocument` checks task closures and receipts, and `verifyClosurePackage` checks obligation closure packages. Clearing verdicts are checked by `verifyClearingVerdict` in [`@atcn/core`](https://www.npmjs.com/package/@atcn/core).
- **Signed estimates and outcomes.** `buildExpectationStatement` and `signExpectation` let a provider sign its estimate or hold; `buildOutcomeStatement` and `signOutcomeStatement` let it sign how a task ended.
- **API clients.** `SubledgerClient` and its `CaptureQueue` record tasks, delegations and charges. `AtcnClient` is for obligations, and `ReceiptLinkClient` is for providers. They need an ATCN API at `baseUrl`; the hosted API is not open for signup yet.
- **Signing.** `EventSigner` signs obligation events. `buildTerms`, `termsData`, `acceptanceData` and `buildEvidenceEnvelope` build their contents.
- **Webhooks and response statements.** `verifyWebhook` and `signWebhook` handle webhook signatures. `buildResponseStatement`, `signStatement` and `verifyStatementSignature` handle provider response statements.
- **Agent traces.** `traceFromOtelSpans` turns an OpenTelemetry GenAI span export into an ATCN trace.

`npx atcn init` records whether this machine shares anonymous usage metrics. Reporting is off by default and needs `ATCN_USAGE_URL`; see [usage data](https://github.com/fadnisnikhil/atcn/blob/main/docs/USAGE_DATA.md).

Source, docs and examples: [github.com/fadnisnikhil/atcn](https://github.com/fadnisnikhil/atcn). Apache-2.0.
