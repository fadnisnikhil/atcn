import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentCard as AgentCardJson, Role, StreamResponse, type SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import {
  delegationFromA2A,
  estimateEventFromA2A,
  estimateFromMetadata,
  obligationTaskMetadata,
  outcomeClaimFromA2A,
  outcomeFromMetadata,
  type A2AAgentCard,
  type A2AStreamResponse,
} from "@atcn/adapter-a2a";
import { AGENT_USAGE_POLICY_V1, verifyClosurePackage, type PackageVerificationReport } from "@atcn/core";
import { LocalNetwork, LocalSubledger, loadOrCreateServiceKey, servicePublicKey, type LocalException } from "@atcn/local-runner";
import type { ClosurePackage, ExecutionDescriptor, Pricing, PublicKeyRecord, SkillRef, VerifierResult } from "@atcn/schema";
import { buildTerms, termsData } from "@atcn/sdk";
import { verifySubledgerDocument, type SignedClosure, type SubledgerVerificationReport, type Totals } from "@atcn/subledger";
import { atcnAgentId, cardSigningKey, CODE_FIX_MODEL, startCodeFixAgent, startSearchAgent, type BillingCharge } from "./agents.js";

export interface A2ADelegationResult {
  task_id: string;
  /** The run Beta's agent declared in obligation.started. */
  execution: ExecutionDescriptor | null;
  /** The agent_trace and usage_cost results for Beta's trace. */
  trace_check: VerifierResult | null;
  usage_check: VerifierResult | null;
  closure: SignedClosure;
  packages: ClosurePackage[];
  trusted_keys: PublicKeyRecord[];
  totals: Record<string, Totals>;
  open_exceptions: LocalException[];
  verification: { closure: SubledgerVerificationReport; packages: PackageVerificationReport[] };
  valid: boolean;
  files: { dir: string; closure: string; keys: string; packages: string[]; traces: string[] };
}

export interface RunOptions {
  /** Where the service key and run outputs go. */
  dataDir: string;
  log?: (line: string) => void;
  /**
   * Also record estimates: Beta's agent publishes a signed USD 95.00 estimate, and the orchestrator records its own
   * USD 10.00 estimate for the search. The closure then reports estimate against actual; nothing is enforced.
   */
  estimates?: boolean;
  /**
   * Gamma's search fails after it was billed: Gamma refunds the charge and signs the failure with the key on its agent
   * card. The search delegation then nets to zero with a provider-signed provider_failure claim.
   */
  searchFails?: boolean;
}

const CODE_FIX_ESTIMATE_MINOR = 9_500;
const SEARCH_ESTIMATE_MINOR = 1_000;
const CODE_FIX_PRICE_MINOR = 10_000;
/** The AgentSkill id on Beta's agent card. Agreed in the terms, so the run Beta declares must perform it. */
const CODE_FIX_SKILL: SkillRef = { namespace: "a2a", skill_id: "code-fix" };
/**
 * A fixed fee for the fix plus model and tool usage at cost (amounts in US cents per unit). usage_cost checks that the
 * trace's usage, priced this way, supports the agreed USD 100.00 within 1%.
 */
const CODE_FIX_PRICING: Pricing = {
  rates: [
    { meter: "input_tokens", model: { provider: CODE_FIX_MODEL.provider, name: CODE_FIX_MODEL.name }, price_numerator: 1, price_denominator: 8_000 },
    { meter: "cache_read_input_tokens", model: { provider: CODE_FIX_MODEL.provider, name: CODE_FIX_MODEL.name }, price_numerator: 1, price_denominator: 80_000 },
    { meter: "output_tokens", model: { provider: CODE_FIX_MODEL.provider, name: CODE_FIX_MODEL.name }, price_numerator: 1, price_denominator: 1_000 },
    { meter: "tool_call", tool_name: "run_tests", price_numerator: 50, price_denominator: 1 },
  ],
  fixed_minor: 9_900,
  tolerance_bps: 100,
};

function userMessage(text: string, metadata: Record<string, unknown> = {}): SendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId: randomUUID(),
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
      taskId: "",
      contextId: "",
      extensions: [],
      metadata,
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: {},
  };
}

