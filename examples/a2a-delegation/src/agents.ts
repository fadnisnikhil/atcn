import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, StreamResponse, TaskState, type AgentCard, type AgentExtension, type Artifact, type Part } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutionEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { A2AObligationBridge, localObligationClient, obligationIdFromMetadata, type A2AStreamResponse } from "@atcn/adapter-a2a";
import type { LocalNetwork } from "@atcn/local-runner";
import { acceptanceData, type EventSigner } from "@atcn/sdk";
import express from "express";

/** Agent card extension through which an A2A agent names its ATCN agent id, so a buyer can make it the counterparty. */
export const ATCN_EXTENSION_URI = "https://github.com/fadnisnikhil/atcn/tree/main/packages/adapter-a2a";

export function atcnAgentId(card: AgentCard): string {
  const extension = card.capabilities?.extensions.find((e) => e.uri === ATCN_EXTENSION_URI);
  const agentId = extension?.params?.agent_id;
  if (typeof agentId !== "string") throw new Error(`${card.name} does not advertise an ATCN agent id`);
  return agentId;
}

/** A charge in the search provider's own billing system, referencing the A2A task it was for. */
export interface BillingCharge {
  charge_id: string;
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

function submitted(context: RequestContext): AgentExecutionEvent {
  return AgentEvent.task({
    id: context.taskId,
    contextId: context.contextId,
    status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [context.userMessage],
    metadata: context.userMessage.metadata,
  });
}

function artifactEvent(context: RequestContext, artifact: Omit<Artifact, "extensions">): AgentExecutionEvent {
  return AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId, artifact: { ...artifact, extensions: [] }, append: false, lastChunk: true, metadata: undefined });
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
 * signed. Its evidence is the test, lint and patch reports in ../evidence.
 */
class CodeFixExecutor implements AgentExecutor {
  constructor(
    private readonly network: LocalNetwork,
    private readonly signer: EventSigner,
  ) {}

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

    const bridge = new A2AObligationBridge({ client: localObligationClient(this.network), worker: this.signer, obligationId });
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

    await emit(submitted(context));
    await emit(status(context, TaskState.TASK_STATE_WORKING));
    await emit(evidence("tests", "junit.xml", "application/xml", "test_report", "junit_tests"));
    await emit(evidence("lint", "eslint.json", "application/json", "lint_report", "eslint_lint"));
    await emit(evidence("patch", "fix.diff", "text/x-diff", "patch_ref", "patch_digest"));
    await emit(status(context, TaskState.TASK_STATE_COMPLETED));
  }
}

/** Gamma's metered search agent. It knows nothing about ATCN: it bills each search in its own system, by A2A task id. */
class SearchExecutor implements AgentExecutor {
  constructor(private readonly charges: BillingCharge[]) {}

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
      a2a_task_id: context.taskId,
      description: `search: ${query}`,
      amount_minor: SEARCH_PRICE_MINOR,
      currency: "USD",
      created_at: new Date().toISOString(),
    });
    eventBus.publish(status(context, TaskState.TASK_STATE_COMPLETED));
  }
}

/** Serves one agent over A2A JSON-RPC on a free localhost port. Routes added by `extraRoutes` sit beside it. */
async function serve(
  card: { name: string; description: string; skill: string; extensions: AgentExtension[] },
  executor: AgentExecutor,
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
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);
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

/** Beta Workers' agent. Its ATCN signing key is registered with the network and stays inside this agent. */
export function startCodeFixAgent(network: LocalNetwork): Promise<RunningAgent> {
  const signer = network.registerAgent("Beta Workers");
  return serve(
    {
      name: "Beta Workers code-fix agent",
      description: "Fixes small bugs for a fixed price agreed as an ATCN obligation; submits test, lint and patch reports as evidence.",
      skill: "code-fix",
      extensions: [{ uri: ATCN_EXTENSION_URI, description: "Takes paid work as ATCN obligations", required: false, params: { agent_id: signer.actorId } }],
    },
    new CodeFixExecutor(network, signer),
  );
}

/**
 * Gamma's search agent, with its billing API at GET /billing/charges. The account already has one charge from an
 * earlier job, so importing the bill shows how a charge that belongs to no delegation of this task is handled.
 */
export function startSearchAgent(): Promise<RunningAgent> {
  const charges: BillingCharge[] = [
    { charge_id: "gamma_ch_0", a2a_task_id: randomUUID(), description: "search: an earlier job's query", amount_minor: SEARCH_PRICE_MINOR, currency: "USD", created_at: new Date().toISOString() },
  ];
  return serve(
    { name: "Gamma Search API", description: "Metered web search, USD 12.00 per search, billed monthly by A2A task id.", skill: "search", extensions: [] },
    new SearchExecutor(charges),
    (app) => app.get("/billing/charges", (_req, res) => void res.json({ items: charges })),
  );
}
