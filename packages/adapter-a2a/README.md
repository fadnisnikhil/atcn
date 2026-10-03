# @atcn/adapter-a2a

Records paid work delegated over [A2A](https://a2a-protocol.org) (v1.0) as signed ATCN obligation events. The working agent runs the bridge on its own task stream:

| A2A | ATCN |
| --- | --- |
| `TASK_STATE_WORKING` | `obligation.started` |
| Artifact with `metadata.atcn` (`evidence_type`, `verifier`, `deliverable_ids`) | `evidence.submitted` |
| `TASK_STATE_COMPLETED` | `completion.proposed` |
| `FAILED`, `CANCELED`, `REJECTED` | Not recorded; the issuer cancels or the clearing policy decides |

Every event is signed with the working agent's key. Clearing, payment and the task closure follow from those events.

It is not published to npm yet. Use it from this repository: `npm ci` at the root builds it and links it for the examples.

```ts
import { StreamResponse } from "@a2a-js/sdk";
import { A2AObligationBridge, localObligationClient, obligationIdFromMetadata } from "@atcn/adapter-a2a";

// In the working agent's AgentExecutor:
const obligationId = obligationIdFromMetadata(requestContext.userMessage.metadata);
const bridge = new A2AObligationBridge({ client: localObligationClient(network), worker: signer, obligationId });
await bridge.handle(StreamResponse.toJSON({ payload: { $case: "statusUpdate", value: statusUpdate } }));
```

`client` is either an `AtcnClient` from `@atcn/sdk` (hosted API) or `localObligationClient(network)` for the in-memory network from `@atcn/local-runner`, which needs no account. The bridge reads A2A wire JSON, so it works with any A2A SDK; with `@a2a-js/sdk`, `StreamResponse.toJSON` produces it.

The delegating agent puts `obligationTaskMetadata(obligationId)` on the A2A message so the worker knows which obligation the task is for.

A runnable example with two A2A agents over HTTP is in [`examples/a2a-delegation`](../../examples/a2a-delegation).

Part of [ATCN](../../README.md). Apache-2.0.
