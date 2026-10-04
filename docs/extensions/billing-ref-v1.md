# A2A extension: billing reference, v1

**URI:** `https://github.com/fadnisnikhil/atcn/blob/main/docs/extensions/billing-ref-v1.md`
**Status:** proposal (ATCN-namespaced; open to a neutral home if the A2A community wants one)
**Required:** no. Agents that don't declare it, and clients that don't read it, work exactly as before.

## Problem

A buyer that delegates paid work to an A2A agent later gets a bill from that agent's provider. To tie each bill
line to the delegated task, the buyer must know which reference the provider's bills carry. Today that is agreed
out of band, or mapped by hand.

## Declaration

The agent adds one entry to `capabilities.extensions` in its Agent Card:

```json
{
  "uri": "https://github.com/fadnisnikhil/atcn/blob/main/docs/extensions/billing-ref-v1.md",
  "required": false,
  "params": {
    "billing_ref": "task_id",
    "currency": "USD",
    "pricing": [{ "skill_id": "search", "unit": "task", "amount_minor": 1200 }]
  }
}
```

| Param | Required | Meaning |
|---|---|---|
| `billing_ref` | yes | `"task_id"`: bills carry the A2A task id. `"context_id"`: they carry the context id. `{ "metadata_key": "<key>" }`: they carry the string at `task.metadata[<key>]`. |
| `currency` | no | ISO 4217 code for `pricing`. |
| `pricing` | no | Stated prices per AgentSkill id, in integer minor units per `unit` (for example `"task"` or `"call"`). |

No other params are allowed. A client that finds the extension with invalid params should report the error, not
silently ignore the extension.

## Client behaviour

1. Read the card. If it declares the extension, the provider job reference for a task is the declared value:
   `task.id`, `task.contextId`, or `task.metadata[metadata_key]`.
2. Store that reference with the delegation, and match each bill line to the delegation by it, using exact
   matches only.
3. A bill line whose reference matches nothing is an exception to review (ATCN opens `unmatched_charge`), never a
   silent drop. If the declared metadata value is missing from the task, the delegation has no reference, and its
   charges surface the same way.
4. `pricing` is a price the agent states. A client may record it as an estimate to compare with the bill. It is not
   a quote, a reservation or a limit.

## What it does not do

It does not move money, reserve budget or gate execution. It only says which reference the bills carry.

## Reference implementation

- TypeScript: `billingRefFromAgentCard`, `providerJobRefFor`, `statedSkillPrice` in `@atcn/schema`; `billingRefExtension`
  and `delegationFromA2A` in `@atcn/adapter-a2a`.
- Python: `atcn.a2a.billing_ref_from_agent_card`, `provider_job_ref_for`, `stated_skill_price`, `billing_ref_extension`.
- JSON Schema: `packages/schema/schemas/1.2/billing-ref-params.json`. Shared vectors: `packages/schema/test-vectors/billing-ref.json`.
- Worked example: `examples/a2a-delegation`. The search agent declares `billing_ref: "task_id"`, and the orchestrator
  takes `provider_job_ref` from the card.
