import { countIndependentWitnesses, type Pricing, type RefundTerms, type SkillRef } from "@atcn/schema";
import type { Rollup } from "./rollup.js";
import type { DeliveryClaim, KeyBindingRecord, ResponseRecord } from "./documents.js";
import { buildExpectationReport, expectationExceptions } from "./expectations.js";
import { deliveryStatus, statementConflicts } from "./projection.js";
import { SKILL_BILLED_EVENT_TYPES, type ExceptionKind, type FinancialEventRecord, type SubledgerWitnessPolicy } from "./types.js";
import { billedMinor, usageCheckFor } from "./usage.js";

/** Exception kinds recomputed from current state; they resolve automatically when the condition clears. */
export const DERIVED_EXCEPTION_KINDS: ExceptionKind[] = [
  "budget_overrun",
  "missing_receipt",
  "amount_mismatch",
  "stale_quote",
  "usage_unpriced",
  "usage_cost_mismatch",
  "refund_terms_breach",
  "skill_price_mismatch",
  "witness_quorum_not_met",
  "conflicting_statements",
  "actual_exceeds_estimate",
  "actual_exceeds_hold",
  "hold_not_released",
  "estimate_after_charge",
  "charge_after_cancellation",
];

export interface DerivedException {
  kind: ExceptionKind;
  /** Stable per condition, so re-deriving never duplicates an open exception. */
  dedupe_key: string;
  delegation_id: string | null;
  detail: string;
}

