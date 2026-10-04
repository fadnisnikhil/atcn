import {
  ATTESTATION_EVIDENCE_TYPES,
  digestOf,
  disputesInEffect,
  findConflicts,
  inEffect,
  resolveAttestations,
  SignedExternalAttestationSchema,
  verifyPayload,
  type AttestationClaim,
  type AttestationConflict,
  type AttestationItem,
  type ObligationTerms,
  type RecordedEvent,
  type Signed,
} from "@atcn/schema";
import { buildEvidenceInputs, declaredExecutions, resolveCounterparty } from "./evidence.js";

export interface AttestationKey {
  actor_id: string;
  public_key: string;
  revoked_at: string | null;
}

export interface ConflictInput {
  /** The obligation's recorded events. */
  events: RecordedEvent[];
  /** Its accepted terms. */
  terms: ObligationTerms;
  /** Attestation text by content digest (the SHA-256 of the evidence bytes). Items without text are skipped. */
  contents: Map<string, string>;
  resolveKey: (keyId: string, keyVersion: number) => AttestationKey | null;
  /** Reference time: the evaluation time for clearing, generated_at for a closure package. */
  at: string;
  /** Only events up to this sequence count (a decision's input cutoff). */
  cutoffSequence?: number;
}

/**
 * Conflicts among an obligation's attestations in effect at `at`, plus runs the counterparty declared twice with
 * different descriptors. An attestation counts only when its signature verifies with a key of its signer, and the signer
 * may attest: an agreed verifier for verifier attestations; for witness attestations, anyone but the parties, limited to
 * the agreed witnesses when the terms list them. Superseded evidence does not count; who uploaded it does not matter.
 */
export function obligationAttestationConflicts(input: ConflictInput): AttestationConflict[] {
  const visible = input.events.filter((e) => input.cutoffSequence === undefined || e.sequence <= input.cutoffSequence);
  const terms = resolveCounterparty(input.terms, visible);
  const parties = [terms.issuer_agent_id, terms.counterparty_agent_id, terms.principal_id];
  const items: AttestationItem[] = [];
  const claims: AttestationClaim[] = [];
  const seen = new Set<string>();
  for (const evidence of buildEvidenceInputs(visible, input.terms)) {
    if (evidence.superseded || !ATTESTATION_EVIDENCE_TYPES.includes(evidence.envelope.evidence_type)) continue;
    const content = input.contents.get(evidence.envelope.content_digest);
    if (content === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      continue;
    }
    const parsed = SignedExternalAttestationSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { payload: p, signature } = parsed.data;
    if (p.obligation_id !== terms.obligation_id) continue;
    const role = p.role ?? "verifier";
    const allowed =
      role === "verifier"
        ? terms.verifier_agent_ids.includes(p.verifier_id)
        : !parties.includes(p.verifier_id) && (terms.witness_policy?.witness_agent_ids ?? [p.verifier_id]).includes(p.verifier_id);
    if (!allowed) continue;
    const key = input.resolveKey(signature.key_id, signature.key_version);
    // An attestation whose text is not canonical JSON (a fraction in an unknown member) cannot be checked or counted.
    let verified: boolean;
    let digest: string;
    try {
      verified = !!key && key.actor_id === p.verifier_id && verifyPayload(raw as Signed<unknown>, key.public_key);
      digest = digestOf((raw as Signed<unknown>).payload);
    } catch {
      continue;
    }
    if (!key || !verified) continue;
    if (key.revoked_at !== null && Date.parse(key.revoked_at) <= Date.parse(p.issued_at ?? input.at)) continue;
    if (seen.has(digest)) continue;
    seen.add(digest);
    items.push({ digest, signer: p.verifier_id, issued_at: p.issued_at, expires_at: p.expires_at, refs: p.refs });
    claims.push({
      digest,
      signer: p.verifier_id,
      subject: `${terms.obligation_id}/${p.deliverable_id}/${p.check_id}`,
      status: p.status,
      ...(p.execution ? { execution_digest: p.execution.execution_digest } : {}),
    });
  }
  const resolution = resolveAttestations(items, input.at);
  const effective = claims.filter((c) => inEffect(resolution, c.digest));
  return [...findConflicts(effective, disputesInEffect(items, resolution)), ...executionConflicts(visible, terms)].sort((a, b) =>
    a.subject !== b.subject ? (a.subject < b.subject ? -1 : 1) : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
}

/** Two obligation.started events that give one execution_id different descriptors: the counterparty equivocated about the run. */
function executionConflicts(events: RecordedEvent[], terms: ObligationTerms): AttestationConflict[] {
  const byId = new Map<string, Set<string>>();
  for (const e of declaredExecutions(events, terms.counterparty_agent_id)) byId.set(e.execution_id, (byId.get(e.execution_id) ?? new Set()).add(e.execution_digest));
  return [...byId.entries()]
    .filter(([, digests]) => digests.size > 1)
    .map(([executionId, digests]) => ({
      kind: "equivocation" as const,
      subject: `${terms.obligation_id}/execution:${executionId}`,
      attestation_digests: [...digests].sort(),
      signers: [terms.counterparty_agent_id!],
    }));
}
