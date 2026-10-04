import { attestationTimeStatus, sameSkill, SignedExternalAttestationSchema, utf8Decode, verifyPayload, type Signed } from "@atcn/schema";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

export interface AttestationPayload {
  obligation_id: string;
  deliverable_id: string;
  check_id: string;
  verifier_id: string;
  status: "pass" | "fail";
  probabilistic: boolean;
  model: { name: string; version: string; confidence_bps: number } | null;
  summary: string;
}

/**
 * Accepts a signed attestation from a verifier named in the obligation terms.
 * Probabilistic attestations (e.g. LLM review) are labeled as such and routed by policy (CL-7).
 */
export const externalAttestationVerifier: VerifierPlugin = {
  name: "external_attestation",
  version: "1.0.0",
  evidenceTypes: ["verifier_attestation"],
  run(context: VerifierContext): VerifierOutcome {
    let attestation: Signed<AttestationPayload>;
    try {
      attestation = JSON.parse(utf8Decode(context.content)) as Signed<AttestationPayload>;
    } catch {
      return invalid("attestation is not JSON");
    }
    const p = attestation?.payload;
    if (!p || !attestation.signature) return invalid("attestation must have payload and signature");
    if (p.obligation_id !== context.obligationId || p.deliverable_id !== context.deliverableId || p.check_id !== context.check.check_id) {
      return invalid("attestation subject does not match obligation, deliverable, and check");
    }
    if (!context.allowedVerifierIds.includes(p.verifier_id)) return invalid("verifier not agreed in obligation terms");
    const key = context.resolveKey(attestation.signature.key_id, attestation.signature.key_version);
    if (!key || key.actor_id !== p.verifier_id) return invalid("attestation key does not belong to verifier");
    if (!verifyPayload(attestation, key.public_key)) return invalid("attestation signature does not verify");
    if (p.status !== "pass" && p.status !== "fail") return invalid("status must be pass or fail");
    return {
      status: p.status,
      kind: p.probabilistic ? "probabilistic" : "deterministic",
      details: { verifier_id: p.verifier_id, summary: p.summary, probabilistic: p.probabilistic },
      model: p.model,
    };
  },
};

/**
 * Version 1.1.0 also checks what the attestation is bound to: the run it judged must be one the counterparty declared
 * (and perform the agreed skill), the evidence it cites must be on the obligation, and it must hold at evaluation time.
 * When the terms name a skill, an attestation that cites no run is refused, because nothing ties it to that skill.
 */
export const externalAttestationVerifierV1_1: VerifierPlugin = {
  name: "external_attestation",
  version: "1.1.0",
  evidenceTypes: ["verifier_attestation"],
  run(context: VerifierContext): VerifierOutcome {
    let raw: unknown;
    try {
      raw = JSON.parse(utf8Decode(context.content));
    } catch {
      return invalid("attestation is not JSON", "malformed");
    }
    const parsed = SignedExternalAttestationSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return invalid(`attestation does not match the schema: ${issue.path.join(".")}: ${issue.message}`, "malformed");
    }
    const { payload: p, signature } = parsed.data;
    if (p.obligation_id !== context.obligationId || p.deliverable_id !== context.deliverableId || p.check_id !== context.check.check_id) {
      return invalid("attestation subject does not match obligation, deliverable, and check", "subject_mismatch");
    }
    if (!context.allowedVerifierIds.includes(p.verifier_id)) return invalid("verifier not agreed in obligation terms", "verifier_not_agreed");
    const key = context.resolveKey(signature.key_id, signature.key_version);
    if (!key || key.actor_id !== p.verifier_id) return invalid("attestation key does not belong to verifier", "key_not_verifier");
    // Verified over the payload exactly as received, so fields this version does not know cannot be dropped silently.
    if (!verifyPayload(raw as Signed<unknown>, key.public_key)) return invalid("attestation signature does not verify", "signature_invalid");

    const at = context.evaluatedAt ?? new Date().toISOString();
    const signedAt = p.issued_at ?? at;
    if (key.revoked_at && Date.parse(key.revoked_at) <= Date.parse(signedAt)) return invalid(`attestation key was revoked at ${key.revoked_at}`, "key_revoked");
    const time = attestationTimeStatus(p, at);
    if (time === "expired") return invalid(`attestation expired at ${p.expires_at}`, "expired");
    if (time === "not_yet_valid") return invalid(`attestation issued_at ${p.issued_at} is later than the evaluation time`, "not_yet_valid");

    const termsSkill = context.termsSkill ?? undefined;
    if (p.execution) {
      const binding = p.execution;
      const declared = (context.executions ?? []).find((e) => e.execution_id === binding.execution_id && e.execution_digest === binding.execution_digest);
      if (!declared) return invalid(`run ${binding.execution_id} with digest ${binding.execution_digest} was not declared by the counterparty`, "execution_not_declared");
      if (termsSkill && !sameSkill(declared.descriptor.skill, termsSkill)) {
        return invalid(`run ${binding.execution_id} does not perform the agreed skill ${termsSkill.namespace}/${termsSkill.skill_id}`, "skill_mismatch");
      }
    } else if (termsSkill) {
      return invalid("the terms name a skill, so the attestation must cite the run it judged", "execution_required");
    }
    const onObligation = new Set(context.obligationEvidenceDigests ?? []);
    const unknownEvidence = (p.evidence_digests ?? []).filter((d) => !onObligation.has(d));
    if (unknownEvidence.length > 0) return invalid(`attestation cites evidence not submitted on this obligation: ${unknownEvidence.join(", ")}`, "evidence_not_on_obligation");

    return {
      status: p.status,
      kind: p.probabilistic ? "probabilistic" : "deterministic",
      details: {
        verifier_id: p.verifier_id,
        summary: p.summary,
        probabilistic: p.probabilistic,
        execution_id: p.execution?.execution_id ?? null,
        expires_at: p.expires_at ?? null,
      },
      model: p.model,
    };
  },
};

function invalid(error: string, code?: string): VerifierOutcome {
  return { status: "invalid_evidence", kind: "deterministic", details: code ? { error, code } : { error }, model: null };
}