export interface DeriveInput {
  task: { task_id: string; currency: string; budget_minor: number | null; estimate_tolerance_bps?: number };
  delegations: {
    delegation_id: string;
    currency: string;
    quoted_max_minor: number | null;
    accepted_amount_minor: number | null;
    quote_valid_until: string | null;
    expected_delivery: string | null;
    pricing?: Pricing | null;
    refund_terms?: RefundTerms | null;
    execution?: { skill?: SkillRef };
    provider_id?: string | null;
    witness_policy?: SubledgerWitnessPolicy | null;
  }[];
  claims: DeliveryClaim[];
  /** The task's financial events with their current attribution. */
  events: { record: FinancialEventRecord; attributed_to: string }[];
  rollup: Rollup;
  now: string;
  /** Witness statements in effect, each with the registrable domain the service verified for its signing key. */
  witnesses?: { delegation_id: string; witness_id: string; domain: string | null }[];
  /** Verified registrable domains of the buyer operator and of each provider (by provider_id), for witness independence. */
  party_domains?: { operator: string | null; providers: Record<string, string | null> };
  /** Responses to the task's receipts and the delegation each receipt covers, for conflicting_statements. */
  responses?: ResponseRecord[];
  receipts?: { receipt_id: string; delegation_id: string }[];
  /** Key bindings for signed estimates and holds (they affect labels only, not exceptions). */
  key_bindings?: KeyBindingRecord[];
  /** True when deriving as the task is closed: an open hold with nothing charged is then flagged. */
  closing?: boolean;
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
    const billed = billedMinor(node?.direct[d.currency]);
    const claims = input.claims.filter((c) => c.delegation_id === d.delegation_id);
    const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
    const active = claims.filter((c) => !superseded.has(c.event_id));
    const hasDeliveryReceipt = active.some((c) => c.type === "completion" || c.type === "partial_completion");
    if (billed > 0 && !hasDeliveryReceipt) {
      result.push({ kind: "missing_receipt", dedupe_key: `missing_receipt:${d.delegation_id}`, delegation_id: d.delegation_id, detail: `billed ${billed} ${d.currency} with no completion receipt recorded` });
    }
    const status = deliveryStatus(claims);
    if ((status === "cancelled" || status === "provider_failed") && billed > 0) {
      result.push({
        kind: "charge_after_cancellation",
        dedupe_key: `charge_after_cancellation:${d.delegation_id}`,
        delegation_id: d.delegation_id,
        detail: `the delegation is ${status.replace("_", " ")} but ${billed} ${d.currency} is still billed; a refund, credit or reversal of it would net it to zero`,
      });
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
    const usage = usageCheckFor({ delegation_id: d.delegation_id, currency: d.currency, pricing: d.pricing, claims, billed_minor: billed, provider_attested: false });
    if (usage && usage.expected_minor === null) {
      result.push({ kind: "usage_unpriced", dedupe_key: `usage_unpriced:${d.delegation_id}`, delegation_id: d.delegation_id, detail: `usage has no agreed rate: ${usage.unpriced.join(", ")}` });
    } else if (usage && usage.within_tolerance === false) {
      const direction = usage.difference_minor! > 0 ? "above" : "below";
      result.push({
        kind: "usage_cost_mismatch",
        dedupe_key: `usage_cost_mismatch:${d.delegation_id}`,
        delegation_id: d.delegation_id,
        detail: `billed ${billed} ${d.currency} is ${direction} usage cost ${usage.expected_minor} by ${Math.abs(usage.difference_minor!)}, more than the allowed ${usage.allowed_difference_minor}; traces ${usage.trace_digests.join(", ")}`,
      });
    }
    const events = activeEventsOf(input.events, d.delegation_id);
    const refundProblems = d.refund_terms ? refundTermsProblems(d.refund_terms, d.expected_delivery, d.currency, events, claims, input.now) : [];
    if (refundProblems.length > 0) {
      result.push({ kind: "refund_terms_breach", dedupe_key: `refund_terms_breach:${d.delegation_id}`, delegation_id: d.delegation_id, detail: refundProblems.join("; ") });
    }
    const agreedSkill = d.execution?.skill;
    const offSkill = agreedSkill ? events.filter((e) => SKILL_BILLED_EVENT_TYPES.includes(e.type) && e.skill && !sameSkill(e.skill, agreedSkill)) : [];
    if (offSkill.length > 0) {
      const agreedPrice = d.accepted_amount_minor ?? d.quoted_max_minor;
      const billedLines = offSkill.map((e) => `${e.type} ${e.financial_event_id} bills ${skillName(e.skill!)} for ${e.amount_minor} ${e.currency}`);
      result.push({
        kind: "skill_price_mismatch",
        dedupe_key: `skill_price_mismatch:${d.delegation_id}`,
        delegation_id: d.delegation_id,
        detail: `${billedLines.join("; ")}; the delegation agreed ${skillName(agreedSkill!)}${agreedPrice !== null ? ` at ${agreedPrice} ${d.currency}` : ""}`,
      });
    }
    const witnessProblem = d.witness_policy ? witnessQuorumProblem(d.witness_policy, d.delegation_id, d.provider_id ?? null, input) : null;
    if (witnessProblem) {
      result.push({ kind: "witness_quorum_not_met", dedupe_key: `witness_quorum_not_met:${d.delegation_id}`, delegation_id: d.delegation_id, detail: witnessProblem });
    }
  }
  const conflicts = statementConflicts(input.responses ?? [], input.now);
  for (const d of input.delegations) {
    const receiptIds = new Set((input.receipts ?? []).filter((r) => r.delegation_id === d.delegation_id).map((r) => r.receipt_id));
    const onDelegation = conflicts.filter((c) => receiptIds.has(c.subject.slice("receipt:".length, c.subject.indexOf("@"))));
    if (onDelegation.length > 0) {
      result.push({
        kind: "conflicting_statements",
        dedupe_key: `conflicting_statements:${d.delegation_id}`,
        delegation_id: d.delegation_id,
        detail: onDelegation.map((c) => `${c.kind} on ${c.subject} between ${c.signers.join(", ")}`).join("; "),
      });
    }
  }
  const report = buildExpectationReport({
    task: input.task,
    delegations: input.delegations.map((d) => ({ delegation_id: d.delegation_id, provider_id: d.provider_id ?? null })),
    claims: input.claims,
    events: input.events,
    rollup: input.rollup,
    key_bindings: input.key_bindings ?? [],
  });
  if (report) result.push(...expectationExceptions(report, input));
  return result;
}

/** Why a delegation lacks its independent witnesses, or null when enough counted. */
function witnessQuorumProblem(policy: SubledgerWitnessPolicy, delegationId: string, providerId: string | null, input: DeriveInput): string | null {
  const operatorDomain = input.party_domains?.operator ?? null;
  const providerDomain = providerId ? (input.party_domains?.providers[providerId] ?? null) : null;
  const unverified = [operatorDomain === null ? "the buyer operator" : null, providerDomain === null ? "the provider" : null].filter((p) => p !== null);
  if (unverified.length > 0) return `witness independence cannot be checked: ${unverified.join(" and ")} has no verified domain`;
  const candidates = (input.witnesses ?? [])
    .filter((w) => w.delegation_id === delegationId && w.witness_id !== providerId && (policy.witness_provider_ids ?? [w.witness_id]).includes(w.witness_id))
    .map((w) => ({ witness_id: w.witness_id, domain: w.domain }));
  const count = countIndependentWitnesses(candidates, [operatorDomain!, providerDomain!]);
  if (count.counted.length >= policy.min_independent_witnesses) return null;
  const refused = count.refused.map((r) => `${r.witness_id} ${r.reason}`);
  return `${count.counted.length} of ${policy.min_independent_witnesses} required independent witnesses attested${refused.length > 0 ? `; not counted: ${refused.join("; ")}` : ""}`;
}

