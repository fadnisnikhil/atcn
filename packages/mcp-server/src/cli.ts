import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubledgerClient } from "@atcn/sdk";
import type { Backend } from "./backend.js";
import { HostedBackend } from "./hosted-backend.js";
import { LocalBackend } from "./local-backend.js";
import { SERVER_VERSION, createAtcnMcpServer } from "./server.js";

const USAGE = `atcn-mcp ${SERVER_VERSION}: the ATCN MCP server, on stdio. Agents record tasks, delegations, delivery claims,
costs, estimates and holds, close tasks into signed closures, and verify signed documents offline.

usage: atcn-mcp [--data-dir <dir>]
options:
  --data-dir <dir>   where the server keeps its signing key, recorded state, and closures (default: ./.atcn-mcp)
environment:
  ATCN_API_URL and ATCN_API_KEY   when both are set, record to the hosted ATCN API instead of locally

ATCN is record-only: it never blocks, gates or reserves money. Estimates and holds never count toward net cost.`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ options: { "data-dir": { type: "string" }, help: { type: "boolean" } } });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    console.error(USAGE);
    return 0;
  }
  const apiUrl = process.env.ATCN_API_URL;
  const apiKey = process.env.ATCN_API_KEY;
  if (Boolean(apiUrl) !== Boolean(apiKey)) {
    console.error("hosted mode needs both ATCN_API_URL and ATCN_API_KEY; set both, or neither to record locally");
    return 2;
  }
  const dataDir = resolve(parsed.values["data-dir"] ?? ".atcn-mcp");
  const backend: Backend = apiUrl && apiKey ? new HostedBackend(new SubledgerClient({ baseUrl: apiUrl, apiKey })) : new LocalBackend(dataDir);
  const server = createAtcnMcpServer({ backend, dataDir });
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol, so status goes to stderr.
  console.error(`atcn-mcp ${SERVER_VERSION} on stdio: ${backend.mode} mode, data in ${dataDir}`);
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
