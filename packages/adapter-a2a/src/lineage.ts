import { ATCN_METADATA_KEY } from "./bridge.js";
import type { A2AOutcome } from "./outcome.js";
import type { A2ATask } from "./types.js";

/**
 * Multi-hop lineage over A2A. When an agent delegates part of its task to another agent, the message that starts the
 * sub-task carries the chain of tasks above it (metadata.atcn.lineage), and the agent reports its sub-tasks back up
 * (metadata.atcn.downstream) with each sub-agent's outcome relayed unchanged. The buyer records every reported sub-task
 * as a child delegation; a sub-agent's signed outcome verifies against its own key even though the buyer never dealt
 * with it, and a sub-task with no outcome is recorded as a broken edge (a capture gap) rather than silently dropped.
 */

/** One hop of the chain: a task an agent was working on when it delegated further. */
export interface A2ALineageHop {
  task_id: string;
  context_id: string | null;
  agent: string;
}

/** The chain in metadata.atcn.lineage, root first; empty when there is none. */
export function lineageFromMetadata(metadata: Record<string, unknown> | undefined): A2ALineageHop[] {
  const value = (metadata?.[ATCN_METADATA_KEY] as { lineage?: unknown } | undefined)?.lineage;
  if (!Array.isArray(value)) return [];
  return value.filter((hop): hop is A2ALineageHop => typeof hop?.task_id === "string" && typeof hop?.agent === "string");
}

/**
 * Delegating agent's side: metadata for the message that starts a sub-task. The chain is the one the agent's own task
 * arrived with, plus its own task.
 */
export function lineageMetadata(parentTask: Pick<A2ATask, "id" | "contextId" | "metadata">, agent: string): Record<string, unknown> {
  const hop: A2ALineageHop = { task_id: parentTask.id, context_id: parentTask.contextId ?? null, agent };
  return { [ATCN_METADATA_KEY]: { lineage: [...lineageFromMetadata(parentTask.metadata), hop] } };
}

/** A sub-task an agent delegated, as it reports it upstream. outcome is the sub-agent's own (signed) outcome, or null when none arrived. */
export interface A2ADownstreamEdge {
  agent: string;
  task_id: string;
  context_id: string | null;
  outcome: A2AOutcome | null;
}

/** Delegating agent's side: task or status metadata reporting its sub-tasks. */
export function downstreamMetadata(edges: A2ADownstreamEdge[]): Record<string, unknown> {
  return { [ATCN_METADATA_KEY]: { downstream: edges } };
}

/** The sub-tasks in metadata.atcn.downstream; empty when there are none. */
export function downstreamFromMetadata(metadata: Record<string, unknown> | undefined): A2ADownstreamEdge[] {
  const value = (metadata?.[ATCN_METADATA_KEY] as { downstream?: unknown } | undefined)?.downstream;
  if (!Array.isArray(value)) return [];
  return value.filter((edge): edge is A2ADownstreamEdge => typeof edge?.task_id === "string" && typeof edge?.agent === "string");
}

/**
 * Buyer side: the child delegation body for a reported sub-task, under the delegation of the agent that reported it.
 * Pass providerId when the sub-agent is a known provider with a bound key, so its signed outcome counts.
 */
export function childDelegationFromA2A(edge: A2ADownstreamEdge, options: { parentDelegationId: string; currency: string; providerId?: string }): Record<string, unknown> {
  return {
    parent_delegation_id: options.parentDelegationId,
    ...(options.providerId ? { provider_id: options.providerId } : {}),
    provider_name_stated: edge.agent,
    provider_job_ref: edge.task_id,
    currency: options.currency,
  };
}

/** Buyer side: the capture gap body for a sub-task that reported no outcome. */
export function brokenEdgeGap(edge: A2ADownstreamEdge, childDelegationId: string): { delegation_id: string; kind: "broken_edge"; detail: string } {
  return { delegation_id: childDelegationId, kind: "broken_edge", detail: `${edge.agent} task ${edge.task_id} reported no outcome` };
}
