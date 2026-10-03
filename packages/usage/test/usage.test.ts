import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { UsageReportSchema, askOnFirstRun, askToShareUsage, readUsageSettings, saveUsageChoice, sendUsageReport, settingsPath, usageStatus, type Env, type UsageEvent } from "../src/index.js";

const URL_ENV = { ATCN_USAGE_URL: "http://collector.test/v1/usage-reports" };
const EVENT: UsageEvent = { event: "task_closed", sdk_version: "typescript/1.3.0", workflow: "custom", delegations: 2, charges: 3 };

function freshEnv(extra: Env = {}): Env {
  return { ATCN_CONFIG_DIR: mkdtempSync(join(tmpdir(), "atcn-usage-")), ...extra };
}

function recordingFetch(bodies: unknown[], status = 202): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status });
  }) as typeof fetch;
}

function answering(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  for (const line of lines) input.write(`${line}\n`);
  return { io: { input, output }, input };
}

describe("usage settings", () => {
  it("is off until the user explicitly says yes, and needs a collector URL", () => {
    const env = freshEnv();
    expect(usageStatus(env)).toMatchObject({ enabled: false, reason: "off: not chosen yet (run npx atcn init)" });
    saveUsageChoice(true, env);
    expect(usageStatus(env)).toMatchObject({ enabled: false, reason: "off until a collector is configured (set ATCN_USAGE_URL)" });
    expect(usageStatus({ ...env, ...URL_ENV })).toMatchObject({ enabled: true, url: URL_ENV.ATCN_USAGE_URL });
  });

  it("keeps the random installation ID while opted in and deletes it on opt-out", () => {
    const env = freshEnv();
    const first = saveUsageChoice(true, env);
    expect(first.installation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saveUsageChoice(true, env).installation_id).toBe(first.installation_id);
    expect(saveUsageChoice(false, env)).toMatchObject({ share_usage: false, installation_id: null });
    expect(JSON.parse(readFileSync(settingsPath(env), "utf8")).installation_id).toBeNull();
    expect(usageStatus({ ...env, ...URL_ENV }).reason).toBe("off: you chose not to share usage metrics");
  });

  it("ATCN_USAGE_DISABLED and DO_NOT_TRACK turn reporting off over a saved yes", () => {
    const env = freshEnv(URL_ENV);
    saveUsageChoice(true, env);
    expect(usageStatus({ ...env, ATCN_USAGE_DISABLED: "1" }).reason).toBe("off: ATCN_USAGE_DISABLED is set");
    expect(usageStatus({ ...env, DO_NOT_TRACK: "1" }).reason).toBe("off: DO_NOT_TRACK is set");
    expect(usageStatus({ ...env, ATCN_USAGE_DISABLED: "0" }).enabled).toBe(true);
  });

  it("treats an unreadable settings file as no choice", () => {
    const env = freshEnv();
    saveUsageChoice(true, env);
    writeFileSync(settingsPath(env), "not json");
    expect(readUsageSettings(env)).toBeNull();
  });
});

describe("usage reports", () => {
  it("accepts only the listed fields", () => {
    const report = { installation_id: "6f1c1f4e-8a0e-4c39-9d5a-3f1f0f6f2a10", occurred_at: "2026-10-03T00:00:00.000Z", ...EVENT };
    expect(UsageReportSchema.safeParse(report).success).toBe(true);
    expect(UsageReportSchema.safeParse({ ...report, task_id: "tsk_1" }).success).toBe(false);
    expect(UsageReportSchema.safeParse({ ...report, sdk_version: "typescript/1.3.0; host=acme" }).success).toBe(false);
    expect(UsageReportSchema.safeParse({ ...report, installation_id: "ten_123" }).success).toBe(false);
  });

  it("sends nothing without an explicit yes", async () => {
    const bodies: unknown[] = [];
    expect(await sendUsageReport(EVENT, { env: freshEnv(URL_ENV), fetch: recordingFetch(bodies) })).toBe(false);
    expect(bodies).toEqual([]);
  });

  it("sends a valid report with the installation ID and timestamp after a yes", async () => {
    const env = freshEnv(URL_ENV);
    const { installation_id } = saveUsageChoice(true, env);
    const bodies: unknown[] = [];
    expect(await sendUsageReport(EVENT, { env, fetch: recordingFetch(bodies) })).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(UsageReportSchema.parse(bodies[0])).toMatchObject({ ...EVENT, installation_id });
  });

  it("never throws when the collector is unreachable or rejects the report", async () => {
    const env = freshEnv(URL_ENV);
    saveUsageChoice(true, env);
    const failing = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    expect(await sendUsageReport(EVENT, { env, fetch: failing })).toBe(false);
    expect(await sendUsageReport(EVENT, { env, fetch: recordingFetch([], 500) })).toBe(false);
  });
});

describe("consent", () => {
  it("saves only an explicit y or n, asking again otherwise", async () => {
    const env = freshEnv();
    const { io } = answering(["", "maybe", "y"]);
    expect(await askToShareUsage(io, env)).toBe(true);
    expect(readUsageSettings(env)?.share_usage).toBe(true);
    const no = answering(["no"]);
    expect(await askToShareUsage(no.io, env)).toBe(false);
    expect(readUsageSettings(env)?.share_usage).toBe(false);
  });

  it("saves nothing if the input closes before an answer", async () => {
    const env = freshEnv();
    const { io, input } = answering([""]);
    input.end();
    expect(await askToShareUsage(io, env)).toBeNull();
    expect(readUsageSettings(env)).toBeNull();
  });

  it("asks on first run only in a terminal, only once, and reports integration_initialized on a yes", async () => {
    const env = freshEnv(URL_ENV);
    const bodies: unknown[] = [];
    await askOnFirstRun("typescript/1.3.0", { env, interactive: false, fetch: recordingFetch(bodies) });
    expect(readUsageSettings(env)).toBeNull();

    await askOnFirstRun("typescript/1.3.0", { env, interactive: true, io: answering(["y"]).io, fetch: recordingFetch(bodies) });
    expect(bodies).toEqual([expect.objectContaining({ event: "integration_initialized", workflow: "demo", sdk_version: "typescript/1.3.0" })]);

    const unanswered = answering([]);
    await askOnFirstRun("typescript/1.3.0", { env, interactive: true, io: unanswered.io, fetch: recordingFetch(bodies) });
    expect(bodies).toHaveLength(1);
  });

  it("does not ask when reporting is turned off by environment", async () => {
    const env = freshEnv({ DO_NOT_TRACK: "1" });
    await askOnFirstRun("typescript/1.3.0", { env, interactive: true, io: answering(["y"]).io });
    expect(readUsageSettings(env)).toBeNull();
  });
});
