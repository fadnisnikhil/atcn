import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  AgentCard as AgentCardJson,
  StreamResponse,
  TaskState,
  type AgentCard,
  type AgentExtension,
  type Artifact,
  type Part,
} from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutionEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import {
  A2AObligationBridge,
  billingRefExtension,
  localObligationClient,
  obligationIdFromMetadata,
  signedEstimateMetadata,
  signedOutcomeMetadata,
  skillIdFromMetadata,
  type A2AAgentCard,
  type A2AStreamResponse,
} from "@atcn/adapter-a2a";
import type { LocalNetwork } from "@atcn/local-runner";
import { generateKeyPair } from "@atcn/schema";
import { acceptanceData, executionBinding, traceFromOtelSpans, type EventSigner, type OtlpTraceExport } from "@atcn/sdk";
import express from "express";

/** Agent card extension through which an A2A agent names its ATCN agent id, so a buyer can make it the counterparty. */
export const ATCN_EXTENSION_URI = "https://github.com/fadnisnikhil/atcn/tree/main/packages/adapter-a2a";

export function atcnAgentId(card: AgentCard): string {
  const extension = card.capabilities?.extensions.find((e) => e.uri === ATCN_EXTENSION_URI);
  const agentId = extension?.params?.agent_id;
  if (typeof agentId !== "string") throw new Error(`${card.name} does not advertise an ATCN agent id`);
  return agentId;
}

/** A charge or refund in the search provider's own billing system, referencing the A2A task it was for. */
export interface BillingCharge {
  charge_id: string;
  type: "charge" | "refund";
  a2a_task_id: string;
  description: string;
  amount_minor: number;
  currency: string;
  created_at: string;
}

export interface RunningAgent {
  name: string;
  url: string;
  close(): Promise<void>;
}

const EVIDENCE_DIR = new URL("../evidence/", import.meta.url);
/** The model Beta's agent runs on. Declared in obligation.started, so the agent_trace check can hold its trace to it. */
export const CODE_FIX_MODEL = { provider: "openai", name: "gpt-5", version: "2026-08" };
const SEARCH_PRICE_MINOR = 1200;

const textPart = (value: string, mediaType = "text/plain"): Part => ({ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType });
const dataPart = (value: unknown): Part => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });

function status(context: RequestContext, state: TaskState): AgentExecutionEvent {
  return AgentEvent.statusUpdate({
    taskId: context.taskId,
    contextId: context.contextId,
    status: { state, timestamp: new Date().toISOString(), message: undefined },
    metadata: undefined,
  });
}

function submitted(context: RequestContext, metadata: Record<string, unknown> | undefined = context.userMessage.metadata): AgentExecutionEvent {
  return AgentEvent.task({
    id: context.taskId,
    contextId: context.contextId,
    status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [context.userMessage],
    metadata,
  });
}

function artifactEvent(context: RequestContext, artifact: Omit<Artifact, "extensions">): AgentExecutionEvent {
  return AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId, artifact: { ...artifact, extensions: [] }, append: false, lastChunk: true, metadata: undefined });
}

const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n);
const intAttr = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
const textAttr = (key: string, value: string) => ({ key, value: { stringValue: value } });

/**
 * The GenAI spans an OpenTelemetry SDK would export for Beta's run: plan the fix, run the tests, write the patch.
 * Times are the moments the agent reached each stage, so every step falls inside the declared run.
 */
