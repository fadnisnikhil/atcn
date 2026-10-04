import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyClearingVerdict } from "@atcn/core";
import { signPayload } from "@atcn/schema";
import { describe, expect, it } from "vitest";
import { loadJob, loadOrCreateServiceKey, runJob } from "../src/index.js";

const DEMO_DIR = fileURLToPath(new URL("../demos/calculator-fix", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ESCROW = { rail: "a2a-se", escrow_ref: "esc-1" };

/** The bundled demo with its obligation backed by an escrow, run into a fresh data directory. */
function escrowedRun(change: (job: Record<string, any>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "atcn-verdict-"));
  cpSync(DEMO_DIR, dir, { recursive: true });
  const jobPath = join(dir, "job.json");
  const job = loadJob(jobPath) as Record<string, any>;
  job.obligations[0].escrow = ESCROW;
  change(job);
  writeFileSync(jobPath, JSON.stringify(job));
  const dataDir = join(dir, ".atcn-local");
  const result = runJob(loadJob(jobPath), { baseDir: dir, dataDir });
  return { result, serviceKey: loadOrCreateServiceKey(join(dataDir, "service-key.json")) };
}

describe("clearing verdict", () => {
  it("publishes the decision in effect as a signed verdict for the named escrow, verified against its package", () => {
    const { result } = escrowedRun();
    expect(result.valid).toBe(true);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].payload).toMatchObject({
      document_type: "atcn.clearing.verdict",
      obligation_id: result.obligations[0].obligation_id,
      decision: { outcome: "accepted", accepted_amount_minor: 10_000, disputed_amount_minor: 0, pending_amount_minor: 0 },
      final: true,
      escrow: ESCROW,
      stance: "record_only",
    });
    expect(result.verification.verdicts[0].checks.map((c) => [c.name, c.ok])).toEqual([
      ["schema", true],
      ["verdict_signature", true],
      ["closure_package", true],
      ["package_digest", true],
      ["decision", true],
    ]);
    expect(existsSync(result.files.verdicts[0])).toBe(true);
  });

  it("writes no verdict for an obligation without an escrow, or one that was cancelled before any decision", () => {
    expect(escrowedRun((job) => delete job.obligations[0].escrow).result.verdicts).toEqual([]);
    const cancelled = escrowedRun((job) => {
      job.obligations[0].cancel = { reason: "no longer needed" };
      job.obligations[0].evidence = {};
      delete job.obligations[0].completion_note;
    });
    expect(cancelled.result.verdicts).toEqual([]);
  });

  it("refuses an altered verdict, a re-signed one that misstates the decision, and the wrong package", () => {
    const { result, serviceKey } = escrowedRun();
    const trustedKeys = result.trusted_keys;
    const pkg = result.packages[0];

    const altered = structuredClone(result.verdicts[0]);
    altered.payload.decision.accepted_amount_minor = 20_000;
    expect(verifyClearingVerdict(altered, { trustedKeys, closurePackage: pkg }).checks.find((c) => c.name === "verdict_signature")).toMatchObject({ ok: false });

    const misstated = signPayload({ ...altered.payload }, serviceKey);
    const report = verifyClearingVerdict(misstated, { trustedKeys, closurePackage: pkg });
    expect(report.valid).toBe(false);
    expect(report.checks.find((c) => c.name === "decision")!.details).toEqual(["decision.accepted_amount_minor differs from the package"]);

    const other = escrowedRun().result.packages[0];
    expect(verifyClearingVerdict(result.verdicts[0], { trustedKeys: [...trustedKeys, ...escrowedRun().result.trusted_keys], closurePackage: other }).valid).toBe(false);

    const withoutPackage = verifyClearingVerdict(result.verdicts[0], { trustedKeys });
    expect(withoutPackage.valid).toBe(true);
    expect(withoutPackage.checks.at(-1)).toMatchObject({ name: "decision", state: "not_inspected" });
  });

  it("is checked by atcn-verify with --obligation-package", () => {
    const { result } = escrowedRun();
    const output = execFileSync(
      join(REPO_ROOT, "node_modules/.bin/tsx"),
      ["--conditions=atcn-source", join(REPO_ROOT, "packages/verify-cli/src/cli.ts"), result.files.verdicts[0], "--keys", result.files.keys, "--obligation-package", result.files.packages[0]],
      { encoding: "utf8", cwd: dirname(result.files.dir) },
    );
    expect(output).toContain("PASS  decision");
    expect(output).toContain("clearing verdict is VALID");
  });

  it("verifies the fixture the Python SDK verifies, so both read the same verdicts", () => {
    const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "packages/sdk-python/tests/fixtures/clearing-verdict.json"), "utf8"));
    const report = verifyClearingVerdict(fixture.verdict, { trustedKeys: fixture.trusted_keys, closurePackage: fixture.closure_package });
    expect(report.valid).toBe(true);
  });
});
