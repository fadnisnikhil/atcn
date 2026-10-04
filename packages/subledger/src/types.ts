import { ExecutionDescriptorSchema, PricingSchema, RefundTermsSchema, SkillRefSchema, UsageSummarySchema, type SkillRef } from "@atcn/schema";
import { z } from "zod";

/** Agent Work Subledger record shapes (PRD v1.2 §6-§7). Amounts are integer minor units; currencies are ISO 4217. */

export const Currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code");
export const Minor = z.number().int().refine(Number.isSafeInteger, "amount must be a safe integer");
const Iso = z.iso.datetime();
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** "estimate" and "hold" (schema 1.5) record what was expected before work ran; they are never costs. */
export const FINANCIAL_EVENT_TYPES = ["quote", "invoice", "charge", "payment_reported", "refund", "reversal", "fee", "credit", "adjustment", "fx_rate", "estimate", "hold"] as const;
export type FinancialEventType = (typeof FINANCIAL_EVENT_TYPES)[number];

/**
 * Normalized status vocabulary; the provider's original status is always kept beside it. "pending_finality" (schema
 * 1.5) is a payment the rail reports as settled that can still be reversed until the rail's finality window ends.
 */
export const NORMALIZED_STATUSES = ["quoted", "issued", "pending", "reported_paid", "pending_finality", "failed", "refunded", "reversed", "void", "unknown"] as const;

/** Financial event types that bill for work and so may name the skill billed (schema 1.5). */
export const SKILL_BILLED_EVENT_TYPES: readonly FinancialEventType[] = ["quote", "invoice", "charge"];

/**
 * Estimates and holds (schema 1.5): what the agent, a budget gateway or the operator expected a piece of work to cost
 * before it ran. ATCN records them and reports the gap against actual cost; it never enforces, blocks or reserves.
 */