function codeFixSpans(planned: number, tested: number, patched: number): OtlpTraceExport {
  const chat = (spanId: string, start: number, end: number, input: number, cached: number, output: number, responseId: string) => ({
    spanId,
    name: `chat ${CODE_FIX_MODEL.name}`,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: [
      textAttr("gen_ai.operation.name", "chat"),
      textAttr("gen_ai.provider.name", CODE_FIX_MODEL.provider),
      textAttr("gen_ai.response.model", CODE_FIX_MODEL.name),
      textAttr("gen_ai.response.id", responseId),
      intAttr("gen_ai.usage.input_tokens", input),
      intAttr("gen_ai.usage.cache_read.input_tokens", cached),
      intAttr("gen_ai.usage.output_tokens", output),
    ],
  });
  const tool = {
    spanId: "0000000000000002",
    name: "execute_tool run_tests",
    startTimeUnixNano: nanos(tested),
    endTimeUnixNano: nanos(tested),
    attributes: [textAttr("gen_ai.operation.name", "execute_tool"), textAttr("gen_ai.tool.name", "run_tests"), textAttr("gen_ai.tool.call.id", "call_run_tests_1")],
  };
  return {
    resourceSpans: [{ scopeSpans: [{ spans: [chat("0000000000000001", planned, tested, 120_000, 20_000, 6_000, "resp_plan"), tool, chat("0000000000000003", tested, patched, 40_000, 0, 9_000, "resp_patch")] }] }],
  };
}

function toStreamResponse(event: AgentExecutionEvent): StreamResponse {
  switch (event.kind) {
    case "task":
      return { payload: { $case: "task", value: event.data } };
    case "message":
      return { payload: { $case: "message", value: event.data } };
    case "statusUpdate":
      return { payload: { $case: "statusUpdate", value: event.data } };
    case "artifactUpdate":
      return { payload: { $case: "artifactUpdate", value: event.data } };
  }
}

/**
 * Beta Workers' code-fix agent. It only takes work offered as an ATCN obligation: it accepts the offered terms with its
 * own key, then runs the bridge on its own task stream, so its progress, evidence and completion become events it
 * signed. Its evidence is the test, lint and patch reports in ../evidence, and the trace of its run.
 */
class CodeFixExecutor implements AgentExecutor {
  constructor(
    private readonly network: LocalNetwork,
    private readonly signer: EventSigner,
    private readonly agentCard: AgentCard,
    private readonly estimateMinor: number | null,
  ) {}

  /** The task metadata, with Beta's own estimate signed with its key when it publishes one. Recorded by the buyer, never enforced. */
  private taskMetadata(context: RequestContext, obligationId: string, currency: string): Record<string, unknown> | undefined {
    if (this.estimateMinor === null) return context.userMessage.metadata;
    const estimate = signedEstimateMetadata(
      { source: "beta-agent", source_event_id: `est-${obligationId}`, amount_minor: this.estimateMinor, currency, issued_at: new Date().toISOString(), basis: "fixed fee plus expected model usage at cost", expires_at: null, supersedes: null, source_ref: null },
      { keyId: this.signer.identity.keyId, privateKey: this.signer.identity.privateKey },
    );
    const own = (context.userMessage.metadata?.atcn ?? {}) as Record<string, unknown>;
    return { ...context.userMessage.metadata, atcn: { ...own, ...(estimate.atcn as Record<string, unknown>) } };
  }

  cancelTask = async (): Promise<void> => {};

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const obligationId = obligationIdFromMetadata(context.userMessage.metadata);
    if (!obligationId) {
      eventBus.publish(submitted(context));
      eventBus.publish(status(context, TaskState.TASK_STATE_REJECTED));
      return;
    }
    const { terms } = this.network.obligation(obligationId);
    this.network.acceptObligation(this.signer.sign("obligation.accepted", obligationId, acceptanceData(terms, this.signer.actorId)));

    const execution = {
      agentCard: AgentCardJson.toJSON(this.agentCard) as A2AAgentCard,
      skillId: skillIdFromMetadata(context.userMessage.metadata) ?? undefined,
      model: CODE_FIX_MODEL,
    };
    const bridge = new A2AObligationBridge({ client: localObligationClient(this.network), worker: this.signer, obligationId, execution });
    const emit = async (event: AgentExecutionEvent) => {
      eventBus.publish(event);
      await bridge.handle(StreamResponse.toJSON(toStreamResponse(event)) as A2AStreamResponse);
    };
    const deliverableIds = terms.deliverables.map((d) => d.deliverable_id);
    const evidence = (artifactId: string, file: string, mediaType: string, evidenceType: string, verifier: string) =>
      artifactEvent(context, {
        artifactId,
        name: file,
        description: `${evidenceType} for ${obligationId}`,
        parts: [textPart(readFileSync(new URL(file, EVIDENCE_DIR), "utf8"), mediaType)],
        metadata: { atcn: { evidence_type: evidenceType, verifier, deliverable_ids: deliverableIds } },
      });

