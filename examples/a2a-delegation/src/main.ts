import { relative, resolve } from "node:path";
import { runA2ADelegation } from "./run.js";

// npm runs workspace scripts inside the workspace; INIT_CWD is where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
const rel = (path: string) => relative(cwd, path) || ".";

const estimates = process.argv.includes("--with-estimates");
const searchFails = process.argv.includes("--search-fails");
const variants = [estimates ? "with estimates" : null, searchFails ? "the search fails and is refunded" : null].filter((v) => v !== null);
console.log(`ATCN + A2A: one job, two A2A agents, one verified closure${variants.length > 0 ? ` (${variants.join("; ")})` : ""}\n`);
const result = await runA2ADelegation({ dataDir: resolve(cwd, process.env.ATCN_DATA_DIR ?? ".atcn-local"), log: (line) => console.log(line), estimates, searchFails });

console.log("\nroll-up");
for (const [currency, t] of Object.entries(result.totals)) {
  console.log(`  net cost ${money(t.net_cost, currency)} (charged ${money(t.charged, currency)}, fees ${money(t.fees, currency)})`);
  console.log(`  reported paid ${money(t.reported_paid, currency)} (sandbox, simulated), unresolved ${money(t.unresolved, currency)}`);
}
const report = result.closure.payload.expectation_report;
if (report) {
  const bps = (value: number | null) => (value === null ? "n/a" : `${value > 0 ? "+" : ""}${(value / 100).toFixed(2)}%`);
  console.log("\nestimate vs actual (recorded only; nothing was enforced or reserved)");
  console.log(`  estimated ${money(report.task.estimated_minor ?? 0, report.currency)}, actual ${money(report.task.actual_minor, report.currency)}, variance ${money(report.task.variance_vs_estimate_minor ?? 0, report.currency)} (${bps(report.task.variance_vs_estimate_bps)})`);
}
console.log(`\nopen exceptions: ${result.open_exceptions.length}`);
for (const x of result.open_exceptions) console.log(`  ${x.kind}: ${x.detail}`);

console.log("\noffline verification");
console.log(`  ${result.verification.closure.valid ? "VALID  " : "INVALID"} task closure (cross-checked against the obligation package)`);
result.verification.packages.forEach((report, i) => console.log(`  ${report.valid ? "VALID  " : "INVALID"} closure package of ${result.packages[i].payload.root_obligation_id}`));
console.log(`\nre-verify: npx atcn-verify ${rel(result.files.closure)} --keys ${rel(result.files.keys)}${result.files.packages.map((p) => ` --obligation-package ${rel(p)}`).join("")}`);
console.log(`recheck the trace and usage cost: npx atcn-verify ${rel(result.files.packages[0])} --keys ${rel(result.files.keys)}${result.files.traces.map((t) => ` --trace ${rel(t)}`).join("")}`);
console.log("\nThe policy evaluated the submitted reports; it did not run the code. Settlement was simulated.");

process.exitCode = result.valid ? 0 : 1;
