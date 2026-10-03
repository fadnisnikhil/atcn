# @atcn/subledger

The ATCN Agent Work Subledger. It records a task's delegations, delivery claims and financial events. Charges are matched to work through stable references, and an event is attributed only when exactly one task or delegation matches. The package also covers:

- exceptions for unmatched, ambiguous, duplicate, over-budget and other conditions;
- roll-up totals;
- signed task closures and provider receipts;
- `verifySubledgerDocument`, the offline verifier for those documents.

```bash
npm install @atcn/subledger
```

```ts
import { verifySubledgerDocument } from "@atcn/subledger";

const report = verifySubledgerDocument(closure, { trustedKeys, obligationPackages });
if (report.unsupported_schema_version) console.log("upgrade the verifier");
console.log(report.valid);
```

Supported subledger schema versions are `1.2` and `1.3`; see [COMPATIBILITY.md](../schema/COMPATIBILITY.md). Part of [ATCN](../../README.md). Apache-2.0.
