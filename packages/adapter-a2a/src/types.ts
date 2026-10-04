/** A2A v1.0 shapes used by the bridge (a2a-protocol.org, camelCase JSON). */

export type A2ATaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

/** One unified part: exactly one of text, raw (base64 bytes), url, or data. */
export interface A2APart {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: unknown;
  timestamp?: string;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  index?: number;
  metadata?: Record<string, unknown>;
}

/** The agent card fields the bridge reads, in A2A wire JSON (with @a2a-js/sdk, `AgentCard.toJSON(card)`). */
export interface A2AAgentCard {
  name: string;
  version: string;
  skills?: { id: string }[];
  [field: string]: unknown;
}

/**
 * Stream responses are discriminated by member name. With @a2a-js/sdk, `StreamResponse.toJSON(event)` produces
 * this shape from the SDK's objects.
 */
export type A2AStreamResponse =
  | { task: A2ATask }
  | { message: unknown }
  | { statusUpdate: A2ATaskStatusUpdateEvent }
  | { artifactUpdate: A2ATaskArtifactUpdateEvent };
