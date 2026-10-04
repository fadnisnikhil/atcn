# Quickstart: capture a job, reconcile its costs, verify the result

Everything below runs on your machine. You need Node.js 20 or later and a checkout of this repository. No account, API, database or payment credentials are needed.

```bash
npm ci
```

`npm ci` installs the dependencies and builds every package, which puts the `atcn-local` and `atcn-verify` commands on the `npx` path.

## 1. Run the bundled demo

```bash
npx atcn-local demo
```

The job is in [`examples/local-runner/demos/calculator-fix/job.json`](../examples/local-runner/demos/calculator-fix/job.json). Acme Robotics opens a task with a USD 150 budget and pays for two pieces of work:

- **Beta Workers fixes a calculator bug for USD 100**, agreed as an obligation on the clearing network. Beta submits a JUnit report, an ESLint report and a patch. The `code-change-checks@1.0.0` policy evaluates them and accepts the full amount. Clearing posts a balanced journal: USD 90 to Beta and a USD 10 platform fee. The runner then simulates paying Beta USD 90 through the sandbox adapter.
- **Gamma Search API runs a search, bought off the network.** Gamma's USD 12 charge arrives with the job reference `search-job-1` and is matched to that delegation automatically.

The runner records everything on the task, closes it, and signs the closure. It exports a closure package for the obligation and verifies both documents with the offline verifiers:

```text
roll-up
  net cost USD 112.00 (charged USD 102.00, fees USD 10.00)
  reported paid USD 90.00 (sandbox, simulated), unresolved USD 22.00

open exceptions: 0

offline verification
  VALID   task closure (cross-checked against the obligation packages)
  VALID   closure package of obl_...
```

The USD 22 is unresolved because nothing reported the USD 12 search charge or the USD 10 fee as paid.

## 2. Verify the result yourself

The runner writes each run to `.atcn-local/runs/<time>-<task>/`:

| File | Contents |
| --- | --- |
| `task-closure.json` | The signed task closure: delegations, claims, financial events, roll-up totals, linked obligations |
| `obligation-<id>.json` | The obligation's signed closure package: events, evidence digests, decision, journal, settlement |
| `keys.json` | The public key the runner signed with |
| `ledger.json` | Everything the runner stored, for inspection (no private keys) |

It also prints the verifier command for that run. It looks like this:

```bash
npx @atcn/verify-cli .atcn-local/runs/<run>/task-closure.json \
  --keys .atcn-local/runs/<run>/keys.json \
  --obligation-package .atcn-local/runs/<run>/obligation-<id>.json
```

`atcn-verify` checks the signature, every event digest, delegation lineage, reversals, allocations and roll-up totals. With `--obligation-package`, it also checks that the obligation's journal produces exactly the costs the closure recorded. Change any amount in `task-closure.json` and run it again: it reports INVALID.

A valid signature attests to what the signer stated, not to the truth of the underlying work or payment. The runner signs with a key it generates in `.atcn-local/service-key.json`, so its documents prove consistency on your machine, not a third party's endorsement.

## 3. Run your own job

Copy the demo directory, edit `job.json` and the evidence files, and run it:

```bash
cp -r examples/local-runner/demos/calculator-fix my-job
npx atcn-local run my-job/job.json
```

Try these changes to see how the result moves:

- Set `"errorCount": 2` in `my-job/evidence/eslint.json`. The policy rejects the work, nothing is paid to Beta, and the net cost falls to USD 12.
- Remove the `test_report` evidence. The decision is `insufficient_evidence`, and the obligation is not cleared.
- Change the charge's `match.provider_job_ref` to a reference nobody knows. The charge stays unattributed, an `unmatched_charge` exception opens, and the net cost drops to USD 100 because the charge is not on the task.

The [job file format](JOB_FILE.md) lists every field.

Exit codes: `0` when the closure and every package verify, `1` when verification fails, `2` for a usage or job file error. Add `--json` for machine-readable output, and `--data-dir <dir>` to keep the key and runs somewhere other than `./.atcn-local`.

## 4. Use the packages in your own code

The runner is a thin layer over the public packages. Its source, [`examples/local-runner/src`](../examples/local-runner/src), shows how to call them:

- **`@atcn/core`**: clearing, journals and closure packages.
- **`@atcn/subledger`**: matching, exceptions, roll-up and closures.
- **`@atcn/verifiers`**: evidence checks.
- **`@atcn/schema`**: signing.

To verify documents in your own code, use `verifySubledgerDocument` and `verifyClosurePackage` from `@atcn/sdk`.

The Python SDK (`packages/sdk-python`) covers canonical JSON, Ed25519 event and statement signing, webhook verification, and offline verification of closures, receipts, closure packages and clearing verdicts, with the same reports as `atcn-verify`.
