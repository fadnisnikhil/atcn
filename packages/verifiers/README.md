# @atcn/verifiers

Evidence verifiers used by ATCN clearing policies:

- **`junit_tests`:** a JUnit XML report, with a minimum test count and pass rate.
- **`eslint_lint`:** an ESLint JSON report, with maximum errors and warnings.
- **`patch_digest`:** a unified diff, with the minimum number of files changed.
- **`external_attestation`:** a signed attestation from an independent verifier. Version `1.1.0` also checks the run the attestation cites (declared by the counterparty in `obligation.started`, performing the agreed skill), the evidence it cites, its expiry, and key revocation; refusals carry a `code` in the result details. Policies pinned to `1.0.0` are unchanged.

They parse the evidence a provider submits. They do not run the delivered code.

```bash
npm install @atcn/verifiers
```

[`test-vectors/attestations.json`](test-vectors/attestations.json) holds adversarial attestations (undeclared run, wrong skill, expired, future-dated, wrong subject, stripped expiry, revoked key, revocation by another signer) with the expected outcome of each; the TypeScript and Python tests replay them.

`runCheck` runs one policy check against submitted evidence. See [`examples/local-runner/src/network.ts`](../../examples/local-runner/src/network.ts) for how clearing calls it. Part of [ATCN](../../README.md). Apache-2.0.
