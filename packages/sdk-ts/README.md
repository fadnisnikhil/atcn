# @atcn/sdk

The ATCN TypeScript SDK. It includes:

- **Signing.** `EventSigner` signs obligation events. `buildTerms`, `termsData`, `acceptanceData` and `buildEvidenceEnvelope` build their contents.
- **API clients.** `AtcnClient` is for the clearing network. `SubledgerClient` and its `CaptureQueue` record tasks, delegations and charges. `ReceiptLinkClient` is for providers.
- **Offline verifiers.** `verifySubledgerDocument` checks task closures and receipts, and `verifyClosurePackage` checks obligation closure packages.
- **Webhooks and response statements.** `verifyWebhook` and `signWebhook` handle webhook signatures. `buildResponseStatement`, `signStatement` and `verifyStatementSignature` handle provider response statements.

```bash
npm install @atcn/sdk
```

```ts
import { verifySubledgerDocument } from "@atcn/sdk";

const report = verifySubledgerDocument(closure, { trustedKeys });
console.log(report.valid ? "VALID" : report.checks.filter((c) => !c.ok));
```

The API clients need an ATCN API at `baseUrl`. The hosted API is not open for signup yet. Everything else works offline.

`npx atcn init` records whether this machine shares anonymous usage metrics. Reporting is off by default and needs `ATCN_USAGE_URL`; see [docs/USAGE_DATA.md](../../docs/USAGE_DATA.md).

Part of [ATCN](../../README.md). Apache-2.0.
