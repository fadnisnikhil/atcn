# @atcn/mcp-server

`atcn-mcp` is an [MCP](https://modelcontextprotocol.io) server for [ATCN](https://github.com/fadnisnikhil/atcn), a cost record for AI agent jobs that anyone can verify. Add it to Claude, Cursor or another MCP host, and the agent can keep track of what each job cost as it works: who it handed work to, what they charged, what was estimated or held, and what doesn't add up. When the job is done, it closes the job into a signed closure and can verify it offline. No SDK code is needed.

A2A records the work that one agent delegates to another. The paid tool calls an agent makes along the way (search APIs, model calls, gateways) would otherwise go unrecorded. This server lets the agent record them as it goes.

**Record-only.** ATCN never blocks, gates or reserves money. Estimates and holds are records of what was expected, and they never count toward net cost. The closure compares them with actual cost.

## Install

By default it runs locally: no account, API or database is needed. It uses the stdio transport.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "atcn": {
      "command": "npx",
      "args": ["-y", "@atcn/mcp-server", "--data-dir", "/Users/you/.atcn-mcp"]
    }
  }
}
```

Cursor (`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "atcn": {
      "command": "npx",
      "args": ["-y", "@atcn/mcp-server", "--data-dir", "/Users/you/.atcn-mcp"]
    }
  }
}
```

`--data-dir` defaults to `./.atcn-mcp` in the directory the host starts the server in. Pass an absolute path, because hosts may start servers from any directory.

From a clone of this repository, run `npm ci && npm run build`, then use `"command": "node"` with `"args": ["/path/to/atcn/packages/mcp-server/bin/atcn-mcp.js", "--data-dir", "..."]`.

## Tools

| Tool | What it records or does |
| --- | --- |
| `create_task` | Opens a task, the root of the cost record for one job. Returns `task_id`; later calls also accept `"ext:<external_ref>"`. |
| `create_delegation` | Work handed to a provider: another agent, or a paid API or tool. Set `external_ref` and `provider_job_ref` so costs and claims match automatically. |
| `record_claim` | A delivery claim: acceptance, completion, partial completion, cancellation, provider failure, terms update or correction. Provider-signed outcome claims carry `signer`. |
| `record_cost` | A charge, invoice, fee, refund, credit, adjustment, reported payment, reversal, quote or FX rate. Payments and refunds can carry a `rail_attestation`. |
| `record_estimate` | An estimate by the agent, a gateway or the operator. A record only: nothing is reserved. |
| `record_hold` | A budget hold that a gateway reported, with its status. A record only: nothing is reserved. |
| `add_provider` | Registers a provider so delegations can name it and its key can be bound. |
| `bind_provider_key` | Binds a provider's Ed25519 public key, so the estimates, holds and outcomes it signs verify. |
| `report_capture_gap` | Part of the delegation chain that was not captured. The closure shows its lineage as incomplete. |
| `task_summary` | The roll-up by currency (net cost, reported paid, unresolved) and the open exceptions. |
| `close_task` | Signs a versioned closure, writes it and the keys that verify it to the data directory, and returns their paths, the digest and a summary. |
| `verify_document` | Verifies a task closure, provider receipt or closure package offline, from a file path or inline JSON. It trusts the server's own service keys automatically; you can add others in `trusted_keys`. |

Input fields use the ATCN subledger schemas. Amounts are integer minor units, and currencies are ISO 4217 codes. Costs, estimates and holds attach to a task or delegation through stable references in `match` only, such as `provider_job_ref` or `delegation_external_ref`. An event without a unique match is kept and opens an exception. Every tool returns a short text summary and the full result as structured JSON. Refused or invalid calls come back as tool errors that carry the reason.

## Local and hosted

- **Local (default).** The server records into an in-process local subledger. It applies the same rules as the hosted API, so its closures pass the same offline verifier. The data directory holds the following:
  - `service-key.json`: the signing key, which never leaves the machine;
  - `state.json`: everything recorded, saved after every change so records survive restarts;
  - `closures/<task_id>.v<version>.json`: the signed closures;
  - `keys.json`: the public keys that verify them.

  You can also check a closure without the server: `npx @atcn/verify-cli <closure.json> --keys keys.json`.
- **Hosted.** Set `ATCN_API_URL` and `ATCN_API_KEY` (in the host config's `"env"`), and the same tools call the hosted ATCN API through `@atcn/sdk`. Closures are still written to the data directory. `verify_document` then trusts the API's published service keys. The hosted API is not open for signup yet.

A valid signature attests to what the signer stated, not to the truth of the underlying work or payment. Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
