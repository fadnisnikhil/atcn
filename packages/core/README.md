# @atcn/core

The ATCN clearing engine. It turns verifier results into a decision under the agreed policy, posts the balanced journal (payee amount and platform fee), builds service events, and exports closure packages. It also exports `verifyClosurePackage`, the offline verifier for those packages. The package includes the reference policies (`REFERENCE_POLICIES`).

```bash
npm install @atcn/core
```

```ts
import { verifyClosurePackage } from "@atcn/core";

const report = verifyClosurePackage(closurePackage, { trustedKeys });
console.log(report.valid, report.checks);
```

See [`examples/local-runner/src/network.ts`](../../examples/local-runner/src/network.ts) for the full flow: evaluation, clearing and settlement. Part of [ATCN](../../README.md). Apache-2.0.
