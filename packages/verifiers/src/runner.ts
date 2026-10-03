import { digestOf, newId, sha256Digest, type EvidenceEnvelope, type PolicyCheck, type VerifierResult } from "@atcn/schema";
import { eslintLintVerifier } from "./eslint.js";
import { externalAttestationVerifier } from "./externalAttestation.js";
import { junitTestsVerifier } from "./junit.js";
import { patchDigestVerifier } from "./patchDigest.js";
import type { KeyLookupResult, VerifierPlugin } from "./types.js";

export const BUILT_IN_VERIFIERS: VerifierPlugin[] = [
  junitTestsVerifier,
  eslintLintVerifier,
  patchDigestVerifier,
  externalAttestationVerifier,
];

export type FetchResult = { ok: true; content: Uint8Array } | { ok: false; error: string };

export interface RunCheckInput {
  obligationId: string;
  deliverableId: string;
  check: PolicyCheck;
  envelope: EvidenceEnvelope | null;
  fetchResult: FetchResult | null;
  requireDigestMatch: boolean;
  allowedVerifierIds: string[];
  resolveKey: (keyId: string, keyVersion: number) => KeyLookupResult | null;
  registry?: VerifierPlugin[];
  now?: Date;
}

/**
 * Runs one policy check and records a verifier result (EV-6). Distinguishes missing
 * evidence, invalid evidence (digest mismatch / unparseable), and unavailable verifier (EV-8).
 */
export function runCheck(input: RunCheckInput): VerifierResult {
  const registry = input.registry ?? BUILT_IN_VERIFIERS;
  const base = {
    result_id: newId("verifierResult"),
    obligation_id: input.obligationId,
    check_id: input.check.check_id,
    deliverable_id: input.deliverableId,
    verifier_name: input.check.verifier,
    verifier_version: input.check.verifier_version,
    config_digest: digestOf(input.check.config),
    evidence_ids: input.envelope ? [input.envelope.evidence_id] : [],
    evidence_digests: input.envelope ? [input.envelope.content_digest] : [],
    executed_at: (input.now ?? new Date()).toISOString(),
  };
  const result = (status: VerifierResult["status"], details: VerifierResult["details"], kind: VerifierResult["kind"] = "deterministic", model: VerifierResult["model"] = null): VerifierResult => ({
    ...base,
    kind,
    status,
    details,
    model,
  });

  if (!input.envelope) return result("missing_evidence", { evidence_type: input.check.evidence_type });
  const plugin = registry.find((p) => p.name === input.check.verifier && p.version === input.check.verifier_version);
  if (!plugin) return result("unavailable", { error: `verifier ${input.check.verifier}@${input.check.verifier_version} not installed` });
  if (!plugin.evidenceTypes.includes(input.envelope.evidence_type)) {
    return result("invalid_evidence", { error: `verifier does not accept evidence type ${input.envelope.evidence_type}` });
  }
  if (!input.envelope.verifiers.includes(plugin.name)) {
    return result("unavailable", { error: "evidence access policy does not allow this verifier" });
  }
  if (!input.fetchResult || !input.fetchResult.ok) {
    return result("unavailable", { error: input.fetchResult ? input.fetchResult.error : "evidence not retrievable" });
  }
  const actualDigest = sha256Digest(input.fetchResult.content);
  if (input.requireDigestMatch && actualDigest !== input.envelope.content_digest) {
    return result("invalid_evidence", { error: "content digest mismatch", actual_digest: actualDigest });
  }
  try {
    const outcome = plugin.run({
      obligationId: input.obligationId,
      deliverableId: input.deliverableId,
      check: input.check,
      envelope: input.envelope,
      content: input.fetchResult.content,
      allowedVerifierIds: input.allowedVerifierIds,
      resolveKey: input.resolveKey,
    });
    return result(outcome.status, outcome.details, outcome.kind, outcome.model);
  } catch (error) {
    return result("unavailable", { error: `verifier crashed: ${(error as Error).message}` });
  }
}
