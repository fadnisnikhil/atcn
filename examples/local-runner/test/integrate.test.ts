import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GUIDE = join(ROOT, "docs/INTEGRATE.md");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLIS: Record<string, string> = {
  "atcn-local": join(ROOT, "examples/local-runner/src/cli.ts"),
  "atcn-verify": join(ROOT, "packages/verify-cli/src/cli.ts"),
};

/** The atcn commands of the guide's code blocks in one language (sh: the main walk-through, shell: preset imports). */
function guideCommands(language = "sh"): string[][] {
  const blocks = [...readFileSync(GUIDE, "utf8").matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
  return blocks.flatMap((block) => block.split("\n").filter((line) => line.startsWith("npx atcn-"))).map((line) => line.split(" ").slice(1));
}

function run(dir: string, [cli, ...args]: string[]) {
  const result = spawnSync(TSX, ["--conditions=atcn-source", CLIS[cli], ...args], { cwd: dir, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("docs/INTEGRATE.md, run end to end", () => {
  it("imports the bill and the gateway holds, closes the task, and the closure verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "atcn-integrate-"));
    cpSync(join(ROOT, "docs/integrate"), dir, { recursive: true });
    const commands = guideCommands();
    expect(commands.map((c) => `${c[0]} ${c[1]}`)).toEqual(["atcn-local import", "atcn-local import", "atcn-local run", "atcn-verify .atcn-local/runs/<run>/task-closure.json"]);

    const [importBill, importHolds, runJob, verify] = commands;
    expect(run(dir, importBill).output).toContain("added 6");
    expect(run(dir, importHolds).output).toContain("added 5");
    expect(run(dir, importHolds).output).toContain("added 0, already present 5");

    const job = run(dir, runJob);
    expect(job.status).toBe(0);
    expect(job.output).toContain("net cost USD 5.00");
    expect(job.output).toContain("held USD 5.00, variance USD 0.00");
    expect(job.output).toContain("budget_overrun");
    expect(job.output).toContain("unmatched_charge");
    expect(job.output).toContain("VALID   task closure");

    const runDir = readdirSync(join(dir, ".atcn-local/runs"))[0];
    const verified = run(dir, verify.map((arg) => arg.replace("<run>", runDir)));
    expect(verified.status).toBe(0);
    expect(verified.output).toContain("task closure is VALID");
  }, 60_000);

  it("imports the LiteLLM, OpenRouter and Stripe samples with presets, and the job still closes", () => {
    const dir = mkdtempSync(join(tmpdir(), "atcn-integrate-presets-"));
    cpSync(join(ROOT, "docs/integrate"), dir, { recursive: true });
    const [litellm, openrouter, stripe] = guideCommands("shell");
    expect([litellm, openrouter, stripe].map((c) => c.at(-1))).toEqual(["litellm", "openrouter", "stripe"]);

    expect(run(dir, litellm).output).toContain("added 2, already present 0, changed and not added 0, skipped 1, rejected 0");
    expect(run(dir, litellm).output).toContain("added 0, already present 2");
    expect(run(dir, openrouter).output).toContain("added 2, already present 0, changed and not added 0, skipped 1, rejected 0");
    const stripeImport = run(dir, stripe);
    expect(stripeImport.output).toContain("added 1, already present 0, changed and not added 0, skipped 2, rejected 0");
    expect(stripeImport.output).toContain("row 3: skipped, reporting_category payout is not job cost");

    const events = (JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as { financial_events: { source: string; type: string; amount_minor: number; match: { provider_job_ref: string } }[] }).financial_events;
    expect(events.map((e) => [e.source, e.type, e.amount_minor, e.match.provider_job_ref])).toEqual([
      ["litellm", "charge", 1, "a2a-task-1"],
      ["litellm", "charge", 3, "a2a-task-2"],
      ["openrouter", "charge", 1, "a2a-task-3"],
      ["openrouter", "charge", 3, "a2a-task-4"],
      ["stripe", "payment_reported", 50, "a2a-task-5"],
    ]);

    const job = run(dir, ["atcn-local", "run", "job.json", "--data-dir", ".atcn-local"]);
    expect(job.status).toBe(0);
    expect(job.output).toContain("net cost USD 0.08");
    expect(job.output).toContain("VALID   task closure");
  }, 60_000);
});
