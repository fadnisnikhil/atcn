import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Backend } from "../src/backend.js";
import { createAtcnMcpServer } from "../src/server.js";

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: any;
}

export function temporaryDir(): string {
  return mkdtempSync(join(tmpdir(), "atcn-mcp-"));
}

/** An MCP client connected in memory to a fresh server over the given backend. */
export async function connect(backend: Backend, dataDir: string) {
  const server = createAtcnMcpServer({ backend, dataDir });
  const client = new Client({ name: "atcn-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, close: () => client.close() };
}

/** The successful result's structured content; fails the test with the tool's message otherwise. */
export function ok(result: ToolResult) {
  if (result.isError) throw new Error(`tool failed: ${result.content.map((c) => c.text).join("\n")}`);
  return result.structuredContent;
}
