# ATCN schema versioning and compatibility (IN-9)

Wire `schema_version` `"1.0"`. Every package in this repository shares one version; the first public release was 1.3.0. Earlier package versions were never published. Published JSON Schemas: [`schemas/1.0/`](schemas/1.0/). Signing vectors: [`test-vectors/vectors.json`](test-vectors/vectors.json).

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

## Subledger documents (`atcn.subledger.*`)

Subledger receipts and closures carry their own `schema_version`, separate from the wire version above.

| Schema version | Adds | Emitted by | Minimum verifier |
| --- | --- | --- | --- |
| `1.2` | Provider receipts, task closures, response statements | Pre-release builds (`@atcn/subledger` 1.0.0) | `@atcn/verify-cli` 1.3.0 (or `@atcn/subledger` / `@atcn/sdk` 1.3.0) |
| `1.3` | Closure `obligation_links`; claim `asserted_by` values `clearing_policy`, `dispute_reviewer`, `clearing_network`; assurance label `network_recorded`; issuer `signed_by` value `atcn-local-runner` | The hosted ATCN service 1.3.0 and later; `@atcn/local-runner` 1.3.0 and later | `@atcn/verify-cli` 1.3.0 (or `@atcn/subledger` / `@atcn/sdk` 1.3.0) |

JSON Schemas: [`schemas/1.2/`](schemas/1.2/) and [`schemas/1.3/`](schemas/1.3/). Each receipt response links the schema matching its own version.

- **Producers.** The service signs every new receipt revision and closure version as `1.3`. Documents that were already signed as `1.2` are never rewritten. A `1.3` revision may link to a `1.2` previous revision.
- **Verifiers 1.3.0 and later** accept `1.2` and `1.3`. They check the version before anything else. Any other version gets one failing check, `schema_version`, plus `unsupported_schema_version` in the report and the message `unsupported schema_version X: this verifier (@atcn/subledger <version>) supports 1.2 and 1.3. Upgrade ...`. `atcn-verify` exits with code `3` for this case, and with `1` for an invalid document.
- **A document that declares `1.2` but uses `1.3` fields** fails the `schema` check, because a `1.2` verifier could not read it. That includes `signed_by: "atcn-local-runner"`.
- **Who signed.** `issuer.signed_by` is `atcn-hosted-service` for documents from the hosted service and `atcn-local-runner` for documents produced on your machine by `atcn-local`. The local runner signs with a key it generates, so its documents prove internal consistency, not a third party's endorsement. Trust it only with the key file from the same run. `atcn-local-runner` was added to `1.3` without a new schema version because no verifier had been published before 1.3.0. Every released verifier accepts it.
- **1.3.0 is the first released verifier, and the 1.0.0 pre-release builds are withdrawn.** They were never published to a registry, and no package will be published as 1.0.0. Do not publish or distribute them: they lack the version check and would reject newer documents with a generic schema error. Every released verifier checks `schema_version` first. That check is covered by the test "names an unsupported schema version explicitly instead of failing on schema or signature", so a verifier meeting a future schema version always says it is unsupported and needs an upgrade.
- The Python SDK does not verify receipts or closures. Response statements are unchanged in `1.3`, so Python statement signing and the shared test vectors are unaffected.

## Releases

- Every npm package and the Python package share one version and are released together from a tagged commit (`v1.3.2`, ...).
- Every push to `main` that changes a package releases all of them at the next patch version. A MINOR or MAJOR release sets the version first (`npm run set-version -- 1.4.0`).
- A published version is never changed or reused. A bad release is fixed with a new version. The bad one is marked with `npm deprecate` or yanked on PyPI, never deleted and re-uploaded.

## Schema versions supported by each package

All packages share one version. This table applies from 1.3.0 on; a release that changes what a package emits or reads updates its row and says from which version.

| Package | Emits | Reads and verifies |
| --- | --- | --- |
| `@atcn/schema` | Wire `1.0` (events, terms, closure packages) | Wire `1.0`; ships JSON Schemas for wire `1.0` and subledger `1.2` and `1.3` |
| `@atcn/core` | Wire `1.0` closure packages and service events | Wire `1.0` closure packages (`verifyClosurePackage`) |
| `@atcn/verifiers` | Verifier results for wire `1.0` evidence | Wire `1.0` evidence envelopes |
| `@atcn/subledger` | Subledger `1.3` receipts and closures | Subledger `1.2` and `1.3` (`verifySubledgerDocument`) |
| `@atcn/sdk` | Wire `1.0` events | Wire `1.0` closure packages; subledger `1.2` and `1.3` |
| `@atcn/verify-cli` | None | Wire `1.0` closure packages; subledger `1.2` and `1.3`. 1.3.0 is the first released verifier. |
| `@atcn/local-runner` | Subledger `1.3` closures (`signed_by: "atcn-local-runner"`); wire `1.0` closure packages | Same as `@atcn/verify-cli` |
| `@atcn/usage` | Usage reports only (no signed documents) | None |
| `atcn` (Python) | Wire `1.0` events; response statements and operator countersignatures (unchanged from subledger `1.2` to `1.3`) | Event, statement and countersignature signatures. It does not verify receipts, closures or closure packages. |

## Deprecation

- A field or event type is marked deprecated for at least one MINOR release before it can be removed in the next MAJOR release.
- The hosted service accepts the previous MAJOR for at least 6 months after a new MAJOR ships.
