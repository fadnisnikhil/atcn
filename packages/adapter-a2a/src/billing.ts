import {
  BILLING_REF_EXTENSION_URI,
  BillingRefParamsSchema,
  digestOf,
  providerJobRefFor,
  type AgentCardExtension,
  type BillingRefParams,
  type ExecutionDescriptor,
} from "@atcn/schema";
import { buildExpectationStatement, signExpectation } from "@atcn/sdk";
import { A2A_SKILL_NAMESPACE, ATCN_METADATA_KEY } from "./bridge.js";
import type { A2AAgentCard, A2ATask } from "./types.js";

/** The capabilities.extensions[] entry an agent adds to its Agent Card to declare what its bills reference. */
export function billingRefExtension(params: BillingRefParams): AgentCardExtension {
  return {
    uri: BILLING_REF_EXTENSION_URI,
    description: "Bills reference this value; buyers match charges to the delegated task by it",
    required: false,
    params: BillingRefParamsSchema.parse(params),
  };
}

export interface DelegationFromA2AOptions {
  card: A2AAgentCard;
  task: Pick<A2ATask, "id" | "contextId" | "metadata">;
  currency: string;
  externalRef?: string;
  /** The AgentSkill id the task performs; recorded in the delegation's run descriptor. */
  skillId?: string;
  /** The agent's ATCN agent id when it has one; otherwise the card's name identifies it. */
  agentId?: string;
  /** Used only when the card declares no billing-reference extension (today's hand mapping). */
  fallbackProviderJobRef?: string | null;
  /** The buyer's delegation this task was sent under, when an agent delegates further and records its own sub-task. */
  parentDelegationId?: string;
}

/**
 * A subledger delegation body for work sent to an A2A agent: provider_job_ref comes from the card's declared
 * billing reference, and the run descriptor records the card's digest. Pass it to createDelegation (hosted API, SDK
 * or local runner). An agent without the extension falls back to `fallbackProviderJobRef`.
 */
export function delegationFromA2A(options: DelegationFromA2AOptions): Record<string, unknown> {
  const { card, task } = options;
  const execution: ExecutionDescriptor = {
    execution_id: `a2a:${task.id}`,
    protocol: { name: "a2a", task_id: task.id, ...(task.contextId ? { context_id: task.contextId } : {}) },
    agent: { agent_id: options.agentId ?? card.name, agent_version: card.version, card_digest: digestOf(JSON.parse(JSON.stringify(card))) },
    ...(options.skillId ? { skill: { namespace: A2A_SKILL_NAMESPACE, skill_id: options.skillId } } : {}),
  };
  return {
    ...(options.externalRef ? { external_ref: options.externalRef } : {}),
    ...(options.parentDelegationId ? { parent_delegation_id: options.parentDelegationId } : {}),
    provider_name_stated: card.name,
    provider_job_ref: providerJobRefFor(card, task) ?? options.fallbackProviderJobRef ?? null,
    currency: options.currency,
    execution,
  };
}

/** An agent's own estimate, as it travels in task or artifact metadata under metadata.atcn.estimate. */
export interface A2AEstimate {
  source: string;
  source_event_id: string;
  amount_minor: number;
  currency: string;
  issued_at: string;
  basis: string | null;
  expires_at: string | null;
  supersedes: string | null;
  source_ref: string | null;
  /** The agent's signing key and its signature over the expectation statement; absent for an unsigned estimate. */
  key_id?: string;
  signature?: string;
}

/**
 * Agent side: metadata carrying a signed estimate. The agent signs with its own key; the buyer binds that key to
 * the agent's provider record and records the estimate as provider_key_signed. Record only: nothing is reserved.
 */
export function signedEstimateMetadata(estimate: Omit<A2AEstimate, "key_id" | "signature">, signing: { keyId: string; privateKey: string }): Record<string, unknown> {
  const statement = buildExpectationStatement({
    type: "estimate",
    source: estimate.source,
    source_event_id: estimate.source_event_id,
    amount_minor: estimate.amount_minor,
    currency: estimate.currency,
    issued_at: estimate.issued_at,
    expectation: { issued_by: "agent", source_ref: estimate.source_ref, basis: estimate.basis, expires_at: estimate.expires_at, supersedes: estimate.supersedes },
  });
  return { [ATCN_METADATA_KEY]: { estimate: { ...estimate, issued_at: statement.issued_at, expires_at: statement.expires_at, key_id: signing.keyId, signature: signExpectation(statement, signing.privateKey) } } };
}

/** The estimate in metadata.atcn.estimate, or null when there is none. */
export function estimateFromMetadata(metadata: Record<string, unknown> | undefined): A2AEstimate | null {
  const value = (metadata?.[ATCN_METADATA_KEY] as { estimate?: A2AEstimate } | undefined)?.estimate;
  return value && typeof value.amount_minor === "number" && typeof value.source_event_id === "string" ? value : null;
}

/**
 * Buyer side: the financial event body for an agent's estimate, matched like a charge (usually by the delegation's
 * provider_job_ref). A signed
 * estimate needs the buyer's provider_id and key binding for the agent's key_id; without them the agent's estimate is
 * relayed unsigned and stays buyer_recorded, so a signature by a key the buyer has not bound is never claimed.
 */
export function estimateEventFromA2A(estimate: A2AEstimate, options: { match: Record<string, string>; binding?: { provider_id: string; binding_id: string; key_id: string } }): Record<string, unknown> {
  const signed = estimate.signature !== undefined && options.binding !== undefined && options.binding.key_id === estimate.key_id;
  return {
    type: "estimate",
    source: estimate.source,
    source_event_id: estimate.source_event_id,
    amount_minor: estimate.amount_minor,
    currency: estimate.currency,
    event_date: estimate.issued_at,
    match: options.match,
    expectation: {
      issued_by: "agent",
      source_ref: estimate.source_ref,
      basis: estimate.basis,
      expires_at: estimate.expires_at,
      supersedes: estimate.supersedes,
      ...(signed ? { signer: { provider_id: options.binding!.provider_id, binding_id: options.binding!.binding_id, key_id: options.binding!.key_id, value: estimate.signature! } } : {}),
    },
  };
}
