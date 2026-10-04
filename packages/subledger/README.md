# @atcn/subledger

The cost record behind [ATCN](https://github.com/fadnisnikhil/atcn): one record per AI agent job, called a task. Most people use it through [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk) or [`@atcn/local-runner`](https://www.npmjs.com/package/@atcn/local-runner); use this package directly to build or verify the documents yourself.

A task holds:

- **delegations:** pieces of the job handed to other agents or paid APIs;
- **delivery claims:** what each provider says happened, optionally signed by the provider;
- **financial events:** charges, fees, refunds, payments, estimates and holds.

Charges are matched to work through stable references (such as the provider's job id), and a charge is attributed only when exactly one task or delegation matches. Anything that doesn't add up becomes an **exception**: an unmatched or duplicate charge, billing after a cancellation, cost over budget or over the estimate, and more. The package also computes the totals, signs task closures and provider receipts, and verifies them offline.

```bash
npm install @atcn/subledger
```

```ts
import { verifySubledgerDocument } from "@atcn/subledger";

const report = verifySubledgerDocument(closure, { trustedKeys, obligationPackages });
if (report.unsupported_schema_version) console.log("upgrade the verifier");
console.log(report.valid);
```

The verifier recomputes the totals, the estimate-against-actual report and the open exceptions from the records in the document, so an issuer cannot quietly drop an inconvenient one.

Supported subledger schema versions are `1.2` to `1.5`; see [compatibility](https://github.com/fadnisnikhil/atcn/blob/main/packages/schema/COMPATIBILITY.md). Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
