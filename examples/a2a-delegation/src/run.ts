import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Role, StreamResponse, type SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, type Client } from "@a2a-js/sdk/client";
import { obligationTaskMetadata, type A2AStreamResponse } from "@atcn/adapter-a2a";
import { REFERENCE_POLICIES, verifyClosurePackage, type PackageVerificationReport } from "@atcn/core";
import { LocalNetwork, LocalSubledger, loadOrCreateServiceKey, servicePublicKey, type LocalException } from "@atcn/local-runner";
import type { ClosurePackage, PublicKeyRecord } from "@atcn/schema";
import { buildTerms, termsData } from "@atcn/sdk";
import { verifySubledgerDocument, type SignedClosure, type SubledgerVerificationReport, type Totals } from "@atcn/subledger";
import { atcnAgentId, startCodeFixAgent, startSearchAgent, type BillingCharge } from "./agents.js";

export interface A2ADelegationResult {
  task_id: string;
  closure: SignedClosure;
  packages: ClosurePackage[];
  trusted_keys: PublicKeyRecord[];
  totals: Record<string, Totals>;
  open_exceptions: LocalException[];
  verification: { closure: SubledgerVerificationReport; packages: PackageVerificationReport[] };
  valid: boolean;
  files: { dir: string; closure: string; keys: string; packages: string[] };
}

export interface RunOptions {
  /** Where the service key and run outputs go. */
  dataDir: string;
  log?: (line: string) => void;
}

const CODE_FIX_PRICE_MINOR = 10_000;

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
  const codeFixAgent = await startCodeFixAgent(network);
  const searchAgent = await startSearchAgent();

  try {
    const factory = new ClientFactory();
    const codeFix = await factory.createFromUrl(codeFixAgent.url);
    const search = await factory.createFromUrl(searchAgent.url);
    const task = subledger.createTask({ external_ref: "calculator-fix-with-research", currency: "USD", budget_minor: 15_000 });
    log(`task ${task.task_id} (${task.external_ref}), budget USD 150.00`);

    // 1. Paid code fix: offer an obligation to the ATCN agent named in Beta's agent card, then send the A2A task.
    const buyer = network.registerAgent("Acme Robotics");
    const policy = REFERENCE_POLICIES.find((p) => p.policy_id === "code-change-checks" && p.policy_version === "1.0.0")!;
    const terms = buildTerms({
      principalId: network.registerPrincipal(),
      issuerAgentId: buyer.actorId,
      counterpartyAgentId: atcnAgentId(await codeFix.getAgentCard()),
      description: "Fix the add() bug in src/math.ts",
      currency: "USD",
      maxAmountMinor: CODE_FIX_PRICE_MINOR,
      deliverables: [{ deliverable_id: "work", description: "Fix the add() bug", amount_minor: CODE_FIX_PRICE_MINOR, required_checks: ["unit_tests", "lint", "patch"] }],
      policy,
    });
    const obligationId = terms.obligation_id;
    network.offerObligation(buyer.sign("obligation.offered", obligationId, termsData(terms)), { task_id: task.task_id });
    log(`obligation ${obligationId}: offered USD 100.00 to ${codeFixAgent.name}`);
    await streamTask(codeFix, userMessage("Fix the add() bug in src/math.ts", obligationTaskMetadata(obligationId)), log, codeFixAgent.name);

    const { decision } = network.evaluate(obligationId);
    if (decision.outcome !== "insufficient_evidence") network.finalize(decision.decision_id);
    const settled = decision.outcome === "insufficient_evidence" ? null : network.settleInSandbox(obligationId);
    log(`  policy ${policy.policy_id}@${policy.policy_version}: ${decision.outcome}, accepted ${decision.accepted_amount_minor}`);
    if (settled) log(`  sandbox settlement: ${settled.settlement_event.amount_minor} reported paid (simulated; no money moved)`);

    // 2. Search bought off the network: the A2A task id is the provider's job reference.
    const searchEvents = await streamTask(search, userMessage("IEEE 754 rounding in JavaScript addition"), log, searchAgent.name);
    const first = searchEvents.find((e): e is { task: { id: string } } & A2AStreamResponse => "task" in e);
    if (!first) throw new Error(`${searchAgent.name} did not start a task`);
    const delegation = subledger.createDelegation(task.task_id, { external_ref: "search", provider_name_stated: searchAgent.name, provider_job_ref: first.task.id, currency: "USD" });
    const completed = searchEvents.some((e) => "statusUpdate" in e && e.statusUpdate.status.state === "TASK_STATE_COMPLETED");
    if (completed) subledger.appendDelegationEvent(delegation.delegation_id, { type: "completion", asserted_by: "provider", note: "A2A task completed" });
    log(`delegation ${delegation.delegation_id} (${searchAgent.name}), provider_job_ref ${first.task.id}`);

    // 3. Import Gamma's bill. Only charges whose A2A task id matches a delegation are attributed to this task.
    const bill = (await (await fetch(`${searchAgent.url}/billing/charges`)).json()) as { items: BillingCharge[] };
    for (const charge of bill.items) {
      const result = subledger.recordFinancialEvent({
        type: "charge",
        source: "gamma-billing",
        source_event_id: charge.charge_id,
        provider_reference: charge.charge_id,
        amount_minor: charge.amount_minor,
        currency: charge.currency,
        event_date: charge.created_at,
        match: { provider_job_ref: charge.a2a_task_id },
      });
      log(`charge ${charge.charge_id} ${charge.amount_minor} ${charge.currency}: ${result.attribution ? `attributed to ${result.attribution.delegation_id}` : "not attributed (see exceptions)"}`);
    }

    // 4. Close, sign, and verify offline.
    const { closure } = subledger.closeTask(task.task_id, network.linksForTask(task.task_id));
    const packages = [network.exportClosurePackage(obligationId)];
    const trustedKeys = [servicePublicKey(serviceKey)];
    const verification = {
      closure: verifySubledgerDocument(closure, { trustedKeys, obligationPackages: packages }),
      packages: packages.map((p) => verifyClosurePackage(p, { trustedKeys })),
    };

    const dir = join(options.dataDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-a2a-delegation`);
    mkdirSync(dir, { recursive: true });
    const files = { dir, closure: join(dir, "task-closure.json"), keys: join(dir, "keys.json"), packages: [join(dir, `obligation-${obligationId}.json`)] };
    writeFileSync(files.closure, `${JSON.stringify(closure, null, 2)}\n`);
    writeFileSync(files.keys, `${JSON.stringify({ items: trustedKeys }, null, 2)}\n`);
    writeFileSync(files.packages[0], `${JSON.stringify(packages[0], null, 2)}\n`);

    return {
      task_id: task.task_id,
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
