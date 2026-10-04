import { buildOutcomeStatement, signOutcomeStatement, type EvidenceRef, type SignedClaimType } from "@atcn/sdk";
import { ATCN_METADATA_KEY } from "./bridge.js";
import type { A2ATaskState } from "./types.js";

/** A2A terminal states where the work ended undelivered, and the subledger claim each one becomes. */
export const TERMINAL_CLAIM_BY_STATE: Partial<Record<A2ATaskState, "provider_failure" | "cancellation">> = {
  TASK_STATE_FAILED: "provider_failure",
  TASK_STATE_CANCELED: "cancellation",
  TASK_STATE_REJECTED: "cancellation",
};

/** The subledger claim type for an A2A task that ended undelivered; throws for any other state. */
export function terminalClaimType(state: A2ATaskState): "provider_failure" | "cancellation" {
  const type = TERMINAL_CLAIM_BY_STATE[state];
  if (!type) throw new Error(`${state} is not a terminal non-success A2A state; use TASK_STATE_FAILED, TASK_STATE_CANCELED or TASK_STATE_REJECTED`);
  return type;
}

/**
 * An agent's statement of how its A2A task ended, as it travels under metadata.atcn.outcome: completed, partly
 * completed, cancelled or failed, with pointers to its evidence.
 */
export interface A2AOutcome {
  type: SignedClaimType;
  task_id: string;
  occurred_at: string;
  note: string | null;
  evidence: EvidenceRef[];
  /** The agent's signing key and its signature over the outcome statement; absent when unsigned. */
  key_id?: string;
  signature?: string;
}

/** Agent side: the outcome with the agent's signature over the A2A task id, note and evidence. */
export function signOutcome(outcome: Omit<A2AOutcome, "key_id" | "signature">, signing: { keyId: string; privateKey: string }): A2AOutcome {
  const statement = buildOutcomeStatement({ type: outcome.type, provider_job_ref: outcome.task_id, occurred_at: outcome.occurred_at, note: outcome.note, evidence: outcome.evidence });
  return { ...outcome, occurred_at: statement.occurred_at, key_id: signing.keyId, signature: signOutcomeStatement(statement, signing.privateKey) };
}

/**
 * Agent side: task or status metadata carrying a signed outcome. The buyer binds the agent's key to its provider
 * record and records the claim as provider_key_signed.
 */
export function signedOutcomeMetadata(outcome: Omit<A2AOutcome, "key_id" | "signature">, signing: { keyId: string; privateKey: string }): Record<string, unknown> {
  return { [ATCN_METADATA_KEY]: { outcome: signOutcome(outcome, signing) } };
}

/** The outcome in metadata.atcn.outcome, or null when there is none. */
export function outcomeFromMetadata(metadata: Record<string, unknown> | undefined): A2AOutcome | null {
  const value = (metadata?.[ATCN_METADATA_KEY] as { outcome?: A2AOutcome } | undefined)?.outcome;
  return value && typeof value.task_id === "string" && typeof value.type === "string" ? value : null;
}

/**
 * Buyer side: the delivery claim body for an agent's outcome. Record it on the delegation whose provider_job_ref is
 * the task id. A signature counts only with the buyer's key binding for the agent's key_id; otherwise the claim is
 * relayed unsigned and stays buyer_recorded.
 */
export function outcomeClaimFromA2A(outcome: A2AOutcome, options: { binding?: { provider_id: string; binding_id: string; key_id: string } } = {}): Record<string, unknown> {
  const binding = options.binding;
  const signed = outcome.signature !== undefined && binding !== undefined && binding.key_id === outcome.key_id;
  return {
    type: outcome.type,
    asserted_by: "provider",
    note: outcome.note,
    occurred_at: outcome.occurred_at,
    evidence: outcome.evidence,
    ...(signed ? { signer: { provider_id: binding.provider_id, binding_id: binding.binding_id, key_id: binding.key_id, value: outcome.signature! } } : {}),
  };
}
