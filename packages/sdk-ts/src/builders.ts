import {
  digestOf,
  newId,
  sha256Digest,
  type Deliverable,
  type EvidenceEnvelope,
  type ObligationTerms,
  type PolicyTemplate,
  type Pricing,
  type RefundTerms,
  type SkillRef,
  type WitnessPolicy,
} from "@atcn/schema";

export interface TermsInput {
  parentObligationId?: string | null;
  principalId: string;
  payerId?: string;
  issuerAgentId: string;
  counterpartyAgentId?: string | null;
  openOfferPlatformIds?: string[];
  taskType?: string;
  description: string;
  artifactRef?: string;
  currency?: string;
  maxAmountMinor: number;
  deliverables: Deliverable[];
  policy: PolicyTemplate;
  deadline?: string;
  offerExpiresAt?: string;
  subdelegation?: { maxDepth: number; maxTotalMinor: number; allowedPolicyIds?: string[] } | null;
  disputeReviewerId?: string | null;
  verifierAgentIds?: string[];
  /** The skill the counterparty performs (for A2A, the AgentSkill id). Produces schema_version 1.1 terms. */
  skill?: SkillRef;
  /** Usage prices for the usage_cost verifier. Produces schema_version 1.2 terms. */
  pricing?: Pricing;
  /** What happens on failure or timeout, and the post-settlement refund budget. Produces schema_version 1.2 terms. */
  refundTerms?: RefundTerms;
  /** Independent witnesses the witness_quorum verifier requires. Produces schema_version 1.2 terms. */
  witnessPolicy?: WitnessPolicy;
}

const DAY_MS = 24 * 3600 * 1000;

/** Builds version-1 obligation terms with sensible defaults (7-day deadline, 1-day offer window). */
export function buildTerms(input: TermsInput): ObligationTerms {
  const now = Date.now();
  return {
    schema_version: input.pricing || input.refundTerms || input.witnessPolicy ? "1.2" : input.skill ? "1.1" : "1.0",
    obligation_id: newId("obligation"),
    terms_version: 1,
    parent_obligation_id: input.parentObligationId ?? null,
    principal_id: input.principalId,
    payer_id: input.payerId ?? input.principalId,
    issuer_agent_id: input.issuerAgentId,
    counterparty_agent_id: input.counterpartyAgentId ?? null,
    payee_selection: input.openOfferPlatformIds ? { type: "open_offer", allowed_platform_ids: input.openOfferPlatformIds } : null,
    scope: { task_type: input.taskType ?? input.policy.task_type, description: input.description, ...(input.artifactRef ? { artifact_ref: input.artifactRef } : {}) },
    currency: input.currency ?? "USD",
    max_amount_minor: input.maxAmountMinor,
    deliverables: input.deliverables,
    acceptance_policy: { policy_id: input.policy.policy_id, policy_version: input.policy.policy_version, policy_digest: digestOf(input.policy) },
    deadline: input.deadline ?? new Date(now + 7 * DAY_MS).toISOString(),
    offer_expires_at: input.offerExpiresAt ?? new Date(now + DAY_MS).toISOString(),
    allow_subdelegation: Boolean(input.subdelegation),
    subdelegation_limits: input.subdelegation
      ? { max_depth: input.subdelegation.maxDepth, max_total_minor: input.subdelegation.maxTotalMinor, allowed_policy_ids: input.subdelegation.allowedPolicyIds ?? [] }
      : null,
    dispute_reviewer_id: input.disputeReviewerId ?? null,
    verifier_agent_ids: input.verifierAgentIds ?? [],
    issued_at: new Date(now).toISOString(),
    ...(input.skill ? { skill: input.skill } : {}),
    ...(input.pricing ? { pricing: input.pricing } : {}),
    ...(input.refundTerms ? { refund_terms: input.refundTerms } : {}),
    ...(input.witnessPolicy ? { witness_policy: input.witnessPolicy } : {}),
  };
}

/** Data for obligation.created / obligation.offered / obligation.amended events. */
export function termsData(terms: ObligationTerms, reason?: string): Record<string, unknown> {
  return { terms, terms_digest: digestOf(terms), ...(reason ? { reason } : {}) };
}

/** Data for obligation.accepted, binding the accepting agent to the exact terms version and policy. */
export function acceptanceData(terms: ObligationTerms, acceptingAgentId: string): Record<string, unknown> {
  return {
    terms_version: terms.terms_version,
    terms_digest: digestOf(terms),
    policy_id: terms.acceptance_policy.policy_id,
    policy_version: terms.acceptance_policy.policy_version,
    counterparty_agent_id: acceptingAgentId,
  };
}

export interface EnvelopeInput {
  evidenceType: string;
  producerId: string;
  content: Uint8Array | string;
  uri: string;
  retrievalMethod: EvidenceEnvelope["retrieval_method"];
  mediaType: string;
  visibleTo?: EvidenceEnvelope["access_policy"]["visible_to"];
  verifiers: string[];
  deliverableIds: string[];
}

/** Evidence envelope with the content digest computed from the bytes the producer holds. */
export function buildEvidenceEnvelope(input: EnvelopeInput): EvidenceEnvelope {
  return {
    evidence_id: newId("evidence"),
    evidence_type: input.evidenceType,
    producer_id: input.producerId,
    created_at: new Date().toISOString(),
    content_digest: sha256Digest(input.content),
    uri: input.uri,
    retrieval_method: input.retrievalMethod,
    media_type: input.mediaType,
    access_policy: { visible_to: input.visibleTo ?? ["issuer", "counterparty", "reviewer", "verifier"] },
    verifiers: input.verifiers,
    deliverable_ids: input.deliverableIds,
  };
}
