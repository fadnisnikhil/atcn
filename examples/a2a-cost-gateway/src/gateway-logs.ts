import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlRows } from "@atcn/subledger";

/**
 * Reads the JSONL event logs written by AliAbdallah21/a2a-cost-gateway (logs/run_*.jsonl, one file per process).
 * Every line is { timestamp, task_id, event_type, actor, payload }; see the schema.md of that repository.
 */

export interface GatewayLogEvent {
  file: string;
  timestamp: string;
  task_id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown>;
}

/** An A2A task the Coordinator delegated, from its task_response event. */
export interface DelegatedTask {
  a2a_task_id: string;
  /** The name on the Agent Card the Coordinator fetched in the same run. */
  agent_name: string | null;
  final_state: string;
  logged_at: string;
}

/** One cost_estimate record, logged by the gateway after the Specialist responded. */
export interface GatewayCostEstimate {
  file: string;
  a2a_task_id: string;
  logged_at: string;
  estimation_method: string;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Null when no rate is configured for the provider (generic_fallback): the gateway has token counts but no price. */
  estimated_cost_usd: number | null;
  scope_note: string;
}

export function readGatewayLogs(dir: string): GatewayLogEvent[] {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("run_") && name.endsWith(".jsonl"))
    .sort();
  return files.flatMap((file) =>
    parseJsonlRows(readFileSync(join(dir, file), "utf8")).map((row) => ({
      file,
      // Python writes "2026-10-07T18:16:24.136811+00:00"; ATCN dates are UTC ISO with a Z.
      timestamp: new Date(String(row.timestamp)).toISOString(),
      task_id: String(row.task_id ?? ""),
      event_type: String(row.event_type),
      actor: String(row.actor),
      payload: (row.payload ?? {}) as Record<string, unknown>,
    })),
  );
}

export function delegatedTasks(events: GatewayLogEvent[]): DelegatedTask[] {
  return events
    .filter((e) => e.actor === "coordinator" && e.event_type === "task_response")
    .map((e) => {
      const task = e.payload.task as { id: string; status: { state: string } };
      const card = events.find((c) => c.file === e.file && c.event_type === "agent_card_fetch");
      return {
        a2a_task_id: task.id,
        agent_name: card ? String(card.payload.name) : null,
        final_state: task.status.state,
        logged_at: e.timestamp,
      };
    });
}

export function costEstimates(events: GatewayLogEvent[]): GatewayCostEstimate[] {
  return events
    .filter((e) => e.actor === "gateway" && e.event_type === "cost_estimate")
    .map((e) => ({
      file: e.file,
      a2a_task_id: e.task_id,
      logged_at: e.timestamp,
      estimation_method: String(e.payload.estimation_method),
      input_tokens: e.payload.input_tokens as number | null,
      output_tokens: e.payload.output_tokens as number | null,
      estimated_cost_usd: e.payload.estimated_cost_usd as number | null,
      scope_note: String(e.payload.scope_note ?? ""),
    }));
}

/** Formats a float USD amount without exponent notation or float noise, for example 4.6499999999999995e-06 as "0.00000465". */
export function formatUsd(usd: number): string {
  return Number(usd.toPrecision(12)).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The ATCN estimate for one cost_estimate record, or null when the gateway logged no dollar figure. ATCN amounts are
 * whole cents, so the amount is rounded to cents and the exact figure is kept in the basis.
 */
export function estimateEvent(estimate: GatewayCostEstimate): Record<string, unknown> | null {
  if (estimate.estimated_cost_usd === null) return null;
  const cents = Math.round(estimate.estimated_cost_usd * 100);
  return {
    type: "estimate",
    source: "a2a-cost-gateway",
    source_event_id: `cost_estimate:${estimate.a2a_task_id}`,
    amount_minor: cents,
    currency: "USD",
    event_date: estimate.logged_at,
    match: { provider_job_ref: estimate.a2a_task_id },
    expectation: {
      issued_by: "gateway",
      source_ref: estimate.file,
      basis: `${estimate.estimation_method}: ${estimate.input_tokens} input + ${estimate.output_tokens} output tokens = USD ${formatUsd(estimate.estimated_cost_usd)} (${cents} cents). ${estimate.scope_note}`,
      expires_at: null,
      supersedes: null,
    },
  };
}
