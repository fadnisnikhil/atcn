import { relative, resolve } from "node:path";
import { runX402Job } from "./run.js";

// npm runs workspace scripts inside the workspace; INIT_CWD is where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
const rel = (path: string) => relative(cwd, path) || ".";

console.log("ATCN + x402: three paid requests, each payment linked to the work it bought\n");
const result = await runX402Job({ dataDir: resolve(cwd, process.env.ATCN_DATA_DIR ?? ".atcn-local"), log: (line) => console.log(line) });

console.log("\nroll-up");
for (const [currency, t] of Object.entries(result.totals)) {
  console.log(`  net cost ${money(t.net_cost, currency)} (charged ${money(t.charged, currency)})`);
  console.log(`  reported paid ${money(t.reported_paid, currency)}, unresolved ${money(t.unresolved, currency)}`);
}
console.log(`\nopen exceptions: ${result.open_exceptions.length}`);
for (const x of result.open_exceptions) console.log(`  ${x.kind}: ${x.detail}`);

console.log("\noffline verification");
console.log(`  ${result.valid ? "VALID  " : "INVALID"} task closure`);
console.log(`\nre-verify: npx atcn-verify ${rel(result.files.closure)} --keys ${rel(result.files.keys)}`);
console.log("\nThe sellers and facilitator are local stand-ins: no chain was contacted and no money moved. USDC is recorded as USD at 1:1.");

process.exitCode = result.valid ? 0 : 1;
