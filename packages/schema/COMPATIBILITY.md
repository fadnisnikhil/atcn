# ATCN schema versioning and compatibility (IN-9)

Wire `schema_version` `"1.0"`; obligation terms `"1.0"` or `"1.1"`. Every package in this repository shares one version; the first public release was 1.3.0. Earlier package versions were never published. Published JSON Schemas: [`schemas/1.0/`](schemas/1.0/) and [`schemas/1.1/`](schemas/1.1/). Signing vectors: [`test-vectors/vectors.json`](test-vectors/vectors.json). Adversarial attestation fixtures: [`packages/verifiers/test-vectors/attestations.json`](../verifiers/test-vectors/attestations.json).

## Versioning rules

- The wire `schema_version` uses `MAJOR.MINOR`. The npm/PyPI package uses semver `MAJOR.MINOR.PATCH`.
- **PATCH:** documentation, examples, and validation messages. No wire change.
- **MINOR:** additive only. New optional fields, new event types, new account types, new enum members in *outputs*. Producers on `1.x` must not emit fields that a `1.0` consumer would need in order to verify a signature or recompute a decision.
- **MAJOR:** any change to required fields, field meaning, the canonicalization rules, the signing input, the decision digest inputs, or the journal balance semantics.

## Consumer rules

- Verify signatures over the **exact received payload**. Never re-serialize after dropping unknown fields.
- Ignore unknown optional fields when validating, but keep them when storing or forwarding.
- Reject events whose `schema_version` major differs from the supported major.
- Decision digests are recomputed with the clearing-engine version recorded in `decision_maker.id`. A newer engine must produce identical digests for decisions made by older engines, or must be registered as a new `decision_maker.id`.

## Canonicalization and signing (stable within major 1)

- Canonical JSON follows RFC 8785 (JCS), restricted to strings, booleans, null, arrays, objects, and **safe integers**. Floats are rejected, and amounts are integer minor units.
- Object keys are ASCII and sorted by UTF-16 code unit.
- The signature is Ed25519 over the UTF-8 bytes of `canonicalize(payload)`, encoded as base64url without padding.
- The payload hash is `"sha256:" + hex(sha256(canonicalize(payload)))`.
- Webhook signatures are Ed25519 over `"<unix seconds>.<raw body>"`, sent in the header `ATCN-Signature: t=..,key_id=..,key_version=..,sig=..`.

## Runs, skills, and attestation expiry and revocation (1.4.0)

- **Terms `schema_version` `1.1`** adds the optional `skill` (`{namespace, skill_id, agent_card_url?}`). Terms that set `skill` must declare `1.1`, because a 1.3.x `@atcn/core` would drop the field and then fail the effective-terms digest. Terms without `skill` stay `1.0`, byte for byte. `buildTerms` picks the version.
- **`obligation.started` data** may carry `execution`, the run descriptor: `execution_id`, the A2A task and context ids, the agent's own id, version, agent card digest, model and config digest, and the skill. Event `schema_version` stays `1.0`, because event `data` is an open record that older consumers keep and sign as received. The service and local runner require `execution.agent.agent_id` to be the signing agent, and require the agreed skill when the terms name one.
- **External attestations** gain optional `execution` (`{execution_id, execution_digest}`, the digest of the descriptor), `evidence_digests`, `issued_at`, `expires_at` and `refs` (`revokes` or `disputes` an earlier attestation by payload digest). `issued_at` is required with `expires_at` or `refs`. They are read by the new verifier `external_attestation@1.1.0`. `1.0.0` is unchanged and ignores them, so a policy opts in by pinning `1.1.0`.
- **`external_attestation@1.1.0`** refuses, with a `code` in the result details: a malformed attestation (`malformed`), a different subject (`subject_mismatch`), an unagreed verifier (`verifier_not_agreed`), a key that is not the verifier's (`key_not_verifier`), a bad signature over the payload as received (`signature_invalid`), a key revoked at or before `issued_at` (`key_revoked`), an expired or future-dated attestation (`expired`, `not_yet_valid`; 5 minutes of clock skew), a run the counterparty did not declare (`execution_not_declared`), a run of another skill (`skill_mismatch`), no run when the terms name a skill (`execution_required`), and evidence not submitted on the obligation (`evidence_not_on_obligation`).
- **Revocation.** Only the original signer can revoke. A revoked attestation stays visible and is labeled, never deleted. A reference to an attestation that is not in the set is reported, not treated as invalid.

## Subledger documents (`atcn.subledger.*`)

Subledger receipts and closures carry their own `schema_version`, separate from the wire version above.

| Schema version | Adds | Emitted by | Minimum verifier |
| --- | --- | --- | --- |
| `1.2` | Provider receipts, task closures, response statements | Pre-release builds (`@atcn/subledger` 1.0.0) | `@atcn/verify-cli` 1.3.0 (or `@atcn/subledger` / `@atcn/sdk` 1.3.0) |
| `1.3` | Closure `obligation_links`; claim `asserted_by` values `clearing_policy`, `dispute_reviewer`, `clearing_network`; assurance label `network_recorded`; issuer `signed_by` value `atcn-local-runner` | The hosted ATCN service 1.3.0 and later; `@atcn/local-runner` 1.3.0 to 1.3.2 | `@atcn/verify-cli` 1.3.0 (or `@atcn/subledger` / `@atcn/sdk` 1.3.0) |
| `1.4` | Delegation `execution` (run descriptor) on receipts and closures; response statement `execution`, `issued_at`, `expires_at`, `refs`; assurance labels `expired` and `revoked` | `@atcn/subledger` and `@atcn/local-runner` 1.4.0 and later; the hosted service once it moves to 1.4.0 | `@atcn/verify-cli` 1.4.0 (or `@atcn/subledger` / `@atcn/sdk` 1.4.0) |

