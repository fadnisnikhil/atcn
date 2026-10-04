/** Obligation lifecycle (PRD 10.1). The event history is authoritative; state is a projection. */
export const OBLIGATION_STATES = [
  "draft",
  "offered",
  "accepted",
  "active",
  "completion_proposed",
  "cleared",
  "partially_cleared",
  "insufficient_evidence",
  "rejected",
  "disputed",
  "cancelled",
  "expired",
] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

export const OBLIGATION_TRANSITIONS: Record<ObligationState, ObligationState[]> = {
  draft: ["offered", "cancelled"],
  offered: ["accepted", "cancelled", "expired"],
  accepted: ["active", "cancelled", "expired"],
  active: ["completion_proposed", "cancelled", "expired"],
  completion_proposed: ["cleared", "partially_cleared", "insufficient_evidence", "rejected", "disputed", "expired"],
  insufficient_evidence: ["completion_proposed", "cleared", "partially_cleared", "insufficient_evidence", "rejected", "disputed", "expired"],
  cleared: ["disputed", "cleared", "partially_cleared", "rejected", "insufficient_evidence"],
  partially_cleared: ["disputed", "cleared", "partially_cleared", "rejected", "insufficient_evidence"],
  rejected: ["disputed", "cleared", "partially_cleared", "rejected", "insufficient_evidence"],
  disputed: ["cleared", "partially_cleared", "rejected", "completion_proposed", "disputed"],
  cancelled: [],
  expired: [],
};

export function canTransition(from: ObligationState, to: ObligationState): boolean {
  return OBLIGATION_TRANSITIONS[from].includes(to);
}

/** States in which an obligation still holds part of its parent's exposure. */
export const EXPOSURE_HOLDING_STATES: ObligationState[] = [
  "offered",
  "accepted",
  "active",
  "completion_proposed",
  "insufficient_evidence",
  "cleared",
  "partially_cleared",
  "disputed",
];

/** Financial lifecycle (PRD 10.2). Linked to, but independent of, the obligation lifecycle. */
export const FINANCIAL_STATUSES = [
  "estimated",
  "contingent",
  "payable",
  "settlement_submitted",
  "settled",
  "disputed_frozen",
  "settlement_failed",
  "returned",
  "refunded",
  "reversed",
  "unknown",
] as const;
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

/** Clearing outcomes (PRD CL-3). */
export const CLEARING_OUTCOMES = [
  "accepted",
  "partially_accepted",
  "rejected",
  "insufficient_evidence",
  "disputed",
  "cancelled",
  "expired",
] as const;
export type ClearingOutcome = (typeof CLEARING_OUTCOMES)[number];

export const OUTCOME_TO_STATE: Record<ClearingOutcome, ObligationState> = {
  accepted: "cleared",
  partially_accepted: "partially_cleared",
  rejected: "rejected",
  insufficient_evidence: "insufficient_evidence",
  disputed: "disputed",
  cancelled: "cancelled",
  expired: "expired",
};

/**
 * Normalized provider settlement states (PRD ST-3). `pending_finality` means the rail reported the money as sent but
 * can still reverse it (A2A discussion #1576); nothing posts to the journal until a later `settled` report.
 */
export const SETTLEMENT_STATUSES = ["submitted", "processing", "pending_finality", "settled", "failed", "returned", "refunded", "unknown"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_ADAPTERS = ["manual", "sandbox", "stripe"] as const;
export type SettlementAdapter = (typeof SETTLEMENT_ADAPTERS)[number];

/**
 * How long each rail usually takes, and at most should take, to go from `pending_finality` to `settled`. A payment
 * still pending after `max_seconds` is raised as a `finality_overdue` exception. Manual reports are final when made.
 * The Stripe figures follow its standard payout schedule (about two business days; a week covers holidays and delays).
 */
export const RAIL_FINALITY: Record<SettlementAdapter, { expected_seconds: number; max_seconds: number }> = {
  manual: { expected_seconds: 0, max_seconds: 0 },
  sandbox: { expected_seconds: 5, max_seconds: 60 },
  stripe: { expected_seconds: 2 * 86_400, max_seconds: 7 * 86_400 },
};
