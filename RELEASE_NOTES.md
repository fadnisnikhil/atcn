# ATCN 1.3.0: first public release

This is the first public release of the ATCN libraries. With them you can capture an agent job, reconcile its costs, and verify the result on your own machine. You don't need an account or a hosted API.

**Start here:** the [quickstart](docs/QUICKSTART.md). Run `npm ci`, then `npx atcn-local demo`.

## What's included

- **Schemas and signing (`@atcn/schema`).**
  - RFC 8785 canonical JSON and Ed25519 signatures.
  - JSON Schemas for the wire format and the subledger documents.
  - Shared test vectors that both SDKs pass.
- **Clearing (`@atcn/core`, `@atcn/verifiers`).**
  - Reference policies and evidence verifiers for JUnit, ESLint, patch digests and attestations.
  - The clearing engine, balanced journals, and closure packages with their offline verifier.
- **Reconciliation and roll-up (`@atcn/subledger`).**
  - Charge matching on stable references, with exceptions for unmatched, ambiguous, duplicate and over-budget events.
  - Roll-up totals.
  - Signed task closures and provider receipts.
  - The offline verifier for subledger documents.
- **SDKs.**
  - TypeScript (`@atcn/sdk`) and Python (`atcn`) SDKs for event signing, webhooks, the API clients and the capture queue.
- **Offline verifier (`@atcn/verify-cli`).**
  - `atcn-verify` checks closures, receipts and closure packages without contacting anyone.
- **Local runner (`@atcn/local-runner`).**
  - `atcn-local demo` runs the bundled USD 112 demo, and `atcn-local run <job.json>` runs your own [job file](docs/JOB_FILE.md).
  - It runs the same domain logic as the hosted service, keeping data in memory and writing results to `.atcn-local/`.
  - Settlement is simulated and labeled `settlement_simulated_in_sandbox`.
  - It evaluates the evidence a provider submits. It does not run the delivered code.
- **Opt-in usage reporting (`@atcn/usage`).**
  - Off by default, with no collector address built in. See [docs/USAGE_DATA.md](docs/USAGE_DATA.md).

## Versions and compatibility

- **Package versions.** Every package is 1.3.0, including `@atcn/schema`, `@atcn/core` and `@atcn/verifiers`, which earlier unpublished builds numbered 1.0.0. No package is published as 1.0.0. The 1.0.0 pre-release verifier builds are withdrawn.
- **Subledger documents.** These use `schema_version` `1.3`. Verifiers 1.3.0 and later accept `1.2` and `1.3`. Any other version fails with an explicit "unsupported schema_version" message, and `atcn-verify` exits with code `3`.
- **The local runner's signer.** Its documents carry `issuer.signed_by: "atcn-local-runner"`. That value was added to schema `1.3` without a new schema version, because no verifier had been published before 1.3.0.
- **Obligation events and closure packages.** These use wire `schema_version` `1.0`.

Details: [COMPATIBILITY.md](packages/schema/COMPATIBILITY.md).

## Release policy

- **Published versions are never changed or unpublished.** A bad release is fixed with a new version.
- **Later releases are published from GitHub Actions** ([`.github/workflows/release.yml`](.github/workflows/release.yml)) when a `v*` tag is pushed. npm releases carry provenance.

## Known limitations

- The hosted API and portal are not part of this repository, and the hosted service is not open for signup yet. The SDK API clients need an ATCN API to talk to; everything else works offline.
- The local runner supports one flow per obligation: accept, submit evidence, evaluate, clear and settle. Drafts, open offers, amendments, subcontracted obligations, disputes and references to other recorded events are not supported. See the job file format for details.
- The Python SDK does not verify closures or receipts; use `atcn-verify` or the TypeScript SDK.
- Policy acceptance is not independent testing. For independent assurance, require an attestation from a verifier the provider doesn't control.
- No payment-provider-confirmed status exists. Payment is always reported by an operator, or simulated in the runner.
