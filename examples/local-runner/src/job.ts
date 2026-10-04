import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REFERENCE_POLICIES, verifyClearingVerdict, verifyClosurePackage, type PackageVerificationReport, type VerdictVerificationReport } from "@atcn/core";
import type { ClearingVerdict, ClosurePackage, PublicKeyRecord } from "@atcn/schema";
import { acceptanceData, buildEvidenceEnvelope, buildTerms, termsData } from "@atcn/sdk";
import {
  DelegationEventInputSchema,
  DelegationInputSchema,
  FinancialEventInputSchema,
  TaskInputSchema,
  verifySubledgerDocument,
  type SignedClosure,
  type SubledgerVerificationReport,
  type Totals,
} from "@atcn/subledger";
import { z } from "zod";
import { LocalRunnerError, parseWith } from "./errors.js";
import { loadOrCreateServiceKey, servicePublicKey } from "./keys.js";
import { LocalNetwork } from "./network.js";
import { LocalSubledger, type LocalException } from "./subledger.js";

/**
 * A job file describes one piece of agent work: the buyer's task, the work delegated as obligations on the clearing
 * network (with the evidence the provider submits), work bought off the network, and the charges it produced.
 * Task, delegation, and financial-event entries use the same fields as the hosted API's request bodies.
 */

/** Evidence the provider submits, by evidence type: file paths relative to the job file. */
const EVIDENCE_TYPES = {
  test_report: { verifier: "junit_tests", mediaType: "application/xml" },
  lint_report: { verifier: "eslint_lint", mediaType: "application/json" },
  patch_ref: { verifier: "patch_digest", mediaType: "text/x-diff" },
} as const;

const DEFAULT_POLICY = "code-change-checks@1.0.0";

const ObligationJobSchema = z.strictObject({
  /** The provider's operator name; each distinct name gets its own agent and key. */
  provider: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  amount_minor: z.number().int().positive(),
  policy: z.string().default(DEFAULT_POLICY),
  required_checks: z.array(z.string()).min(1).default(["unit_tests", "lint", "patch"]),
  evidence: z.strictObject({ test_report: z.string().optional(), lint_report: z.string().optional(), patch_ref: z.string().optional() }).default({}),
  completion_note: z.string().max(2000).optional(),
  /** Simulate paying the provider through the sandbox adapter after clearing. */
  settle: z.boolean().default(true),
  /** The buyer cancels after the provider started, before any evidence or completion: nothing is cleared or paid. */
  cancel: z.strictObject({ reason: z.string().min(1).max(2000) }).optional(),
  /** An escrow rail that reads this obligation's outcome: the runner writes a signed clearing verdict for it. The rail decides whether to release. */
  escrow: z.strictObject({ rail: z.string().min(1).max(100), escrow_ref: z.string().min(1).max(200) }).optional(),
});

const ApiBody = z.record(z.string(), z.unknown());

/** A provider's or gateway's public key, bound before anything is recorded so signatures made ahead of the run verify. */
const ProviderKeySchema = z.strictObject({
  provider: z.string().min(1).max(200),
  key_id: z.string().min(1).max(200),
  public_key: z.string().min(1),
});

/** A signature made before the run. The runner fills in the provider and the key binding it created for `key_id`. */
const ClaimSignerSchema = z.strictObject({ key_id: z.string().min(1), value: z.string().min(1) });
const ExpectationSignerSchema = ClaimSignerSchema.extend({ provider: z.string().min(1).max(200) });

export const JobSchema = z.strictObject({
  /** The buyer's name, shown as the closure issuer's operator name. */
  operator: z.string().min(1).max(200).default("Local operator"),
  task: ApiBody,
  /** Keys of the providers and gateways whose signed claims, estimates and holds the file carries. */
  provider_keys: z.array(ProviderKeySchema).default([]),
  obligations: z.array(ObligationJobSchema).default([]),
  /** Work bought off the network; each entry may carry delivery `claims`. */
  delegations: z.array(ApiBody).default([]),
  financial_events: z.array(ApiBody).default([]),
});
export type Job = z.input<typeof JobSchema>;

export interface ObligationOutcome {
  obligation_id: string;
  delegation_id: string;
  provider: string;
  outcome: string;
  accepted_amount_minor: number;
  finalized: boolean;
  settled_minor: number;
}

