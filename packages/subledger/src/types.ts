import { z } from "zod";

/** Agent Work Subledger record shapes (PRD v1.2 §6-§7). Amounts are integer minor units; currencies are ISO 4217. */

export const Currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code");
export const Minor = z.number().int().refine(Number.isSafeInteger, "amount must be a safe integer");
const Iso = z.iso.datetime();
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const FINANCIAL_EVENT_TYPES = ["quote", "invoice", "charge", "payment_reported", "refund", "reversal", "fee", "credit", "adjustment", "fx_rate"] as const;
export type FinancialEventType = (typeof FINANCIAL_EVENT_TYPES)[number];

/** Normalized status vocabulary; the provider's original status is always kept beside it. */
export const NORMALIZED_STATUSES = ["quoted", "issued", "pending", "reported_paid", "failed", "refunded", "reversed", "void", "unknown"] as const;

export const PAYERS = ["buyer", "provider", "other"] as const;

export const DELIVERY_EVENT_TYPES = ["acceptance", "completion", "partial_completion", "cancellation", "provider_failure", "terms_update", "correction"] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

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
] as const;
export type AssuranceLabel = (typeof ASSURANCE_LABELS)[number];

export const RESPONSE_TYPES = ["acknowledge_view", "acknowledge_delivery", "submit_evidence", "propose_correction", "signed_attestation"] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

export const SHARE_ACTIONS = ["view", "acknowledge_delivery", "submit_evidence", "propose_correction", "signed_attestation"] as const;
export type ShareAction = (typeof SHARE_ACTIONS)[number];

/** Receipt fields a provider may attest to or contest. Attesting one never implies the others (acceptance 16). */
export const ATTESTABLE_FIELDS = ["delivery.status", "delivery.evidence", "scope.terms_digest", "financial.amounts", "financial.status"] as const;
export type AttestableField = (typeof ATTESTABLE_FIELDS)[number];

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
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const ProviderInputSchema = z.object({
  name: z.string().min(1).max(200),
  provider_own_id: z.string().max(200).nullable().default(null),
  domain: z.string().max(253).nullable().default(null),
});

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
    })
    .nullable()
    .default(null),
  /** correction only: the superseded event and the reason. */
  supersedes_event_id: z.string().nullable().default(null),
  reason: z.string().max(2000).nullable().default(null),
  retrospective: z.boolean().default(false),
  occurred_at: Iso.nullable().default(null),
});
export type DelegationEventInput = z.infer<typeof DelegationEventInputSchema>;

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
  });
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
