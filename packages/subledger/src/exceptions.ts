import type { Rollup } from "./rollup.js";
import type { DeliveryClaim } from "./documents.js";
import type { ExceptionKind } from "./types.js";

/** Exception kinds recomputed from current state; they resolve automatically when the condition clears. */
export const DERIVED_EXCEPTION_KINDS: ExceptionKind[] = ["budget_overrun", "missing_receipt", "amount_mismatch", "stale_quote"];

export interface DerivedException {
  kind: ExceptionKind;
  /** Stable per condition, so re-deriving never duplicates an open exception. */
  dedupe_key: string;
  delegation_id: string | null;
  detail: string;
}

export interface DeriveInput {
  task: { task_id: string; currency: string; budget_minor: number | null };
  delegations: { delegation_id: string; currency: string; quoted_max_minor: number | null; accepted_amount_minor: number | null; quote_valid_until: string | null }[];
  claims: DeliveryClaim[];
  rollup: Rollup;
  now: string;
}

/**
 * Condition-based exceptions recomputed from current state (PRD §6). They resolve automatically when the
 * condition clears. Flags only: the product records an overrun, it never claims to have prevented spend.
 */
export function deriveTaskExceptions(input: DeriveInput): DerivedException[] {
  const result: DerivedException[] = [];
  const rootTotals = input.rollup.root_total[input.task.currency];
  if (input.task.budget_minor !== null && rootTotals && rootTotals.net_cost > input.task.budget_minor) {
    result.push({
      kind: "budget_overrun",
      dedupe_key: `budget_overrun:${input.task.task_id}`,
      delegation_id: null,
      detail: `net cost ${rootTotals.net_cost} ${input.task.currency} exceeds budget ${input.task.budget_minor}; recorded after the fact, not prevented`,
    });
  }
  for (const d of input.delegations) {
    const node = input.rollup.nodes.find((n) => n.node_id === d.delegation_id);
    const own = node?.direct[d.currency];
    const billed = own ? own.invoiced + own.charged + own.fees + own.adjustments - own.credits - own.refunded : 0;
    const claims = input.claims.filter((c) => c.delegation_id === d.delegation_id);
    const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
    const active = claims.filter((c) => !superseded.has(c.event_id));
    const hasDeliveryReceipt = active.some((c) => c.type === "completion" || c.type === "partial_completion");
    if (billed > 0 && !hasDeliveryReceipt) {
      result.push({ kind: "missing_receipt", dedupe_key: `missing_receipt:${d.delegation_id}`, delegation_id: d.delegation_id, detail: `billed ${billed} ${d.currency} with no completion receipt recorded` });
    }
    const agreed = d.accepted_amount_minor ?? d.quoted_max_minor;
    if (agreed !== null && billed > agreed) {
      const basis = d.accepted_amount_minor !== null ? "accepted amount" : "quoted maximum";
      result.push({ kind: "amount_mismatch", dedupe_key: `amount_mismatch:${d.delegation_id}`, delegation_id: d.delegation_id, detail: `billed ${billed} ${d.currency} exceeds ${basis} ${agreed}` });
    }
    const accepted = active.some((c) => c.type === "acceptance");
    if (d.quote_valid_until !== null && d.quote_valid_until < input.now && !accepted) {
      result.push({ kind: "stale_quote", dedupe_key: `stale_quote:${d.delegation_id}`, delegation_id: d.delegation_id, detail: `quote expired at ${d.quote_valid_until} without a recorded acceptance` });
    }
  }
  return result;
}

/** The latest exception recorded under a derived exception's dedupe key. */
export interface LatestException {
  status: string;
  resolved_by: string | null;
  detail: string;
}

/**
 * What to do with a derived exception given the latest one under its dedupe key: a person's resolution of this exact
 * condition stands ("keep"); an open exception whose condition changed shows the current detail ("update_detail");
 * otherwise it is opened, which is a no-op when one is already open.
 */
export function derivedExceptionAction(latest: LatestException | null, derived: DerivedException): "keep" | "update_detail" | "open" {
  if (latest && latest.status !== "open" && latest.resolved_by !== "system" && latest.detail === derived.detail) return "keep";
  if (latest?.status === "open" && latest.detail !== derived.detail) return "update_detail";
  return "open";
}
