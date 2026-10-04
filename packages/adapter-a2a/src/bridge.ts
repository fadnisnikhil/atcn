import { createHash } from "node:crypto";
import { digestOf, sha256Digest, type ExecutionDescriptor, type SignedEvent } from "@atcn/schema";
import { buildEvidenceEnvelope, type EventSigner } from "@atcn/sdk";
import type { A2AAgentCard, A2AArtifact, A2APart, A2AStreamResponse, A2ATaskState } from "./types.js";

/** Metadata namespace the bridge reads on A2A messages, tasks and artifacts. */
export const ATCN_METADATA_KEY = "atcn";

/** SkillRef namespace for A2A: the skill_id is an AgentSkill id from the worker's agent card. */
export const A2A_SKILL_NAMESPACE = "a2a";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Evidence id derived from the obligation, the artifact id and the artifact's content digest. Every task snapshot
 * (tasks/get returns all artifacts each time) yields the same id for the same artifact, so it is recorded once.
 */
export function artifactEvidenceId(obligationId: string, artifactId: string, contentDigest: string): string {
  const hash = createHash("sha256").update(`${obligationId}\n${artifactId}\n${contentDigest}`).digest();
  let body = "";
  for (let i = 0; i < 26; i++) body += CROCKFORD[hash[i] % 32];
  return `evd_${body}`;
}

/** Metadata a delegating agent attaches to the A2A message (or task) it sends for an ATCN obligation. */
export function obligationTaskMetadata(obligationId: string, options: { skillId?: string } = {}): Record<string, unknown> {
  return { [ATCN_METADATA_KEY]: { obligation_id: obligationId, ...(options.skillId ? { skill_id: options.skillId } : {}) } };
}

/** The obligation id written by obligationTaskMetadata, or null when the metadata carries none. */
export function obligationIdFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.[ATCN_METADATA_KEY] as { obligation_id?: unknown } | undefined;
  return typeof value?.obligation_id === "string" ? value.obligation_id : null;
}

/** The skill id written by obligationTaskMetadata, or null when the metadata names none. */
export function skillIdFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.[ATCN_METADATA_KEY] as { skill_id?: unknown } | undefined;
  return typeof value?.skill_id === "string" ? value.skill_id : null;
}

/**
 * Artifact metadata marking an artifact as ATCN evidence. url parts must carry content_digest,
 * because ATCN verifies digests of bytes the producer actually held.
 */
export interface ArtifactEvidenceMetadata {
  evidence_type: string;
  verifier: string;
  /** Every verifier that may read the evidence, when more than one does (an agent_trace for agent_trace and usage_cost). Defaults to [verifier]. */
  verifiers?: string[];
  deliverable_ids: string[];
  content_digest?: string;
}

/** The calls the bridge makes. `AtcnClient` from @atcn/sdk has them; localObligationClient adapts the local runner. */
export interface ObligationClient {
  getObligation(obligationId: string): Promise<unknown>;
  appendEvent(obligationId: string, signed: SignedEvent): Promise<unknown>;
  uploadBlob(bytes: Uint8Array, mediaType?: string): Promise<{ uri: string }>;
  submitEvidence(obligationId: string, signed: SignedEvent): Promise<unknown>;
}

/** The parts of the local runner's `LocalNetwork` (@atcn/local-runner) the bridge uses. */
export interface LocalNetworkLike {
  obligation(obligationId: string): { state: string };
  appendLifecycleEvent(body: unknown): unknown;
  uploadBlob(content: Uint8Array): string;
  submitEvidence(body: unknown): unknown;
}

/** Lets the bridge write to the local runner's in-memory network instead of the hosted API. */
export function localObligationClient(network: LocalNetworkLike): ObligationClient {
  return {
    getObligation: async (obligationId) => network.obligation(obligationId),
    appendEvent: async (_obligationId, signed) => network.appendLifecycleEvent(signed),
    uploadBlob: async (bytes) => ({ uri: network.uploadBlob(bytes) }),
    submitEvidence: async (_obligationId, signed) => network.submitEvidence(signed),
  };
}

