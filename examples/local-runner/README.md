# @atcn/local-runner

`atcn-local` runs an ATCN job end to end on your machine. It needs no account, API, database or payment credentials. It takes each job through these steps:

1. Generates a signing key.
2. Opens the task and its obligations.
3. Submits the provider's evidence files.
4. Runs the policy evaluator.
5. Posts the balanced journal.
6. Simulates settlement.
7. Records off-network work and charges on the task.
8. Signs the task closure and the obligations' closure packages, and verifies them offline.

```bash
npx @atcn/local-runner demo                # the bundled USD 112 demo
npx @atcn/local-runner run job.json        # your own job
```

Options:

- **`--data-dir <dir>`:** where the key and the run outputs go (default `./.atcn-local`).
- **`--json`:** prints machine-readable output.

Exit codes:

- `0`: everything verifies.
- `1`: verification failed.
- `2`: usage or job file error.

The runner evaluates the evidence a provider submits. It does not run the delivered code. Settlement is simulated and labeled `settlement_simulated_in_sandbox`: no money moves and no payment is confirmed.

- [Quickstart](../../docs/QUICKSTART.md)
- [Job file format](../../docs/JOB_FILE.md)

Part of [ATCN](../../README.md). Apache-2.0.
