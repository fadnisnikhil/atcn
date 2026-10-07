import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey, type LocalException } from "@atcn/local-runner";
import type { PublicKeyRecord } from "@atcn/schema";
import { importPresetRows, parseExportText, verifySubledgerDocument, type SignedClosure, type SubledgerVerificationReport, type Totals } from "@atcn/subledger";
import { costEstimates, delegatedTasks, estimateEvent, formatUsd, readGatewayLogs, type GatewayCostEstimate } from "./gateway-logs.js";

export interface RunOptions {
  /** Where the service key and run outputs go. */
  dataDir: string;
  /** The gateway's logs/ directory (run_*.jsonl files). */
  logsDir: string;
  /** The Specialist's LiteLLM spend logs: the provider's bill, with the A2A task id as end_user. */
  billPath: string;
  log?: (line: string) => void;
}

/** One delegated A2A task: the gateway's estimate next to what the provider billed for it. */
export interface TaskComparison {
  a2a_task_id: string;
  delegation_id: string;
  gateway_estimate: GatewayCostEstimate | null;
  /** The status of the gateway's estimate in the closure's expectation report. */
  estimate_status: string | null;
  billed_minor: number;
}

export interface CostGatewayResult {
  task_id: string;
  comparisons: TaskComparison[];
  closure: SignedClosure;
  trusted_keys: PublicKeyRecord[];
  totals: Record<string, Totals>;
  open_exceptions: LocalException[];
  skipped_bill_rows: { row: number; reason: string }[];
  verification: SubledgerVerificationReport;
  files: { dir: string; closure: string; keys: string };
}

/** The Specialist's dollar budget in the gateway's checked-in gateway/budget_config.json. */
const SPECIALIST_BUDGET_MINOR = 100;

/**
 * Reconciles one Coordinator run of a2a-cost-gateway against the provider's bill:
 *
 * 1. Each A2A task the Coordinator delegated becomes a delegation whose provider_job_ref is the A2A task id.
 * 2. Each gateway cost_estimate becomes a gateway-issued estimate on that delegation.
 * 3. The LiteLLM spend logs are imported; a charge is attributed only when its end_user is a delegated A2A task id.
 * 4. The task is closed, signed, and verified offline.
 */
export function runCostGatewayReconciliation(options: RunOptions): CostGatewayResult {
  const log = options.log ?? (() => {});
  const serviceKey = loadOrCreateServiceKey(join(options.dataDir, "service-key.json"));
  const subledger = new LocalSubledger(serviceKey, "Coordinator operator");

  const events = readGatewayLogs(options.logsDir);
  const tasks = delegatedTasks(events);
  const estimates = costEstimates(events);
  log(`read ${events.length} log events: ${tasks.length} delegated A2A task(s), ${estimates.length} gateway cost estimate(s)`);

  const task = subledger.createTask({ external_ref: "coordinator-run", currency: "USD", budget_minor: SPECIALIST_BUDGET_MINOR });
  log(`task ${task.task_id}, budget USD 1.00 (the Specialist's budget in gateway/budget_config.json)`);

  // 1. One delegation per delegated A2A task.
  const delegationIds = new Map<string, string>();
  for (const t of tasks) {
    const delegation = subledger.createDelegation(task.task_id, { provider_name_stated: t.agent_name, provider_job_ref: t.a2a_task_id, currency: "USD" });
    delegationIds.set(t.a2a_task_id, delegation.delegation_id);
    if (t.final_state === "TASK_STATE_COMPLETED") {
      subledger.appendDelegationEvent(delegation.delegation_id, { type: "completion", asserted_by: "provider", note: "A2A task completed (Coordinator log)", occurred_at: t.logged_at });
    }
    log(`delegation ${delegation.delegation_id} to ${t.agent_name ?? "unknown agent"}, A2A task ${t.a2a_task_id}, ${t.final_state}`);
  }

  // 2. The gateway's estimates.
  for (const estimate of estimates) {
    const body = estimateEvent(estimate);
    if (body === null) {
      log(`  gateway estimate for ${estimate.a2a_task_id}: no dollar figure (${estimate.estimation_method}), not recorded`);
      continue;
    }
    subledger.recordFinancialEvent(body);
    log(`  gateway estimate for ${estimate.a2a_task_id}: USD ${formatUsd(estimate.estimated_cost_usd!)} (${estimate.estimation_method}), logged ${estimate.logged_at}`);
  }

  // 3. The provider's bill. LiteLLM spend is summed per end_user per UTC day and rounded to cents once.
  const bill = importPresetRows("litellm", parseExportText(readFileSync(options.billPath, "utf8")), { source: "litellm" });
  for (const { event } of bill.events) {
    const result = subledger.recordFinancialEvent(event);
    const ref = (event.match as { provider_job_ref: string }).provider_job_ref;
    log(`charge ${event.amount_minor} cents for end_user ${ref}: ${result.attribution ? `attributed to ${result.attribution.delegation_id}` : "not attributed (see exceptions)"}`);
  }
  for (const s of bill.skipped) log(`bill row ${s.row} skipped: ${s.reason}`);
  if (bill.errors.length > 0) throw new Error(`bill rows could not be read: ${bill.errors.map((e) => `row ${e.row}: ${e.error}`).join("; ")}`);

  // 4. Close, sign, and verify offline.
  const { closure } = subledger.closeTask(task.task_id, []);
  const trustedKeys = [servicePublicKey(serviceKey)];
  const verification = verifySubledgerDocument(closure, { trustedKeys });

  const report = closure.payload.expectation_report;
  const comparisons: TaskComparison[] = tasks.map((t) => {
    const delegationId = delegationIds.get(t.a2a_task_id)!;
    const record = report?.records.find((r) => r.node_id === delegationId && r.type === "estimate");
    const node = closure.payload.rollup.nodes.find((n) => n.node_id === delegationId);
    return {
      a2a_task_id: t.a2a_task_id,
      delegation_id: delegationId,
      gateway_estimate: estimates.find((e) => e.a2a_task_id === t.a2a_task_id) ?? null,
      estimate_status: record?.status ?? null,
      billed_minor: node?.direct.USD?.charged ?? 0,
    };
  });

  const dir = join(options.dataDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-a2a-cost-gateway`);
  mkdirSync(dir, { recursive: true });
  const files = { dir, closure: join(dir, "task-closure.json"), keys: join(dir, "keys.json") };
  writeFileSync(files.closure, `${JSON.stringify(closure, null, 2)}\n`);
  writeFileSync(files.keys, `${JSON.stringify({ items: trustedKeys }, null, 2)}\n`);

  return {
    task_id: task.task_id,
    comparisons,
    closure,
    trusted_keys: trustedKeys,
    totals: subledger.summary(task.task_id).rollup.root_total,
    open_exceptions: subledger.exceptions.filter((x) => x.status === "open"),
    skipped_bill_rows: bill.skipped,
    verification,
    files,
  };
}