export const EXPECTATION_EVENT_TYPES: readonly FinancialEventType[] = ["estimate", "hold"];
export const EXPECTATION_ISSUERS = ["agent", "gateway", "operator"] as const;
export type ExpectationIssuer = (typeof EXPECTATION_ISSUERS)[number];
export const HOLD_STATUSES = ["open", "captured", "released", "expired"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

/**
 * A signature by a key bound to a registered provider (an agent's provider or a gateway), over the statement of an
 * estimate, a hold, or a terminal delivery claim (schema 1.5).
 */
export const KeySignerSchema = z.strictObject({
  provider_id: z.string().min(1),
  binding_id: z.string().min(1),
  key_id: z.string().min(1),
  value: z.string().min(1),
});
export type KeySigner = z.infer<typeof KeySignerSchema>;

export const ExpectationSchema = z.strictObject({
  /** Who made the estimate or hold. */
  issued_by: z.enum(EXPECTATION_ISSUERS),
  /** The issuer's own reference, such as a gateway request ID. */
  source_ref: z.string().max(200).nullable(),
  /** How the amount was worked out, for example "max tokens x rate". */
  basis: z.string().max(500).nullable(),
  expires_at: Iso.nullable(),
  /** The source_event_id (same source) of the earlier estimate, or earlier record of the same hold, this one replaces. */
  supersedes: z.string().max(200).nullable(),
  /** Holds only: the hold's status as of this record. */
  hold_status: z.enum(HOLD_STATUSES).optional(),
  /** Absent when the operator recorded it; the record is then buyer_recorded. */
  signer: KeySignerSchema.optional(),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

/**
 * A payment rail's own record of a payment or refund (schema 1.5), for example an A2A-SE escrow attestation with its
 * Merkle inclusion proof. `scheme` names the format; `record` is the rail's record exactly as received.
 */
export const RailAttestationSchema = z.strictObject({
  scheme: z.string().min(1).max(200),
  record: z.record(z.string(), z.unknown()),
});
export type RailAttestation = z.infer<typeof RailAttestationSchema>;
export const RAIL_ATTESTED_EVENT_TYPES: readonly FinancialEventType[] = ["payment_reported", "refund"];

export const PAYERS = ["buyer", "provider", "other"] as const;

export const DELIVERY_EVENT_TYPES = ["acceptance", "completion", "partial_completion", "cancellation", "provider_failure", "terms_update", "correction"] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/** Outcome claims the provider may sign with its bound key (schema 1.5): how its work ended. */
export const SIGNED_CLAIM_TYPES = ["completion", "partial_completion", "cancellation", "provider_failure"] as const;
export type SignedClaimType = (typeof SIGNED_CLAIM_TYPES)[number];

/**
 * Who made a delivery statement. Callers record "buyer" or "provider" (relayed by the buyer). The other values are
 * recorded only from clearing-network events: "clearing_policy" for a decision computed by the agreed policy from
 * submitted evidence, "dispute_reviewer" for a decision by the human reviewer named in the terms, and
 * "clearing_network" for automatic rules such as expiry.
 */
export const CLAIM_ASSERTERS = ["buyer", "provider", "clearing_policy", "dispute_reviewer", "clearing_network"] as const;
export type ClaimAsserter = (typeof CLAIM_ASSERTERS)[number];

export const EXCEPTION_KINDS = [
  "budget_overrun",
  "unmatched_charge",
  "ambiguous_match",
  "missing_receipt",
  "duplicate_event",
  "amount_mismatch",
  "currency_mismatch",
  "stale_quote",
  "refund_after_close",
  "allocation_changed_after_close",
  "incomplete_lineage",
  "usage_unpriced",
  "usage_cost_mismatch",
  /** A refund exceeds the agreed post-settlement cap or window, or a refund the terms require was not made. */
  "refund_terms_breach",
  /** A quote, invoice or charge names a different skill from the one delegated. */
  "skill_price_mismatch",
  /** Fewer independent witnesses attested to the run than the delegation requires. */
  "witness_quorum_not_met",
  /** Signed provider statements bound to the same receipt contradict each other. */
  "conflicting_statements",
  /** An estimate or hold matched no task or delegation, or several. */
  "unmatched_estimate",
  /** Actual cost on a node exceeds its estimate (beyond the task's tolerance). Recorded, not prevented. */
  "actual_exceeds_estimate",
  /** Actual cost on a node exceeds what is held for it. Recorded, not prevented. */
  "actual_exceeds_hold",
  /** A hold is still open past its expiry, or at close with nothing charged. */
  "hold_not_released",
  /** An estimate was issued after the first charge on its node; it is kept but not used as the estimate. */
  "estimate_after_charge",
  /** A cancelled or failed delegation still has billed cost that no refund, credit or reversal nets to zero. */
  "charge_after_cancellation",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** Trust labels kept separate on every screen and export (PRD §16 "Identity assurance"). Never collapsed into "verified". */
export const ASSURANCE_LABELS = [
  "issuer_signed",
  "buyer_recorded",
  /** Recorded automatically by the clearing network from a signed network event the claim cites (schema 1.3). */
  "network_recorded",
  "recipient_viewed",
  "link_authenticated_response",
  "provider_identity_bound",
  "provider_key_signed",
  "contested",
  "superseded",
  /** A response statement past its signed expires_at at the document's time (schema 1.4). */
  "expired",
  /** A response statement revoked by a later statement from the same provider (schema 1.4). */
  "revoked",
  /** An estimate or hold signed by a budget gateway's bound key (schema 1.5). */
  "gateway_signed",
  /** A payment or refund backed by the rail's own attestation, verified offline (schema 1.5). Not operator-reported. */
  "rail_attested",
] as const;
export type AssuranceLabel = (typeof ASSURANCE_LABELS)[number];

export const RESPONSE_TYPES = ["acknowledge_view", "acknowledge_delivery", "submit_evidence", "propose_correction", "signed_attestation"] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

/** "witness_attestation" (schema 1.5) lets an independent witness sign a statement that it observed the run. */
export const SHARE_ACTIONS = ["view", "acknowledge_delivery", "submit_evidence", "propose_correction", "signed_attestation", "witness_attestation"] as const;
export type ShareAction = (typeof SHARE_ACTIONS)[number];

/** Receipt fields a provider may attest to or contest. Attesting one never implies the others (acceptance 16). */
export const ATTESTABLE_FIELDS = ["delivery.status", "delivery.evidence", "scope.terms_digest", "financial.amounts", "financial.status", "delivery.usage"] as const;
export type AttestableField = (typeof ATTESTABLE_FIELDS)[number];

/** Schema 1.5 added "delivery.usage". Documents of earlier versions disclose exactly these fields. */
const ATTESTABLE_FIELDS_BEFORE_1_5: readonly AttestableField[] = ["delivery.status", "delivery.evidence", "scope.terms_digest", "financial.amounts", "financial.status"];

export function attestableFieldsFor(schemaVersion: string): readonly AttestableField[] {
  return ["1.2", "1.3", "1.4"].includes(schemaVersion) ? ATTESTABLE_FIELDS_BEFORE_1_5 : ATTESTABLE_FIELDS;
}

/** The usage of a run as recorded on a delivery claim: the trace's summary and the digest of the full trace, which stays with its holder. */
export const UsageRecordSchema = z.strictObject({
  trace_digest: Digest,
  summary: UsageSummarySchema,
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** Delivery claims that may carry usage. */
export const USAGE_CLAIM_TYPES: readonly string[] = ["completion", "partial_completion"];

/** Evidence stays in its source system; only references and digests are stored. Script-capable schemes are refused. */
export const EvidenceRefSchema = z.object({
  uri: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^(https:\/\/|urn:|s3:\/\/|gs:\/\/)/, "evidence uri must use https, urn, s3, or gs"),
  digest: Digest.nullable(),
  evidence_type: z.string().min(1).max(100),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Why part of a delegation chain was not captured. broken_edge: a reported sub-task arrived with no outcome. */
export const CAPTURE_GAP_KINDS = ["capture_failed", "queue_overflow", "provider_undisclosed", "manual_gap", "broken_edge"] as const;

export const CaptureGapInputSchema = z.object({
  delegation_id: z.string().nullable().default(null),
  kind: z.enum(CAPTURE_GAP_KINDS),
  detail: z.string().min(1).max(2000),
});
export type CaptureGapInput = z.infer<typeof CaptureGapInputSchema>;

export const TaskInputSchema = z.object({
  external_ref: z.string().min(1).max(200),
  currency: Currency,
  budget_minor: Minor.nonnegative().nullable().default(null),
  customer_ref: z.string().max(200).nullable().default(null),
  project_ref: z.string().max(200).nullable().default(null),
  cost_center: z.string().max(200).nullable().default(null),
  scope_ref: z.string().max(500).nullable().default(null),
  shared_description: z.string().max(1000).nullable().default(null),
  retrospective: z.boolean().default(false),
  occurred_at: Iso.nullable().default(null),
  /** Schema 1.5: how far actual cost may exceed an estimate, in basis points, before actual_exceeds_estimate opens. */
  estimate_tolerance_bps: z.number().int().min(0).max(100_000).optional(),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const ProviderInputSchema = z.object({
  name: z.string().min(1).max(200),
  provider_own_id: z.string().max(200).nullable().default(null),
  domain: z.string().max(253).nullable().default(null),
});

/**
 * Independent witnesses a delegation requires (schema 1.5). A witness is a registered provider other than the
 * delegation's own, signing with a domain-challenged key; it counts only if that registrable domain differs from the
 * provider's, the buyer operator's and every other counted witness's. Too few raise witness_quorum_not_met.
 */
export const SubledgerWitnessPolicySchema = z.strictObject({
  min_independent_witnesses: z.number().int().min(1).max(10),
  /** If set, only these providers may witness. */
  witness_provider_ids: z.array(z.string().min(1)).min(1).max(20).optional(),
  independence: z.literal("distinct_verified_domain"),
});
export type SubledgerWitnessPolicy = z.infer<typeof SubledgerWitnessPolicySchema>;

export const DelegationInputSchema = z.object({
  parent_delegation_id: z.string().nullable().default(null),
  provider_id: z.string().nullable().default(null),
  provider_name_stated: z.string().max(200).nullable().default(null),
  provider_own_id: z.string().max(200).nullable().default(null),
  external_ref: z.string().max(200).nullable().default(null),
  provider_job_ref: z.string().max(200).nullable().default(null),
  scope_ref: z.string().max(500).nullable().default(null),
  shared_description: z.string().max(1000).nullable().default(null),
  currency: Currency,
  quoted_max_minor: Minor.nonnegative().nullable().default(null),
  quote_basis: z.string().max(200).nullable().default(null),
  quote_valid_until: Iso.nullable().default(null),
  accepted_amount_minor: Minor.nonnegative().nullable().default(null),
  /** Digest of the agreed terms document, which stays in the operator's systems. */
  terms_digest: Digest.nullable().default(null),
  expected_delivery: Iso.nullable().default(null),
  /** Whether the provider disclosed its own subdelegations. Absent data stays "unknown" (acceptance 24). */
  downstream_visibility: z.enum(["unknown", "disclosed", "none"]).default("unknown"),
  retrospective: z.boolean().default(false),
  /** The provider's run as the buyer recorded it (for A2A, from the task and agent card). Provider statements can cite it. */
  execution: ExecutionDescriptorSchema.optional(),
  /** Agreed usage prices (schema 1.5). Billed cost is compared with usage priced at these rates. */
  pricing: PricingSchema.optional(),
  /** Agreed refund and failure terms (schema 1.5). Refunds that break them raise refund_terms_breach. */
  refund_terms: RefundTermsSchema.optional(),
  /** Independent witnesses required (schema 1.5). */
  witness_policy: SubledgerWitnessPolicySchema.optional(),
});
export type DelegationInput = z.infer<typeof DelegationInputSchema>;

export const DelegationEventInputSchema = z.object({
  type: z.enum(DELIVERY_EVENT_TYPES),
  /** Who made the statement. The buyer records it either way; a provider statement relayed by the buyer is not provider-verified. */
  asserted_by: z.enum(["buyer", "provider"]).default("buyer"),
  note: z.string().max(2000).nullable().default(null),
  evidence: z.array(EvidenceRefSchema).max(20).default([]),
  /** terms_update only: new commercial terms (amount changes create new events, PRD §6). */
  terms: z
    .object({
      quoted_max_minor: Minor.nonnegative().nullable().optional(),
      accepted_amount_minor: Minor.nonnegative().nullable().optional(),
      quote_basis: z.string().max(200).nullable().optional(),
      quote_valid_until: Iso.nullable().optional(),
      terms_digest: Digest.nullable().optional(),
      expected_delivery: Iso.nullable().optional(),
      downstream_visibility: z.enum(["unknown", "disclosed", "none"]).optional(),
      /** Schema 1.5: replaces the delegation's pricing; null removes it. */
      pricing: PricingSchema.nullable().optional(),
      /** Schema 1.5: replaces the delegation's refund terms; null removes them. */
      refund_terms: RefundTermsSchema.nullable().optional(),
      /** Schema 1.5: replaces the delegation's witness policy; null removes it. */
      witness_policy: SubledgerWitnessPolicySchema.nullable().optional(),
    })
    .nullable()
    .default(null),
  /** correction only: the superseded event and the reason. */
  supersedes_event_id: z.string().nullable().default(null),
  reason: z.string().max(2000).nullable().default(null),
  retrospective: z.boolean().default(false),
  occurred_at: Iso.nullable().default(null),
  /** completion and partial_completion only (schema 1.5): the run's usage, from its trace. */
  usage: UsageRecordSchema.optional(),
  /**
   * Outcome claims asserted by the provider only (schema 1.5): the provider's signature over the outcome statement,
   * which names the delegation's provider_job_ref (for A2A, the task id) and the claim's evidence.
   */
  signer: KeySignerSchema.optional(),
});
export type DelegationEventInput = z.infer<typeof DelegationEventInputSchema>;

/** Rules across fields of a delivery event that the schema cannot express. */
export function delegationEventProblems(input: Pick<DelegationEventInput, "type" | "usage"> & Partial<Pick<DelegationEventInput, "asserted_by" | "signer">>): string[] {
  const problems: string[] = [];
  if (input.usage !== undefined && !USAGE_CLAIM_TYPES.includes(input.type)) problems.push(`usage is allowed only on ${USAGE_CLAIM_TYPES.join(" and ")} events`);
  if (input.signer !== undefined) {
    if (!(SIGNED_CLAIM_TYPES as readonly string[]).includes(input.type)) problems.push(`signer is allowed only on ${SIGNED_CLAIM_TYPES.join(", ")} events`);
    if (input.asserted_by !== "provider") problems.push("a signed claim must be asserted_by provider");
    if (input.usage !== undefined) problems.push("a signed claim cannot carry usage, which the outcome statement does not cover");
  }
  return problems;
}

export const FxSchema = z.object({
  base_currency: Currency,
  quote_currency: Currency,
  /** 1 base = rate_numerator / rate_denominator quote (integers only, so records stay canonical-JSON safe). */
  rate_numerator: z.number().int().positive(),
  rate_denominator: z.number().int().positive(),
});
export type Fx = z.infer<typeof FxSchema>;

export const FinancialEventInputSchema = z
  .object({
    type: z.enum(FINANCIAL_EVENT_TYPES),
    source: z.string().min(1).max(100),
    source_event_id: z.string().min(1).max(200),
    provider_id: z.string().nullable().default(null),
    provider_reference: z.string().max(200).nullable().default(null),
    amount_minor: Minor,
    currency: Currency,
    event_date: Iso,
    provider_status: z.string().max(100).nullable().default(null),
    normalized_status: z.enum(NORMALIZED_STATUSES).default("unknown"),
    evidence: EvidenceRefSchema.nullable().default(null),
    retrospective: z.boolean().default(false),
    payer: z.enum(PAYERS).default("buyer"),
    liability_owner: z.string().max(200).nullable().default(null),
    economic_event_id: z.string().max(200).nullable().default(null),
    included_in_event_id: z.string().nullable().default(null),
    reverses_event_id: z.string().nullable().default(null),
    settles_event_id: z.string().nullable().default(null),
    fx: FxSchema.nullable().default(null),
    reason: z.string().max(2000).nullable().default(null),
    /** Quotes, invoices and charges only (schema 1.5): the skill billed, from the provider's billing line. */
    skill: SkillRefSchema.optional(),
    /** Estimates and holds only (schema 1.5): who issued it, why, and how it relates to earlier ones. */
    expectation: ExpectationSchema.optional(),
    /** Payments and refunds only (schema 1.5): the rail's own attestation of the payment, embedded so it verifies offline. */
    rail_attestation: RailAttestationSchema.optional(),
    /** Stable references used for matching. Only a unique match is applied automatically. */
    match: z
      .object({
        task_id: z.string().nullable().default(null),
        delegation_id: z.string().nullable().default(null),
        task_external_ref: z.string().nullable().default(null),
        delegation_external_ref: z.string().nullable().default(null),
        provider_job_ref: z.string().nullable().default(null),
      })
      .default({ task_id: null, delegation_id: null, task_external_ref: null, delegation_external_ref: null, provider_job_ref: null }),
  })
  .superRefine((e, issue) => {
    if (e.type !== "adjustment" && e.amount_minor < 0) issue.addIssue({ code: "custom", path: ["amount_minor"], message: "only adjustments may be negative" });
    if (e.type === "fx_rate" && !e.fx) issue.addIssue({ code: "custom", path: ["fx"], message: "fx_rate events need fx" });
    if (e.type === "reversal" && !e.reverses_event_id) issue.addIssue({ code: "custom", path: ["reverses_event_id"], message: "reversal needs reverses_event_id" });
    if (e.type === "reversal" && !e.reason) issue.addIssue({ code: "custom", path: ["reason"], message: "reversal needs a reason" });
    if (e.skill && !SKILL_BILLED_EVENT_TYPES.includes(e.type)) issue.addIssue({ code: "custom", path: ["skill"], message: `skill is allowed only on ${SKILL_BILLED_EVENT_TYPES.join(", ")} events` });
    for (const problem of expectationProblems(e)) issue.addIssue({ code: "custom", path: ["expectation"], message: problem });
    if (e.rail_attestation && !RAIL_ATTESTED_EVENT_TYPES.includes(e.type)) {
      issue.addIssue({ code: "custom", path: ["rail_attestation"], message: `rail_attestation is allowed only on ${RAIL_ATTESTED_EVENT_TYPES.join(" and ")} events` });
    }
  });

/** Rules for estimates and holds that the schema cannot express. */
export function expectationProblems(e: { type: FinancialEventType; amount_minor: number; expectation?: Expectation }): string[] {
  const isExpectation = EXPECTATION_EVENT_TYPES.includes(e.type);
  if (!isExpectation) return e.expectation ? ["expectation is allowed only on estimate and hold events"] : [];
  if (!e.expectation) return [`${e.type} events need expectation`];
  const problems: string[] = [];
  if (e.amount_minor < 0) problems.push(`${e.type} amount must not be negative`);
  if (e.type === "hold" && !e.expectation.hold_status) problems.push("hold events need expectation.hold_status");
  if (e.type === "estimate" && e.expectation.hold_status) problems.push("only hold events carry hold_status");
  if (e.expectation.issued_by === "operator" && e.expectation.signer) problems.push("operator estimates and holds are recorded by the operator, not signed by a provider key");
  return problems;
}
export type FinancialEventInput = z.input<typeof FinancialEventInputSchema>;

/** A stored financial event exactly as hashed into exports. */
export interface FinancialEventRecord {
  financial_event_id: string;
  type: FinancialEventType;
  source: string;
  source_event_id: string;
  provider_id: string | null;
  provider_reference: string | null;
  amount_minor: number;
  currency: string;
  event_date: string;
  imported_at: string;
  provider_status: string | null;
  normalized_status: (typeof NORMALIZED_STATUSES)[number];
  evidence: EvidenceRef | null;
  retrospective: boolean;
  payer: (typeof PAYERS)[number];
  liability_owner: string | null;
  economic_event_id: string | null;
  included_in_event_id: string | null;
  reverses_event_id: string | null;
  settles_event_id: string | null;
  fx: Fx | null;
  reason: string | null;
  /** Schema 1.5, present only when stated: the skill billed. */
  skill?: SkillRef;
  /** Schema 1.5, estimates and holds only. */
  expectation?: Expectation;
  /** Schema 1.5, payments and refunds only. */
  rail_attestation?: RailAttestation;
}

export const AllocationTargetSchema = z.object({
  type: z.enum(["task", "delegation", "cost_center", "unallocated"]),
  id: z.string().max(200).nullable(),
});
export type AllocationTarget = z.infer<typeof AllocationTargetSchema>;

export interface AllocationLine {
  target: AllocationTarget;
  amount_minor: number;
}

export const AllocationInputSchema = z
  .object({
    lines: z.array(z.object({ target: AllocationTargetSchema, amount_minor: Minor.nonnegative() })).max(100).nullable().default(null),
    rule: z.object({ rule_id: z.string(), version: z.number().int().positive() }).nullable().default(null),
    reason: z.string().min(1).max(2000),
  })
  .refine((a) => (a.lines === null) !== (a.rule === null), "provide exactly one of lines or rule");

export const AllocationRuleInputSchema = z.object({
  rule_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  match: z.object({ provider_id: z.string().nullable().default(null), task_external_ref: z.string().nullable().default(null), cost_center: z.string().nullable().default(null) }),
  /** Weights in basis points; must sum to 10000. */
  splits: z.array(z.object({ target: AllocationTargetSchema, weight_bps: z.number().int().positive() })).min(1).max(50),
});

export interface DelegationNode {
  delegation_id: string;
  parent_delegation_id: string | null;
  currency: string;
  quoted_max_minor: number | null;
  accepted_amount_minor: number | null;
}

export interface RootNode {
  task_id: string;
  currency: string;
  budget_minor: number | null;
}