export interface JobResult {
  task_id: string;
  closure: SignedClosure;
  packages: ClosurePackage[];
  /** Signed clearing verdicts for obligations that name an escrow and have a decision. */
  verdicts: ClearingVerdict[];
  trusted_keys: PublicKeyRecord[];
  obligations: ObligationOutcome[];
  totals: Record<string, Totals>;
  open_exceptions: LocalException[];
  verification: { closure: SubledgerVerificationReport; packages: PackageVerificationReport[]; verdicts: VerdictVerificationReport[] };
  valid: boolean;
  files: { dir: string; closure: string; keys: string; packages: string[]; verdicts: string[]; ledger: string };
}

export interface RunOptions {
  /** Directory that evidence paths are relative to (the job file's directory). */
  baseDir: string;
  /** Where the runner keeps its service key and run outputs. */
  dataDir: string;
  log?: (line: string) => void;
}

export function loadJob(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LocalRunnerError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Runs a job end to end on this machine: opens the task, takes each obligation through offer, acceptance, evidence,
 * policy evaluation, clearing, and simulated settlement, records off-network work and charges, closes the task, and
 * verifies the closure and every obligation's closure package offline. Writes all documents to a new run directory.
 */
export function runJob(input: unknown, options: RunOptions): JobResult {
  const log = options.log ?? (() => {});
  const job = parseWith(JobSchema, input, "job");
  const serviceKey = loadOrCreateServiceKey(join(options.dataDir, "service-key.json"));
  const subledger = new LocalSubledger(serviceKey, job.operator);
  const network = new LocalNetwork(subledger, serviceKey);

  const task = subledger.createTask(parseWith(TaskInputSchema.strict(), job.task, "task"));
  log(`task ${task.task_id} (${task.external_ref}), budget ${task.budget_minor ?? "none"} ${task.currency}`);

  const providerNamed = (name: string) => subledger.providers.find((p) => p.name === name) ?? subledger.addProvider(name, null);
  const bindings = job.provider_keys.map((k, index) => {
    const provider = providerNamed(k.provider);
    if (subledger.keyBindings.some((b) => b.provider_id === provider.provider_id && b.key_id === k.key_id)) {
      throw new LocalRunnerError(`provider_keys[${index}]: ${k.provider} already has a key ${k.key_id}`);
    }
    log(`key ${k.key_id} bound to ${k.provider}`);
    return subledger.bindProviderKey(provider.provider_id, k.public_key, k.key_id);
  });
  const signerFor = (providerName: string, keyId: string, value: string, label: string) => {
    const provider = providerNamed(providerName);
    const binding = bindings.find((b) => b.provider_id === provider.provider_id && b.key_id === keyId);
    if (!binding) throw new LocalRunnerError(`${label}: provider_keys has no key ${keyId} for ${providerName}`);
    return { provider_id: binding.provider_id, binding_id: binding.binding_id, key_id: keyId, value };
  };

  const buyer = network.registerAgent(job.operator);
  const principalId = network.registerPrincipal();
  const providers = new Map<string, ReturnType<LocalNetwork["registerAgent"]>>();
  const outcomes: ObligationOutcome[] = [];

  job.obligations.forEach((o, index) => {
    const label = `obligations[${index}]`;
    const policy = REFERENCE_POLICIES.find((p) => `${p.policy_id}@${p.policy_version}` === o.policy);
    if (!policy) throw new LocalRunnerError(`${label}.policy: unknown policy ${o.policy}; use one of ${REFERENCE_POLICIES.map((p) => `${p.policy_id}@${p.policy_version}`).join(", ")}`);
    if (!providers.has(o.provider)) providers.set(o.provider, network.registerAgent(o.provider));
    const provider = providers.get(o.provider)!;

    const terms = buildTerms({
      principalId,
      issuerAgentId: buyer.actorId,
      counterpartyAgentId: provider.actorId,
      description: o.description,
      currency: task.currency,
      maxAmountMinor: o.amount_minor,
      deliverables: [{ deliverable_id: "work", description: o.description, amount_minor: o.amount_minor, required_checks: o.required_checks }],
      policy,
    });
    const id = terms.obligation_id;
    const { delegation_id } = network.offerObligation(buyer.sign("obligation.offered", id, termsData(terms)), { task_id: task.task_id });
    network.acceptObligation(provider.sign("obligation.accepted", id, acceptanceData(terms, provider.actorId)));
    network.appendLifecycleEvent(provider.sign("obligation.started", id));
    if (o.cancel) {
      if (Object.keys(o.evidence).length > 0 || o.completion_note !== undefined) throw new LocalRunnerError(`${label}: a cancelled obligation takes no evidence or completion_note`);
      network.cancelObligation(buyer.sign("obligation.cancelled", id, { reason: o.cancel.reason }));
      log(`obligation ${id}: ${o.provider} accepted ${o.amount_minor} and started; cancelled by the buyer (${o.cancel.reason}), nothing cleared`);
      outcomes.push({ obligation_id: id, delegation_id: delegation_id!, provider: o.provider, outcome: "cancelled", accepted_amount_minor: 0, finalized: false, settled_minor: 0 });
      return;
    }
    for (const [evidenceType, path] of Object.entries(o.evidence)) {
      const { verifier, mediaType } = EVIDENCE_TYPES[evidenceType as keyof typeof EVIDENCE_TYPES];
      const content = readEvidence(resolve(options.baseDir, path), `${label}.evidence.${evidenceType}`);
      const uri = network.uploadBlob(content);
      const envelope = buildEvidenceEnvelope({ evidenceType, producerId: provider.actorId, content, uri, retrievalMethod: "atcn-blob", mediaType, verifiers: [verifier], deliverableIds: ["work"] });
      network.submitEvidence(provider.sign("evidence.submitted", id, { envelope }));
    }
    network.appendLifecycleEvent(provider.sign("completion.proposed", id, o.completion_note ? { note: o.completion_note } : {}));
    log(`obligation ${id}: ${o.provider} accepted ${o.amount_minor}, submitted ${Object.keys(o.evidence).length} evidence file(s), proposed completion`);

    const { decision } = network.evaluate(id);
    const finalized = decision.outcome !== "insufficient_evidence";
    if (finalized) network.finalize(decision.decision_id);
    const settled = finalized && o.settle ? network.settleInSandbox(id) : null;
    log(`  policy ${policy.policy_id}@${policy.policy_version}: ${decision.outcome}, accepted ${decision.accepted_amount_minor}${finalized ? ", cleared" : ", not cleared"}`);
    if (settled) log(`  sandbox settlement: ${settled.settlement_event.amount_minor} reported paid (simulated; no money moved)`);
    outcomes.push({
      obligation_id: id,
      delegation_id: delegation_id!,
      provider: o.provider,
      outcome: decision.outcome,
      accepted_amount_minor: decision.accepted_amount_minor,
      finalized,
      settled_minor: settled?.settlement_event.amount_minor ?? 0,
    });
  });

  job.delegations.forEach((d, index) => {
    const label = `delegations[${index}]`;
    const { claims = [], provider, ...body } = d;
    if (provider !== undefined && typeof provider !== "string") throw new LocalRunnerError(`${label}.provider must be a provider name`);
    const providerId = provider === undefined ? {} : { provider_id: providerNamed(provider).provider_id };
    const delegation = subledger.createDelegation(task.task_id, parseWith(DelegationInputSchema.strict(), { currency: task.currency, ...body, ...providerId }, label));
    if (!Array.isArray(claims)) throw new LocalRunnerError(`${label}.claims must be a list`);
    claims.forEach((claim: Record<string, unknown>, claimIndex) => {
      const claimLabel = `${label}.claims[${claimIndex}]`;
      let input = claim;
      if (claim.signer !== undefined) {
        if (provider === undefined) throw new LocalRunnerError(`${claimLabel}.signer: a signed claim needs the delegation's provider`);
        if (claim.occurred_at === undefined) throw new LocalRunnerError(`${claimLabel}.occurred_at: a signed claim needs the time it was signed with`);
        const { key_id, value } = parseWith(ClaimSignerSchema, claim.signer, `${claimLabel}.signer`);
        input = { ...claim, signer: signerFor(provider, key_id, value, `${claimLabel}.signer`) };
      }
      subledger.appendDelegationEvent(delegation.delegation_id, parseWith(DelegationEventInputSchema.strict(), input, claimLabel));
    });
    log(`delegation ${delegation.delegation_id} (${delegation.provider_name_stated ?? delegation.external_ref ?? "unnamed"}), ${claims.length} claim(s)`);
  });

  job.financial_events.forEach((e, index) => {
    const label = `financial_events[${index}]`;
    const expectation = e.expectation as Record<string, unknown> | undefined;
    let body = e;
    if (expectation?.signer !== undefined) {
      if (e.event_date === undefined) throw new LocalRunnerError(`${label}.event_date: a signed ${String(e.type)} needs the date it was signed with`);
      const { provider, key_id, value } = parseWith(ExpectationSignerSchema, expectation.signer, `${label}.expectation.signer`);
      body = { ...e, expectation: { ...expectation, signer: signerFor(provider, key_id, value, `${label}.expectation.signer`) } };
    }
    const event = parseWith(FinancialEventInputSchema, { currency: task.currency, event_date: new Date().toISOString(), ...body }, label);
    const result = subledger.recordFinancialEvent(event);
    const where = result.attribution ? `attributed to ${result.attribution.delegation_id ?? result.attribution.task_id}` : "not attributed (see exceptions)";
    log(`${event.type} ${event.amount_minor} ${event.currency} from ${event.source}: ${where}`);
  });

  const { closure } = subledger.closeTask(task.task_id, network.linksForTask(task.task_id));
  const packages = outcomes.map((o) => network.exportClosurePackage(o.obligation_id));
  const escrowed = job.obligations
    .map((o, index) => ({ escrow: o.escrow, pkg: packages[index], outcome: outcomes[index] }))
    .filter((e) => e.escrow !== undefined && e.pkg.payload.decisions.length > 0);
  const verdicts = escrowed.map((e) => network.clearingVerdict(e.pkg, e.escrow));
  const trustedKeys = [servicePublicKey(serviceKey)];
  const verification = {
    closure: verifySubledgerDocument(closure, { trustedKeys, obligationPackages: packages }),
    packages: packages.map((p) => verifyClosurePackage(p, { trustedKeys })),
    verdicts: verdicts.map((v, i) => verifyClearingVerdict(v, { trustedKeys, closurePackage: escrowed[i].pkg })),
  };
  const valid = verification.closure.valid && verification.packages.every((r) => r.valid) && verification.verdicts.every((r) => r.valid);
  const summary = subledger.summary(task.task_id);

  const dir = join(options.dataDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${task.external_ref.replace(/[^\w.-]/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  const files = {
    dir,
    closure: join(dir, "task-closure.json"),
    keys: join(dir, "keys.json"),
    packages: outcomes.map((o) => join(dir, `obligation-${o.obligation_id}.json`)),
    verdicts: escrowed.map((e) => join(dir, `verdict-${e.outcome.obligation_id}.json`)),
    ledger: join(dir, "ledger.json"),
  };
  writeJson(files.closure, closure);
  writeJson(files.keys, { items: trustedKeys });
  packages.forEach((p, i) => writeJson(files.packages[i], p));
  verdicts.forEach((v, i) => writeJson(files.verdicts[i], v));
  writeJson(files.ledger, {
    subledger: {
      tasks: subledger.tasks,
      providers: subledger.providers,
      delegations: subledger.delegations,
      claims: subledger.claims,
      financial_events: subledger.financialEvents,
      exceptions: subledger.exceptions,
    },
    network: {
      agents: network.agents,
      public_keys: network.keys,
      obligations: network.obligations,
      events: network.events,
      evidence: network.evidence,
      verifier_results: network.verifierResults,
      decisions: network.decisions,
      posting_batches: network.batches,
      settlement_instructions: network.instructions,
      settlement_events: network.settlementEvents,
    },
  });

  return {
    task_id: task.task_id,
    closure,
    packages,
    verdicts,
    trusted_keys: trustedKeys,
    obligations: outcomes,
    totals: summary.rollup.root_total,
    // Unmatched charges belong to no task yet, so the task summary leaves them out; this run holds one job.
    open_exceptions: subledger.exceptions.filter((x) => x.status === "open"),
    verification,
    valid,
    files,
  };
}

function readEvidence(path: string, label: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch {
    throw new LocalRunnerError(`${label}: cannot read ${path}`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
