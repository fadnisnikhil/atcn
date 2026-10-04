import { digestOf } from "./crypto.js";
import type { AttestationConflict, AttestationRef, ExecutionBinding, ExecutionDescriptor, SkillRef } from "./types.js";

/** How far an attestation's issued_at may run ahead of the reference time before it counts as not yet valid. */
export const ATTESTATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A run declared by the agent doing it, as read from a signed obligation.started event. */
export interface DeclaredExecution {
  execution_id: string;
  execution_digest: string;
  started_event_id: string;
  descriptor: ExecutionDescriptor;
  /** Service-recorded time of the obligation.started event (received_at). Traces must not start before it. */
  started_at?: string;
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

/** Whether an attestation still counts: within its time bounds and not revoked. */
export function inEffect(resolution: AttestationResolution, digest: string): boolean {
  const s = resolution.status[digest];
  return s !== undefined && s.time === "valid" && s.revoked_by === null;
}

/** One thing an attestation says about one subject. An attestation about several subjects gives one claim each. */
export interface AttestationClaim {
  digest: string;
  signer: string | null;
  subject: string;
  status: string;
  execution_digest?: string;
}

/**
 * Conflicts among claims that are in effect (filter with inEffect first). Within a subject: one signer saying two
 * different things is `equivocation`; different signers with different statuses is `disagreement`; different cited
 * runs is `execution_mismatch`. `disputes` lists (by, target) attestation pairs where both are in effect; each gives a
 * `disputed` conflict on every subject of the target. One conflict per kind and subject, sorted.
 */
export function findConflicts(claims: AttestationClaim[], disputes: { by: string; target: string }[] = []): AttestationConflict[] {
  const found = new Map<string, { kind: AttestationConflict["kind"]; subject: string; digests: Set<string>; signers: Set<string> }>();
  const add = (kind: AttestationConflict["kind"], subject: string, members: AttestationClaim[]) => {
    const key = `${kind}|${subject}`;
    const entry = found.get(key) ?? { kind, subject, digests: new Set<string>(), signers: new Set<string>() };
    for (const m of members) {
      entry.digests.add(m.digest);
      if (m.signer !== null) entry.signers.add(m.signer);
    }
    found.set(key, entry);
  };

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.subject !== b.subject || a.digest === b.digest) continue;
      const differentRun = a.execution_digest !== undefined && b.execution_digest !== undefined && a.execution_digest !== b.execution_digest;
      if (a.signer !== null && a.signer === b.signer) {
        if (a.status !== b.status || differentRun) add("equivocation", a.subject, [a, b]);
        continue;
      }
      if (a.status !== b.status) add("disagreement", a.subject, [a, b]);
      if (differentRun) add("execution_mismatch", a.subject, [a, b]);
    }
  }
  for (const { by, target } of disputes) {
    const disputer = claims.find((c) => c.digest === by);
    for (const t of claims.filter((c) => c.digest === target)) add("disputed", t.subject, disputer ? [disputer, t] : [t]);
  }

  return [...found.values()]
    .map((e) => ({ kind: e.kind, subject: e.subject, attestation_digests: [...e.digests].sort(), signers: [...e.signers].sort() }))
    .sort((x, y) => (x.subject !== y.subject ? (x.subject < y.subject ? -1 : 1) : x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
}

/** (by, target) pairs for every `disputes` reference where both attestations are in effect. */
export function disputesInEffect(items: AttestationItem[], resolution: AttestationResolution): { by: string; target: string }[] {
  return items.flatMap((item) =>
    inEffect(resolution, item.digest)
      ? (item.refs ?? []).filter((r) => r.relation === "disputes" && inEffect(resolution, r.attestation_digest)).map((r) => ({ by: item.digest, target: r.attestation_digest }))
      : [],
  );
}

/** A witness and the registrable domain (eTLD+1) the service verified for it by DNS challenge, or null if none. */
export interface WitnessCandidate {
  witness_id: string;
  domain: string | null;
}

export interface WitnessCount {
  counted: { witness_id: string; domain: string }[];
  refused: { witness_id: string; reason: string }[];
}

/**
 * Applies `distinct_verified_domain`: a witness counts only with a verified domain that differs from every party's
 * domain and from every witness already counted. Two witnesses under one domain count once. The caller must make sure
 * every party has a verified domain; without one, overlap cannot be checked.
 */
export function countIndependentWitnesses(candidates: WitnessCandidate[], partyDomains: string[]): WitnessCount {
  const parties = new Set(partyDomains.map((d) => d.toLowerCase()));
  const counted: WitnessCount["counted"] = [];
  const refused: WitnessCount["refused"] = [];
  for (const c of candidates) {
    if (counted.some((w) => w.witness_id === c.witness_id)) continue;
    const domain = c.domain?.toLowerCase() ?? null;
    const sameDomain = domain === null ? undefined : counted.find((w) => w.domain === domain);
    if (domain === null) refused.push({ witness_id: c.witness_id, reason: "has no verified domain" });
    else if (parties.has(domain)) refused.push({ witness_id: c.witness_id, reason: `shares the domain ${domain} with a party` });
    else if (sameDomain) refused.push({ witness_id: c.witness_id, reason: `shares the domain ${domain} with witness ${sameDomain.witness_id}` });
    else counted.push({ witness_id: c.witness_id, domain });
  }
  return { counted, refused };
}
