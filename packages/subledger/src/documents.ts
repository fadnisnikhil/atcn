import { z } from "zod";
import { ASSURANCE_LABELS, ATTESTABLE_FIELDS, CLAIM_ASSERTERS, Currency, DELIVERY_EVENT_TYPES, EvidenceRefSchema, FINANCIAL_EVENT_TYPES, FxSchema, Minor, NORMALIZED_STATUSES, PAYERS, RESPONSE_TYPES } from "./types.js";

/**
 * Signed documents of the Agent Work Subledger (PRD v1.2 §6, §16).
 * Schema 1.3 adds closure `obligation_links`, the clearing-network claim asserters, and the `network_recorded` assurance label;
 * 1.2 documents must use neither (see packages/schema/COMPATIBILITY.md).
 */

export const SUBLEDGER_SCHEMA_VERSION = "1.3" as const;
export const SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS = ["1.2", "1.3"] as const;
/** Must equal this package's version in package.json (checked by a test). */
export const SUBLEDGER_VERIFIER_VERSION = "1.3.0" as const;
export const RECEIPT_DOCUMENT_TYPE = "atcn.subledger.receipt" as const;
export const CLOSURE_DOCUMENT_TYPE = "atcn.subledger.closure" as const;
export const RESPONSE_STATEMENT_TYPE = "atcn.subledger.receipt_response" as const;
export const SIGNED_BY_HOSTED_SERVICE = "atcn-hosted-service" as const;
export const SIGNED_BY_LOCAL_RUNNER = "atcn-local-runner" as const;

const Iso = z.string().min(1);
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Assurance = z.array(z.enum(ASSURANCE_LABELS));

export const SignatureSchema = z.object({
  key_id: z.string(),
  key_version: z.number().int().positive(),
  algorithm: z.literal("Ed25519"),
  value: z.string(),
});

/** A countersignature by the operator's own key over the same canonical payload bytes the service signed. */
export const OperatorSignatureSchema = z.object({
  key_id: z.string(),
  algorithm: z.literal("Ed25519"),
  value: z.string(),
  /** Recorded by the service when the countersignature was submitted; not covered by the signature. */
  signed_at: Iso,
});
export type OperatorSignature = z.infer<typeof OperatorSignatureSchema>;

/** A published operator public key (GET /v1/operators/{operator_id}/keys). The private key never reaches ATCN. */
export const OperatorKeyRecordSchema = z.object({
  operator_id: z.string(),
  key_id: z.string(),
  algorithm: z.literal("Ed25519"),
  public_key: z.string(),
  created_at: Iso,
  revoked_at: Iso.nullable(),
});
export type OperatorKeyRecord = z.infer<typeof OperatorKeyRecordSchema>;

export const IssuerSchema = z.object({
  operator_id: z.string(),
  operator_name: z.string(),
  /**
   * The hosted service signs on the operator's behalf with its published key. The local reference runner signs
   * with a key generated on the developer's machine, which only that developer can vouch for.
   */
  signed_by: z.enum([SIGNED_BY_HOSTED_SERVICE, SIGNED_BY_LOCAL_RUNNER]),
});
export type Issuer = z.infer<typeof IssuerSchema>;

export const TotalsSchema = z.object({
  quoted: Minor,
  accepted: Minor,
  invoiced: Minor,
  charged: Minor,
  fees: Minor,
  adjustments: Minor,
  refunded: Minor,
  credits: Minor,
  reported_paid: Minor,
  net_cost: Minor,
  unresolved: Minor,
  downstream_reported: Minor,
  allocated: Minor,
  unallocated: Minor,
});
export const CurrencyTotalsSchema = z.record(Currency, TotalsSchema);
export const ReceiptTotalsSchema = z.record(Currency, TotalsSchema.omit({ allocated: true, unallocated: true }));
export type ReceiptTotals = z.infer<typeof ReceiptTotalsSchema>;

