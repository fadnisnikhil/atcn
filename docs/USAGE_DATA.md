# Usage data

Nothing in this repository sends usage data unless you configure it to. Reporting is off by default, and no collector address is built in. Turning it on or off never changes what the tools do.

## Requests to an API you configure

The API clients (`AtcnClient` and `SubledgerClient`, in both SDKs) talk only to the `baseUrl` you give them. Every request carries one header naming the SDK and its version, for example `atcn-sdk: typescript/1.3.0` or `atcn-sdk: python/1.3.0`. The clients make no other network calls.

You can add headers with the client's `headers` option (Python: `default_headers`). Bundled examples send `atcn-workflow: demo` so that a server can tell demo runs from your own work.

## Opt-in usage reports

Two things must both be true before any report is sent:

1. **You said yes on this machine.** Run `npx atcn init` or `python -m atcn init`. It asks once, with an explicit choice: "Share anonymous usage metrics to help improve ATCN? [y/n]". Only `y`/`yes` or `n`/`no` count. To answer without the prompt, for example on a server, run `npx atcn init --share-usage yes` (or `no`). No other command asks this question.
2. **You set `ATCN_USAGE_URL`** to the collector that should receive reports. There is no default, so without it nothing is sent, even after a yes.

The answer is saved in `~/.config/atcn/usage.json`. Set `ATCN_CONFIG_DIR` to use another directory. The TypeScript and Python tools share this file. Saying yes creates a random installation ID; saying no deletes it.

### What is sent

| Event | Sent by | When |
| --- | --- | --- |
| `integration_initialized` | `atcn init`, `python -m atcn init` | You answered yes |
| `closure_verified` | `atcn-local` | A run's closure and packages verified |

The `workflow` field says whether a report came from a bundled demo or your own work. `atcn-local demo` reports `demo`, and `atcn-local run <job.json>` reports `custom`.

Each report is one JSON POST with exactly these fields. The schema rejects anything else (`UsageReportSchema` in `@atcn/usage`):

```json
{
  "installation_id": "6f1c1f4e-8a0e-4c39-9d5a-3f1f0f6f2a10",
  "event": "closure_verified",
  "occurred_at": "2026-10-03T12:00:00.000Z",
  "sdk_version": "typescript/1.3.0",
  "workflow": "custom",
  "delegations": 2,
  "charges": 3
}
```

| Field | Contents |
| --- | --- |
| `installation_id` | The random ID created when you said yes |
| `event` | `integration_initialized` or `closure_verified` here. The schema also allows `task_closed` and `exception_resolved`, which only an ATCN API server sends. |
| `occurred_at` | When it happened |
| `sdk_version` | `typescript/<version>` or `python/<version>` |
| `workflow` | `demo` or `custom` |
| `delegations`, `charges` | How many delegations and charges the task had (`null` for `integration_initialized`) |

A report never contains task data, references, amounts, currencies, names, keys or file paths. It is sent with a 2-second timeout, and failures are ignored.

### What never reports

- **The SDK libraries.** They send only the `atcn-sdk` header to the API you configured.
- **The offline verifier.** `atcn-verify`, `verifySubledgerDocument` and `verifyClosurePackage` never contact anyone.

### Turning it off

Any of these turns reporting off and wins over a saved yes:

- Answer no: `npx atcn init --share-usage no`.
- Unset `ATCN_USAGE_URL`.
- Set `ATCN_USAGE_DISABLED=1`.
- Set `DO_NOT_TRACK=1`.

`npx atcn init` and `python -m atcn init` print the current status after saving.
