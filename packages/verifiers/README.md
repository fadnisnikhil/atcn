# @atcn/verifiers

The evidence checks that [ATCN](https://github.com/fadnisnikhil/atcn) policies use to decide whether paid work is accepted. A provider submits evidence (a test report, a lint report, a patch, an attestation), and a policy says which checks it must pass. These checks read the evidence; they never run the delivered code.

| Check | What it reads | What the policy can require |
| --- | --- | --- |
| `junit_tests` | A JUnit XML test report | A minimum number of tests and a pass rate |
| `eslint_lint` | An ESLint JSON report | At most so many errors and warnings |
| `patch_digest` | A unified diff | A minimum number of files changed |
| `external_attestation` | A signed attestation from an independent verifier | Version `1.1.0` also checks the run and skill it cites, the evidence it cites, its expiry and key revocation; refusals carry a `code`. Policies pinned to `1.0.0` are unchanged. |
| `agent_trace` | An agent trace file | That it belongs to a run the provider declared: bound by digest, using only the declared models, inside the run's time window |
| `usage_cost` | The usage in agent traces, priced at the agreed rates | That the usage supports the amount charged, within the agreed tolerance |
| `witness_quorum` | Witness attestations | That enough independent witnesses, on distinct verified domains, attested to the run |

```bash
npm install @atcn/verifiers
```

`runCheck` runs one policy check against submitted evidence. See [`examples/local-runner/src/network.ts`](https://github.com/fadnisnikhil/atcn/blob/main/examples/local-runner/src/network.ts) for how clearing calls it.

[`test-vectors/attestations.json`](https://github.com/fadnisnikhil/atcn/blob/main/packages/verifiers/test-vectors/attestations.json) holds adversarial attestations (undeclared run, wrong skill, expired, future-dated, wrong subject, stripped expiry, revoked key, revocation by another signer) with the expected outcome of each; the TypeScript and Python tests replay them.

Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