/** Sends one message, streams the A2A task to completion, and returns its events as A2A wire JSON. */
async function streamTask(client: Client, request: SendMessageRequest, log: (line: string) => void, agentName: string): Promise<A2AStreamResponse[]> {
  const events: A2AStreamResponse[] = [];
  for await (const event of client.sendMessageStream(request)) {
    const wire = StreamResponse.toJSON(event) as A2AStreamResponse;
    events.push(wire);
    if ("task" in wire) log(`  a2a ${agentName}: task ${wire.task.id} ${wire.task.status.state}`);
    if ("statusUpdate" in wire) log(`  a2a ${agentName}: ${wire.statusUpdate.status.state}`);
    if ("artifactUpdate" in wire) log(`  a2a ${agentName}: artifact ${wire.artifactUpdate.artifact.name ?? wire.artifactUpdate.artifact.artifactId}`);
  }
  return events;
}

/**
 * Acme's orchestrator runs one job through two A2A agents on localhost:
 *
 * 1. A paid code fix from Beta Workers, agreed as an ATCN obligation. Beta's agent signs its own progress, evidence and
 *    completion through the A2A bridge; the policy evaluates the evidence, clearing posts the journal, and payment is
 *    simulated.
 * 2. A search from Gamma, bought off the network. Gamma bills by A2A task id; the bill is imported and each charge is
 *    matched to the delegation whose provider_job_ref is that task id.
 *
 * The task is then closed, signed, and verified offline. The in-memory network stands in for the hosted API; both
 * agents and the orchestrator share it because they run in one process.
 */
