# ATCN 1.5.1: import LiteLLM, OpenRouter and Stripe exports without a column map

- **Import presets (`@atcn/subledger`).** `importPresetRows("litellm" | "openrouter" | "stripe", rows)` turns these exports into financial events, and `parseExportText` reads them saved as JSON, JSONL or CSV.
  - `litellm`: LiteLLM proxy spend logs (`/spend/logs/v2`). The job reference is `end_user`, the OpenAI `user` field the agent sent.
  - `openrouter`: OpenRouter analytics rows grouped by `external_user` and day. The job reference is the request's `user` field.
  - `stripe`: the itemized balance report. `charge` becomes a charge, `refund` a refund, a Connect `transfer` `payment_reported`, and a `transfer_reversal` a refund. The job reference is `atcn_job_ref` metadata on the PaymentIntent or transfer. Payouts, Stripe fees, disputes and adjustments are skipped and listed.
  - LLM spend comes in fractions of a cent. It is summed exactly per job reference per UTC day and rounded half up to cents once.
- **Local runner:** `atcn-local import <file> --job job.json --preset litellm|openrouter|stripe`. [Section 7 of the integration guide](docs/INTEGRATE.md#7-import-litellm-openrouter-or-stripe-exports-without-a-column-map) runs on sample exports in CI.
- **SDKs:** `importCsv(text, { preset })` in TypeScript and `import_csv(text, preset=...)` in Python.
- **[SECURITY.md](SECURITY.md):** how to report a vulnerability privately, and what counts.
- **Provenance:** `@atcn/adapter-a2a` and `@atcn/mcp-server` are now published from GitHub Actions with npm provenance, like the other packages.

Everything is additive; documents made before 1.5.1 verify byte for byte.

# ATCN 1.5.0: agent traces, usage against cost, witnesses and agreed failure terms

A signature proves who sent a record, not that the job ran. 1.5.0 lets the verifier see the run's trace: which models and tools it called and how many tokens it used. It also checks that the price agreed for the work is supported by that usage at agreed rates. Independent witnesses can attest the run, conflicting attestations go to a reviewer instead of being silently resolved, and refund terms are agreed before work starts. Everything is additive. Documents made before 1.5.0 verify byte for byte.

- **Agent traces (`@atcn/schema`, trace `1.0`).**
  - What a trace holds: one run's model calls, tool calls and A2A calls, with tokens per model call, bound to the declared run.
  - What it leaves out: prompts and outputs are never included.
  - Helpers: `traceDigest`, `summarizeTrace` and `traceProblems`.
  - JSON Schemas: `agent-trace` and `usage-summary` in [`schemas/1.2/`](packages/schema/schemas/1.2/).
- **OpenTelemetry import.** `traceFromOtelSpans` (TypeScript) and `trace_from_otel_spans` (Python) turn an OTLP JSON export of GenAI spans into a trace. Every span they skip is listed with the reason.
- **Runs** can declare `additional_models` for multi-model agents.
- **Verifiers (`@atcn/verifiers`).**
  - `agent_trace@1.0.0` checks that the trace:
    - is well formed;
    - belongs to a run the counterparty declared;
    - uses only that run's models;
    - falls inside the run.
  - `usage_cost@1.0.0` prices every trace on a deliverable at the agreed rates. It fails when the agreed amount exceeds usage cost by more than the tolerance; an amount below cost passes.
  - New reference policy: `agent-usage-checks@1.0.0`.
- **Pricing.**
  - Terms `schema_version` `1.2` adds `pricing`: per-meter rates, an optional fixed fee, and a tolerance. `buildTerms({ pricing })` sets it.
  - `expectedCostFromUsage` and `usageCostDetails` give identical results in TypeScript and Python. Each rate line rounds half up once, and all arithmetic is exact.
- **Subledger documents (`schema_version` `1.5`).**
  - Delegations can carry `pricing`.
  - Completion claims, from either party, can carry `usage` (`{trace_digest, summary}`).
  - Closures record `usage_checks`, expected cost against billed, in both directions.
  - New exceptions: `usage_unpriced` and `usage_cost_mismatch`.
  - Providers can attest the new field `delivery.usage`.
- **Offline (`atcn-verify --trace`).**
  - With trace files, `atcn-verify` recomputes recorded usage from each trace and recomputes every `usage_cost` result.
  - Without them, it reports "not inspected", which is neither a pass nor a failure.
- **Fixtures.** [`packages/sdk-ts/test-vectors/traces.json`](packages/sdk-ts/test-vectors/traces.json) covers the OpenTelemetry import, digests, summaries, malformed traces, expected costs and `usage_cost` details. TypeScript and Python reproduce every value.
- **A2A example.**
  - Beta's agent builds its trace from GenAI spans and submits it as evidence.
  - The obligation carries agreed prices.
  - The run rechecks the trace and usage cost offline.

## From the A2A discussions

- **The A2A adapter records each artifact once** ([#2277](https://github.com/a2aproject/A2A/discussions/2277)). `tasks/get` returns every artifact on each poll, and the bridge used to submit them again. Evidence ids now derive from the obligation, the artifact id and the content digest (`artifactEvidenceId`). `BridgeOptions.submittedEvidenceIds` lets a restarted bridge skip what the obligation already holds.
- **Refund and failure terms agreed up front** ([#1969](https://github.com/a2aproject/A2A/discussions/1969), [#2124](https://github.com/a2aproject/A2A/discussions/2124)).
  - Terms `1.2` add `refund_terms`: `on_failure` (`refund` or `dispute`), `on_timeout` (`refund`) and `after_settlement` (`cap_minor`, `window_seconds`).
  - With `on_failure: "dispute"`, work that fails its checks goes to the dispute reviewer (reason `failure_terms_dispute`) instead of being rejected.
  - Subledger delegations carry `refund_terms`. Refunds above the cap, after the window, or missing when the terms require one raise `refund_terms_breach`.
- **Payment finality** ([#1576](https://github.com/a2aproject/A2A/discussions/1576)). Settlement status `pending_finality` sits between submitted and settled. `RAIL_FINALITY` gives each adapter's expected and maximum finality time, so a service can raise `finality_overdue`. Subledger payments can be `pending_finality`; they change no totals until final.
- **Price bound to the skill** ([#1576](https://github.com/a2aproject/A2A/discussions/1576), settlement-conformance vector `skill-pricing-bait-001`). Quotes, invoices and charges can name the `skill` they bill. One for a different skill from the delegated run raises `skill_price_mismatch`.
- **Independent witnesses** (evidence plan phase 3).
  - Terms `1.2` add `witness_policy`: `min_independent_witnesses`, optional `witness_agent_ids`, and `independence: "distinct_verified_domain"`.
  - A witness signs an `external_attestation` with `role: "witness"`, citing the run and the evidence it saw. It is submitted as `witness_attestation` evidence.
  - `witness_quorum@1.0.0` counts witnesses by verified registrable domain. A witness sharing a domain with a party, or with another witness, counts once or not at all, and the result says why. When a party has no verified domain it refuses with `independence_unverifiable`. Too few witnesses is `insufficient_evidence` (reason `witness_quorum_not_met`), not a failure of the work.
  - New reference policy: `witnessed-agent-work`.
  - Subledger delegations carry `witness_policy`; provider statements can carry `role: "witness"`, signed with a domain-challenged key of another provider. Missing witnesses raise `witness_quorum_not_met`.
  - SDKs: `createWitnessShare` (TypeScript) and `create_witness_share` (Python) issue a receipt link for a witness provider, and the link client's `respond` takes `role: "witness"`.
- **Conflicting attestations** (evidence plan phase 4).
  - `findConflicts` reports `equivocation` (one signer, two answers), `disagreement` (two signers, two answers), `execution_mismatch` (two runs for one check) and `disputed`.
  - Clearing never picks a winner: a conflict on a check sends the deliverable to the dispute reviewer (reason `conflicting_attestations`). The clearing engine is now `atcn-clearing-engine@1.1.0`; decisions by `1.0.0` replay without conflicts.
  - Closure package `1.1` carries the attestation texts and the recorded `attestation_conflicts`. `verifyClosurePackage` recomputes the conflicts offline, so deleting one, or withholding a text, fails even when the package is re-signed.
  - Subledger closures mark a field contested when signed statements conflict, and conflicts raise `conflicting_statements`.
- **Field-by-field tamper test** ([#1920](https://github.com/a2aproject/A2A/discussions/1920)). [`examples/a2a-delegation/test/mutation.test.ts`](examples/a2a-delegation/test/mutation.test.ts) changes every leaf of a closure package and a subledger closure one at a time, re-signs with the service key, and requires the offline verifier to reject it. The few fields nothing checks are pinned with the reason.
- **RFC 8785 cross-implementation vectors** ([#2038](https://github.com/a2aproject/A2A/discussions/2038)). TypeScript and Python reproduce AlgoVoi's JCS edge vectors (copied with their Apache-2.0 notice) and ATCN's own [`atcn_jcs_v1.json`](packages/schema/test-vectors/atcn_jcs_v1.json).

## For A2A builders: estimates, failures, rails, lineage and verdicts

ATCN stays an after-the-fact record: none of this blocks work, reserves money or releases funds.

- **Billing-reference extension for Agent Cards** ([spec](docs/extensions/billing-ref-v1.md)). An agent declares what its bills reference (`task_id`, `context_id` or a metadata key). `delegationFromA2A` takes the delegation's `provider_job_ref` from it, so charges match without hand mapping. Shared vectors keep TypeScript and Python in step.
- **Estimates and holds** ([ESTIMATES.md](docs/ESTIMATES.md)). Estimates and holds from agents, budget gateways or the operator are recorded next to actual cost, optionally signed by the issuer. Closures carry an `expectation_report` with the variance, which the verifier recomputes. New exceptions: `actual_exceeds_estimate`, `actual_exceeds_hold`, `hold_not_released`, `estimate_after_charge` (including back-dated estimates) and `unmatched_estimate`. Tasks can set `estimate_tolerance_bps`.
- **Adoption kit.**
  - `@atcn/adapter-a2a` is published from 1.5.0.
  - `atcn-local import` adds a provider bill or a gateway's estimate/hold log (CSV or JSONL) to a job file. Rows without an id get a key derived from the columns you name, so re-importing adds nothing.
  - [INTEGRATE.md](docs/INTEGRATE.md) walks through it, and CI runs its commands.
- **Failed, canceled and rejected tasks.**
  - Providers can sign how their work ended (outcome statement over the task id, note and evidence pointers), and the closure check `signed_claims` re-verifies it offline.
  - The A2A bridge reports `FAILED`, `CANCELED` and `REJECTED` as `terminal` actions.
  - A cancelled or failed delegation that is still billed raises `charge_after_cancellation`.
  - Job files can `cancel` an obligation. The A2A example shows a signed failure with a refund (`--search-fails`).
- **Rail attestations.** A payment or refund can carry the rail's own record: an A2A-SE escrow attestation with its Merkle inclusion proof, or an x402 exact-EVM payment (EIP-3009 authorization plus settlement). The record is re-verified at intake and again offline, labelled `rail_attested`, and listed in the closure's `rail_attestations`. `financialEventFromRailAttestation` turns a raw attestation into a financial event.
- **Multi-hop lineage over A2A.** The adapter carries the chain of parent tasks to sub-agents (`lineageMetadata`) and reports sub-tasks back up with each sub-agent's signed outcome (`downstreamMetadata`). The buyer records them as child delegations. A sub-task with no outcome becomes a `broken_edge` capture gap, so the closure shows lineage as incomplete.
- **Reconciliation conformance vectors.** [`reconciliation.json`](packages/subledger/test-vectors/reconciliation.json) covers double charges, cross-task replay, refund after close, charge after cancellation and back-dated estimates. [`reconciliation-results.json`](packages/subledger/test-vectors/reconciliation-results.json) holds ATCN's results in the settlement-conformance results shape (`npm run gen:reconciliation`).
- **Python parity.** The `atcn` package verifies subledger closures and receipts offline, check for check with TypeScript, and has A2A helpers (billing reference, estimates, signed outcomes, lineage). `verify_closure_package` verifies closure packages, and `verify_subledger_document(..., obligation_packages=...)` cross-checks obligation-backed delegations against them. `verify_clearing_verdict` checks verdicts and verifies their package in full. The API clients add `record_rail_attestation`, `clearing_verdict` and import options for `import_csv`. Shared vectors (`npm run gen:vectors`) and a TypeScript-against-Python fuzz comparison keep the reports identical. Python differs only on hostile input (strict Ed25519 instead of ZIP-215, a scheme check for `z.url()`, tie order among 64 or more equal evidence candidates, `__proto__` keys).
- **Offline verifier robustness.** `verifyClosurePackage` and `verifyClearingVerdict` now fail a check instead of throwing on several hostile inputs: terms without an `acceptance_policy`, an `evidence.submitted` event without a valid envelope, invalid terms cited by digest, journal totals past the safe integer range, attestation text holding a fraction, usage too large to price exactly, and a verdict's package with a fraction in an unknown member.
- **Verifier hardening.** A closure with a delegation whose parent is outside the task or in a cycle, a signed claim or estimate with an unreadable date, or a payload number no signature could cover (such as a fraction inside a rail record) now gets a failing check instead of an exception or a hang, in TypeScript and Python.
- **Clearing verdict.** `buildClearingVerdict` and `verifyClearingVerdict` (`@atcn/core`) publish an obligation's decision in effect as a signed verdict that an escrow rail can name as its release authority. The rail decides whether to release. `atcn-verify` checks a verdict against its closure package, and job files can name an `escrow` to get one.
- **Signed records on receipts.** A 1.5 receipt lists the key bindings its signed outcome claims, estimates and holds name, and the new receipt check `signed_records` re-verifies them offline, as `signed_claims` and `expectations` do on closures.
- **Open exceptions recomputed offline.** The closure check `open_exceptions` derives every condition-based exception from the closure's own records as of `generated_at`. Each one must be listed open, or in the new `resolved_exceptions` with the person who resolved or dismissed it, and no open one may lack its condition. Dropping an exception, or leaving a stale one open, fails even when the closure is re-signed.
- **Signed records in job files.** `provider_keys` binds providers' and gateways' public keys before the run, so outcome claims, estimates and holds signed ahead of time verify ([JOB_FILE.md](docs/JOB_FILE.md#signed-records)).
- **CSV import options.** `importCsv` and `import_csv` take a column `map` (`column_map` in Python) and `minor_digits` for a provider's or gateway's own export.
- **MCP server (`@atcn/mcp-server`).** Agents in MCP hosts (Claude, Cursor and others) can record tasks, delegations, estimates, holds, costs and outcomes, close the task and verify the result, with no SDK code. It runs locally with no account, or against the hosted API.
- **New on npm.** `@atcn/adapter-a2a` and `@atcn/mcp-server` are published for the first time. Every README now starts with what the package is for and a quick start, and links work on npm and PyPI.

## Compatibility

- **Subledger 1.5.** Producers on 1.5.0 sign as `1.5`, and 1.4.x verifiers report an unsupported schema version (exit code `3`). Upgrade verifiers before producers. A document declaring `1.2` to `1.4` that uses `1.5` fields fails the `schema` check.
- **Terms 1.2.** 1.4.x `@atcn/core` rejects terms with `pricing`, `refund_terms` or `witness_policy` at the schema. Terms without them are unchanged.
- **Closure packages.** A package stays `1.0` unless it holds attestation evidence or a `pending_finality` settlement; then it is `1.1`. 1.4.x verifiers only know `1.0` and fail a `1.1` package at the `schema` check (exit code `1`), so upgrade verifiers first. From 1.5.0 on, a package version the verifier does not know is reported as unsupported (exit code `3`) instead.
- **The event wire format** is unchanged at `1.0`.
- **Not in 1.5.0:**
  - A trace is the provider's claim. Witnesses attest that a run happened and what evidence they saw; nothing checks a trace step by step against the model provider's own records.
  - Witness independence is by registrable domain, as verified by the service. Two domains owned by one company count as independent.
  - Pricing checks the agreed amount. It never computes a payout.
  - A rail attestation proves what the rail recorded, not that the rail is honest: an A2A-SE Merkle root is not signed, so compare it with the root the exchange publishes; an x402 record proves the payer's authorization, not on-chain inclusion.
  - A signed outcome is the provider's statement about its own work, not proof the work happened.
  - Offline recomputation of open exceptions leaves out `witness_quorum_not_met` (it needs the domains the service verified) and exceptions raised at intake (duplicate, unmatched and ambiguous events).

Details: [COMPATIBILITY.md](packages/schema/COMPATIBILITY.md#agent-traces-usage-and-pricing-150).

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