export const FinancialEventRecordSchema = z.object({
  financial_event_id: z.string(),
  type: z.enum(FINANCIAL_EVENT_TYPES),
  source: z.string(),
  source_event_id: z.string(),
  provider_id: z.string().nullable(),
  provider_reference: z.string().nullable(),
  amount_minor: Minor,
  currency: Currency,
  event_date: Iso,
  imported_at: Iso,
  provider_status: z.string().nullable(),
  normalized_status: z.enum(NORMALIZED_STATUSES),
  evidence: EvidenceRefSchema.nullable(),
  retrospective: z.boolean(),
  payer: z.enum(PAYERS),
  liability_owner: z.string().nullable(),
  economic_event_id: z.string().nullable(),
  included_in_event_id: z.string().nullable(),
  reverses_event_id: z.string().nullable(),
  settles_event_id: z.string().nullable(),
  fx: FxSchema.nullable(),
  reason: z.string().nullable(),
});

export const DeliveryClaimSchema = z.object({
  event_id: z.string(),
  delegation_id: z.string(),
  type: z.enum(DELIVERY_EVENT_TYPES),
  asserted_by: z.enum(CLAIM_ASSERTERS),
  assurance: Assurance,
  note: z.string().nullable(),
  evidence: z.array(EvidenceRefSchema),
  supersedes_event_id: z.string().nullable(),
  reason: z.string().nullable(),
  retrospective: z.boolean(),
  occurred_at: Iso,
  recorded_at: Iso,
});
export type DeliveryClaim = z.infer<typeof DeliveryClaimSchema>;

export const FIELD_STATES = ["missing", "imported", "buyer_asserted", "provider_reported", "contested"] as const;
export type FieldState = (typeof FIELD_STATES)[number];
export const FieldStatusSchema = z.record(z.enum(ATTESTABLE_FIELDS), z.enum(FIELD_STATES));

export const CorrectionSchema = z.object({ field: z.enum(ATTESTABLE_FIELDS), proposed_value: z.string().max(1000), reason: z.string().max(2000) });
export type Correction = z.infer<typeof CorrectionSchema>;

/** The exact statement a provider signs (or a link holder submits). Binds receipt, digest, revision, issuer tenant, type, and fields. */
export const ResponseStatementSchema = z.object({
  document_type: z.literal(RESPONSE_STATEMENT_TYPE),
  receipt_id: z.string(),
  receipt_digest: Digest,
  receipt_revision: z.number().int().positive(),
  issuer_operator_id: z.string(),
  response_type: z.enum(RESPONSE_TYPES),
  fields: z.array(z.enum(ATTESTABLE_FIELDS)),
  note: z.string().max(2000).nullable(),
  evidence: z.array(EvidenceRefSchema).max(20),
  corrections: z.array(CorrectionSchema).max(20),
});
export type ResponseStatement = z.infer<typeof ResponseStatementSchema>;

export const ResponseRecordSchema = z.object({
  response_id: z.string(),
  receipt_id: z.string(),
  receipt_revision: z.number().int().positive(),
  provider_id: z.string().nullable(),
  statement: ResponseStatementSchema,
  statement_digest: Digest,
  provider_signature: z.object({ key_id: z.string(), binding_id: z.string(), value: z.string() }).nullable(),
  assurance: Assurance,
  decision: z.object({ status: z.enum(["accepted", "rejected"]), reason: z.string(), decided_by: z.string(), decided_at: Iso }).nullable(),
  created_at: Iso,
});
export type ResponseRecord = z.infer<typeof ResponseRecordSchema>;

export const KeyBindingRecordSchema = z.object({
  binding_id: z.string(),
  provider_id: z.string(),
  key_id: z.string(),
  public_key: z.string(),
  method: z.enum(["operator_configured", "domain_challenge"]),
  /** The domain whose DNS TXT record named this key (domain_challenge bindings only). */
  domain: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: Iso,
  revoked_at: Iso.nullable(),
});
export type KeyBindingRecord = z.infer<typeof KeyBindingRecordSchema>;

export const CaptureGapSchema = z.object({
  gap_id: z.string(),
  delegation_id: z.string().nullable(),
  kind: z.string(),
  detail: z.string(),
  reported_at: Iso,
});
export type CaptureGap = z.infer<typeof CaptureGapSchema>;

// ---------- Provider receipt (one delegation; PRD §16 "Receipt contents") ----------