    await emit(submitted(context, this.taskMetadata(context, obligationId, terms.currency)));
    await emit(status(context, TaskState.TASK_STATE_WORKING));
    const planned = Date.now();
    await emit(evidence("tests", "junit.xml", "application/xml", "test_report", "junit_tests"));
    const tested = Date.now();
    await emit(evidence("lint", "eslint.json", "application/json", "lint_report", "eslint_lint"));
    await emit(evidence("patch", "fix.diff", "text/x-diff", "patch_ref", "patch_digest"));
    const patched = Date.now();

    // The trace binds to the run the bridge declared in obligation.started, which the WORKING update triggered.
    if (bridge.execution) {
      const { trace } = traceFromOtelSpans(codeFixSpans(planned, tested, patched), executionBinding(bridge.execution));
      await emit(
        artifactEvent(context, {
          artifactId: "trace",
          name: "trace.json",
          description: `agent_trace for ${obligationId}`,
          parts: [textPart(JSON.stringify(trace), "application/json")],
          metadata: { atcn: { evidence_type: "agent_trace", verifier: "agent_trace", verifiers: ["agent_trace", "usage_cost"], deliverable_ids: deliverableIds } },
        }),
      );
    }
    await emit(status(context, TaskState.TASK_STATE_COMPLETED));
  }
}

/**
 * Gamma's metered search agent. It bills each search in its own system, by A2A task id. With `failWith`, the search
 * fails after it was billed: Gamma refunds the charge and signs the failure with its own key in the status metadata.
 */
class SearchExecutor implements AgentExecutor {
  constructor(
    private readonly charges: BillingCharge[],
    private readonly failWith: { keyId: string; privateKey: string } | null,
  ) {}

  cancelTask = async (): Promise<void> => {};

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const part = context.userMessage.parts.find((p) => p.content?.$case === "text");
    const query = part?.content?.$case === "text" ? part.content.value : "";
    eventBus.publish(submitted(context));
    eventBus.publish(status(context, TaskState.TASK_STATE_WORKING));
    eventBus.publish(
      artifactEvent(context, {
        artifactId: "results",
        name: "results",
        description: `results for "${query}"`,
        parts: [dataPart({ query, results: [{ title: "Floating point arithmetic: issues and limitations", url: "https://docs.python.org/3/tutorial/floatingpoint.html" }] })],
        metadata: undefined,
      }),
    );
    this.charges.push({
      charge_id: `gamma_ch_${this.charges.length}`,
      type: "charge",
      a2a_task_id: context.taskId,
      description: `search: ${query}`,
      amount_minor: SEARCH_PRICE_MINOR,
      currency: "USD",
      created_at: new Date().toISOString(),
    });
    if (!this.failWith) {
      eventBus.publish(status(context, TaskState.TASK_STATE_COMPLETED));
      return;
    }
    const failedAt = new Date().toISOString();
    this.charges.push({ charge_id: `gamma_rf_${this.charges.length}`, type: "refund", a2a_task_id: context.taskId, description: `refund: search failed`, amount_minor: SEARCH_PRICE_MINOR, currency: "USD", created_at: failedAt });
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        status: { state: TaskState.TASK_STATE_FAILED, timestamp: failedAt, message: undefined },
        metadata: signedOutcomeMetadata({ type: "provider_failure", task_id: context.taskId, occurred_at: failedAt, note: "search index unavailable; charge refunded", evidence: [] }, this.failWith),
      }),
    );
  }
}

