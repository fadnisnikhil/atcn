# A2A delegation: delegated tasks, provider charges, one verified closure

An orchestrator runs one job through two [A2A](https://a2a-protocol.org) v1.0 agents over HTTP on localhost, using the official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk). ATCN records both delegations and the provider's bill, reconciles them, and signs a closure that verifies offline.

```bash
npm ci              # from the repository root
npm run demo:a2a
```

No account, API key, database or payment credentials are needed.

## What happens

1. **Acme's orchestrator opens a task** with a USD 150 budget.
2. **It pays Beta's code-fix agent USD 100.** Beta's agent card advertises its ATCN agent id. The orchestrator offers it an obligation for the card's `code-fix` skill (terms `skill: a2a/code-fix`), then sends the A2A task with `obligationTaskMetadata(obligationId, { skillId: "code-fix" })` on the message. Beta's agent accepts the terms with its own key and runs [`@atcn/adapter-a2a`](../../packages/adapter-a2a) on its own task stream:
   - `TASK_STATE_WORKING` becomes `obligation.started`, declaring the run: the A2A task id, the agent card's version and digest, and the skill. An attestation can cite exactly this run;
   - its test, lint and patch artifacts become `evidence.submitted`;
   - `TASK_STATE_COMPLETED` becomes `completion.proposed`.

   Every event is signed by Beta's agent. The `code-change-checks@1.0.0` policy evaluates the evidence, and clearing posts USD 90 to Beta plus a USD 10 platform fee. Payment is simulated.
3. **It buys a search from Gamma's agent.** Gamma's agent knows nothing about ATCN. The orchestrator records the delegation with the A2A task id as `provider_job_ref`.
4. **It imports Gamma's bill** from Gamma's billing API. The charge for this job's A2A task is matched to the search delegation. A charge for an earlier job matches nothing here, so it stays off the task and opens an `unmatched_charge` exception.
5. **It closes the task.** The signed closure is checked against the obligation's closure package, and both are verified offline.

```text
roll-up
  net cost USD 112.00 (charged USD 102.00, fees USD 10.00)
  reported paid USD 90.00 (sandbox, simulated), unresolved USD 22.00

open exceptions: 1
  unmatched_charge: no task or delegation has a matching stable reference

offline verification
  VALID   task closure (cross-checked against the obligation package)
  VALID   closure package of obl_...
```

The run prints an `npx atcn-verify ...` command for checking the files yourself. Change any amount in `task-closure.json` and run it again: it reports INVALID.

## Using it in your own agents

- **A working agent paid through an obligation:** read the obligation id with `obligationIdFromMetadata(userMessage.metadata)`, then pass each event you publish through `bridge.handle(StreamResponse.toJSON(event))`. See `CodeFixExecutor` in [`src/agents.ts`](src/agents.ts).
- **A provider that bills on its own:** record the delegation with the provider's job reference (here the A2A task id) and import its charges with `match.provider_job_ref`. See steps 3 and 4 in [`src/run.ts`](src/run.ts).

## Limits

- The orchestrator and both agents share one in-memory ATCN network from `@atcn/local-runner`, because they run in one process. With the hosted API, each side uses `AtcnClient` instead. The hosted API is not open for signup yet.
- The policy evaluates the reports the agent submits. It does not run the delivered code.
- Settlement is simulated. No money moves.
