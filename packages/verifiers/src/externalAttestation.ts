import { utf8Decode, verifyPayload, type Signed } from "@atcn/schema";
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

function invalid(error: string): VerifierOutcome {
  return { status: "invalid_evidence", kind: "deterministic", details: { error }, model: null };
}
