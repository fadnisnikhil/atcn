import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readUsageSettings, type Env } from "@atcn/usage";
import { runCli } from "../src/init.js";
import { SDK_VERSION } from "../src/client.js";

function freshEnv(): Env {
  return { ATCN_CONFIG_DIR: mkdtempSync(join(tmpdir(), "atcn-init-")), ATCN_USAGE_URL: "http://collector.test/v1/usage-reports" };
}

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
}

function recordingFetch(bodies: unknown[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  }) as typeof fetch;
}

describe("atcn init", () => {
  it("--share-usage yes saves the choice and reports integration_initialized for a custom integration", async () => {
    const env = freshEnv();
    const bodies: unknown[] = [];
    const out = capture();
    expect(await runCli(["init", "--share-usage", "yes"], { env, fetch: recordingFetch(bodies), ...out })).toBe(0);
    expect(readUsageSettings(env)?.share_usage).toBe(true);
    expect(bodies).toEqual([expect.objectContaining({ event: "integration_initialized", workflow: "custom", sdk_version: `typescript/${SDK_VERSION}` })]);
    expect(out.lines.at(-1)).toContain("Usage metrics: on");
  });

  it("--share-usage no saves the choice and sends nothing", async () => {
    const env = freshEnv();
    const bodies: unknown[] = [];
    const out = capture();
    expect(await runCli(["init", "--share-usage", "no"], { env, fetch: recordingFetch(bodies), ...out })).toBe(0);
    expect(readUsageSettings(env)).toMatchObject({ share_usage: false, installation_id: null });
    expect(bodies).toEqual([]);
    expect(out.lines.at(-1)).toBe("Usage metrics: off: you chose not to share usage metrics.");
  });

  it("asks in a terminal when no flag is given", async () => {
    const env = freshEnv();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    input.write("n\n");
    expect(await runCli(["init"], { env, interactive: true, io: { input, output }, ...capture() })).toBe(0);
    expect(readUsageSettings(env)?.share_usage).toBe(false);
  });

  it("refuses to guess outside a terminal, and rejects bad arguments", async () => {
    const env = freshEnv();
    const out = capture();
    expect(await runCli(["init"], { env, interactive: false, ...out })).toBe(2);
    expect(out.lines).toContain("Not an interactive terminal: pass --share-usage yes or --share-usage no.");
    expect(await runCli(["init", "--share-usage", "maybe"], { env, ...capture() })).toBe(2);
    expect(await runCli(["start"], { env, ...capture() })).toBe(2);
    expect(await runCli(["init", "--unknown"], { env, ...capture() })).toBe(2);
    expect(readUsageSettings(env)).toBeNull();
  });
});
