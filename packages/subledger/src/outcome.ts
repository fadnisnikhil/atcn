import { canonicalize, signBytes, utf8Encode, verifyBytes } from "@atcn/schema";
import type { DeliveryClaim, KeyBindingRecord } from "./documents.js";
import { SIGNED_CLAIM_TYPES, type EvidenceRef, type SignedClaimType } from "./types.js";

/**
 * Signed outcome claims (schema 1.5): the provider signs how its work ended (completed, partly completed, cancelled or
 * failed), naming its own job reference (for A2A, the task id) and pointing at its evidence. The buyer records the
 * claim; a matching key binding makes it provider_key_signed. A downstream agent the buyer never dealt with can sign
 * one too, so a delegation chain with a broken edge still carries a verifiable outcome for that edge.
 */

export const OUTCOME_STATEMENT_TYPE = "atcn.subledger.outcome";

/** What the provider signs. */
export interface OutcomeStatement {
  document_type: typeof OUTCOME_STATEMENT_TYPE;
  type: SignedClaimType;
  provider_job_ref: string;
  occurred_at: string;
  note: string | null;
  evidence: EvidenceRef[];
}

export function buildOutcomeStatement(input: { type: SignedClaimType; provider_job_ref: string; occurred_at: string; note?: string | null; evidence?: EvidenceRef[] }): OutcomeStatement {
  return {
    document_type: OUTCOME_STATEMENT_TYPE,
    type: input.type,
    provider_job_ref: input.provider_job_ref,
    occurred_at: new Date(input.occurred_at).toISOString(),
    note: input.note ?? null,
    evidence: input.evidence ?? [],
  };
}

/** Provider-side signing. The operator never holds the provider's private key. */
export function signOutcomeStatement(statement: OutcomeStatement, privateKey: string): string {
  return signBytes(utf8Encode(canonicalize(statement)), privateKey);
}

export function verifyOutcomeSignature(statement: OutcomeStatement, signature: string, publicKey: string): boolean {
  return verifyBytes(utf8Encode(canonicalize(statement)), signature, publicKey);
}

/**
 * Why a signed outcome claim does not verify, or null when it does (or carries no signature). The key must be bound to
 * the delegation's provider and not revoked when the claim occurred, and the delegation must have a provider_job_ref.
 */
export function outcomeSignatureProblem(
  claim: DeliveryClaim,
  delegation: { provider_id: string | null; provider_job_ref: string | null },
  keyBindings: KeyBindingRecord[],
): string | null {
  const signer = claim.signer;
  if (!signer) return null;
  const label = `${claim.type} claim ${claim.event_id}`;
  const type = SIGNED_CLAIM_TYPES.find((t) => t === claim.type);
  if (!type) return `${label} is signed, but only ${SIGNED_CLAIM_TYPES.join(", ")} claims may be`;
  if (delegation.provider_job_ref === null) return `${label} is signed, but its delegation has no provider_job_ref to sign over`;
  if (signer.provider_id !== delegation.provider_id) return `${label} is signed by a provider other than the delegation's`;
  const binding = keyBindings.find((b) => b.binding_id === signer.binding_id && b.key_id === signer.key_id);
  if (!binding) return `${label} is signed with a key binding that is not listed`;
  if (binding.provider_id !== signer.provider_id) return `${label} key binding belongs to another provider`;
  if (binding.revoked_at !== null && binding.revoked_at <= claim.occurred_at) return `${label} was signed after its key binding was revoked`;
  const jobRef = delegation.provider_job_ref;
  const verifies = signedStatementVerifies(() =>
    verifyOutcomeSignature(buildOutcomeStatement({ type, provider_job_ref: jobRef, occurred_at: claim.occurred_at, note: claim.note, evidence: claim.evidence }), signer.value, binding.public_key),
  );
  if (!verifies) return `${label} signature does not verify`;
  return null;
}

/** A statement whose dates cannot be read cannot have been signed as given, so it does not verify. */
function signedStatementVerifies(verify: () => boolean): boolean {
  try {
    return verify();
  } catch {
    return false;
  }
}
