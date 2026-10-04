import {
  CLEARING_VERDICT_TYPE,
  ClearingVerdictSchema,
  digestOf,
  verifyPayload,
  type ClearingDecision,
  type ClearingVerdictPayload,
  type ClosurePackage,
  type PublicKeyRecord,
} from "@atcn/schema";
import { verifyClosurePackage, type CheckResult } from "./package.js";
import { SERVICE_ACTOR_ID } from "./service.js";

/** The obligation's decision in effect: the latest one that no other decision supersedes. */
export function currentDecision(pkg: ClosurePackage, obligationId: string): ClearingDecision | null {
  const decisions = pkg.payload.decisions.filter((d) => d.obligation_id === obligationId);
  const superseded = new Set(decisions.map((d) => d.supersedes_decision_id).filter((id) => id !== null));
  const current = decisions.filter((d) => !superseded.has(d.decision_id));
  return current.reduce<ClearingDecision | null>((latest, d) => (latest === null || d.decided_at > latest.decided_at ? d : latest), null);
}

function isFinal(decision: Pick<ClearingDecision, "outcome" | "disputed_amount_minor" | "pending_amount_minor">): boolean {
  return decision.outcome !== "disputed" && decision.outcome !== "insufficient_evidence" && decision.disputed_amount_minor === 0 && decision.pending_amount_minor === 0;
}

/**
 * The verdict payload for an obligation, read from its closure package. Sign it with the service key (signPayload).
 * Throws when the package holds no decision for the obligation.
 */
export function buildClearingVerdict(
  pkg: ClosurePackage,
  options: { obligationId?: string; escrow?: { rail: string; escrow_ref: string } | null; issuedAt: string },
): ClearingVerdictPayload {
  const obligationId = options.obligationId ?? pkg.payload.requested_obligation_id;
  const decision = currentDecision(pkg, obligationId);
  if (!decision) throw new Error(`obligation ${obligationId} has no clearing decision yet`);
  return {
    document_type: CLEARING_VERDICT_TYPE,
    verdict_version: "1.0",
    issued_at: new Date(options.issuedAt).toISOString(),
    obligation_id: obligationId,
    decision: {
      decision_id: decision.decision_id,
      decision_digest: decision.decision_digest,
      decided_at: decision.decided_at,
      outcome: decision.outcome,
      currency: decision.currency,
      accepted_amount_minor: decision.accepted_amount_minor,
      rejected_amount_minor: decision.rejected_amount_minor,
      disputed_amount_minor: decision.disputed_amount_minor,
      pending_amount_minor: decision.pending_amount_minor,
    },
    final: isFinal(decision),
    escrow: options.escrow ?? null,
    package_digest: digestOf(pkg.payload),
    stance: "record_only",
  };
}

export interface VerdictVerificationReport {
  valid: boolean;
  checks: CheckResult[];
}

/**
 * Offline verification of a clearing verdict: the service signature, and, given the closure package it names, that
 * the package verifies and the verdict states the decision in effect in it. Without the package the decision is not
 * compared with its evidence (reported as not inspected).
 */
export function verifyClearingVerdict(input: unknown, options: { trustedKeys: PublicKeyRecord[]; closurePackage?: unknown }): VerdictVerificationReport {
  const parsed = ClearingVerdictSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, checks: [{ name: "schema", ok: false, details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }] };
  }
  const verdict = parsed.data;
  const checks: CheckResult[] = [{ name: "schema", ok: true, details: [] }];

  const serviceKey = options.trustedKeys.find((k) => k.key_id === verdict.signature.key_id && k.key_version === verdict.signature.key_version && k.actor_id === SERVICE_ACTOR_ID);
  const keyValid = !!serviceKey && serviceKey.valid_from <= verdict.payload.issued_at && (serviceKey.revoked_at === null || serviceKey.revoked_at > verdict.payload.issued_at);
  const signatureOk = keyValid && verifyPayload(verdict, serviceKey.public_key);
  const signatureProblem = !serviceKey ? "service key not among trusted keys" : !keyValid ? "service key was not valid when the verdict was issued" : "signature does not verify";
  checks.push({ name: "verdict_signature", ok: signatureOk, details: signatureOk ? [] : [signatureProblem] });

  if (options.closurePackage === undefined) {
    checks.push({ name: "decision", ok: true, state: "not_inspected", details: ["no closure package supplied; the decision was not compared with its evidence"] });
    return { valid: checks.every((c) => c.ok), checks };
  }

  const packageReport = verifyClosurePackage(options.closurePackage, { trustedKeys: options.trustedKeys });
  checks.push({ name: "closure_package", ok: packageReport.valid, details: packageReport.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.details.join("; ")}`) });
  if (!packageReport.valid) return { valid: false, checks };

  const pkg = options.closurePackage as ClosurePackage;
  // Unknown members are not signed, so a valid package can still hold values canonical JSON refuses; such a package is not the one read.
  let digestOk: boolean;
  try {
    digestOk = digestOf(pkg.payload) === verdict.payload.package_digest;
  } catch {
    digestOk = false;
  }
  checks.push({ name: "package_digest", ok: digestOk, details: digestOk ? [] : ["the closure package is not the one the verdict was read from"] });

  const decision = currentDecision(pkg, verdict.payload.obligation_id);
  const decisionProblems: string[] = [];
  if (!decision) {
    decisionProblems.push(`the package holds no decision for ${verdict.payload.obligation_id}`);
  } else {
    if (decision.decision_id !== verdict.payload.decision.decision_id) decisionProblems.push(`the decision in effect is ${decision.decision_id}, not ${verdict.payload.decision.decision_id}`);
    for (const field of Object.keys(verdict.payload.decision) as (keyof ClearingVerdictPayload["decision"])[]) {
      if (decision[field] !== verdict.payload.decision[field]) decisionProblems.push(`decision.${field} differs from the package`);
    }
    if (isFinal(decision) !== verdict.payload.final) decisionProblems.push("final differs from the decision's amounts and outcome");
  }
  checks.push({ name: "decision", ok: decisionProblems.length === 0, details: decisionProblems });
  return { valid: checks.every((c) => c.ok), checks };
}
