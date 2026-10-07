import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUsd } from "./gateway-logs.js";
import { runCostGatewayReconciliation } from "./run.js";

// npm runs workspace scripts inside the workspace; INIT_CWD is where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();
const exampleDir = fileURLToPath(new URL("..", import.meta.url));
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
const rel = (path: string) => relative(cwd, path) || ".";

// Optional: your own gateway logs directory and LiteLLM spend export, instead of the samples in this folder.
const [logsArg, billArg] = process.argv.slice(2);
const logsDir = resolve(cwd, logsArg ?? resolve(exampleDir, "gateway-logs"));
const billPath = resolve(cwd, billArg ?? resolve(exampleDir, "litellm-spend.json"));

console.log("ATCN + a2a-cost-gateway: the gateway's estimates next to the provider's bill, in one verified closure\n");
const result = runCostGatewayReconciliation({ dataDir: resolve(cwd, process.env.ATCN_DATA_DIR ?? ".atcn-local"), logsDir, billPath, log: (line) => console.log(line) });

console.log("\nper delegated A2A task: gateway estimate vs billed");
for (const c of result.comparisons) {
  const estimate = c.gateway_estimate?.estimated_cost_usd;
  const estimateText = estimate === null || estimate === undefined ? "no dollar estimate" : `USD ${formatUsd(estimate)}`;
  console.log(`  ${c.a2a_task_id}  estimate ${estimateText}${c.estimate_status ? ` [${c.estimate_status}]` : ""}, billed ${money(c.billed_minor, "USD")}`);
}

console.log("\nroll-up");
for (const [currency, t] of Object.entries(result.totals)) {
  console.log(`  net cost ${money(t.net_cost, currency)} (charged ${money(t.charged, currency)}), unresolved ${money(t.unresolved, currency)}`);
}

console.log(`\nopen exceptions: ${result.open_exceptions.length}`);
for (const x of result.open_exceptions) console.log(`  ${x.kind}: ${x.detail}`);

console.log("\noffline verification");
console.log(`  ${result.verification.valid ? "VALID  " : "INVALID"} task closure`);
console.log(`\nre-verify: npx atcn-verify ${rel(result.files.closure)} --keys ${rel(result.files.keys)}`);
console.log("\nThe estimates and charges are recorded as given; nothing was enforced, and no money moved.");

process.exitCode = result.verification.valid ? 0 : 1;
