# a2a-cost-gateway: the gateway's estimates next to the provider's bill

[a2a-cost-gateway](https://github.com/AliAbdallah21/a2a-cost-gateway) sits between a Coordinator and a Specialist, estimates what each delegated A2A task cost, and logs everything to JSONL. This example reads those logs as they are, imports the provider's bill, matches each charge to its A2A task, and signs a closure that verifies offline.

Nothing is added to a2a-cost-gateway: the example only reads its log files.

```bash
npm ci                     # from the repository root
npm run demo:cost-gateway
```

No account, API key or database is needed.

## Inputs

- [`gateway-logs/`](gateway-logs): the `logs/run_*.jsonl` files from one real run of a2a-cost-gateway at commit [`08c1ead`](https://github.com/AliAbdallah21/a2a-cost-gateway/tree/08c1ead95b217645cfb00878b613bf266d291d5d): the Specialist, the Gateway, and two Coordinator runs through the Gateway (`COORDINATOR_TARGET_URL=http://127.0.0.1:8080 python -m agents.coordinator`). Each Coordinator run delegated one A2A task, and the Gateway logged one `cost_estimate` per task.
- [`litellm-spend.json`](litellm-spend.json): the provider's bill, as LiteLLM proxy spend logs (`/spend/logs/v2`). It is a sample: the toy Specialist only upper-cases its input and calls no model. It shows what a Specialist that calls `gpt-4o-mini` through a LiteLLM proxy, passing the A2A task id as the OpenAI `user` field, would be billed. The spend is priced with the same rates as the gateway's `rate_table.json`.

## What happens

1. **Each delegated A2A task becomes a delegation** whose `provider_job_ref` is the A2A task id, read from the Coordinator's `task_response` event. The provider name is the Agent Card name the Coordinator fetched.
2. **Each `cost_estimate` becomes an estimate** on that delegation, `issued_by: "gateway"`. ATCN amounts are whole cents, so the amount is rounded to cents; the exact figure, the estimation method and the gateway's scope note are kept in the estimate's `basis`. A `generic_fallback` record with no dollar figure is not recorded as an estimate.
3. **The bill is imported** with the `litellm` preset: spend is summed per `end_user` per UTC day and rounded to cents once. A charge is attributed only when its `end_user` is a delegated A2A task id.
4. **The task is closed**, signed and verified offline.

```text
per delegated A2A task: gateway estimate vs billed
  62c22827-2f08-458a-b62b-ad757fa10a52  estimate USD 0.00000465 [after_charge], billed USD 0.03
  cb08c12b-a44c-425f-930a-9c992f1d36c0  estimate USD 0.00000465 [after_charge], billed USD 0.01

roll-up
  net cost USD 0.04 (charged USD 0.04), unresolved USD 0.04

open exceptions: 3
  unmatched_charge: no task or delegation has a matching stable reference
  estimate_after_charge: estimate fev_... issued 2026-10-07T18:16:24.136Z ..., after the first charge on its node; kept, not used as the estimate
  estimate_after_charge: estimate fev_... issued 2026-10-07T18:16:24.374Z ..., after the first charge on its node; kept, not used as the estimate

offline verification
  VALID   task closure
```

The run prints an `npx atcn-verify ...` command for checking the closure yourself. Change any amount in `task-closure.json` and it reports INVALID.

## Reading the result

- **The gap is the gateway's scope.** The gateway counts tokens in the visible A2A message and artifact (3 in, 7 out here), as its scope note says. The bill covers the Specialist's own model calls, which the gateway cannot see.
- **`estimate_after_charge`.** ATCN uses an estimate for the estimate-vs-actual variance only if it is dated before the first charge on its delegation. Here it is not, for two reasons: the gateway logs `cost_estimate` after the Specialist has responded, and the `litellm` preset dates each day's summed charge at 00:00 UTC. ATCN keeps both estimates in the closure with their exact figures, but reports no variance for them.
- **`unmatched_charge`.** One bill row is for an A2A task from an earlier run, not in these logs. It stays off this task and opens an exception instead of being attributed by amount or date.
- **Skipped row.** One bill row has no `end_user`, so it cannot be tied to any task. The import lists it as skipped.

## Using your own logs

```bash
npm run demo:cost-gateway -- path/to/a2a-cost-gateway/logs path/to/litellm-spend.json
```

The bill must reference the A2A task id. With LiteLLM, the Specialist passes the A2A task id as the `user` field of its model calls, and LiteLLM logs it as `end_user`. Without a task id on the bill, charges cannot be matched to tasks.

## Limits

- The bill is a sample; see [Inputs](#inputs).
- Estimates and charges are recorded as given, unsigned (`buyer_recorded`). a2a-cost-gateway does not sign its log, so the closure attests that the operator recorded these figures, not that the gateway produced them.
- `budget_rejection` events have no A2A task id (`task_id: ""`), so they are not matched to anything.
- The local runner stands in for the hosted API. Nothing is enforced and no money moves.
