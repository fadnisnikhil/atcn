import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey, type LocalException } from "@atcn/local-runner";
import type { PublicKeyRecord } from "@atcn/schema";
import { verifySubledgerDocument, type SignedClosure, type SubledgerVerificationReport, type Totals } from "@atcn/subledger";
import { recordX402Purchase } from "./record.js";
import { RESOURCES, startSellers } from "./sellers.js";
import { buyWithX402 } from "./x402.js";

export interface X402JobResult {
  task_id: string;
  closure: SignedClosure;
  trusted_keys: PublicKeyRecord[];
  totals: Record<string, Totals>;
  open_exceptions: LocalException[];
  verification: SubledgerVerificationReport;
  valid: boolean;
  files: { dir: string; closure: string; keys: string };
}

export interface RunOptions {
  /** Where the service key and run outputs go. */
  dataDir: string;
  log?: (line: string) => void;
}

const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

/**
 * Acme's research agent prepares one customer brief by buying three resources over x402. Each purchase is recorded on
 * the task as it happens; then the task is closed, signed, and verified offline.
 */
export async function runX402Job(options: RunOptions): Promise<X402JobResult> {
  const log = options.log ?? (() => {});
  const serviceKey = loadOrCreateServiceKey(join(options.dataDir, "service-key.json"));
  const subledger = new LocalSubledger(serviceKey, "Acme Research");
  const sellers = await startSellers();

  try {
    const task = subledger.createTask({ external_ref: "brief-acme-gears", currency: "USD", budget_minor: 500, customer_ref: "customer-42" });
    log(`task ${task.task_id} (${task.external_ref}), budget USD 5.00`);

    for (const [index, resource] of RESOURCES.entries()) {
      const purchase = await buyWithX402(`${sellers.url}${resource.path}`, PAYER);
      const delegation = recordX402Purchase(subledger, task.task_id, `purchase-${index + 1}`, purchase);
      const outcome = purchase.settlement.success ? `paid, tx ${purchase.settlement.transaction.slice(0, 12)}...` : `HTTP ${purchase.status}, ${purchase.settlement.errorReason}`;
      log(`  ${resource.serviceName}: ${purchase.accepted.amount} atomic USDC (${outcome}) -> delegation ${delegation.delegation_id}, ${delegation.delivery_status}`);
    }

    const { closure } = subledger.closeTask(task.task_id, []);
    const trustedKeys = [servicePublicKey(serviceKey)];
    const verification = verifySubledgerDocument(closure, { trustedKeys });

    const dir = join(options.dataDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-x402-payments`);
    mkdirSync(dir, { recursive: true });
    const files = { dir, closure: join(dir, "task-closure.json"), keys: join(dir, "keys.json") };
    writeFileSync(files.closure, `${JSON.stringify(closure, null, 2)}\n`);
    writeFileSync(files.keys, `${JSON.stringify({ items: trustedKeys }, null, 2)}\n`);

    return {
      task_id: task.task_id,
      closure,
      trusted_keys: trustedKeys,
      totals: subledger.summary(task.task_id).rollup.root_total,
      open_exceptions: subledger.exceptions.filter((x) => x.status === "open"),
      verification,
      valid: verification.valid,
      files,
    };
  } finally {
    await sellers.close();
  }
}