export type BridgeAction =
  | { kind: "event"; eventType: "obligation.started" | "completion.proposed"; eventId: string }
  | { kind: "evidence"; artifactId: string; evidenceId: string }
  /** The task ended undelivered. Record `claimType` on the buyer's delegation (see outcomeClaimFromA2A); the issuer may cancel the obligation. */
  | { kind: "terminal"; state: A2ATaskState; claimType: "provider_failure" | "cancellation"; taskId: string }
  | { kind: "skipped"; detail: string };

export interface BridgeOptions {
  client: ObligationClient;
  /** Signer for the remote (working) agent, i.e. the obligation's counterparty. */
  worker: EventSigner;
  obligationId: string;
  /**
   * Describes the run in obligation.started, so attestations can cite it: the A2A task and context ids, the agent
   * card's version and digest, and the skill. Without it, obligation.started carries no run.
   */
  execution?: {
    agentCard: A2AAgentCard;
    agentCardUrl?: string;
    skillId?: string;
    model?: { provider: string; name: string; version: string };
    configDigest?: string;
  };
  /**
   * Evidence ids the obligation already holds (for example from listEvidence), so a bridge restarted mid-task skips
   * them. Without it, the service refuses the repeated id ("evidence_id already registered") and records nothing twice.
   */
  submittedEvidenceIds?: string[];
}

/**
 * Translates an A2A task stream from the worker's side into ATCN signed events:
 * WORKING -> obligation.started, evidence-tagged artifacts -> evidence.submitted,
 * COMPLETED -> completion.proposed. Terminal FAILED/CANCELED/REJECTED states sign nothing on the obligation (only the
 * issuer may cancel it); they come back as "terminal" actions naming the subledger claim to record.
 */
export class A2AObligationBridge {
  private started = false;
  private completed = false;
  private readonly pendingChunks = new Map<string, A2APart[]>();
  private readonly submittedEvidenceIds: Set<string>;
  /** The run this bridge declared in obligation.started, once it has. */
  execution: ExecutionDescriptor | null = null;

  constructor(private readonly options: BridgeOptions) {
    this.submittedEvidenceIds = new Set(options.submittedEvidenceIds ?? []);
  }

  async handle(response: A2AStreamResponse): Promise<BridgeAction[]> {
    if ("task" in response) {
      const actions = await this.onState(response.task.status.state, response.task.id, response.task.contextId);
      for (const artifact of response.task.artifacts ?? []) actions.push(await this.onArtifact(artifact));
      return actions;
    }
    if ("statusUpdate" in response) return this.onState(response.statusUpdate.status.state, response.statusUpdate.taskId, response.statusUpdate.contextId);
    if ("artifactUpdate" in response) {
      const update = response.artifactUpdate;
      const previous = update.append ? (this.pendingChunks.get(update.artifact.artifactId) ?? []) : [];
      const parts = appendParts(previous, update.artifact.parts);
      if (update.lastChunk === false) {
        this.pendingChunks.set(update.artifact.artifactId, parts);
        return [];
      }
      this.pendingChunks.delete(update.artifact.artifactId);
      return [await this.onArtifact({ ...update.artifact, parts })];
    }
    return [];
  }

  private async onState(state: A2ATaskState, taskId: string, contextId: string): Promise<BridgeAction[]> {
    const { client, worker, obligationId } = this.options;
    const actions: BridgeAction[] = [];
    if ((state === "TASK_STATE_WORKING" || state === "TASK_STATE_COMPLETED") && !this.started) {
      const current = (await client.getObligation(obligationId)) as { state: string };
      if (current.state === "accepted") {
        const execution = this.describeRun(taskId, contextId);
        const signed = worker.sign("obligation.started", obligationId, execution ? { execution } : {});
        await client.appendEvent(obligationId, signed);
        this.execution = execution;
        actions.push({ kind: "event", eventType: "obligation.started", eventId: signed.payload.event_id });
      }
      this.started = true;
    }
    if (state === "TASK_STATE_COMPLETED" && !this.completed) {
      const signed = worker.sign("completion.proposed", obligationId, { note: "A2A task completed" });
      await client.appendEvent(obligationId, signed);
      this.completed = true;
      actions.push({ kind: "event", eventType: "completion.proposed", eventId: signed.payload.event_id });
    }
    if (state === "TASK_STATE_FAILED" || state === "TASK_STATE_CANCELED" || state === "TASK_STATE_REJECTED") {
      actions.push({ kind: "terminal", state, claimType: state === "TASK_STATE_FAILED" ? "provider_failure" : "cancellation", taskId });
    }
    return actions;
  }

