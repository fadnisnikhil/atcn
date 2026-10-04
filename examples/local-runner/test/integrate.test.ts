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

/** The shell commands of the guide's sh blocks, in order, as argument lists. */
function guideCommands(): string[][] {
  const blocks = [...readFileSync(GUIDE, "utf8").matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
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
});
