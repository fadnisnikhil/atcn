# LangGraph: one customer job, several paid services, reconciled costs

A [LangGraph](https://github.com/langchain-ai/langgraph) graph prepares a company brief for one customer. Three of its nodes call paid services: a search API, a company-data API and a language model. ATCN matches each provider's bill to the node that caused it, flags what doesn't add up, and signs a closure that verifies offline.

Needs Python 3.10+ and Node.js 20+.

```bash
cd examples/langgraph-paid-services
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python graph.py
```

The three services are deterministic stand-ins in [`services.py`](services.py), so no API keys are needed.

## What happens

1. **Every node that calls a paid service adds a delegation to the graph state:** the provider, the provider's job reference, and the quote if there is one. The `delegations` list uses LangGraph's `operator.add` reducer, so nodes only append.
2. **The `reconcile` node imports the providers' bills.** Each charge carries the provider's job reference. The node writes an ATCN [job file](../../docs/JOB_FILE.md) and runs `npx @atcn/local-runner run job.json --json`.
3. **The local runner matches each charge to its delegation, rolls up the cost, closes the task into a signed closure, and verifies it offline.**

```text
roll-up
  net cost USD 3.27 (charged USD 3.27)
  reported paid USD 0.00, unresolved USD 3.27

open exceptions: 1
  amount_mismatch: billed 240 USD exceeds quoted maximum 200
```

The company-data API quoted USD 2.00 and billed USD 2.40. The closure records the overrun as an open exception instead of hiding it in a total.

## Using it in your own graph

Keep two things from each paid call: the provider's job reference (request id, invoice line reference, run id) and the quote. Append them as a delegation in your node's return value. When the bills arrive, set `match.provider_job_ref` on each charge. The [job file format](../../docs/JOB_FILE.md) lists the other fields: payment reports, refunds, fees, budgets and nested delegations.

## Limits

- The runner keeps everything in memory and writes the signed documents to `.atcn-local/`. The closure proves consistency on your machine, signed with a key the runner generates; it is not a third party's endorsement.
- Charges are matched on the references you pass. A provider that returns no job reference can only be matched by your own `external_ref`.
