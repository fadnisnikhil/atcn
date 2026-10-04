import { digestOf } from "./crypto.js";
import type { AttestationRef, ExecutionBinding, ExecutionDescriptor, SkillRef } from "./types.js";

/** How far an attestation's issued_at may run ahead of the reference time before it counts as not yet valid. */
export const ATTESTATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A run declared by the agent doing it, as read from a signed obligation.started event. */
export interface DeclaredExecution {
  execution_id: string;
  execution_digest: string;
  started_event_id: string;
  descriptor: ExecutionDescriptor;
}

export function executionBinding(descriptor: ExecutionDescriptor): ExecutionBinding {
  return { execution_id: descriptor.execution_id, execution_digest: digestOf(descriptor) };
}

export function sameSkill(a: SkillRef | undefined, b: SkillRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.namespace === b.namespace && a.skill_id === b.skill_id;
}

export type AttestationTimeStatus = "valid" | "expired" | "not_yet_valid";

/** Whether an attestation holds at `at`. Without issued_at or expires_at, that bound does not apply. */
export function attestationTimeStatus(attestation: { issued_at?: string; expires_at?: string }, at: string): AttestationTimeStatus {
  const atMs = Date.parse(at);
  if (attestation.issued_at !== undefined && Date.parse(attestation.issued_at) > atMs + ATTESTATION_CLOCK_SKEW_MS) return "not_yet_valid";
  if (attestation.expires_at !== undefined && atMs >= Date.parse(attestation.expires_at)) return "expired";
  return "valid";
}

/** One attestation as the resolver sees it. signer is null when no verified key stands behind it, so it cannot revoke. */
export interface AttestationItem {
  digest: string;
  signer: string | null;
  issued_at?: string;
  expires_at?: string;
  refs?: AttestationRef[];
}

export interface AttestationProblem {
  /** The attestation carrying the reference. */
  digest: string;
  code: "revocation_not_by_signer" | "unknown_reference";
  /** The referenced attestation digest. */
  target: string;
}

export interface AttestationResolution {
  status: Record<string, { time: AttestationTimeStatus; revoked_by: string | null }>;
  problems: AttestationProblem[];
}

/**
 * Applies expiry and revocation to a set of attestations at reference time `at`.
 * A revocation takes effect only when its own signer signed the target; it stays in force even if the revoking
 * attestation later expires or is itself revoked. Disputes never change status; they are kept for conflict handling.
 * A reference to an attestation not in the set is reported, not treated as invalid: it may simply not have been shared.
 */
export function resolveAttestations(items: AttestationItem[], at: string): AttestationResolution {
  const byDigest = new Map(items.map((item) => [item.digest, item]));
  const status: AttestationResolution["status"] = {};
  for (const item of items) status[item.digest] = { time: attestationTimeStatus(item, at), revoked_by: null };
  const problems: AttestationProblem[] = [];
  for (const item of items) {
    if (status[item.digest].time === "not_yet_valid") continue;
    for (const ref of item.refs ?? []) {
      const target = byDigest.get(ref.attestation_digest);
      if (!target) {
        problems.push({ digest: item.digest, code: "unknown_reference", target: ref.attestation_digest });
        continue;
      }
      if (ref.relation !== "revokes") continue;
      if (item.signer === null || target.signer !== item.signer) {
        problems.push({ digest: item.digest, code: "revocation_not_by_signer", target: target.digest });
        continue;
      }
      status[target.digest].revoked_by ??= item.digest;
    }
  }
  return { status, problems };
}
