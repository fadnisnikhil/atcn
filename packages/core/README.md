# @atcn/core

The obligation engine of [ATCN](https://github.com/fadnisnikhil/atcn). An obligation is a piece of paid work with agreed terms: for example "fix this bug for USD 100, accepted if the tests pass". This package:

- turns the results of evidence checks into a decision under the agreed policy (the reference policies are in `REFERENCE_POLICIES`);
- posts a balanced journal: the provider's amount and the platform fee;
- exports a **closure package**, the signed record of the obligation, and verifies it offline with `verifyClosurePackage`;
- builds and verifies **clearing verdicts**: the decision in effect, signed for a payment rail to read. The rail decides whether to pay; ATCN moves no money.

```bash
npm install @atcn/core
```

```ts
import { verifyClosurePackage, verifyClearingVerdict } from "@atcn/core";

const report = verifyClosurePackage(closurePackage, { trustedKeys });
console.log(report.valid, report.checks);

const verdictReport = verifyClearingVerdict(verdict, { trustedKeys, closurePackage });
console.log(verdictReport.valid);
```

The verifier replays the policy decision for every automated decision, so a package whose decision doesn't follow from its evidence fails. See [`examples/local-runner/src/network.ts`](https://github.com/fadnisnikhil/atcn/blob/main/examples/local-runner/src/network.ts) for the full flow: evaluation, clearing and simulated settlement.

Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
