import {
  AGENT_TRACE_EVIDENCE_TYPE,
  digestOf,
  WITNESS_ATTESTATION_EVIDENCE_TYPE,
  type AttestationConflict,
  type DecisionBody,
  type DeliverableOutcome,
  type EvidenceEnvelope,
  type ObligationTerms,
  type PolicyCheck,
  type PolicyTemplate,
  type Reason,
  type VerifierResult,
  type ClearingOutcome,
  type EventType,
} from "@atcn/schema";

/**
 * Version 1.1.0 sends a deliverable with conflicting attestations to the reviewer instead of using the newest result.
 * Replays honour the version a decision names: decisions by 1.0.0 are replayed without attestation conflicts.
 */
export const CLEARING_ENGINE_ID = "atcn-clearing-engine@1.1.0";
export const CLEARING_ENGINE_ID_V1_0 = "atcn-clearing-engine@1.0.0";

/** The service event that records each decision outcome. */
export const OUTCOME_EVENT: Record<ClearingOutcome, EventType> = {
  accepted: "completion.accepted",
  partially_accepted: "completion.partially_accepted",
  rejected: "completion.rejected",
  insufficient_evidence: "completion.insufficient_evidence",
  disputed: "completion.disputed",
  cancelled: "obligation.cancelled",
  expired: "obligation.expired",
};

export type ProducerRole = "issuer" | "counterparty" | "verifier" | "witness" | "other";

export interface EvidenceInput {
  envelope: EvidenceEnvelope;
  event_id: string;
  producer_role: ProducerRole;
  superseded: boolean;
}

export interface ClearingInput {
  terms: ObligationTerms;
  terms_digest: string;
  policy: PolicyTemplate;
  policy_digest: string;
  acceptance_event_id: string;
  completion_event_id: string | null;
  evidence: EvidenceInput[];
  verifier_results: VerifierResult[];
  decision_maker?: { type: "automated" | "human"; id: string };
  /** Conflicts among the obligation's attestations at evaluation time (see obligationAttestationConflicts). */
  attestation_conflicts?: AttestationConflict[];
}

export function isAdmissible(evidence: EvidenceInput, policy: PolicyTemplate): boolean {
  if (evidence.superseded) return false;
  return (policy.evidence_admissibility.allowed_producers as string[]).includes(evidence.producer_role);
}

function covers(envelope: EvidenceEnvelope, deliverableId: string): boolean {
  return envelope.deliverable_ids.length === 0 || envelope.deliverable_ids.includes(deliverableId);
}

/** Latest admissible evidence of a type covering a deliverable (ordered by created_at, then evidence_id). */
export function selectEvidence(
  evidence: EvidenceInput[],
  policy: PolicyTemplate,
  evidenceType: string,
  deliverableId: string,
): EvidenceInput | null {
  const candidates = evidence
    .filter((e) => isAdmissible(e, policy) && e.envelope.evidence_type === evidenceType && covers(e.envelope, deliverableId))
    .sort((a, b) => {
      if (a.envelope.created_at !== b.envelope.created_at) return a.envelope.created_at < b.envelope.created_at ? 1 : -1;
      return a.envelope.evidence_id < b.envelope.evidence_id ? 1 : -1;
    });
  return candidates[0] ?? null;
}

function allEvidenceFor(evidence: EvidenceInput[], policy: PolicyTemplate, evidenceType: string, deliverableId: string): EvidenceInput[] {
  return evidence
    .filter((e) => isAdmissible(e, policy) && e.envelope.evidence_type === evidenceType && covers(e.envelope, deliverableId))
    .sort((a, b) => {
      if (a.envelope.created_at !== b.envelope.created_at) return a.envelope.created_at < b.envelope.created_at ? -1 : 1;
      return a.envelope.evidence_id < b.envelope.evidence_id ? -1 : 1;
    });
}

/** Every admissible agent_trace evidence item covering a deliverable, oldest first. Retries each count. */
export function traceEvidenceFor(evidence: EvidenceInput[], policy: PolicyTemplate, deliverableId: string): EvidenceInput[] {
  return allEvidenceFor(evidence, policy, AGENT_TRACE_EVIDENCE_TYPE, deliverableId);
}

/** Every admissible witness_attestation evidence item covering a deliverable, oldest first, for witness_quorum. */
export function witnessEvidenceFor(evidence: EvidenceInput[], policy: PolicyTemplate, deliverableId: string): EvidenceInput[] {
  return allEvidenceFor(evidence, policy, WITNESS_ATTESTATION_EVIDENCE_TYPE, deliverableId);
}

export interface CheckPlanItem {
  deliverable_id: string;
  check: PolicyCheck;
  evidence: EvidenceInput | null;
}

