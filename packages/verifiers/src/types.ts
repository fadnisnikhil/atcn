import type { EvidenceEnvelope, PolicyCheck, VerifierStatus } from "@atcn/schema";

export interface KeyLookupResult {
  actor_id: string;
  public_key: string;
}

export interface VerifierContext {
  obligationId: string;
  deliverableId: string;
  check: PolicyCheck;
  envelope: EvidenceEnvelope;
  /** Retrieved evidence bytes (already digest-checked by the runner). */
  content: Uint8Array;
  /** Verifier agents both parties agreed to in the obligation terms. */
  allowedVerifierIds: string[];
  resolveKey: (keyId: string, keyVersion: number) => KeyLookupResult | null;
}

export interface VerifierOutcome {
  status: Exclude<VerifierStatus, "missing_evidence" | "unavailable">;
  kind: "deterministic" | "probabilistic";
  details: Record<string, string | number | boolean | null>;
  model: { name: string; version: string; confidence_bps: number } | null;
}

export interface VerifierPlugin {
  name: string;
  version: string;
  evidenceTypes: string[];
  run(context: VerifierContext): VerifierOutcome;
}
