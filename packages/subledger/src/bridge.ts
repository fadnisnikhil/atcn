import { agreedAmount } from "@atcn/core";
import { digestOf, type ObligationTerms, type PostingBatch, type PostingLine, type RecordedEvent, type SettlementEvent } from "@atcn/schema";
import type { ClaimAsserter, DeliveryEventType, EvidenceRef, FinancialEventInput, FinancialEventRecord } from "./types.js";

/**
 * Bridge from the clearing network's journal to the buyer's subledger. A delegation backed by an obligation
 * receives one financial event per journal fact; the API records them and the offline verifier recomputes them
 * from the obligation's closure package with this same code.
 */

/** Source of financial events recorded from the clearing network's journal. */
export const CLEARING_SOURCE = "atcn-clearing" as const;

export type ClearingFactType = "charge" | "fee" | "payment_reported" | "refund" | "reversal";

export interface ClearingFact {
  /** The financial event's source_event_id: "<batch_id>:<kind>". */
  key: string;
  type: ClearingFactType;
  amount_minor: number;
  currency: string;
  /** Reversals only: the key of the fact being undone. */
  reverses_key: string | null;
}

const PAYEE_ROLES = ["payee_share", "child_cost", "parent_margin"];

function credited(lines: PostingLine[], match: (line: PostingLine) => boolean): number {
  return lines.filter(match).reduce((sum, line) => sum + line.credit_minor, 0);
}

function fact(batch: PostingBatch, kind: string, type: ClearingFactType, amount: number): ClearingFact[] {
  return amount > 0 ? [{ key: `${batch.batch_id}:${kind}`, type, amount_minor: amount, currency: batch.lines[0].currency, reverses_key: null }] : [];
}

/**
 * Financial facts of one journal batch, from the payer's side:
 * - clearing: a charge (the payee's share, including child cost and margin) and a platform fee;
 * - settlement: a payment report; refund: a refund;
 * - a reversal of a clearing batch, or a return of a settlement: reversals of the undone batch's facts.
 * Contingent, reserve, and dispute-freeze batches are estimates or holds, not costs, and produce nothing.
 */
export function clearingFacts(batch: PostingBatch, undone: PostingBatch | null): ClearingFact[] {
  switch (batch.entry_type) {
    case "clearing":
      return [
        ...fact(batch, "charge", "charge", credited(batch.lines, (l) => l.account_type === "payable" && PAYEE_ROLES.includes(l.allocation_role))),
        ...fact(batch, "fee", "fee", credited(batch.lines, (l) => l.account_type === "platform_fee")),
      ];
    case "settlement":
      return fact(batch, "payment", "payment_reported", credited(batch.lines, (l) => l.account_type === "settlement_reported"));
    case "refund":
      return fact(batch, "refund", "refund", credited(batch.lines, (l) => l.account_type === "refund"));
    case "reversal":
    case "return": {
      if (!undone) return [];
      return clearingFacts(undone, null).map((f) => ({
        key: `${batch.batch_id}:${f.key.slice(f.key.indexOf(":") + 1)}`,
        type: "reversal",
        amount_minor: f.amount_minor,
        currency: f.currency,
        reverses_key: f.key,
      }));
    }
    default:
      return [];
  }
}

/**
 * What backs a settlement report, by the adapter that reported it. ATCN receives every report from the operator,
 * so none is confirmed by the payment provider to ATCN itself: a manual report is the operator's statement, and a
 * Stripe report was checked against Stripe's webhook signature by the operator's own connector before relaying.
 */
export const SETTLEMENT_REPORT_BASIS: Record<SettlementEvent["provider"], string> = {
  manual: "settlement_reported_by_operator",
  stripe: "settlement_relayed_from_stripe_by_operator_connector",
  sandbox: "settlement_simulated_in_sandbox",
};

/**
 * Evidence for the financial events of a batch posted from a settlement report (settlement, refund, return): the
 * report's ID and digest, labeled with its basis. Null for batches not posted from a settlement report.
 */
export function settlementEvidence(batch: PostingBatch, settlementEvents: SettlementEvent[]): EvidenceRef | null {
  const event = settlementEvents.find((e) => e.settlement_event_id === batch.settlement_event_id);
  if (!event) return null;
  return { uri: `urn:atcn:settlement-event:${event.settlement_event_id}`, digest: digestOf(event), evidence_type: SETTLEMENT_REPORT_BASIS[event.provider] };
}

/**
 * The batch whose facts a reversal or return undoes: the reversed batch, or the settlement batch of the
 * returned instruction. Null for every other batch and when the undone batch is not among the given batches.
 */
export function undoneBatch(batch: PostingBatch, batches: PostingBatch[], settlementEvents: SettlementEvent[]): PostingBatch | null {
  if (batch.entry_type === "reversal") return batches.find((b) => b.batch_id === batch.reverses_batch_id) ?? null;
  if (batch.entry_type !== "return") return null;
  const instructionId = settlementEvents.find((e) => e.settlement_event_id === batch.settlement_event_id)?.instruction_id;
  if (!instructionId) return null;
  const settled = new Set(settlementEvents.filter((e) => e.instruction_id === instructionId && e.normalized_status === "settled").map((e) => e.settlement_event_id));
  return batches.find((b) => b.entry_type === "settlement" && b.settlement_event_id !== null && settled.has(b.settlement_event_id)) ?? null;
}