function sameSkill(a: SkillRef, b: SkillRef): boolean {
  return a.namespace === b.namespace && a.skill_id === b.skill_id;
}

function skillName(skill: SkillRef): string {
  return `${skill.namespace}/${skill.skill_id}`;
}

/** A delegation's events that count: attributed to it, not reversed, and not reversals themselves. */
function activeEventsOf(events: { record: FinancialEventRecord; attributed_to: string }[], delegationId: string): FinancialEventRecord[] {
  const reversed = new Set(events.map((e) => e.record.reverses_event_id).filter((id): id is string => id !== null));
  return events
    .filter((e) => e.attributed_to === delegationId && e.record.type !== "reversal" && !reversed.has(e.record.financial_event_id))
    .map((e) => e.record);
}

const sumOf = (events: FinancialEventRecord[]) => events.reduce((total, e) => total + e.amount_minor, 0);

/**
 * Where the recorded refunds break the agreed refund terms: more refunded than the post-settlement cap, a refund
 * outside the window, or a refund the terms require on failure or timeout that was not made by the window's end.
 */
function refundTermsProblems(terms: RefundTerms, expectedDelivery: string | null, currency: string, events: FinancialEventRecord[], claims: DeliveryClaim[], now: string): string[] {
  const problems: string[] = [];
  const windowMs = terms.after_settlement.window_seconds * 1000;
  const cap = terms.after_settlement.cap_minor;
  const payments = events.filter((e) => e.type === "payment_reported").sort((a, b) => Date.parse(a.event_date) - Date.parse(b.event_date));
  const refunds = events.filter((e) => e.type === "refund");
  const paid = sumOf(payments);
  const refunded = sumOf(refunds);
  if (refunded > cap) problems.push(`refunded ${refunded} ${currency}, more than the agreed cap of ${cap}`);

  const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
  const active = claims.filter((c) => !superseded.has(c.event_id));
  const status = deliveryStatus(claims);
  const delivered = active.some((c) => c.type === "completion" || c.type === "partial_completion");
  let trigger: { reason: "failure" | "timeout"; at: string } | null = null;
  if ((status === "provider_failed" || status === "cancelled") && terms.on_failure === "refund") {
    const failure = active.filter((c) => c.type === "provider_failure" || c.type === "cancellation").at(-1)!;
    trigger = { reason: "failure", at: failure.occurred_at };
  } else if (!delivered && expectedDelivery !== null && expectedDelivery < now && terms.on_timeout === "refund") {
    trigger = { reason: "timeout", at: expectedDelivery };
  }

  if (payments.length > 0) {
    const windowStart = Math.max(Date.parse(payments[0].event_date), trigger ? Date.parse(trigger.at) : 0);
    const windowEnd = new Date(windowStart + windowMs).toISOString();
    for (const r of refunds) {
      if (Date.parse(r.event_date) > windowStart + windowMs) problems.push(`refund ${r.financial_event_id} on ${r.event_date} is after the refund window ended at ${windowEnd}`);
    }
  }
  if (trigger && paid > 0) {
    const required = Math.min(paid, cap);
    const deadline = new Date(Date.parse(trigger.at) + windowMs).toISOString();
    if (now > deadline && refunded < required) problems.push(`the terms require a refund on ${trigger.reason}: ${required} ${currency} was due by ${deadline}, ${refunded} was refunded`);
  }
  return problems;
}

/** Kinds the offline verifier cannot recompute: witness independence needs the domains the service verified. */
export const SERVICE_ONLY_EXCEPTION_KINDS: ExceptionKind[] = ["witness_quorum_not_met"];

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

/**
 * The latest exceptions under derived dedupe keys that a person's resolution keeps closed while the condition holds.
 * A closure lists them so the offline verifier can tell a resolved condition from an omitted one.
 */
export function resolutionsInForce<T extends LatestException & { dedupe_key: string }>(derived: DerivedException[], exceptions: T[]): T[] {
  return derived.flatMap((d) => {
    const latest = exceptions.filter((x) => x.dedupe_key === d.dedupe_key).at(-1) ?? null;
    return latest && derivedExceptionAction(latest, d) === "keep" ? [latest] : [];
  });
}