/** Which verifier runs are needed for an evaluation: one per (deliverable, required check). */
export function planChecks(input: Pick<ClearingInput, "terms" | "policy" | "evidence">): CheckPlanItem[] {
  const plan: CheckPlanItem[] = [];
  for (const deliverable of input.terms.deliverables) {
    for (const checkId of deliverable.required_checks) {
      const check = input.policy.checks.find((c) => c.check_id === checkId);
      if (!check) continue;
      plan.push({
        deliverable_id: deliverable.deliverable_id,
        check,
        evidence: selectEvidence(input.evidence, input.policy, check.evidence_type, deliverable.deliverable_id),
      });
    }
  }
  return plan;
}

/** Digest of a verifier result over its immutable fields (execution time excluded). */
export function verifierOutputDigest(result: VerifierResult): string {
  const { executed_at: _executedAt, result_id: _resultId, ...stable } = result;
  return digestOf(stable);
}

/** Decision digest (CL-5): covers inputs and outcome; excludes ids and timestamps. */
export function decisionDigest(body: DecisionBody): string {
  return digestOf(body);
}

type DeliverableVerdict = DeliverableOutcome["outcome"];

function sortResultsNewestFirst(results: VerifierResult[]): VerifierResult[] {
  return [...results].sort((a, b) => {
    if (a.executed_at !== b.executed_at) return a.executed_at < b.executed_at ? 1 : -1;
    return a.result_id < b.result_id ? 1 : -1;
  });
}

/** Role of an evidence producer, derived only from the signed terms. */
export function producerRole(terms: ObligationTerms, producerId: string): ProducerRole {
  if (producerId === terms.issuer_agent_id || producerId === terms.principal_id) return "issuer";
  if (producerId === terms.counterparty_agent_id) return "counterparty";
  if (terms.verifier_agent_ids.includes(producerId)) return "verifier";
  const witnesses = terms.witness_policy?.witness_agent_ids;
  if (terms.witness_policy && (witnesses === undefined || witnesses.includes(producerId))) return "witness";
  return "other";
}

/**
 * Deterministic clearing (CL-2 .. CL-7). Pure function of the accepted terms, the
 * policy version, admissible evidence metadata, and recorded verifier results.
 */
