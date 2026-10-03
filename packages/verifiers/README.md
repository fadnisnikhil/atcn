# @atcn/verifiers

Evidence verifiers used by ATCN clearing policies:

- **`junit_tests`:** a JUnit XML report, with a minimum test count and pass rate.
- **`eslint_lint`:** an ESLint JSON report, with maximum errors and warnings.
- **`patch_digest`:** a unified diff, with the minimum number of files changed.
- **`external_attestation`:** a signed attestation from an independent verifier.

They parse the evidence a provider submits. They do not run the delivered code.

```bash
npm install @atcn/verifiers
```

`runCheck` runs one policy check against submitted evidence. See [`examples/local-runner/src/network.ts`](../../examples/local-runner/src/network.ts) for how clearing calls it. Part of [ATCN](../../README.md). Apache-2.0.