export const ReceiptFinancialEventSchema = FinancialEventRecordSchema.omit({ liability_owner: true, economic_event_id: true, fx: true }).extend({
  allocation_version: z.number().int().nonnegative(),
});

export const ReceiptPayloadSchema = z.object({
  document_type: z.literal(RECEIPT_DOCUMENT_TYPE),
  schema_version: z.enum(SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS),
  receipt_id: z.string(),
  revision: z.number().int().positive(),
  previous_receipt_id: z.string().nullable(),
  previous_receipt_digest: Digest.nullable(),
  issued_at: Iso,
  expires_at: Iso.nullable(),
  issuer: IssuerSchema,
  delegation: z.object({
    delegation_id: z.string(),
    root_task_id: z.string(),
    external_ref: z.string().nullable(),
    provider_job_ref: z.string().nullable(),
    shared_description: z.string().nullable(),
    terms_digest: Digest.nullable(),
    currency: Currency,
    quoted_max_minor: Minor.nullable(),
    quote_basis: z.string().nullable(),
    accepted_amount_minor: Minor.nullable(),
    expected_delivery: Iso.nullable(),
    retrospective: z.boolean(),
    downstream_visibility: z.enum(["unknown", "disclosed", "none"]),
  }),
  provider: z.object({
    provider_id: z.string().nullable(),
    name_stated: z.string().nullable(),
    provider_own_id: z.string().nullable(),
    identity_binding: z.enum(["key_bound", "not_bound"]),
  }),
  delivery_claims: z.array(DeliveryClaimSchema.omit({ delegation_id: true })),
  financial_events: z.array(ReceiptFinancialEventSchema),
  totals: ReceiptTotalsSchema,
  field_status: FieldStatusSchema,
  /** Every non-missing field is unverified by the provider at issuance; attestations live in responses bound to this revision. */
  unverified_fields: z.array(z.enum(ATTESTABLE_FIELDS)),
  corrections: z.array(
    z.object({ response_id: z.string(), receipt_revision: z.number().int().positive(), fields: z.array(z.enum(ATTESTABLE_FIELDS)), decision: z.enum(["accepted", "rejected", "open"]) }),
  ),
  lineage: z.object({ complete: z.boolean(), capture_gaps: z.array(CaptureGapSchema.omit({ delegation_id: true })) }),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayloadSchema>;
export const SignedReceiptSchema = z.object({ payload: ReceiptPayloadSchema, signature: SignatureSchema, operator_signatures: z.array(OperatorSignatureSchema).optional() });
export type SignedReceipt = z.infer<typeof SignedReceiptSchema>;

// ---------- Private closure snapshot (full root task; PRD §4 step 6, §6) ----------

export const ClosureDelegationSchema = z.object({
  delegation_id: z.string(),
  parent_delegation_id: z.string().nullable(),
  depth: z.number().int().positive(),
  provider_id: z.string().nullable(),
  provider_name_stated: z.string().nullable(),
  provider_own_id: z.string().nullable(),
  external_ref: z.string().nullable(),
  provider_job_ref: z.string().nullable(),
  scope_ref: z.string().nullable(),
  currency: Currency,
  quoted_max_minor: Minor.nullable(),
  quote_basis: z.string().nullable(),
  quote_valid_until: Iso.nullable(),
  accepted_amount_minor: Minor.nullable(),
  terms_digest: Digest.nullable(),
  expected_delivery: Iso.nullable(),
  downstream_visibility: z.enum(["unknown", "disclosed", "none"]),
  delivery_status: z.string(),
  retrospective: z.boolean(),
  created_at: Iso,
});
export type ClosureDelegation = z.infer<typeof ClosureDelegationSchema>;

export const AllocationRecordSchema = z.object({
  allocation_id: z.string(),
  financial_event_id: z.string(),
  version: z.number().int().positive(),
  source_event_digest: Digest,
  source_amount_minor: Minor,
  currency: Currency,
  lines: z.array(z.object({ target: z.object({ type: z.enum(["task", "delegation", "cost_center", "unallocated"]), id: z.string().nullable() }), amount_minor: Minor.nonnegative() })),
  rounding: z.object({ method: z.enum(["largest_remainder", "none"]), remainder_units: z.array(z.object({ line_index: z.number().int().nonnegative(), units: z.number().int().positive() })) }),
  rule: z.object({ rule_id: z.string(), version: z.number().int().positive() }).nullable(),
  reason: z.string(),
  after_close: z.boolean(),
  created_by: z.string(),
  created_at: Iso,
});
export type AllocationRecord = z.infer<typeof AllocationRecordSchema>;

export const ExceptionRecordSchema = z.object({
  exception_id: z.string(),
  kind: z.string(),
  status: z.enum(["open", "resolved", "dismissed"]),
  delegation_id: z.string().nullable(),
  financial_event_id: z.string().nullable(),
  detail: z.string(),
  created_at: Iso,
});
export type ExceptionRecord = z.infer<typeof ExceptionRecordSchema>;

export const NodeRollupSchema = z.object({
  node_id: z.string(),
  parent_id: z.string().nullable(),
  direct: CurrencyTotalsSchema,
  descendant: CurrencyTotalsSchema,
  total: CurrencyTotalsSchema,
  event_ids: z.array(z.string()),
});

export const RollupSchema = z.object({
  root_task_id: z.string(),
  nodes: z.array(NodeRollupSchema),
  root_total: CurrencyTotalsSchema,
  excluded_event_ids: z.object({ reversed: z.array(z.string()), reversals: z.array(z.string()), fx_rates: z.array(z.string()) }),
});

export const DisclosureSchema = z.object({
  missing: z.array(z.string()),
  unverified: z.array(z.string()),
  contested: z.array(z.string()),
  provider_reported: z.array(z.string()),
  retrospective: z.array(z.string()),
});
export type Disclosure = z.infer<typeof DisclosureSchema>;

/** A delegation backed by a clearing-network obligation, with the obligation's latest decision when the task was closed. */
export const ObligationLinkSchema = z.object({
  delegation_id: z.string(),
  obligation_id: z.string(),
  decision_id: z.string().nullable(),
  decision_digest: Digest.nullable(),
});
export type ObligationLink = z.infer<typeof ObligationLinkSchema>;

export const ClosurePayloadSchema = z.object({
  document_type: z.literal(CLOSURE_DOCUMENT_TYPE),
  schema_version: z.enum(SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS),
  closure_id: z.string(),
  version: z.number().int().positive(),
  previous_closure_id: z.string().nullable(),
  previous_closure_digest: Digest.nullable(),
  generated_at: Iso,
  issuer: IssuerSchema,
  task: z.object({
    task_id: z.string(),
    external_ref: z.string(),
    currency: Currency,
    budget_minor: Minor.nullable(),
    customer_ref: z.string().nullable(),
    project_ref: z.string().nullable(),
    cost_center: z.string().nullable(),
    scope_ref: z.string().nullable(),
    retrospective: z.boolean(),
    created_at: Iso,
  }),
  delegations: z.array(ClosureDelegationSchema),
  delivery_claims: z.array(DeliveryClaimSchema),
  financial_events: z.array(z.object({ record: FinancialEventRecordSchema, event_digest: Digest, attributed_to: z.string() })),
  allocations: z.array(AllocationRecordSchema),
  rollup: RollupSchema,
  open_exceptions: z.array(ExceptionRecordSchema),
  receipts: z.array(z.object({ receipt_id: z.string(), delegation_id: z.string(), revision: z.number().int().positive(), digest: Digest })),
  responses: z.array(ResponseRecordSchema),
  key_bindings: z.array(KeyBindingRecordSchema),
  lineage: z.object({ complete: z.boolean(), capture_gaps: z.array(CaptureGapSchema), unknown_downstream: z.array(z.string()) }),
  disclosure: DisclosureSchema,
  /** Present only when at least one delegation is backed by an obligation, so older closures keep their bytes. */
  obligation_links: z.array(ObligationLinkSchema).optional(),
});
export type ClosurePayload = z.infer<typeof ClosurePayloadSchema>;
export const SignedClosureSchema = z.object({ payload: ClosurePayloadSchema, signature: SignatureSchema, operator_signatures: z.array(OperatorSignatureSchema).optional() });
export type SignedClosure = z.infer<typeof SignedClosureSchema>;
