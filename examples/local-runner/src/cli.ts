import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sendUsageReport } from "@atcn/usage";
import type { ExpectationIssuer } from "@atcn/subledger";
import { LocalRunnerError } from "./errors.js";
import { importIntoJob, importPresetIntoJob, parseColumnMap, parseImportKind, parseImportPreset, type ImportSummary } from "./import.js";
import { loadJob, runJob, type JobResult } from "./job.js";

const VERSION = "1.5.0";
const DEMO_JOB = fileURLToPath(new URL("../demos/calculator-fix/job.json", import.meta.url));

const USAGE = `atcn-local ${VERSION}: capture a job, reconcile its costs, and verify the result on this machine.

usage: atcn-local demo                run the bundled calculator-fix demo ($100 obligation + $12 search charge)
       atcn-local run <job.json>      run your own job file
       atcn-local import <file.csv|file.jsonl> --job <job.json> --source <name> [import options]
                                      add a provider bill or a gateway's estimate/hold log to a job file
       atcn-local import <file> --job <job.json> --preset litellm|openrouter|stripe [--source <name>]
                                      add a LiteLLM, OpenRouter or Stripe export without a column map
options:
  --data-dir <dir>   where the runner keeps its signing key and run outputs (default: ./.atcn-local)
  --json             print the result as JSON
import options:
  --kind <kind>      charge (default), invoice, estimate or hold
  --map f=column     read field f from that column (repeatable), e.g. --map provider_job_ref=a2a_task_id
                     fields: source_event_id, amount_minor, amount_major, currency, event_date, provider_reference,
                     provider_status, provider_job_ref, task_external_ref, delegation_external_ref, issued_by,
                     source_ref, basis, expires_at, supersedes, hold_status
  --key c1,c2        when rows have no event id: the columns that identify a row (its key is their canonical hash)
  --currency <code>  currency when the file has no currency column
  --issued-by <who>  agent, gateway (default) or operator, for estimates and holds without an issued_by column
  --preset <name>    litellm: spend logs, job ref in end_user; openrouter: analytics rows by external_user and day;
                     stripe: itemized balance report, job ref in payment_metadata[atcn_job_ref] or
                     transfer_metadata[atcn_job_ref]. LLM spend is summed per job and UTC day, then rounded to cents.

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
  const report = result.closure.payload.expectation_report;
  if (report) {
    const pct = (bps: number | null) => (bps === null ? "" : ` (${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%)`);
    const t = report.task;
    console.log("\nestimates and holds against actual cost (recorded only; nothing was enforced or reserved)");
    if (t.estimated_minor !== null) console.log(`  estimated ${money(t.estimated_minor, report.currency)}, variance ${money(t.variance_vs_estimate_minor!, report.currency)}${pct(t.variance_vs_estimate_bps)}`);
    if (t.variance_vs_hold_minor !== null) console.log(`  held ${money(t.held_minor, report.currency)}, variance ${money(t.variance_vs_hold_minor, report.currency)}${pct(t.variance_vs_hold_bps)}`);
    console.log(`  actual ${money(t.actual_minor, report.currency)}, of which not estimated ${money(t.unestimated_minor, report.currency)}`);
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
  result.verification.verdicts.forEach((report, i) => show(`clearing verdict for ${result.verdicts[i].payload.obligation_id} (published only; the escrow rail decides whether to release)`, report));

  const rel = (path: string) => relative(process.cwd(), path) || ".";
  console.log(`\nfiles in ${rel(result.files.dir)}: task-closure.json, keys.json, ledger.json${result.files.packages.length ? ", obligation-*.json" : ""}${result.files.verdicts.length ? ", verdict-*.json" : ""}`);
  const packageArgs = result.files.packages.map((p) => ` --obligation-package ${rel(p)}`).join("");
  console.log(`re-verify: npx @atcn/verify-cli ${rel(result.files.closure)} --keys ${rel(result.files.keys)}${packageArgs}`);
  result.verdicts.forEach((v, i) => {
    const pkg = result.files.packages[result.obligations.findIndex((o) => o.obligation_id === v.payload.obligation_id)];
    console.log(`           npx @atcn/verify-cli ${rel(result.files.verdicts[i])} --keys ${rel(result.files.keys)} --obligation-package ${rel(pkg)}`);
  });
  console.log("\nThe runner evaluated submitted evidence; it did not execute the delivered code. Settlement was simulated.");
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        "data-dir": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        job: { type: "string" },
        source: { type: "string" },
        kind: { type: "string" },
        map: { type: "string", multiple: true },
        key: { type: "string" },
        currency: { type: "string" },
        "issued-by": { type: "string" },
        preset: { type: "string" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, jobArg, ...extra] = parsed.positionals;
  if (command === "import" && jobArg !== undefined && extra.length === 0) return runImport(jobArg, parsed.values);
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

/** atcn-local import: appends one financial event per row to the job file, then the job runs as usual. */
function runImport(file: string, values: { job?: string; source?: string; kind?: string; map?: string[]; key?: string; currency?: string; "issued-by"?: string; preset?: string; json?: boolean }): number {
  if (!values.job || (!values.source && !values.preset)) {
    console.error(`import needs --job <job.json> and --source <name> or --preset <name>\n\n${USAGE}`);
    return 2;
  }
  const columnOptions = [values.kind && "--kind", values.map?.length && "--map", values.key && "--key", values.currency && "--currency", values["issued-by"] && "--issued-by"].filter(Boolean);
  if (values.preset && columnOptions.length > 0) {
    console.error(`--preset maps the columns itself; drop ${columnOptions.join(", ")}`);
    return 2;
  }
  try {
    const summary: ImportSummary = values.preset
      ? importPresetIntoJob(resolve(values.job), resolve(file), parseImportPreset(values.preset), { source: values.source })
      : importIntoJob(resolve(values.job), resolve(file), {
          kind: parseImportKind(values.kind ?? "charge"),
          source: values.source!,
          map: parseColumnMap(values.map ?? []),
          keyColumns: values.key ? values.key.split(",").map((c) => c.trim()) : undefined,
          currency: values.currency,
          issuedBy: values["issued-by"] as ExpectationIssuer | undefined,
        });
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else {
      const skipped = values.preset ? `, skipped ${summary.skipped.length}` : "";
      console.log(`added ${summary.added}, already present ${summary.deduplicated}, changed and not added ${summary.conflicting.length}${skipped}, rejected ${summary.errors.length}`);
      for (const c of summary.conflicting) console.log(`  row ${c.row}: ${c.source_event_id} is already in the job with different content; the original is kept`);
      for (const s of summary.skipped) console.log(`  row ${s.row}: skipped, ${s.reason}`);
      for (const e of summary.errors) console.log(`  row ${e.row}: ${e.error}`);
      console.log(`next: atcn-local run ${relative(process.cwd(), resolve(values.job))}`);
    }
    return summary.errors.length > 0 || summary.conflicting.length > 0 ? 1 : 0;
  } catch (error) {
    if (!(error instanceof LocalRunnerError)) throw error;
    console.error(error.message);
    return 2;
  }
}

process.exitCode = await main();