/** Serves one agent over A2A JSON-RPC on a free localhost port. Routes added by `extraRoutes` sit beside it. */
async function serve(
  card: { name: string; description: string; skill: string; extensions: AgentExtension[] },
  executorFor: (agentCard: AgentCard) => AgentExecutor,
  extraRoutes: (app: express.Express) => void = () => {},
): Promise<RunningAgent> {
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const agentCard: AgentCard = {
    name: card.name,
    description: card.description,
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: card.name, url: "https://github.com/fadnisnikhil/atcn" },
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: card.extensions, extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "task-status"],
    skills: [{ id: card.skill, name: card.skill, description: card.description, tags: [card.skill], examples: [], inputModes: ["text"], outputModes: ["text"], securityRequirements: [] }],
    documentationUrl: "",
    signatures: [],
  };
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executorFor(agentCard));
  extraRoutes(app);
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    name: card.name,
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Beta Workers' agent. Its ATCN signing key is registered with the network and stays inside this agent. With
 * `estimateMinor`, it publishes a signed estimate of its price in the task metadata (metadata.atcn.estimate).
 */
export function startCodeFixAgent(network: LocalNetwork, options: { estimateMinor?: number } = {}): Promise<RunningAgent> {
  const signer = network.registerAgent("Beta Workers");
  return serve(
    {
      name: "Beta Workers code-fix agent",
      description: "Fixes small bugs for a price agreed as an ATCN obligation; submits test, lint and patch reports and the trace of its run as evidence.",
      skill: "code-fix",
      extensions: [{ uri: ATCN_EXTENSION_URI, description: "Takes paid work as ATCN obligations", required: false, params: { agent_id: signer.actorId } }],
    },
    (agentCard) => new CodeFixExecutor(network, signer, agentCard, options.estimateMinor ?? null),
  );
}

/** Agent card extension through which Gamma publishes the key it signs its outcome statements with. */
export const SIGNING_KEY_EXTENSION_URI = "https://github.com/fadnisnikhil/atcn/blob/main/packages/adapter-a2a/README.md#signed-outcomes";

/** The key an agent card publishes through SIGNING_KEY_EXTENSION_URI, or null when it publishes none. */
export function cardSigningKey(card: A2AAgentCard): { key_id: string; public_key: string } | null {
  const extensions = (card.capabilities as { extensions?: { uri: string; params?: Record<string, unknown> }[] } | undefined)?.extensions ?? [];
  const params = extensions.find((e) => e.uri === SIGNING_KEY_EXTENSION_URI)?.params;
  return typeof params?.key_id === "string" && typeof params.public_key === "string" ? { key_id: params.key_id, public_key: params.public_key } : null;
}

/**
 * Gamma's search agent, with its billing API at GET /billing/charges. The account already has one charge from an
 * earlier job, so importing the bill shows how a charge that belongs to no delegation of this task is handled.
 * With `fail`, the search fails after billing, Gamma refunds it, and its card publishes the key that signs the failure.
 */
export function startSearchAgent(options: { fail?: boolean } = {}): Promise<RunningAgent> {
  const charges: BillingCharge[] = [
    { charge_id: "gamma_ch_0", type: "charge", a2a_task_id: randomUUID(), description: "search: an earlier job's query", amount_minor: SEARCH_PRICE_MINOR, currency: "USD", created_at: new Date().toISOString() },
  ];
  const keys = options.fail ? generateKeyPair() : null;
  const signingKey = keys ? { keyId: "gamma-outcome-key", privateKey: keys.privateKey } : null;
  return serve(
    {
      name: "Gamma Search API",
      description: "Metered web search, USD 12.00 per search, billed monthly by A2A task id.",
      skill: "search",
      // Declares that every bill line carries the A2A task id, so a buyer matches charges without hand mapping.
      extensions: [
        billingRefExtension({ billing_ref: "task_id", currency: "USD", pricing: [{ skill_id: "search", unit: "task", amount_minor: SEARCH_PRICE_MINOR }] }) as AgentExtension,
        ...(keys ? [{ uri: SIGNING_KEY_EXTENSION_URI, description: "Key that signs this agent's outcome statements", required: false, params: { key_id: signingKey!.keyId, public_key: keys.publicKey } }] : []),
      ],
    },
    () => new SearchExecutor(charges, signingKey),
    (app) => app.get("/billing/charges", (_req, res) => void res.json({ items: charges })),
  );
}
