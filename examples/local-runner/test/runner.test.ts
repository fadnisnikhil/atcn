import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signPayload } from "@atcn/schema";
import { verifySubledgerDocument } from "@atcn/subledger";
import { describe, expect, it } from "vitest";
import { LocalRunnerError, loadJob, loadOrCreateServiceKey, runJob } from "../src/index.js";

const DEMO_DIR = fileURLToPath(new URL("../demos/calculator-fix", import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "atcn-local-"));
}

/** A copy of the demo job with its evidence, so a test can change files without touching the bundled demo. */
function demoCopy(change: (job: Record<string, any>) => void = () => {}): { jobPath: string; dir: string } {
  const dir = tempDir();
  cpSync(DEMO_DIR, dir, { recursive: true });
  const jobPath = join(dir, "job.json");
  const job = loadJob(jobPath) as Record<string, any>;
  change(job);
  writeFileSync(jobPath, JSON.stringify(job));
  return { jobPath, dir };
}

function run(jobPath: string, dataDir = tempDir()) {
  return runJob(loadJob(jobPath), { baseDir: dirname(jobPath), dataDir });
}

describe("local runner", () => {
  it("runs the bundled demo: $112 net cost, $90 reported paid, everything verifies", () => {
    const result = run(join(DEMO_DIR, "job.json"));
    expect(result.valid).toBe(true);
    expect(result.obligations).toMatchObject([{ outcome: "accepted", accepted_amount_minor: 10_000, finalized: true, settled_minor: 9_000 }]);
    expect(result.totals.USD).toMatchObject({ charged: 10_200, fees: 1_000, net_cost: 11_200, reported_paid: 9_000, unresolved: 2_200 });
    expect(result.open_exceptions).toEqual([]);
    expect(result.closure.payload.issuer.signed_by).toBe("atcn-local-runner");
    for (const path of [result.files.closure, result.files.keys, result.files.ledger, ...result.files.packages]) expect(existsSync(path)).toBe(true);
    expect(readFileSync(result.files.ledger, "utf8")).not.toContain(loadOrCreateServiceKey(join(dirname(dirname(result.files.dir)), "service-key.json")).privateKey);
  });

  it("detects a tampered closure", () => {
    const result = run(join(DEMO_DIR, "job.json"));
    const tampered = structuredClone(result.closure);
    tampered.payload.financial_events[0].record.amount_minor += 1;
    const report = verifySubledgerDocument(tampered, { trustedKeys: result.trusted_keys, obligationPackages: result.packages });
    expect(report.valid).toBe(false);
  });

  it("rejects work whose lint report has errors, and charges nothing for it", () => {
    const { jobPath, dir } = demoCopy();
    writeFileSync(join(dir, "evidence/eslint.json"), JSON.stringify([{ filePath: "src/math.ts", errorCount: 1, warningCount: 0, messages: [{ ruleId: "no-unused-vars", severity: 2, message: "unused" }] }]));
    const result = run(jobPath);
    expect(result.valid).toBe(true);
    expect(result.obligations).toMatchObject([{ outcome: "rejected", accepted_amount_minor: 0, finalized: true, settled_minor: 0 }]);
    expect(result.totals.USD).toMatchObject({ net_cost: 1_200, reported_paid: 0 });
  });

  it("leaves work with missing evidence uncleared", () => {
    const { jobPath } = demoCopy((job) => {
      job.obligations[0].evidence = { patch_ref: "evidence/fix.diff" };
    });
    const result = run(jobPath);
    expect(result.valid).toBe(true);
    expect(result.obligations).toMatchObject([{ outcome: "insufficient_evidence", finalized: false, settled_minor: 0 }]);
    expect(result.totals.USD.net_cost).toBe(1_200);
  });

  it("reports a charge nobody can be matched to as an open exception", () => {
    const { jobPath } = demoCopy((job) => {
      job.financial_events[0].match.provider_job_ref = "nobody-knows";
    });
    const result = run(jobPath);
    expect(result.valid).toBe(true);
    expect(result.open_exceptions).toMatchObject([{ kind: "unmatched_charge" }]);
    expect(result.totals.USD.net_cost).toBe(10_000);
  });

  it("runs a subledger-only job with no obligations, recording the run a delegation names", () => {
    const llmRun = { execution_id: "req_123", agent: { agent_id: "model-api", agent_version: "2026-09", model: { provider: "example", name: "large", version: "2026-09" } } };
    const dir = tempDir();
    const jobPath = join(dir, "job.json");
    writeFileSync(
      jobPath,
      JSON.stringify({
        task: { external_ref: "research-1", currency: "USD" },
        delegations: [{ external_ref: "llm-call", provider_name_stated: "Model API", execution: llmRun, claims: [{ type: "completion" }] }],
        financial_events: [{ type: "charge", source: "model-billing", source_event_id: "inv-7", amount_minor: 1_150, match: { delegation_external_ref: "llm-call" } }],
      }),
    );
    const result = run(jobPath);
    expect(result.valid).toBe(true);
    expect(result.totals.USD).toMatchObject({ net_cost: 1_150, unresolved: 1_150 });
    expect(result.closure.payload.schema_version).toBe("1.4");
    expect(result.closure.payload.delegations[0].execution).toEqual(llmRun);
  });

  it("explains job file mistakes by path", () => {
    const { jobPath } = demoCopy((job) => {
      job.task.budget = 100;
      job.obligations[0].amount_minor = -5;
    });
    expect(() => run(jobPath)).toThrow(LocalRunnerError);
    expect(() => run(jobPath)).toThrow(/job\.obligations\.0\.amount_minor/);
    const { jobPath: badTask } = demoCopy((job) => {
      job.task.budget = 100;
    });
    expect(() => run(badTask)).toThrow(/task: Unrecognized key: "budget"|task.*budget/);
  });

  it("keeps the signing key between runs, and schema 1.2 closures may not claim the local runner as signer", () => {
    const dataDir = tempDir();
    const first = run(join(DEMO_DIR, "job.json"), dataDir);
    const second = run(join(DEMO_DIR, "job.json"), dataDir);
    expect(second.trusted_keys).toEqual(first.trusted_keys);

    const key = loadOrCreateServiceKey(join(dataDir, "service-key.json"));
    const { obligation_links: _links, ...payload } = first.closure.payload;
    const downgraded = signPayload({ ...payload, schema_version: "1.2" }, key);
    const report = verifySubledgerDocument(downgraded, { trustedKeys: first.trusted_keys });
    expect(report.valid).toBe(false);
    expect(report.checks.flatMap((c) => c.details)).toContain("schema 1.2 does not allow signed_by atcn-local-runner");
  });
});
