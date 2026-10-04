# @atcn/adapter-a2a

Connects [A2A](https://a2a-protocol.org) (Agent2Agent v1.0) agents to [ATCN](https://github.com/fadnisnikhil/atcn), so paid work handed from one agent to another ends up in a cost record that anyone can verify offline. ATCN only records: it never blocks, holds or releases money.

What it gives each side:

- **The agent doing the work** signs its task events as it goes (started, evidence submitted, completed) and can sign its estimate and how the task ended.
- **The agent paying for it** turns A2A tasks into delegations, matches the worker's bills to them through a declared billing reference, and records estimates, signed outcomes and sub-tasks handed further down the chain.

```bash
npm install @atcn/adapter-a2a
```

## Signed task events

The working agent runs the bridge on its own task stream:

| A2A | ATCN |
| --- | --- |
| `TASK_STATE_WORKING` | `obligation.started` |
| Artifact with `metadata.atcn` (`evidence_type`, `verifier`, `deliverable_ids`) | `evidence.submitted` |
| `TASK_STATE_COMPLETED` | `completion.proposed` |
| `FAILED`, `CANCELED`, `REJECTED` | Nothing signed on the obligation (only the issuer may cancel it); the bridge returns a `terminal` action naming the subledger claim to record (`provider_failure` or `cancellation`) |

Every event is signed with the working agent's key. Clearing, payment and the task closure follow from those events.

```ts
import { StreamResponse } from "@a2a-js/sdk";
import { A2AObligationBridge, localObligationClient, obligationIdFromMetadata } from "@atcn/adapter-a2a";

// In the working agent's AgentExecutor:
const obligationId = obligationIdFromMetadata(requestContext.userMessage.metadata);
const bridge = new A2AObligationBridge({ client: localObligationClient(network), worker: signer, obligationId });
await bridge.handle(StreamResponse.toJSON({ payload: { $case: "statusUpdate", value: statusUpdate } }));
```

`client` is either an `AtcnClient` from `@atcn/sdk` (hosted API) or `localObligationClient(network)` for the in-memory network from `@atcn/local-runner`, which needs no account. The bridge reads A2A wire JSON, so it works with any A2A SDK; with `@a2a-js/sdk`, `StreamResponse.toJSON` produces it.

The delegating agent puts `obligationTaskMetadata(obligationId)` on the A2A message so the worker knows which obligation the task is for. `obligationTaskMetadata(obligationId, { skillId })` also names the AgentSkill it wants; the worker reads it with `skillIdFromMetadata`.

Pass `execution` to describe the run in `obligation.started`, so attestations can cite exactly which run, agent version and skill they judged:

```ts
import { AgentCard } from "@a2a-js/sdk";

const bridge = new A2AObligationBridge({
  client,
  worker: signer,
  obligationId,
  execution: { agentCard: AgentCard.toJSON(card), skillId: skillIdFromMetadata(metadata) ?? undefined },
});
```

The run's `execution_id` is `a2a:<task id>`. It records the A2A task and context ids, the card's `version` and digest, and the skill (namespace `a2a`). Optional `model` and `configDigest` are recorded as given; the agent declares them itself. When the obligation's terms name a skill, the network refuses a run of any other skill. After `obligation.started`, `bridge.execution` holds the descriptor; an attestation cites it as `executionBinding(bridge.execution)` from `@atcn/schema`.

## Billing reference

An agent declares what its bills reference with the [billing-reference extension](https://github.com/fadnisnikhil/atcn/blob/main/docs/extensions/billing-ref-v1.md): `billingRefExtension({ billing_ref: "task_id", currency: "USD" })` goes in its Agent Card's `capabilities.extensions`. The buyer records the delegation with `delegationFromA2A({ card, task, currency })`, which takes `provider_job_ref` from that declaration, so the agent's charges match the delegation without a hand-written mapping. Pass `parentDelegationId` when an agent records a sub-task under its own delegation.

## Estimates

An agent can sign its own estimate and send it in task or artifact metadata: `signedEstimateMetadata(estimate, { keyId, privateKey })`. The buyer reads it with `estimateFromMetadata` and records it with `estimateEventFromA2A(estimate, { match, binding })`. With a key binding for the agent's `key_id` it is `provider_key_signed`; without one it is relayed unsigned. Estimates are records only: nothing is reserved and they never count toward net cost. See [ESTIMATES.md](https://github.com/fadnisnikhil/atcn/blob/main/docs/ESTIMATES.md).

## Signed outcomes

An agent signs how its task ended, over its A2A task id, its note and pointers to its evidence:

```ts
import { signedOutcomeMetadata, terminalClaimType } from "@atcn/adapter-a2a";

// Agent side, on a failed task (the same works for "completion" or "partial_completion"):
const metadata = signedOutcomeMetadata(
  { type: terminalClaimType("TASK_STATE_FAILED"), task_id: taskId, occurred_at: new Date().toISOString(), note: "index unavailable; charge refunded", evidence: [] },
  { keyId: "gamma-key", privateKey },
);
```

The buyer reads it from the status update with `outcomeFromMetadata` and records `outcomeClaimFromA2A(outcome, { binding })` on the delegation whose `provider_job_ref` is the task id. The claim is `provider_key_signed` only when the buyer bound the agent's key; the closure verifier re-checks the signature offline (check `signed_claims`). A failed or cancelled delegation that is still billed raises `charge_after_cancellation` until a refund, credit or reversal nets it to zero. The [A2A example](https://github.com/fadnisnikhil/atcn/tree/main/examples/a2a-delegation) publishes the signing key in a card extension (`npm run demo:a2a -- --search-fails`).

## Multi-hop lineage

When an agent hands part of its task to another agent, `lineageMetadata(parentTask, agentName)` on the message that starts the sub-task carries the chain of tasks above it (`metadata.atcn.lineage`, root first; read it with `lineageFromMetadata`). The agent reports its sub-tasks back up with `downstreamMetadata(edges)`, each with the sub-agent's own signed outcome relayed unchanged. The buyer records every edge from `downstreamFromMetadata` as a child delegation (`childDelegationFromA2A(edge, { parentDelegationId, currency, providerId })`) and its outcome with `outcomeClaimFromA2A`. A sub-agent's signed outcome verifies against its own key even though the buyer never dealt with it. An edge that arrives with no outcome is a broken edge: record `brokenEdgeGap(edge, childDelegationId)` as a capture gap, and the closure shows lineage as incomplete with an `incomplete_lineage` exception.

A runnable example with two A2A agents over HTTP is in [`examples/a2a-delegation`](https://github.com/fadnisnikhil/atcn/tree/main/examples/a2a-delegation).

Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