export async function runA2ADelegation(options: RunOptions): Promise<A2ADelegationResult> {
  const log = options.log ?? (() => {});
  const serviceKey = loadOrCreateServiceKey(join(options.dataDir, "service-key.json"));
  const subledger = new LocalSubledger(serviceKey, "Acme Robotics");
  const network = new LocalNetwork(subledger, serviceKey);
  const codeFixAgent = await startCodeFixAgent(network, options.estimates ? { estimateMinor: CODE_FIX_ESTIMATE_MINOR } : {});
  const searchAgent = await startSearchAgent({ fail: options.searchFails });

  try {
    const factory = new ClientFactory();
    const codeFix = await factory.createFromUrl(codeFixAgent.url);
    const search = await factory.createFromUrl(searchAgent.url);
    const task = subledger.createTask({ external_ref: "calculator-fix-with-research", currency: "USD", budget_minor: 15_000 });
    log(`task ${task.task_id} (${task.external_ref}), budget USD 150.00`);

    // 1. Paid code fix: offer an obligation to the ATCN agent named in Beta's agent card, then send the A2A task.
    const buyer = network.registerAgent("Acme Robotics");
    const policy = AGENT_USAGE_POLICY_V1;
    const terms = buildTerms({
      principalId: network.registerPrincipal(),
      issuerAgentId: buyer.actorId,
      counterpartyAgentId: atcnAgentId(await codeFix.getAgentCard()),
      description: "Fix the add() bug in src/math.ts",
      currency: "USD",
      maxAmountMinor: CODE_FIX_PRICE_MINOR,
      deliverables: [
        { deliverable_id: "work", description: "Fix the add() bug", amount_minor: CODE_FIX_PRICE_MINOR, required_checks: ["unit_tests", "lint", "patch", "trace", "usage_cost"] },
      ],
      policy,
      skill: CODE_FIX_SKILL,
      pricing: CODE_FIX_PRICING,
    });
    const obligationId = terms.obligation_id;
    network.offerObligation(buyer.sign("obligation.offered", obligationId, termsData(terms)), { task_id: task.task_id });
    log(`obligation ${obligationId}: offered USD 100.00 to ${codeFixAgent.name} for skill a2a/${CODE_FIX_SKILL.skill_id}`);
    const codeFixEvents = await streamTask(codeFix, userMessage("Fix the add() bug in src/math.ts", obligationTaskMetadata(obligationId, { skillId: CODE_FIX_SKILL.skill_id })), log, codeFixAgent.name);
    if (options.estimates) recordAgentEstimate(subledger, network, codeFixEvents, obligationId, log);

    const started = network.events.find((e) => e.payload.obligation_id === obligationId && e.payload.event_type === "obligation.started");
    const execution = (started?.payload.data.execution as ExecutionDescriptor | undefined) ?? null;
    if (execution) log(`  run ${execution.execution_id}: agent version ${execution.agent.agent_version}, skill ${execution.skill?.namespace}/${execution.skill?.skill_id}`);

    const { decision } = network.evaluate(obligationId);
    const latestResult = (verifier: string) => network.verifierResults.filter((r) => r.obligation_id === obligationId && r.verifier_name === verifier).at(-1) ?? null;
    const traceCheck = latestResult("agent_trace");
    const usageCheck = latestResult("usage_cost");
    if (traceCheck) log(`  agent_trace: ${traceCheck.status}, ${traceCheck.details.model_calls} model call(s), ${traceCheck.details.input_tokens} input and ${traceCheck.details.output_tokens} output tokens, ${traceCheck.details.tool_calls} tool call(s)`);
    if (usageCheck) log(`  usage_cost: ${usageCheck.status}, usage cost ${usageCheck.details.expected_minor}, agreed ${usageCheck.details.amount_minor}, allowed difference ${usageCheck.details.allowed_difference_minor}`);
    if (decision.outcome !== "insufficient_evidence") network.finalize(decision.decision_id);
    const settled = decision.outcome === "insufficient_evidence" ? null : network.settleInSandbox(obligationId);
    log(`  policy ${policy.policy_id}@${policy.policy_version}: ${decision.outcome}, accepted ${decision.accepted_amount_minor}`);
    if (settled) log(`  sandbox settlement: ${settled.settlement_event.amount_minor} reported paid (simulated; no money moved)`);

    // 2. Search bought off the network. Gamma's card declares that its bills reference the A2A task id.
    const searchEstimatedAt = new Date().toISOString();
    const searchEvents = await streamTask(search, userMessage("IEEE 754 rounding in JavaScript addition"), log, searchAgent.name);
    const first = searchEvents.find((e): e is Extract<A2AStreamResponse, { task: unknown }> => "task" in e);
    if (!first) throw new Error(`${searchAgent.name} did not start a task`);
    const searchCard = AgentCardJson.toJSON(await search.getAgentCard()) as A2AAgentCard;
    const searchKey = cardSigningKey(searchCard);
    // A signed claim needs the delegation's provider on record, to bind the provider's key to.
    const searchProvider = searchKey ? subledger.addProvider(searchCard.name, null) : null;
    const delegation = subledger.createDelegation(task.task_id, {
      ...delegationFromA2A({ card: searchCard, task: first.task, currency: "USD", externalRef: "search", skillId: "search" }),
      ...(searchProvider ? { provider_id: searchProvider.provider_id } : {}),
    });
    const completed = searchEvents.some((e) => "statusUpdate" in e && e.statusUpdate.status.state === "TASK_STATE_COMPLETED");
    if (completed) subledger.appendDelegationEvent(delegation.delegation_id, { type: "completion", asserted_by: "provider", note: "A2A task completed" });
    log(`delegation ${delegation.delegation_id} (${searchAgent.name}), provider_job_ref ${delegation.provider_job_ref} from the card's billing reference`);
    const outcome = searchEvents.map((e) => ("statusUpdate" in e ? outcomeFromMetadata(e.statusUpdate.metadata) : null)).find((o) => o !== null);
    if (outcome) {
      const binding = searchKey && searchProvider ? subledger.bindProviderKey(searchProvider.provider_id, searchKey.public_key, searchKey.key_id) : undefined;
      const claim = subledger.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A(outcome, { binding }));
      log(`  signed outcome: recorded ${claim.type}, ${claim.assurance.join(", ")} (${outcome.note ?? "no note"})`);
    }
    if (options.estimates) {
      subledger.recordFinancialEvent({
        type: "estimate",
        source: "acme-orchestrator",
        source_event_id: `est-${delegation.external_ref}`,
        amount_minor: SEARCH_ESTIMATE_MINOR,
        currency: "USD",
        event_date: searchEstimatedAt,
        match: { delegation_id: delegation.delegation_id },
        expectation: { issued_by: "operator", source_ref: null, basis: "orchestrator's search budget line", expires_at: null, supersedes: null },
      });
      log(`  estimate USD 10.00 for the search, recorded by the orchestrator`);
    }

    // 3. Import Gamma's bill. Only charges whose A2A task id matches a delegation are attributed to this task.
    const bill = (await (await fetch(`${searchAgent.url}/billing/charges`)).json()) as { items: BillingCharge[] };
    for (const charge of bill.items) {
      const result = subledger.recordFinancialEvent({
        type: charge.type,
        source: "gamma-billing",
        source_event_id: charge.charge_id,
        provider_reference: charge.charge_id,
        amount_minor: charge.amount_minor,
        currency: charge.currency,
        event_date: charge.created_at,
        match: { provider_job_ref: charge.a2a_task_id },
      });
      log(`${charge.type} ${charge.charge_id} ${charge.amount_minor} ${charge.currency}: ${result.attribution ? `attributed to ${result.attribution.delegation_id}` : "not attributed (see exceptions)"}`);
    }

    // 4. Close, sign, and verify offline.
    const { closure } = subledger.closeTask(task.task_id, network.linksForTask(task.task_id));
    const packages = [network.exportClosurePackage(obligationId)];
    const trustedKeys = [servicePublicKey(serviceKey)];
    const traces = network.evidence
      .filter((e) => e.obligation_id === obligationId && e.envelope.evidence_type === "agent_trace")
      .map((e) => network.blobs.get(e.envelope.content_digest)!);
    const verification = {
      closure: verifySubledgerDocument(closure, { trustedKeys, obligationPackages: packages }),
      packages: packages.map((p) => verifyClosurePackage(p, { trustedKeys, traces })),
    };

    const dir = join(options.dataDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-a2a-delegation`);
    mkdirSync(dir, { recursive: true });
    const files = {
      dir,
      closure: join(dir, "task-closure.json"),
      keys: join(dir, "keys.json"),
      packages: [join(dir, `obligation-${obligationId}.json`)],
      traces: traces.map((_, i) => join(dir, `trace-${i + 1}.json`)),
    };
    writeFileSync(files.closure, `${JSON.stringify(closure, null, 2)}\n`);
    writeFileSync(files.keys, `${JSON.stringify({ items: trustedKeys }, null, 2)}\n`);
    writeFileSync(files.packages[0], `${JSON.stringify(packages[0], null, 2)}\n`);
    traces.forEach((bytes, i) => writeFileSync(files.traces[i], bytes));

    return {
      task_id: task.task_id,
      execution,
      trace_check: traceCheck,
      usage_check: usageCheck,
      closure,
      packages,
      trusted_keys: trustedKeys,
      totals: subledger.summary(task.task_id).rollup.root_total,
      open_exceptions: subledger.exceptions.filter((x) => x.status === "open"),
      verification,
      valid: verification.closure.valid && verification.packages.every((r) => r.valid),
      files,
    };
  } finally {
    await codeFixAgent.close();
    await searchAgent.close();
  }
}

/**
 * Records the signed estimate Beta's agent published in its task metadata. The orchestrator binds the key the network
 * registered for Beta's agent to Beta's provider record, so the estimate is labeled provider_key_signed.
 */
function recordAgentEstimate(subledger: LocalSubledger, network: LocalNetwork, events: A2AStreamResponse[], obligationId: string, log: (line: string) => void): void {
  const taskEvent = events.find((e): e is Extract<A2AStreamResponse, { task: unknown }> => "task" in e);
  const estimate = estimateFromMetadata(taskEvent?.task.metadata);
  if (!estimate) return;
  const link = network.links.find((l) => l.obligation_id === obligationId)!;
  const providerId = subledger.delegation(link.delegation_id).provider_id!;
  const key = network.keys.find((k) => k.key_id === estimate.key_id);
  if (!key) throw new Error(`the network has no key ${estimate.key_id} for Beta's agent`);
  const binding = subledger.bindProviderKey(providerId, key.public_key, key.key_id);
  subledger.recordFinancialEvent(estimateEventFromA2A(estimate, { match: { provider_job_ref: obligationId }, binding }));
  log(`  estimate ${estimate.currency} ${(estimate.amount_minor / 100).toFixed(2)} signed by Beta's agent with its own key`);
}
