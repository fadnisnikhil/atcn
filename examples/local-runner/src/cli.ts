import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sendUsageReport } from "@atcn/usage";
import { LocalRunnerError } from "./errors.js";
import { loadJob, runJob, type JobResult } from "./job.js";

const VERSION = "1.4.1";
const DEMO_JOB = fileURLToPath(new URL("../demos/calculator-fix/job.json", import.meta.url));

const USAGE = `atcn-local ${VERSION}: capture a job, reconcile its costs, and verify the result on this machine.

usage: atcn-local demo                run the bundled calculator-fix demo ($100 obligation + $12 search charge)
       atcn-local run <job.json>      run your own job file
options:
  --data-dir <dir>   where the runner keeps its signing key and run outputs (default: ./.atcn-local)
  --json             print the result as JSON

No account, API, database, or payment credentials are needed. The runner evaluates the evidence a provider
submits (test, lint, and patch reports) against the agreed policy; it does not execute the delivered code.
Settlement is simulated: no money moves and no payment is confirmed.
Exit code 0 = closure and packages verify, 1 = verification failed, 2 = usage or job file error.`;

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

function printResult(result: JobResult): void {
  console.log("\nroll-up");
  for (const [currency, t] of Object.entries(result.totals)) {
    const parts: [string, number][] = [["invoiced", t.invoiced], ["charged", t.charged], ["fees", t.fees], ["adjustments", t.adjustments], ["refunded", t.refunded], ["credits", t.credits]];
    const breakdown = parts.filter(([, amount]) => amount !== 0).map(([name, amount]) => `${name} ${money(amount, currency)}`).join(", ");
    console.log(`  net cost ${money(t.net_cost, currency)}${breakdown ? ` (${breakdown})` : ""}`);
    console.log(`  reported paid ${money(t.reported_paid, currency)} (sandbox, simulated), unresolved ${money(t.unresolved, currency)}`);
  }
  console.log(`\nopen exceptions: ${result.open_exceptions.length}`);
  for (const x of result.open_exceptions) console.log(`  ${x.kind}: ${x.detail}`);

  console.log("\noffline verification");
  const show = (label: string, report: { valid: boolean; checks: { name: string; ok: boolean; details: string[] }[] }) => {
    console.log(`  ${report.valid ? "VALID  " : "INVALID"} ${label}`);
    for (const check of report.checks.filter((c) => !c.ok)) console.log(`    FAIL ${check.name}: ${check.details.join("; ")}`);
  };
  show("task closure (cross-checked against the obligation packages)", result.verification.closure);
  result.verification.packages.forEach((report, i) => show(`closure package of ${result.obligations[i].obligation_id}`, report));

  const rel = (path: string) => relative(process.cwd(), path) || ".";
  console.log(`\nfiles in ${rel(result.files.dir)}: task-closure.json, keys.json, ledger.json${result.files.packages.length ? ", obligation-*.json" : ""}`);
  const packageArgs = result.files.packages.map((p) => ` --obligation-package ${rel(p)}`).join("");
  console.log(`re-verify: npx @atcn/verify-cli ${rel(result.files.closure)} --keys ${rel(result.files.keys)}${packageArgs}`);
  console.log("\nThe runner evaluated submitted evidence; it did not execute the delivered code. Settlement was simulated.");
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { "data-dir": { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, jobArg, ...extra] = parsed.positionals;
  const isDemo = command === "demo" && jobArg === undefined;
  const isRun = command === "run" && jobArg !== undefined && extra.length === 0;
  if (parsed.values.help || (!isDemo && !isRun)) {
    console.error(USAGE);
    return parsed.values.help ? 0 : 2;
  }

  const jobPath = isDemo ? DEMO_JOB : resolve(jobArg);
  if (!existsSync(jobPath)) {
    console.error(`job file not found: ${jobPath}`);
    return 2;
  }
  const log = parsed.values.json ? undefined : (line: string) => console.log(line);
  let result: JobResult;
  try {
    if (!parsed.values.json) console.log(isDemo ? "ATCN local runner: bundled demo\n" : `ATCN local runner: ${relative(process.cwd(), jobPath)}\n`);
    result = runJob(loadJob(jobPath), { baseDir: dirname(jobPath), dataDir: resolve(parsed.values["data-dir"] ?? ".atcn-local"), log });
  } catch (error) {
    if (!(error instanceof LocalRunnerError)) throw error;
    console.error(error.message);
    return 2;
  }

  if (parsed.values.json) {
    const { closure: _closure, packages: _packages, ...summary } = result;
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printResult(result);
  }

  // Sent only if you opted in to anonymous usage metrics and configured a collector (ATCN_USAGE_URL); off by default.
  if (result.valid) {
    const charges = result.closure.payload.financial_events.filter((e) => e.record.type === "charge").length;
    await sendUsageReport({ event: "closure_verified", sdk_version: `typescript/${VERSION}`, workflow: isDemo ? "demo" : "custom", delegations: result.closure.payload.delegations.length, charges });
  }
  return result.valid ? 0 : 1;
}

process.exitCode = await main();
