# Estimates and holds

Agents, budget gateways and operators often say what a piece of work should cost before the bill arrives. ATCN records those statements next to the actual cost so the closure shows the gap. It never enforces them: nothing is reserved, nothing is blocked, and estimates and holds never count toward net cost.

- **Estimate:** what someone expected a delegation (or the whole task) to cost.
- **Hold:** an amount a gateway or wallet set aside for it. ATCN records the hold and its status; it does not hold any money itself.

Both are financial events (`type: "estimate"` or `"hold"`, subledger schema `1.5`), matched to a task or delegation like a charge, with an `expectation`:

| Field | Meaning |
| --- | --- |
| `issued_by` | `agent`, `gateway` or `operator`. |
| `source_ref` | The issuer's own reference, such as a gateway request id. |
| `basis` | How the amount was worked out, for example "max tokens x rate". |
| `expires_at` | When the estimate or hold lapses; `null` for never. |
| `supersedes` | The `source_event_id` (same source and type) of the record this one replaces. Revise by superseding; estimates and holds cannot be reversed. |
| `hold_status` | Holds only: `open`, `captured`, `released` or `expired`. |
| `signer` | Optional: the issuer's signature with a key bound to its provider record (`provider_id`, `binding_id`, `key_id`, `value`). |

## Signed estimates

The issuer signs an expectation statement (`buildExpectationStatement` and `signExpectation` in `@atcn/sdk`; `build_expectation_statement` and `sign_expectation` in Python) with its own key. The buyer binds that key to the issuer's provider record (`bindProviderKey`) and records the event with the signer. The record is then `provider_key_signed`; unsigned records are `buyer_recorded`. Over A2A, an agent sends its signed estimate in task metadata (see the [adapter README](../packages/adapter-a2a/README.md#estimates)). The closure lists the key bindings, so the signatures verify offline.

## What the closure shows

Closures with estimates or holds carry an `expectation_report`, which the offline verifier recomputes:

- per node and for the task: the estimate used, the amount held, the actual net cost, and the variance against each, in minor units and basis points;
- every estimate and hold with its status: `current`, `superseded`, `not_latest` (another current estimate was issued later), `after_charge` or `other_currency`.

A task can set `estimate_tolerance_bps`, the variance allowed before an exception is raised. The default is 0.

## Exceptions

All of these are recorded, not prevented:

| Exception | When |
| --- | --- |
| `actual_exceeds_estimate` | Actual cost on a node exceeds its estimate beyond the tolerance. |
| `actual_exceeds_hold` | Actual cost on a node exceeds what is held for it. |
| `hold_not_released` | A hold is still open past its expiry, or at close with nothing charged. |
| `estimate_after_charge` | An estimate is dated after the first charge on its node, or was recorded after that charge although dated earlier (a back-dated estimate). It is kept but not used as the estimate. |
| `unmatched_estimate` | An estimate or hold matched no task or delegation, or several. |

An import that adds records after the fact on purpose, such as loading last month's gateway log, sets `retrospective: true` on its estimates; their recorded time is then not compared with the charges'.

## Importing logs

`atcn-local import <file> --job job.json --source <name> --kind estimate` (or `--kind hold`) reads a CSV or JSONL log. Rows without an event id get a key derived from the columns named with `--key`, so re-importing the same log adds nothing. See [INTEGRATE.md](INTEGRATE.md) for a worked example with a budget gateway's holds.
