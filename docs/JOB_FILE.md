# Job file format (`atcn-local run <job.json>`)

A job file describes one piece of agent work:

- the buyer's task;
- work agreed as obligations on the clearing network, with the evidence the provider submits;
- work bought off the network;
- the charges that work produced.

Amounts are integer minor units (`10000` is USD 100.00). Currencies are ISO 4217 codes. Unknown fields are rejected, and every error names the field path, for example `job.obligations.0.amount_minor`.

The bundled example is [`examples/local-runner/demos/calculator-fix/job.json`](../examples/local-runner/demos/calculator-fix/job.json).

```json
{
  "operator": "Acme Robotics",
  "task": { "external_ref": "calculator-fix", "currency": "USD", "budget_minor": 15000 },
  "obligations": [
    {
      "provider": "Beta Workers",
      "description": "Fix the add() bug",
      "amount_minor": 10000,
      "evidence": { "test_report": "evidence/junit.xml", "lint_report": "evidence/eslint.json", "patch_ref": "evidence/fix.diff" }
    }
  ],
  "delegations": [
    { "external_ref": "search-1", "provider_name_stated": "Gamma Search API", "provider_job_ref": "search-job-1", "claims": [{ "type": "completion", "asserted_by": "provider" }] }
  ],
  "financial_events": [
    { "type": "charge", "source": "gamma-billing", "source_event_id": "gamma-inv-1", "amount_minor": 1200, "match": { "provider_job_ref": "search-job-1" } }
  ]
}
```

## Top level

| Field | Required | Meaning |
| --- | --- | --- |
| `operator` | no (default `"Local operator"`) | The buyer's name. It appears as the closure issuer's operator name. |
| `task` | yes | The task. See below. |
| `obligations` | no | Work agreed on the clearing network and cleared by a policy. |
| `delegations` | no | Work bought off the network. |
| `financial_events` | no | Charges, invoices, refunds, fees and other money events from outside the network. |

## `task`

| Field | Required | Meaning |
| --- | --- | --- |
| `external_ref` | yes | Your reference for the task |
| `currency` | yes | The task's currency; obligations, delegations and financial events default to it |
| `budget_minor` | no | Budget; going over it opens a `budget_overrun` exception |
| `customer_ref`, `project_ref`, `cost_center`, `scope_ref`, `shared_description` | no | Your labels, copied into the closure |
| `retrospective`, `occurred_at` | no | Mark a task recorded after the fact, and when it happened |

## `obligations[]`

Each obligation goes through these steps:

1. The buyer offers the obligation and the provider accepts it.
2. The provider submits the evidence files.
3. The policy evaluates the evidence.
4. Clearing posts a balanced journal.
5. Unless `settle` is `false`, the runner simulates payment through the sandbox adapter.

Every step is a signed event, and all of them are recorded on the task as a delegation.

| Field | Required | Meaning |
| --- | --- | --- |
| `provider` | yes | The provider's name; each distinct name gets its own agent and signing key |
| `description` | yes | What was agreed |
| `amount_minor` | yes | The agreed amount |
| `policy` | no (default `code-change-checks@1.0.0`) | `code-change-checks@1.0.0` (no lint errors, 10% platform fee), `code-change-checks@1.1.0` (up to 5 lint errors), or `code-change-subtask@1.0.0` (no platform fee) |
| `required_checks` | no (default `["unit_tests", "lint", "patch"]`) | Checks the policy must pass. `review` needs an independent attestation, which the runner cannot submit, so requiring it yields `insufficient_evidence`. |
| `evidence.test_report` | no | Path to a JUnit XML report, relative to the job file. Every test must pass. |
| `evidence.lint_report` | no | Path to an ESLint JSON report |
| `evidence.patch_ref` | no | Path to a unified diff touching at least one file. Every policy requires it. |
| `completion_note` | no | The provider's note when proposing completion |
| `settle` | no (default `true`) | Simulate paying the provider after clearing |

The decision depends on the evidence:

- **`accepted`:** all required checks pass.
- **`rejected`:** a check fails, for example lint errors.
- **`insufficient_evidence`:** required evidence is missing. The obligation is then left uncleared and nothing is charged for it.

## `delegations[]`

Off-network work. The fields are the same as the hosted API's delegation request body.

| Field | Meaning |
| --- | --- |
| `external_ref` | Your reference; charges can match it with `match.delegation_external_ref` |
| `provider_name_stated`, `provider_own_id` | Who did the work |
| `provider_job_ref` | The provider's job reference; charges can match it with `match.provider_job_ref` |
| `parent_delegation_id` | `"ext:<external_ref>"` of another delegation in this file, for nested work |
| `quoted_max_minor`, `quote_basis`, `quote_valid_until`, `accepted_amount_minor` | Commercial terms |
| `currency` | Defaults to the task's currency |
| `shared_description`, `scope_ref`, `terms_digest`, `expected_delivery` | Description and references |
| `downstream_visibility` | `unknown` (default), `disclosed` or `none`: whether the provider disclosed its own subcontractors |
| `claims` | Delivery statements, in order. See below. |

Each entry in `claims` has these fields:

- **`type`:** `acceptance`, `completion`, `partial_completion`, `cancellation`, `provider_failure`, `terms_update` or `correction`.
- **`asserted_by`:** `buyer` (default) or `provider`. A provider statement relayed by the buyer is labeled as such; it is not provider-verified.
- **`note`:** optional.
- **`evidence`:** optional `{ "uri", "digest", "evidence_type" }` references. The URI must use https, urn, s3 or gs.
- **`terms`:** for `terms_update` only.
- **`supersedes_event_id` and `reason`:** for `correction` only (not usable in a job file; see the end of this page).

## `financial_events[]`

Money events from outside the clearing network. The fields are the same as the hosted API's financial-event request body.

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `quote`, `invoice`, `charge`, `payment_reported`, `refund`, `reversal`, `fee`, `credit`, `adjustment` or `fx_rate` |
| `source`, `source_event_id` | yes | Where the event came from and its ID there. The same pair sent twice with the same content is ignored; with different content it opens a `duplicate_event` exception. |
| `amount_minor` | yes | Non-negative, except for `adjustment` |
| `currency` | no | Defaults to the task's currency |
| `event_date` | no | Defaults to the time of the run |
| `match` | no | Stable references to attribute the event: `task_external_ref`, `delegation_external_ref` or `provider_job_ref` |
| `provider_reference`, `provider_status`, `normalized_status`, `payer`, `liability_owner`, `economic_event_id`, `fx`, `reason`, `evidence` | no | As in the hosted API |

An event is attributed only when exactly one task or delegation matches. No match opens an `unmatched_charge` exception and leaves the event off the task. More than one match opens `ambiguous_match`.

## Not supported by the runner

These fail with an explicit error:

- **References to other recorded events.** `reverses_event_id`, `included_in_event_id`, `settles_event_id` and a claim's `supersedes_event_id` need IDs that are generated during the run, so reversals and corrections can't be written in a job file.
- **Clearing-network features beyond accept, evaluate, clear and settle.** That rules out drafts, open offers, amendments, subcontracted obligations, cancellations and disputes.
- **Evidence other than local files.**

The hosted API supports all of them.