  private describeRun(taskId: string, contextId: string): ExecutionDescriptor | null {
    const options = this.options.execution;
    if (!options) return null;
    return {
      execution_id: `a2a:${taskId}`,
      protocol: { name: "a2a", task_id: taskId, ...(contextId ? { context_id: contextId } : {}) },
      agent: {
        agent_id: this.options.worker.actorId,
        agent_version: options.agentCard.version,
        card_digest: digestOf(JSON.parse(JSON.stringify(options.agentCard))),
        ...(options.model ? { model: options.model } : {}),
        ...(options.configDigest ? { config_digest: options.configDigest } : {}),
      },
      ...(options.skillId
        ? { skill: { namespace: A2A_SKILL_NAMESPACE, skill_id: options.skillId, ...(options.agentCardUrl ? { agent_card_url: options.agentCardUrl } : {}) } }
        : {}),
    };
  }

  private async onArtifact(artifact: A2AArtifact): Promise<BridgeAction> {
    const meta = artifact.metadata?.[ATCN_METADATA_KEY] as ArtifactEvidenceMetadata | undefined;
    if (!meta) return { kind: "skipped", detail: `artifact ${artifact.artifactId} has no ${ATCN_METADATA_KEY} evidence metadata` };
    const { client, worker, obligationId } = this.options;
    const part = artifact.parts[0];
    if (!part || artifact.parts.length !== 1) return { kind: "skipped", detail: `artifact ${artifact.artifactId} must have exactly one part to be evidence` };

    if (part.url !== undefined && !meta.content_digest) return { kind: "skipped", detail: `url artifact ${artifact.artifactId} needs metadata.atcn.content_digest` };
    const bytes = part.url === undefined ? partBytes(part) : null;
    const contentDigest = bytes ? sha256Digest(bytes) : meta.content_digest!;
    const evidenceId = artifactEvidenceId(obligationId, artifact.artifactId, contentDigest);
    if (this.submittedEvidenceIds.has(evidenceId)) return { kind: "skipped", detail: `artifact ${artifact.artifactId} was already submitted as ${evidenceId}` };

    let envelope;
    if (part.url !== undefined) {
      envelope = {
        ...buildEvidenceEnvelope({
          evidenceType: meta.evidence_type,
          producerId: worker.actorId,
          content: "",
          uri: part.url,
          retrievalMethod: "https",
          mediaType: part.mediaType ?? "application/octet-stream",
          verifiers: meta.verifiers ?? [meta.verifier],
          deliverableIds: meta.deliverable_ids,
        }),
        content_digest: contentDigest,
      };
    } else {
      const mediaType = part.mediaType ?? (part.data !== undefined ? "application/json" : "text/plain");
      const blob = await client.uploadBlob(bytes!, mediaType);
      envelope = buildEvidenceEnvelope({
        evidenceType: meta.evidence_type,
        producerId: worker.actorId,
        content: bytes!,
        uri: blob.uri,
        retrievalMethod: "atcn-blob",
        mediaType,
        verifiers: meta.verifiers ?? [meta.verifier],
        deliverableIds: meta.deliverable_ids,
      });
    }
    envelope = { ...envelope, evidence_id: evidenceId };
    await client.submitEvidence(obligationId, worker.sign("evidence.submitted", obligationId, { envelope }));
    this.submittedEvidenceIds.add(evidenceId);
    return { kind: "evidence", artifactId: artifact.artifactId, evidenceId };
  }
}

/** Streamed text chunks continue the previous text part; other parts are kept as they are. */
function appendParts(previous: A2APart[], next: A2APart[]): A2APart[] {
  const result = [...previous];
  for (const part of next) {
    const last = result.at(-1);
    if (last?.text !== undefined && part.text !== undefined) result[result.length - 1] = { ...last, text: last.text + part.text };
    else result.push(part);
  }
  return result;
}

function partBytes(part: A2APart): Uint8Array {
  if (part.raw !== undefined) return new Uint8Array(Buffer.from(part.raw, "base64"));
  if (part.text !== undefined) return new TextEncoder().encode(part.text);
  return new TextEncoder().encode(JSON.stringify(part.data ?? null));
}