JSON Schemas: [`schemas/1.2/`](schemas/1.2/), [`schemas/1.3/`](schemas/1.3/) and [`schemas/1.4/`](schemas/1.4/). Each receipt response links the schema matching its own version.

- **Producers.** New receipt revisions and closure versions are signed as the newest version the producer supports. Documents already signed are never rewritten. A revision may link to a previous revision of an older version.
- **Verifiers 1.4.0 and later** accept `1.2`, `1.3` and `1.4` (1.3.x verifiers accept `1.2` and `1.3`). They check the version before anything else. Any other version gets one failing check, `schema_version`, plus `unsupported_schema_version` in the report and the message `unsupported schema_version X: this verifier (@atcn/subledger <version>) supports 1.2, 1.3 and 1.4. Upgrade ...`. `atcn-verify` exits with code `3` for this case, and with `1` for an invalid document.
- **A document that declares an older version but uses newer fields** fails the `schema` check, because a verifier of that version could not read it. That includes `signed_by: "atcn-local-runner"` in `1.2`, and delegation `execution`, the new statement fields or the labels `expired` and `revoked` in `1.2` or `1.3`.
- **`1.4` checks.** A receipt gets an `expiry` check: it fails once `expires_at` has passed (`atcn-verify --at <time>` checks against another time). In a closure, `provider_responses` also fails when a statement cites a run other than the one recorded on its delegation, has `expires_at` or `refs` without `issued_at`, expires before it was issued, was issued after the closure was generated, or revokes a statement its provider key did not sign; and when the `expired` and `revoked` labels do not match the statements as of `generated_at`. A reference to a statement outside the closure is a note on a passing check.
- **Who signed.** `issuer.signed_by` is `atcn-hosted-service` for documents from the hosted service and `atcn-local-runner` for documents produced on your machine by `atcn-local`. The local runner signs with a key it generates, so its documents prove internal consistency, not a third party's endorsement. Trust it only with the key file from the same run. `atcn-local-runner` was added to `1.3` without a new schema version because no verifier had been published before 1.3.0. Every released verifier accepts it.
- **1.3.0 is the first released verifier, and the 1.0.0 pre-release builds are withdrawn.** They were never published to a registry, and no package will be published as 1.0.0. Do not publish or distribute them: they lack the version check and would reject newer documents with a generic schema error. Every released verifier checks `schema_version` first. That check is covered by the test "names an unsupported schema version explicitly instead of failing on schema or signature", so a verifier meeting a future schema version always says it is unsupported and needs an upgrade.
- The Python SDK does not verify receipts or closures. Response statements are unchanged in `1.3`. In `1.4`, `build_response_statement` takes the new optional fields and leaves them out when not given, so earlier statements keep their bytes; the shared test vectors cover both.

## Releases

- Every npm package and the Python package share one version and are released together from a tagged commit (`v1.3.2`, ...).
- Every push to `main` that changes a package releases all of them at the next patch version. A MINOR or MAJOR release sets the version first (`npm run set-version -- 1.4.0`).
- A published version is never changed or reused. A bad release is fixed with a new version. The bad one is marked with `npm deprecate` or yanked on PyPI, never deleted and re-uploaded.

## Schema versions supported by each package

All packages share one version. This table applies from 1.4.0 on (in 1.3.x, read `1.3` for every subledger `1.4`, and terms `1.0` only); a release that changes what a package emits or reads updates its row and says from which version.

| Package | Emits | Reads and verifies |
| --- | --- | --- |
| `@atcn/schema` | Wire `1.0` (events, closure packages); terms `1.0` and `1.1` | Wire `1.0`, terms `1.0` and `1.1`; ships JSON Schemas for wire `1.0` and `1.1` and subledger `1.2`, `1.3` and `1.4` |
| `@atcn/core` | Wire `1.0` closure packages and service events | Wire `1.0` closure packages (`verifyClosurePackage`), with terms `1.0` or `1.1` |
| `@atcn/verifiers` | Verifier results for wire `1.0` evidence; `external_attestation` `1.0.0` and `1.1.0` | Wire `1.0` evidence envelopes |
| `@atcn/subledger` | Subledger `1.4` receipts and closures | Subledger `1.2`, `1.3` and `1.4` (`verifySubledgerDocument`) |
| `@atcn/sdk` | Wire `1.0` events; terms `1.1` when `skill` is set | Wire `1.0` closure packages; subledger `1.2`, `1.3` and `1.4` |
| `@atcn/verify-cli` | None | Wire `1.0` closure packages; subledger `1.2`, `1.3` and `1.4` |
| `@atcn/local-runner` | Subledger `1.4` closures (`signed_by: "atcn-local-runner"`); wire `1.0` closure packages | Same as `@atcn/verify-cli` |
| `@atcn/usage` | Usage reports only (no signed documents) | None |
| `atcn` (Python) | Wire `1.0` events; response statements (with the optional `1.4` fields) and operator countersignatures | Event, statement, countersignature and attestation signatures; execution bindings. It does not verify receipts, closures or closure packages. |

## Deprecation

- A field or event type is marked deprecated for at least one MINOR release before it can be removed in the next MAJOR release.
- The hosted service accepts the previous MAJOR for at least 6 months after a new MAJOR ships.