export function evaluateClearing(input: ClearingInput): DecisionBody {
  const { terms, policy } = input;
  const usedEvidence = new Map<string, EvidenceInput>();
  const usedResults = new Map<string, VerifierResult>();
  const deliverableOutcomes: DeliverableOutcome[] = [];
  const conflicts = input.attestation_conflicts ?? [];

  for (const deliverable of terms.deliverables) {
    const reasons: Reason[] = [];
    const verdicts: DeliverableVerdict[] = [];

    for (const evidenceType of policy.required_evidence) {
      const found = selectEvidence(input.evidence, policy, evidenceType, deliverable.deliverable_id);
      if (!found) {
        reasons.push({ code: "missing_evidence", evidence_type: evidenceType });
        verdicts.push("insufficient_evidence");
      } else {
        usedEvidence.set(found.envelope.evidence_id, found);
      }
    }

    for (const checkId of deliverable.required_checks) {
      const check = policy.checks.find((c) => c.check_id === checkId);
      if (!check) {
        reasons.push({ code: "verifier_unavailable", check_id: checkId, detail: "check not defined by policy" });
        verdicts.push(policy.verifier_unavailable_outcome);
        continue;
      }
      const evidence = selectEvidence(input.evidence, policy, check.evidence_type, deliverable.deliverable_id);
      if (!evidence) {
        reasons.push({ code: "missing_evidence", check_id: checkId, evidence_type: check.evidence_type });
        verdicts.push("insufficient_evidence");
        continue;
      }
      usedEvidence.set(evidence.envelope.evidence_id, evidence);

      const results = sortResultsNewestFirst(input.verifier_results).filter(
        (r) =>
          r.check_id === checkId &&
          r.deliverable_id === deliverable.deliverable_id &&
          r.evidence_ids.includes(evidence.envelope.evidence_id) &&
          r.verifier_name === check.verifier &&
          r.verifier_version === check.verifier_version,
      );
      const deterministic = results.find((r) => r.kind === "deterministic");
      const probabilistic = results.find((r) => r.kind === "probabilistic");
      const result = deterministic ?? probabilistic;
      if (!result) {
        reasons.push({ code: "verifier_unavailable", check_id: checkId, detail: "no verifier result recorded" });
        verdicts.push(policy.verifier_unavailable_outcome);
        continue;
      }
      usedResults.set(verifierOutputDigest(result), result);

      if (result.status === "missing_evidence") {
        reasons.push({ code: "missing_evidence", check_id: checkId, evidence_type: check.evidence_type });
        verdicts.push("insufficient_evidence");
      } else if (result.status === "invalid_evidence") {
        reasons.push({ code: "invalid_evidence", check_id: checkId, evidence_type: check.evidence_type });
        verdicts.push("insufficient_evidence");
      } else if (result.status === "unavailable") {
        reasons.push({ code: "verifier_unavailable", check_id: checkId });
        verdicts.push(policy.verifier_unavailable_outcome);
      } else if (result.kind === "probabilistic") {
        reasons.push({ code: "probabilistic_review_required", check_id: checkId, detail: `probabilistic result: ${result.status}` });
        verdicts.push(policy.probabilistic_routing === "human_review" ? "disputed" : "insufficient_evidence");
      } else if (result.status === "fail" && check.verifier === "witness_quorum") {
        reasons.push({ code: "witness_quorum_not_met", check_id: checkId, detail: String(result.details.refused ?? "") });
        verdicts.push("insufficient_evidence");
      } else if (result.status === "fail") {
        reasons.push({ code: "failed_criteria", check_id: checkId });
        verdicts.push("rejected");
      } else {
        reasons.push({ code: "passed", check_id: checkId });
        verdicts.push("accepted");
      }
      const onCheck = conflicts.filter((c) => c.subject === `${terms.obligation_id}/${deliverable.deliverable_id}/${checkId}`);
      if (onCheck.length > 0) {
        reasons.push({ code: "conflicting_attestations", check_id: checkId, detail: onCheck.map((c) => c.kind).join(",") });
        verdicts.push("disputed");
      }
    }
    const onRun = conflicts.filter((c) => c.subject.startsWith(`${terms.obligation_id}/execution:`));
    if (onRun.length > 0) {
      reasons.push({ code: "conflicting_attestations", detail: `the counterparty declared conflicting descriptors for ${onRun.map((c) => c.subject.split("/execution:")[1]).join(", ")}` });
      verdicts.push("disputed");
    }

    let verdict = combineVerdicts(verdicts);
    if (verdict === "rejected" && terms.refund_terms?.on_failure === "dispute") {
      verdict = "disputed";
      reasons.push({ code: "failure_terms_dispute" });
    }
    deliverableOutcomes.push({
      deliverable_id: deliverable.deliverable_id,
      amount_minor: deliverable.amount_minor,
      outcome: verdict,
      reasons,
    });
  }

  const outcome = overallOutcome(deliverableOutcomes, policy);
  applyPortionPolicy(deliverableOutcomes, outcome, policy);

  const sumBy = (verdict: DeliverableVerdict) =>
    deliverableOutcomes.filter((d) => d.outcome === verdict).reduce((sum, d) => sum + d.amount_minor, 0);

  const inputEventIds = new Set<string>([input.acceptance_event_id]);
  if (input.completion_event_id) inputEventIds.add(input.completion_event_id);
  for (const e of usedEvidence.values()) inputEventIds.add(e.event_id);

  return {
    obligation_id: terms.obligation_id,
    terms_version: terms.terms_version,
    terms_digest: input.terms_digest,
    policy: { policy_id: policy.policy_id, policy_version: policy.policy_version, policy_digest: input.policy_digest },
    outcome,
    currency: terms.currency,
    accepted_amount_minor: outcome === "insufficient_evidence" ? 0 : sumBy("accepted"),
    rejected_amount_minor: sumBy("rejected"),
    disputed_amount_minor: sumBy("disputed"),
    pending_amount_minor: sumBy("insufficient_evidence") + (outcome === "insufficient_evidence" ? sumBy("accepted") : 0),
    deliverable_outcomes: deliverableOutcomes,
    input_event_ids: [...inputEventIds].sort(),
    evidence_digests: [...new Set([...usedEvidence.values()].map((e) => e.envelope.content_digest))].sort(),
    verifier_output_digests: [...usedResults.keys()].sort(),
    decision_maker: input.decision_maker ?? { type: "automated", id: CLEARING_ENGINE_ID },
  };
}

/** Worst verdict wins: insufficient_evidence > disputed > rejected > accepted. */
function combineVerdicts(verdicts: DeliverableVerdict[]): DeliverableVerdict {
  if (verdicts.includes("insufficient_evidence")) return "insufficient_evidence";
  if (verdicts.includes("disputed")) return "disputed";
  if (verdicts.includes("rejected")) return "rejected";
  return "accepted";
}

function overallOutcome(outcomes: DeliverableOutcome[], policy: PolicyTemplate): ClearingOutcome {
  const has = (v: DeliverableVerdict) => outcomes.some((d) => d.outcome === v);
  const all = (v: DeliverableVerdict) => outcomes.every((d) => d.outcome === v);
  if (has("insufficient_evidence")) return "insufficient_evidence";
  if (all("accepted")) return "accepted";
  if (has("disputed") && !has("accepted")) return "disputed";
  if (!has("accepted")) return "rejected";
  if (!policy.thresholds.partial_acceptance) return "rejected";
  if (has("disputed")) return "disputed";
  return "partially_accepted";
}

/** Applies failed-portion handling and the all-or-nothing rule after the overall outcome is known. */
function applyPortionPolicy(outcomes: DeliverableOutcome[], outcome: ClearingOutcome, policy: PolicyTemplate): void {
  for (const d of outcomes) {
    if (outcome === "rejected" && d.outcome === "accepted") {
      d.outcome = "rejected";
      d.reasons.push({ code: "partial_not_permitted" });
    }
    if (outcome === "partially_accepted" && d.outcome === "rejected" && policy.thresholds.failed_portion_outcome === "disputed") {
      d.outcome = "disputed";
    }
  }
}