export const CLEARING_FACT_STATUS: Record<ClearingFactType, FinancialEventRecord["normalized_status"]> = {
  charge: "issued",
  fee: "issued",
  payment_reported: "reported_paid",
  refund: "refunded",
  reversal: "reversed",
};

export interface ClearingFactContext {
  batch: PostingBatch;
  settlementEvents: SettlementEvent[];
  obligationId: string;
  delegationId: string;
  providerId: string | null;
  /** Reversals only: the recorded financial event of the fact being undone. */
  reversesEventId: string | null;
}

/** The financial event recorded on the delegation for one clearing fact. Its source key makes retries deduplicate. */
export function clearingFactEvent(fact: ClearingFact, ctx: ClearingFactContext): FinancialEventInput {
  const settlement = ctx.settlementEvents.find((e) => e.settlement_event_id === ctx.batch.settlement_event_id) ?? null;
  return {
    type: fact.type,
    source: CLEARING_SOURCE,
    source_event_id: fact.key,
    provider_id: ctx.providerId,
    provider_reference: settlement?.provider_reference ?? ctx.obligationId,
    amount_minor: fact.amount_minor,
    currency: fact.currency,
    event_date: ctx.batch.posted_at,
    provider_status: settlement?.provider_status ?? null,
    normalized_status: CLEARING_FACT_STATUS[fact.type],
    evidence: settlementEvidence(ctx.batch, ctx.settlementEvents),
    reverses_event_id: ctx.reversesEventId,
    reason: fact.type === "reversal" ? `clearing-network ${ctx.batch.entry_type} batch ${ctx.batch.batch_id}` : null,
    match: { delegation_id: ctx.delegationId },
  };
}

/** Delivery claim recorded for a decision's outcome event. Insufficient evidence and disputed outcomes record none. */
export const CLAIM_BY_OUTCOME_EVENT: Record<string, DeliveryEventType> = {
  "completion.accepted": "completion",
  "completion.partially_accepted": "partial_completion",
  "completion.rejected": "provider_failure",
};

/** A claim recorded from a network event cites that signed event, which is in the obligation's closure package. */
export function networkEventEvidence(event: RecordedEvent): EvidenceRef[] {
  return [{ uri: `urn:atcn:event:${event.payload.event_id}`, digest: event.payload_hash, evidence_type: "atcn_signed_event" }];
}

export interface DecisionEventData {
  decision_id: string;
  outcome: string;
  accepted_amount_minor: number;
  policy_version: string;
  decision_maker: { type: "automated" | "human"; id: string };
}

/**
 * Who stands behind a clearing decision, and the claim's note. A policy decision means the evidence the provider
 * submitted met the agreed policy; ATCN parses that evidence but does not re-run checks against the delivered work.
 */
export function decisionClaim(data: DecisionEventData, policyId: string): { asserted_by: ClaimAsserter; note: string } {
  const result = `${data.outcome}, accepted ${data.accepted_amount_minor} (${data.decision_id})`;
  if (data.decision_maker.type === "human") return { asserted_by: "dispute_reviewer", note: `decided by dispute reviewer ${data.decision_maker.id}: ${result}` };
  return {
    asserted_by: "clearing_policy",
    note: `decided by policy ${policyId}@${data.policy_version} from the provider's submitted evidence: ${result}. ATCN did not re-run checks against the delivered work.`,
  };
}

export interface LinkedObligation {
  obligation_id: string;
  terms: ObligationTerms;
  terms_digest: string;
}

const isoMs = (value: string) => new Date(value).toISOString();

/** Delegation fields of an obligation offered for a subledger task, taken from its signed terms. */
export function obligationDelegationFields(ob: LinkedObligation) {
  return {
    provider_own_id: ob.terms.counterparty_agent_id,
    provider_job_ref: ob.obligation_id,
    shared_description: ob.terms.scope.description.slice(0, 1000),
    currency: ob.terms.currency,
    quoted_max_minor: ob.terms.max_amount_minor,
    quote_basis: `ATCN obligation terms version ${ob.terms.terms_version}`,
    quote_valid_until: isoMs(ob.terms.offer_expires_at),
    terms_digest: ob.terms_digest,
    expected_delivery: isoMs(ob.terms.deadline),
    downstream_visibility: ob.terms.allow_subdelegation ? ("unknown" as const) : ("none" as const),
  };
}

type AcceptedTerms = { quoted_max_minor: number | null; accepted_amount_minor: number | null; terms_digest: string | null; expected_delivery: string | null };

/** Accepted terms that differ from what the delegation records; recorded as a terms_update claim when non-empty. */
export function acceptedTermsChanges(delegation: AcceptedTerms, ob: LinkedObligation): Partial<AcceptedTerms> {
  const accepted: AcceptedTerms = {
    quoted_max_minor: ob.terms.max_amount_minor,
    accepted_amount_minor: agreedAmount(ob.terms),
    terms_digest: ob.terms_digest,
    expected_delivery: isoMs(ob.terms.deadline),
  };
  return Object.fromEntries(Object.entries(accepted).filter(([key, value]) => delegation[key as keyof AcceptedTerms] !== value));
}
