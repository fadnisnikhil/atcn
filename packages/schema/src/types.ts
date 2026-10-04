import { z } from "zod";
import { EVENT_TYPE_NAMES } from "./events.js";
import { CLEARING_OUTCOMES, SETTLEMENT_STATUSES } from "./states.js";

const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";
const prefixed = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${ULID_BODY}$`), `expected ${prefix}_<ULID>`);

export const PrincipalId = prefixed("prn");
export const PlatformId = prefixed("plt");
export const AgentId = prefixed("agt");
export const ObligationId = prefixed("obl");
export const EventId = prefixed("evt");
export const EvidenceId = prefixed("evd");
export const DecisionId = prefixed("dec");
export const KeyId = z.string().regex(new RegExp(`^(key_${ULID_BODY}|key_atcn_service)$`));
/** Actors that may sign events: principals, agents, platforms, or the ATCN service. */
export const ActorId = z.string().regex(new RegExp(`^((prn|agt|plt)_${ULID_BODY}|svc_atcn)$`));

export const Timestamp = z.iso.datetime({ offset: false });
export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const Currency = z.string().regex(/^[A-Z]{3}$/);
export const AmountMinor = z.number().int().nonnegative().refine(Number.isSafeInteger, "amount must be a safe integer");
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);
/** Values allowed inside signed payloads (canonical JSON subset: no floats). */
export const CanonicalValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number().int(), z.boolean(), z.null(), z.array(CanonicalValue), z.record(z.string(), CanonicalValue)]),
);

export const SignatureSchema = z.object({
  key_id: KeyId,
  key_version: z.number().int().positive(),
  algorithm: z.literal("Ed25519"),
  value: z.string().min(1),
});

// ---------- Policy templates (CL-1, CL-2, CL-11) ----------

export const PolicyCheckSchema = z.object({
  check_id: z.string().regex(/^[a-z0-9_]+$/),
  verifier: z.string().regex(/^[a-z0-9_]+$/),
  verifier_version: SemVer,
  evidence_type: z.string().regex(/^[a-z0-9_]+$/),
  config: z.record(z.string(), CanonicalValue),
});

export const PolicyTemplateSchema = z.object({
  schema_version: z.literal("1.0"),
  policy_id: z.string().regex(/^[a-z0-9-]+$/),
  policy_version: SemVer,
  task_type: z.string().min(1),
  description: z.string(),
  evidence_admissibility: z.object({
    allowed_producers: z.array(z.enum(["issuer", "counterparty", "verifier"])).min(1),
    require_digest_match: z.boolean(),
  }),
  required_evidence: z.array(z.string().regex(/^[a-z0-9_]+$/)),
  checks: z.array(PolicyCheckSchema),
  thresholds: z.object({
    partial_acceptance: z.boolean(),
    failed_portion_outcome: z.enum(["rejected", "disputed"]),
  }),
  verifier_unavailable_outcome: z.enum(["insufficient_evidence", "disputed"]),
  probabilistic_routing: z.enum(["evidence_only", "human_review"]),
  timeouts: z.object({ evaluation_window_seconds: z.number().int().positive() }),
  dispute: z.object({
    window_seconds: z.number().int().positive(),
    review_window_seconds: z.number().int().positive(),
    default_outcome: z.enum(["uphold"]),
  }),
  allocation: z.object({ platform_fee_bps: z.number().int().min(0).max(10000) }),
  rounding: z.literal("largest_remainder"),
});
export type PolicyTemplate = z.infer<typeof PolicyTemplateSchema>;
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PolicyRefSchema = z.object({
  policy_id: z.string(),
  policy_version: SemVer,
  policy_digest: Digest,
});
export type PolicyRef = z.infer<typeof PolicyRefSchema>;

// ---------- Executions and attestation references ----------

/** A skill the parties agreed on. For A2A, namespace "a2a" and the AgentSkill id from the agent card. */
export const SkillRefSchema = z.object({
  namespace: z.string().regex(/^[a-z0-9_.-]+$/),
  skill_id: z.string().min(1).max(200),
  agent_card_url: z.url().optional(),
});
export type SkillRef = z.infer<typeof SkillRefSchema>;

/**
 * One run of work, described by the agent doing it: in obligation.started on the network, or recorded by the buyer on
 * a subledger delegation. agent_id is the ATCN agent on the network and the provider's own identifier off it.
 */
export const ExecutionDescriptorSchema = z.object({
  execution_id: z.string().min(1).max(200),
  protocol: z
    .object({ name: z.literal("a2a"), task_id: z.string().min(1).max(200), context_id: z.string().min(1).max(200).optional() })
    .optional(),
  agent: z.object({
    agent_id: z.string().min(1).max(200),
    agent_version: z.string().min(1).max(100),
    card_digest: Digest.optional(),
    model: z.object({ provider: z.string().min(1).max(100), name: z.string().min(1).max(200), version: z.string().min(1).max(100) }).optional(),
    /** Digest of the agent's configuration, so the configuration itself is never disclosed. */
    config_digest: Digest.optional(),
  }),
  skill: SkillRefSchema.optional(),
});
export type ExecutionDescriptor = z.infer<typeof ExecutionDescriptorSchema>;

/** How an attestation cites a run: its id and the digest of its descriptor. */
export const ExecutionBindingSchema = z.object({
  execution_id: z.string().min(1).max(200),
  execution_digest: Digest,
});
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

/** Only the original signer can revoke an attestation; anyone allowed to attest can dispute one. */
export const ATTESTATION_REF_RELATIONS = ["revokes", "disputes"] as const;
export const AttestationRefSchema = z.object({
  relation: z.enum(ATTESTATION_REF_RELATIONS),
  attestation_digest: Digest,
  reason: z.string().min(1).max(2000),
});
export type AttestationRef = z.infer<typeof AttestationRefSchema>;

// ---------- Obligations (OB-1 .. OB-9) ----------

export const DeliverableSchema = z.object({
  deliverable_id: z.string().regex(/^[a-z0-9_-]+$/),
  description: z.string(),
  amount_minor: AmountMinor,
  required_checks: z.array(z.string()).min(1),
});
export type Deliverable = z.infer<typeof DeliverableSchema>;

/** Terms that use a 1.1 field declare 1.1, so a 1.0 verifier rejects them instead of dropping the field. */
export const TERMS_SCHEMA_VERSIONS = ["1.0", "1.1"] as const;

export const ObligationTermsSchema = z
  .object({
    schema_version: z.enum(TERMS_SCHEMA_VERSIONS),
    obligation_id: ObligationId,
    terms_version: z.number().int().positive(),
    parent_obligation_id: ObligationId.nullable(),
    principal_id: PrincipalId,
    payer_id: z.union([PrincipalId, AgentId]),
    issuer_agent_id: AgentId,
    counterparty_agent_id: AgentId.nullable(),
    payee_selection: z
      .object({ type: z.literal("open_offer"), allowed_platform_ids: z.array(PlatformId).min(1) })
      .nullable(),
    scope: z.object({
      task_type: z.string().min(1),
      description: z.string().min(1),
      artifact_ref: z.string().optional(),
    }),
    currency: Currency,
    max_amount_minor: AmountMinor,
    deliverables: z.array(DeliverableSchema).min(1),
    acceptance_policy: PolicyRefSchema,
    deadline: Timestamp,
    offer_expires_at: Timestamp,
    allow_subdelegation: z.boolean(),
    subdelegation_limits: z
      .object({
        max_depth: z.number().int().positive(),
        max_total_minor: AmountMinor,
        allowed_policy_ids: z.array(z.string()),
      })
      .nullable(),
    dispute_reviewer_id: z.union([AgentId, PrincipalId]).nullable(),
    /** Verifiers both parties agreed may submit evidence and attestations. */
    verifier_agent_ids: z.array(AgentId),
    issued_at: Timestamp,
    /** Schema 1.1: the skill the counterparty performs. Each declared run must name the same skill. */
    skill: SkillRefSchema.optional(),
  })
  .refine((t) => t.skill === undefined || t.schema_version === "1.1", {
    message: "skill requires schema_version 1.1",
  })
  .refine((t) => t.counterparty_agent_id !== null || t.payee_selection !== null, {
    message: "either counterparty_agent_id or payee_selection is required",
  })
  .refine((t) => !t.allow_subdelegation || t.subdelegation_limits !== null, {
    message: "subdelegation_limits are required when allow_subdelegation is true",
  })
  .refine((t) => t.deliverables.reduce((sum, d) => sum + d.amount_minor, 0) <= t.max_amount_minor, {
    message: "sum of deliverable amounts exceeds max_amount_minor",
  })
  .refine((t) => new Set(t.deliverables.map((d) => d.deliverable_id)).size === t.deliverables.length, {
    message: "deliverable_id values must be unique",
  });
export type ObligationTerms = z.infer<typeof ObligationTermsSchema>;

// ---------- Evidence (EV-4 .. EV-9) ----------

export const EvidenceEnvelopeSchema = z.object({
  evidence_id: EvidenceId,
  evidence_type: z.string().regex(/^[a-z0-9_]+$/),
  producer_id: ActorId,
  created_at: Timestamp,
  content_digest: Digest,
  uri: z.string().min(1),
  retrieval_method: z.enum(["https", "atcn-blob", "out_of_band"]),
  media_type: z.string().min(1),
  access_policy: z.object({
    visible_to: z.array(z.enum(["issuer", "counterparty", "reviewer", "verifier"])).min(1),
  }),
  verifiers: z.array(z.string()).min(1),
  deliverable_ids: z.array(z.string()),
});
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

// ---------- Event envelope (EV-1) ----------

export const EventPayloadSchema = z.object({
  schema_version: z.literal("1.0"),
  event_id: EventId,
  event_type: z.enum(EVENT_TYPE_NAMES as [string, ...string[]]),
  obligation_id: ObligationId,
  actor_id: ActorId,
  actor_platform_id: z.union([PlatformId, z.literal("svc_atcn")]),
  event_time: Timestamp,
  causation_ids: z.array(EventId),
  data: z.record(z.string(), CanonicalValue),
});
export type EventPayload = z.infer<typeof EventPayloadSchema>;

export const SignedEventSchema = z.object({
  payload: EventPayloadSchema,
  signature: SignatureSchema,
});
export type SignedEvent = z.infer<typeof SignedEventSchema>;

/** Stored event = signed envelope + server receipt facts (EV-1, EV-10). */
export const RecordedEventSchema = SignedEventSchema.extend({
  payload_hash: Digest,
  received_at: Timestamp,
  sequence: z.number().int().positive(),
});
export type RecordedEvent = z.infer<typeof RecordedEventSchema>;

// Event-specific data payloads.
export const EventDataSchemas = {
  "obligation.created": z.object({ terms: ObligationTermsSchema, terms_digest: Digest }),
  "obligation.offered": z.object({ terms: ObligationTermsSchema, terms_digest: Digest }),
  "obligation.accepted": z.object({
    terms_version: z.number().int().positive(),
    terms_digest: Digest,
    policy_id: z.string(),
    policy_version: SemVer,
    counterparty_agent_id: AgentId,
  }),
  "obligation.amended": z.object({ terms: ObligationTermsSchema, terms_digest: Digest, reason: z.string().min(1) }),
  "obligation.started": z.object({ execution: ExecutionDescriptorSchema.optional() }),
  "completion.proposed": z.object({ note: z.string().optional() }),
  "obligation.cancelled": z.object({ reason: z.string().min(1) }),
  "event.superseded": z.object({ superseded_event_id: EventId, reason: z.string().min(1) }),
  "evidence.submitted": z.object({ envelope: EvidenceEnvelopeSchema }),
  "dispute.opened": z.object({
    decision_id: DecisionId,
    amount_minor: AmountMinor,
    deliverable_ids: z.array(z.string()),
    reason_code: z.enum(["criteria_not_met", "evidence_invalid", "verifier_error", "amount_incorrect", "work_not_delivered", "other"]),
    reason: z.string().min(1),
    evidence_ids: z.array(EvidenceId),
  }),
  "dispute.resolved": z.object({
    dispute_id: z.string(),
    outcome: z.enum(["uphold", "amend", "remand"]),
    rationale: z.string().min(1),
    amended_accepted_amount_minor: AmountMinor.nullable(),
    default_applied: z.boolean(),
  }),
} as const;

// ---------- Verifier results (EV-6, CL-7) ----------

export const VerifierStatus = z.enum(["pass", "fail", "invalid_evidence", "missing_evidence", "unavailable"]);
export type VerifierStatus = z.infer<typeof VerifierStatus>;

export const VerifierResultSchema = z.object({
  result_id: z.string(),
  obligation_id: ObligationId,
  check_id: z.string(),
  deliverable_id: z.string(),
  verifier_name: z.string(),
  verifier_version: SemVer,
  config_digest: Digest,
  kind: z.enum(["deterministic", "probabilistic"]),
  evidence_ids: z.array(EvidenceId),
  evidence_digests: z.array(Digest),
  status: VerifierStatus,
  details: z.record(z.string(), CanonicalValue),
  model: z.object({ name: z.string(), version: z.string(), confidence_bps: z.number().int() }).nullable(),
  executed_at: Timestamp,
});
export type VerifierResult = z.infer<typeof VerifierResultSchema>;

// ---------- External attestations (evidence type verifier_attestation) ----------

/**
 * A verifier's signed judgement of one check. The optional fields are read by external_attestation@1.1.0:
 * the run it judged, the evidence it saw, when it was issued and expires, and earlier attestations it revokes or disputes.
 */
export const ExternalAttestationPayloadSchema = z
  .object({
    obligation_id: ObligationId,
    deliverable_id: z.string(),
    check_id: z.string(),
    verifier_id: AgentId,
    status: z.enum(["pass", "fail"]),
    probabilistic: z.boolean(),
    model: z.object({ name: z.string(), version: z.string(), confidence_bps: z.number().int() }).nullable(),
    summary: z.string(),
    execution: ExecutionBindingSchema.optional(),
    evidence_digests: z.array(Digest).max(50).optional(),
    issued_at: Timestamp.optional(),
    expires_at: Timestamp.optional(),
    refs: z.array(AttestationRefSchema).max(20).optional(),
  })
  .refine((a) => a.issued_at !== undefined || (a.expires_at === undefined && a.refs === undefined), {
    message: "issued_at is required with expires_at or refs",
  })
  .refine((a) => a.issued_at === undefined || a.expires_at === undefined || Date.parse(a.issued_at) < Date.parse(a.expires_at), {
    message: "expires_at must be after issued_at",
  });
export type ExternalAttestationPayload = z.infer<typeof ExternalAttestationPayloadSchema>;

export const SignedExternalAttestationSchema = z.object({
  payload: ExternalAttestationPayloadSchema,
  signature: SignatureSchema,
});
export type SignedExternalAttestation = z.infer<typeof SignedExternalAttestationSchema>;

// ---------- Clearing decisions (CL-3, CL-4, CL-5) ----------

export const ReasonSchema = z.object({
  code: z.enum([
    "missing_evidence",
    "invalid_evidence",
    "failed_criteria",
    "verifier_unavailable",
    "probabilistic_review_required",
    "partial_not_permitted",
    "passed",
    "dispute_amended",
    "dispute_upheld",
  ]),
  check_id: z.string().optional(),
  evidence_type: z.string().optional(),
  detail: z.string().optional(),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const DeliverableOutcomeSchema = z.object({
  deliverable_id: z.string(),
  amount_minor: AmountMinor,
  outcome: z.enum(["accepted", "rejected", "insufficient_evidence", "disputed"]),
  reasons: z.array(ReasonSchema),
});
export type DeliverableOutcome = z.infer<typeof DeliverableOutcomeSchema>;

export const DecisionBodySchema = z.object({
  obligation_id: ObligationId,
  terms_version: z.number().int().positive(),
  terms_digest: Digest,
  policy: PolicyRefSchema,
  outcome: z.enum(CLEARING_OUTCOMES),
  currency: Currency,
  accepted_amount_minor: AmountMinor,
  rejected_amount_minor: AmountMinor,
  disputed_amount_minor: AmountMinor,
  pending_amount_minor: AmountMinor,
  deliverable_outcomes: z.array(DeliverableOutcomeSchema),
  input_event_ids: z.array(EventId),
  evidence_digests: z.array(Digest),
  verifier_output_digests: z.array(Digest),
  decision_maker: z.object({ type: z.enum(["automated", "human"]), id: z.string() }),
});
export type DecisionBody = z.infer<typeof DecisionBodySchema>;

export const ClearingDecisionSchema = DecisionBodySchema.extend({
  decision_id: DecisionId,
  decision_digest: Digest,
  decided_at: Timestamp,
  supersedes_decision_id: DecisionId.nullable(),
  /** Highest event sequence visible to the evaluation; replays use events up to this point. */
  input_cutoff_sequence: z.number().int().nonnegative(),
});
export type ClearingDecision = z.infer<typeof ClearingDecisionSchema>;

// ---------- Journal (LJ-1 .. LJ-7) ----------

export const ACCOUNT_TYPES = [
  "obligation_expense",
  "contingent_expense",
  "contingent_payable",
  "payable",
  "receivable",
  "platform_fee",
  "dispute_frozen",
  "reserve_reported",
  "settlement_reported",
  "refund",
  "unallocated_residual",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ALLOCATION_ROLES = [
  "payer_expense",
  "payee_share",
  "parent_margin",
  "child_cost",
  "platform_fee",
  "contingent",
  "dispute_freeze",
  "settlement",
  "reserve",
  "refund",
  "unallocated_residual",
] as const;
export type AllocationRole = (typeof ALLOCATION_ROLES)[number];

export const PostingLineSchema = z.object({
  account_type: z.enum(ACCOUNT_TYPES),
  party_id: z.string(),
  allocation_role: z.enum(ALLOCATION_ROLES),
  currency: Currency,
  debit_minor: AmountMinor,
  credit_minor: AmountMinor,
});
export type PostingLine = z.infer<typeof PostingLineSchema>;

export const ENTRY_TYPES = ["contingent", "clearing", "dispute_freeze", "dispute_release", "settlement", "reserve", "refund", "return", "reversal"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const PostingBatchSchema = z.object({
  batch_id: z.string(),
  obligation_id: ObligationId,
  entry_type: z.enum(ENTRY_TYPES),
  decision_id: DecisionId.nullable(),
  settlement_event_id: z.string().nullable(),
  reverses_batch_id: z.string().nullable(),
  policy_version: z.string().nullable(),
  source_event_ids: z.array(EventId),
  rounding: z.object({ method: z.string(), detail: z.string() }).nullable(),
  lines: z.array(PostingLineSchema).min(2),
  posted_at: Timestamp,
});
export type PostingBatch = z.infer<typeof PostingBatchSchema>;

// ---------- Settlement (ST-1 .. ST-8) ----------

export const SettlementInstructionSchema = z.object({
  instruction_id: z.string(),
  obligation_id: ObligationId,
  decision_id: DecisionId,
  beneficiary_party_id: z.string(),
  beneficiary_ref: z.string().min(1),
  currency: Currency,
  amount_minor: AmountMinor,
  adapter: z.enum(["manual", "sandbox", "stripe"]),
  idempotency_key: z.string().min(1),
  expires_at: Timestamp,
  status: z.enum(SETTLEMENT_STATUSES),
  created_at: Timestamp,
});
export type SettlementInstruction = z.infer<typeof SettlementInstructionSchema>;

export const SettlementEventSchema = z.object({
  settlement_event_id: z.string(),
  instruction_id: z.string().nullable(),
  provider: z.enum(["manual", "sandbox", "stripe"]),
  provider_event_id: z.string().min(1),
  provider_reference: z.string().min(1),
  provider_status: z.string().min(1),
  normalized_status: z.enum(SETTLEMENT_STATUSES),
  currency: Currency,
  amount_minor: AmountMinor,
  /** Provider's original response, kept verbatim as JSON text (may contain non-canonical numbers). */
  raw_json: z.string(),
  reported_at: Timestamp,
});
export type SettlementEvent = z.infer<typeof SettlementEventSchema>;

// ---------- Keys and closure package (L) ----------

export const PublicKeyRecordSchema = z.object({
  key_id: KeyId,
  key_version: z.number().int().positive(),
  actor_id: ActorId,
  algorithm: z.literal("Ed25519"),
  public_key: z.string(),
  valid_from: Timestamp,
  revoked_at: Timestamp.nullable(),
});
export type PublicKeyRecord = z.infer<typeof PublicKeyRecordSchema>;

export const ClosurePackageBodySchema = z.object({
  package_version: z.literal("1.0"),
  generated_at: Timestamp,
  root_obligation_id: ObligationId,
  requested_obligation_id: ObligationId,
  obligations: z.array(
    z.object({
      obligation_id: ObligationId,
      parent_obligation_id: ObligationId.nullable(),
      redacted: z.boolean(),
      effective_terms: ObligationTermsSchema.nullable(),
      effective_terms_digest: Digest.nullable(),
      state: z.string(),
    }),
  ),
  events: z.array(RecordedEventSchema),
  public_keys: z.array(PublicKeyRecordSchema),
  policies: z.array(PolicyTemplateSchema),
  evidence: z.array(EvidenceEnvelopeSchema),
  verifier_results: z.array(VerifierResultSchema),
  decisions: z.array(ClearingDecisionSchema),
  posting_batches: z.array(PostingBatchSchema),
  settlement_instructions: z.array(SettlementInstructionSchema),
  settlement_events: z.array(SettlementEventSchema),
});
export type ClosurePackageBody = z.infer<typeof ClosurePackageBodySchema>;

export const ClosurePackageSchema = z.object({
  payload: ClosurePackageBodySchema,
  signature: SignatureSchema,
});
export type ClosurePackage = z.infer<typeof ClosurePackageSchema>;
