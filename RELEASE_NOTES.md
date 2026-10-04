# ATCN 1.4.0: runs, skills, expiry and revocation for attestations

An attestation about agent work can now say exactly which run, agent version and skill it judged, how long it holds, and which earlier attestation it revokes or disputes. Verifiers check all of it offline. Everything is additive: documents and attestations made before 1.4.0 verify byte for byte.

- **Runs and skills.**
  - Obligation terms can name a `skill` (terms `schema_version` `1.1`; `buildTerms({ skill })` sets it).
  - The working agent declares its run in `obligation.started`: `execution_id`, A2A task and context ids, its own agent version, agent card digest, model and config digest, and the skill. The network refuses a run of any skill other than the agreed one.
  - `@atcn/adapter-a2a`: pass `execution: { agentCard, skillId }` and the bridge declares the run. `obligationTaskMetadata(id, { skillId })` and `skillIdFromMetadata` carry the requested skill. The [A2A example](examples/a2a-delegation) agrees `a2a/code-fix` and prints the run.
- **Attestations (`@atcn/verifiers`).** New `external_attestation@1.1.0`. It also checks the cited run (declared by the counterparty, performing the agreed skill), the cited evidence, `issued_at` and `expires_at`, and whether the signing key was revoked first. Each refusal carries a `code`. Policies pinned to `1.0.0` behave as before.
- **Subledger documents (`schema_version` `1.4`).**
  - A delegation can record its run, and it appears on the receipt and the closure.
  - Provider response statements can cite the run and carry `issued_at`, `expires_at` and `refs`. Only the same provider key can revoke a statement.
  - Revoked and expired statements stay visible, labeled `revoked` and `expired`.
  - Receipts get an `expiry` check. `atcn-verify --at <time>` checks against a time other than now.
  - The SDKs (`respond()` in TypeScript, `build_response_statement` and `ReceiptLinkClient.respond` in Python) take the new fields. `executionBinding` / `execution_binding` compute how a statement cites a run.
- **Adversarial fixtures.** [`packages/verifiers/test-vectors/attestations.json`](packages/verifiers/test-vectors/attestations.json): undeclared or altered runs, the wrong skill, a missing run, expired and future-dated attestations, the wrong obligation, a stripped `expires_at`, a revoked key, revocation by another signer, and unknown references. TypeScript replays every case. Python checks the signatures, digests and run bindings.
- **JSON Schemas.** [`schemas/1.1/`](packages/schema/schemas/1.1/) (terms, the signed external attestation and the run descriptor) and [`schemas/1.4/`](packages/schema/schemas/1.4/) (subledger). Earlier directories are unchanged.

## Compatibility

- **Subledger 1.4.** Producers on 1.4.0 sign receipts and closures as `1.4`, and 1.3.x verifiers report them as an unsupported schema version (`atcn-verify` exit code `3`). Upgrade verifiers before producers. Verifiers 1.4.0 accept `1.2`, `1.3` and `1.4`. A document declaring `1.2` or `1.3` that uses `1.4` fields fails the `schema` check.
- **Terms 1.1.** Terms with a `skill` declare `1.1`, and a 1.3.x `@atcn/core` rejects them. Terms without one are unchanged.
- **Event wire format.** Unchanged at `1.0`. The run lives in `obligation.started` data, which older consumers keep as received.
- **Out of scope for 1.4.0.** Witness roles and independence, and detection of conflicting signed accounts, come in a later release. A dispute ref is recorded but does not change the clearing outcome yet.

Details: [COMPATIBILITY.md](packages/schema/COMPATIBILITY.md#runs-skills-and-attestation-expiry-and-revocation-140).

# Unreleased: A2A adapter and ecosystem examples

- **`@atcn/adapter-a2a` (new package, not on npm yet).** Use it from this repository. Turns an A2A v1.0 task stream into signed obligation events: `WORKING` becomes `obligation.started`, evidence-tagged artifacts become `evidence.submitted`, and `COMPLETED` becomes `completion.proposed`. It works with `AtcnClient` (hosted API) or with the local runner's network through `localObligationClient`. `obligationIdFromMetadata` reads the obligation id that `obligationTaskMetadata` puts on an A2A message.
- **Examples.** [A2A delegation](examples/a2a-delegation) (`npm run demo:a2a`), [LangGraph paid services](examples/langgraph-paid-services), and [x402 payments](examples/x402-payments) (`npm run demo:x402`). They are private workspaces, so they are tested in CI but never published.
- No published package changed, so this publishes nothing to npm or PyPI.

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

- **Package versions.** Every package is 1.3.0, including `@atcn/schema`, `@atcn/core` and `@atcn/verifiers`, which earlier unpublished builds numbered 1.0.0. No package is published as 1.0.0. The 1.0.0 pre-release verifier builds are withdrawn, and `@atcn/verify-cli` 1.3.0 is the first released verifier. Later releases keep every package at one shared version. [COMPATIBILITY.md](packages/schema/COMPATIBILITY.md#schema-versions-supported-by-each-package) lists the schema versions each package emits and reads.
- **Subledger documents.** These use `schema_version` `1.3`. Verifiers 1.3.0 and later accept `1.2` and `1.3`. Any other version fails with an explicit "unsupported schema_version" message, and `atcn-verify` exits with code `3`.
- **The local runner's signer.** Its documents carry `issuer.signed_by: "atcn-local-runner"`. That value was added to schema `1.3` without a new schema version, because no verifier had been published before 1.3.0.
- **Obligation events and closure packages.** These use wire `schema_version` `1.0`.

Details: [COMPATIBILITY.md](packages/schema/COMPATIBILITY.md).

## Release policy

- **Published versions are never changed or unpublished.** A bad release is fixed with a new version.
- **One version for everything.** Every npm package and the Python package share one version. `npm run check:versions` checks that the package files, internal `@atcn/*` pins and version constants agree; CI fails otherwise.
- **Every push to `main` releases automatically** ([`.github/workflows/release.yml`](.github/workflows/release.yml)). If a package changed since the published version, GitHub Actions bumps every package to the next patch version, commits "Release X" to `main`, tags `vX`, and publishes to npm (with provenance) and PyPI. A push that changes only docs, tests or CI publishes nothing. Pull after a release, because the version bump is a new commit on `main`.
- **MINOR and MAJOR releases:** run `npm run set-version -- 1.4.0`, commit, and push. That version is published as is.
- `npm run release:plan` shows what the next push would release (after `npm ci`).

## Known limitations

- The hosted API and portal are not part of this repository, and the hosted service is not open for signup yet. The SDK API clients need an ATCN API to talk to; everything else works offline.
- The local runner supports one flow per obligation: accept, submit evidence, evaluate, clear and settle. Drafts, open offers, amendments, subcontracted obligations, disputes and references to other recorded events are not supported. See the job file format for details.
- The Python SDK does not verify closures or receipts; use `atcn-verify` or the TypeScript SDK.
- Policy acceptance is not independent testing. For independent assurance, require an attestation from a verifier the provider doesn't control.
- No payment-provider-confirmed status exists. Payment is always reported by an operator, or simulated in the runner.
