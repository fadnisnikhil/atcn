import type { DeclaredExecution, EvidenceEnvelope, PolicyCheck, SkillRef, VerifierStatus } from "@atcn/schema";

export interface KeyLookupResult {
  actor_id: string;
  public_key: string;
  /** When the key was revoked, if it was. Signatures dated at or after this time are refused. */
  revoked_at?: string | null;
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
  /** Runs the counterparty declared in signed obligation.started events. */
  executions?: DeclaredExecution[];
  /** The skill named in the accepted terms, if any. */
  termsSkill?: SkillRef | null;
  /** Content digests of every evidence item submitted on the obligation. */
  obligationEvidenceDigests?: string[];
  /** Reference time for attestation expiry (ISO 8601). */
  evaluatedAt?: string;
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
