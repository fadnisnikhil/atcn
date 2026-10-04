# A2A delegation: delegated tasks, provider charges, one verified closure

An orchestrator runs one job through two [A2A](https://a2a-protocol.org) v1.0 agents over HTTP on localhost, using the official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk). ATCN records both delegations and the provider's bill, reconciles them, and signs a closure that verifies offline.

```bash
npm ci              # from the repository root
npm run demo:a2a
```

No account, API key, database or payment credentials are needed.

## What happens

1. **Acme's orchestrator opens a task** with a USD 150 budget.
2. **It pays Beta's code-fix agent USD 100.** Beta's agent card advertises its ATCN agent id. The orchestrator offers it an obligation for the card's `code-fix` skill (terms `skill: a2a/code-fix`), with agreed usage prices (terms `pricing`: a USD 99 fixed fee plus model and tool usage at cost, within 1%), then sends the A2A task with `obligationTaskMetadata(obligationId, { skillId: "code-fix" })` on the message. Beta's agent accepts the terms with its own key and runs [`@atcn/adapter-a2a`](../../packages/adapter-a2a) on its own task stream:
   - `TASK_STATE_WORKING` becomes `obligation.started`, declaring the run: the A2A task id, the agent card's version and digest, the model, and the skill. An attestation can cite exactly this run;
   - its test, lint and patch artifacts become `evidence.submitted`;
   - its trace becomes `agent_trace` evidence. Beta's agent builds it from its OpenTelemetry GenAI spans with `traceFromOtelSpans`: two model calls with their token counts and one `run_tests` tool call, bound to the declared run;
   - `TASK_STATE_COMPLETED` becomes `completion.proposed`.

   Every event is signed by Beta's agent. The `agent-usage-checks@1.0.0` policy evaluates the evidence: the test, lint and patch checks, `agent_trace` (the trace belongs to the declared run and uses only its model), and `usage_cost` (the usage, priced at the agreed rates, supports USD 100). Clearing posts USD 90 to Beta plus a USD 10 platform fee. Payment is simulated.
3. **It buys a search from Gamma's agent.** Gamma's agent knows nothing about ATCN's obligations, but its agent card declares the [billing-reference extension](../../docs/extensions/billing-ref-v1.md): its bills reference the A2A task id. The orchestrator records the delegation with `delegationFromA2A`, which takes `provider_job_ref` from that declaration.
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

The run prints `npx atcn-verify ...` commands for checking the files yourself, including one that passes the saved trace with `--trace` so the trace and usage cost are rechecked offline. Change any amount in `task-closure.json` and run it again: it reports INVALID.

## Variations

- `npm run demo:a2a -- --with-estimates` also records Beta's signed USD 95.00 estimate from its task metadata and the orchestrator's own USD 10.00 estimate for the search, and the closure's `expectation_report` compares them with actual cost. Nothing is enforced.
- `npm run demo:a2a -- --search-fails` makes the search fail. Gamma refunds its charge and signs a `provider_failure` outcome over the A2A task id with a key published in its agent card; the orchestrator records it as `provider_key_signed`, the search nets to zero, and the closure check `signed_claims` re-verifies the signature offline.

## Using it in your own agents

- **A working agent paid through an obligation:** read the obligation id with `obligationIdFromMetadata(userMessage.metadata)`, then pass each event you publish through `bridge.handle(StreamResponse.toJSON(event))`. See `CodeFixExecutor` in [`src/agents.ts`](src/agents.ts).
- **A provider that bills on its own:** record the delegation with `delegationFromA2A`, which reads the provider's billing reference from its agent card (here the A2A task id), and import its charges with `match.provider_job_ref`. See steps 3 and 4 in [`src/run.ts`](src/run.ts).

## Limits

- The orchestrator and both agents share one in-memory ATCN network from `@atcn/local-runner`, because they run in one process. With the hosted API, each side uses `AtcnClient` instead. The hosted API is not open for signup yet.
- The policy evaluates the reports the agent submits. It does not run the delivered code.
- The trace is Beta's own claim about its run. ATCN checks that it is consistent with the declared run and the agreed prices, not that the model calls happened; an independent witness, such as the model provider or a gateway, is needed for that.
- Settlement is simulated. No money moves.
