import {
  OUTCOME_EVENT,
  REFERENCE_POLICIES,
  agreedAmount,
  buildClearingLines,
  buildContingentLines,
  buildEvidenceInputs,
  buildReversalLines,
  buildSettlementLines,
  checkBalanced,
  decisionDigest,
  evaluateClearing,
  planChecks,
  serviceEventPayload,
  type BuiltLines,
  type ServiceEventInput,
} from "@atcn/core";
import { EventSigner } from "@atcn/sdk";
import {
  EventDataSchemas,
  OUTCOME_TO_STATE,
  SignedEventSchema,
  canTransition,
  canonicalize,
  digestOf,
  generateKeyPair,
  newId,
  sha256Digest,
  signPayload,
  verifyPayload,
  type ClearingDecision,
  type ClosurePackage,
  type ClosurePackageBody,
  type EntryType,
  type EventType,
  type EvidenceEnvelope,
  type ObligationState,
  type ObligationTerms,
  type PolicyTemplate,
  type PostingBatch,
  type PublicKeyRecord,
  type RecordedEvent,
  type SettlementEvent,
  type SettlementInstruction,
  type SignedEvent,
  type VerifierResult,
} from "@atcn/schema";
import {
  CLAIM_BY_OUTCOME_EVENT,
  CLEARING_SOURCE,
  acceptedTermsChanges,
  clearingFactEvent,
  clearingFacts,
  decisionClaim,
  networkEventEvidence,
  obligationDelegationFields,
  undoneBatch,
  type ClaimAsserter,
  type DecisionEventData,
  type DeliveryEventType,
  type LinkedObligation,
  type ObligationLink,
} from "@atcn/subledger";
import { runCheck, type FetchResult, type KeyLookupResult } from "@atcn/verifiers";
import { LocalRunnerError, parseWith } from "./errors.js";
import { servicePublicKey, type ServiceKey } from "./keys.js";
import type { LocalSubledger } from "./subledger.js";

/**
 * The clearing network, kept in memory: agents and keys, signed obligation events, evidence, verifier results,
 * decisions, the balanced journal, and simulated (sandbox) settlement. Decisions come from the same policy
 * evaluator and verifier plugins as the hosted service, and every journal batch is recorded on the buyer's
 * subledger delegation with the shared bridge functions, so the offline verifier can recompute both sides.
 *
 * Not covered: drafts, open offers, amendments, subdelegation, cancellation, disputes, and real payment rails.
 */

export interface LocalAgent {
  agent_id: string;
  platform_id: string;
  operator_name: string;
}

export interface LocalObligation {
  obligation_id: string;
  terms: ObligationTerms;
  terms_digest: string;
  policy: PolicyTemplate;
  state: ObligationState;
  counterparty_agent_id: string | null;
  acceptance_event_id: string | null;
  completion_event_id: string | null;
  latest_decision_id: string | null;
  finalized: boolean;
}

interface TaskLink {
  task_id: string;
  delegation_id: string;
  obligation_id: string;
}

interface BatchInput {
  entryType: EntryType;
  decisionId?: string | null;
  settlementEventId?: string | null;
  reversesBatchId?: string | null;
  policyVersion?: string | null;
  sourceEventIds: string[];
  built: BuiltLines;
}

const EVALUABLE_STATES: ObligationState[] = ["completion_proposed", "insufficient_evidence", "cleared", "partially_cleared", "rejected"];
const DAY_MS = 24 * 3600 * 1000;
const now = () => new Date().toISOString();

export class LocalNetwork {
  readonly agents: LocalAgent[] = [];
  readonly principals: string[] = [];
  readonly keys: PublicKeyRecord[] = [];
  readonly obligations: LocalObligation[] = [];
  readonly events: RecordedEvent[] = [];
  readonly evidence: { obligation_id: string; envelope: EvidenceEnvelope }[] = [];
  readonly blobs = new Map<string, Uint8Array>();
  readonly verifierResults: VerifierResult[] = [];
  readonly decisions: ClearingDecision[] = [];
  readonly batches: PostingBatch[] = [];
  readonly instructions: SettlementInstruction[] = [];
  readonly settlementEvents: SettlementEvent[] = [];
  readonly links: TaskLink[] = [];

  constructor(
    private readonly subledger: LocalSubledger,
    private readonly serviceKey: ServiceKey,
  ) {
    this.keys.push(servicePublicKey(serviceKey));
  }

  // ---------- Identities ----------

  registerPrincipal(): string {
    const principalId = newId("principal");
    this.principals.push(principalId);
    return principalId;
  }

  /** Registers an agent with a fresh key pair. The private key stays in the returned signer. */
  registerAgent(operatorName: string): EventSigner {
    const pair = generateKeyPair();
    const agent: LocalAgent = { agent_id: newId("agent"), platform_id: newId("platform"), operator_name: operatorName };
    const keyId = newId("key");
    this.agents.push(agent);
    this.keys.push({ key_id: keyId, key_version: 1, actor_id: agent.agent_id, algorithm: "Ed25519", public_key: pair.publicKey, valid_from: now(), revoked_at: null });
    return new EventSigner({ actorId: agent.agent_id, platformId: agent.platform_id, keyId, privateKey: pair.privateKey });
  }

  // ---------- Obligation lifecycle ----------

  /** Records a signed offer. With `link`, the obligation also becomes a delegation of the buyer's subledger task. */
  offerObligation(body: unknown, link?: { task_id: string }): { obligation: LocalObligation; event: RecordedEvent; delegation_id: string | null } {
    const { signed, agent } = this.verify(body, ["obligation.offered"]);
    const { terms, terms_digest } = signed.payload.data as { terms: ObligationTerms; terms_digest: string };
    if (terms.obligation_id !== signed.payload.obligation_id) throw new LocalRunnerError("terms.obligation_id must equal payload.obligation_id");
    if (agent.agent_id !== terms.issuer_agent_id) throw new LocalRunnerError("only the issuer agent may offer an obligation");
    if (terms.terms_version !== 1) throw new LocalRunnerError("new obligations start at terms_version 1");
    if (digestOf(terms) !== terms_digest) throw new LocalRunnerError("terms_digest does not match the canonical terms");
    if (Date.parse(terms.offer_expires_at) <= Date.now()) throw new LocalRunnerError("offer_expires_at must be in the future");
    if (this.obligations.some((o) => o.obligation_id === terms.obligation_id)) throw new LocalRunnerError(`obligation ${terms.obligation_id} already exists`);
    if (terms.parent_obligation_id) throw new LocalRunnerError("the local runner records root obligations only; subdelegation needs the hosted network");
    const policy = this.validateTerms(terms);

    const obligation: LocalObligation = {
      obligation_id: terms.obligation_id,
      terms,
      terms_digest,
      policy,
      state: "offered",
      counterparty_agent_id: null,
      acceptance_event_id: null,
      completion_event_id: null,
      latest_decision_id: null,
      finalized: false,
    };
    this.obligations.push(obligation);
    const event = this.append(signed);
    if (!link) return { obligation, event, delegation_id: null };

    const counterparty = this.agent(terms.counterparty_agent_id!);
    const provider = this.subledger.addProvider(counterparty.operator_name, `atcn:operator:${counterparty.platform_id}`);
    const delegation = this.subledger.createDelegation(link.task_id, {
      provider_id: provider.provider_id,
      provider_name_stated: provider.name,
      ...obligationDelegationFields(linked(obligation)),
    });
    this.links.push({ task_id: link.task_id, delegation_id: delegation.delegation_id, obligation_id: obligation.obligation_id });
    return { obligation, event, delegation_id: delegation.delegation_id };
  }

  /** Signed acceptance of the offered terms; the agreed price becomes a contingent amount. */
  acceptObligation(body: unknown): RecordedEvent {
    const { signed, agent } = this.verify(body, ["obligation.accepted"]);
    const ob = this.obligation(signed.payload.obligation_id);
    const data = signed.payload.data as { terms_version: number; terms_digest: string; policy_id: string; policy_version: string; counterparty_agent_id: string };
    if (ob.state !== "offered") throw new LocalRunnerError(`cannot accept an obligation in state ${ob.state}`);
    if (Date.now() > Date.parse(ob.terms.offer_expires_at)) throw new LocalRunnerError("the offer has expired");
    if (data.terms_digest !== ob.terms_digest || data.terms_version !== ob.terms.terms_version) {
      throw new LocalRunnerError("acceptance must reference the currently offered terms version and digest");
    }
    if (data.policy_id !== ob.policy.policy_id || data.policy_version !== ob.policy.policy_version) throw new LocalRunnerError("acceptance must reference the offered policy version");
    if (data.counterparty_agent_id !== agent.agent_id) throw new LocalRunnerError("data.counterparty_agent_id must be the accepting agent");
    if (ob.terms.counterparty_agent_id !== agent.agent_id) throw new LocalRunnerError("only the named counterparty may accept");

    ob.state = "accepted";
    ob.counterparty_agent_id = agent.agent_id;
    ob.acceptance_event_id = signed.payload.event_id;
    const event = this.append(signed);
    const amount = agreedAmount(ob.terms);
    if (amount > 0) {
      this.postBatch(ob, {
        entryType: "contingent",
        policyVersion: ob.policy.policy_version,
        sourceEventIds: [event.payload.event_id],
        built: buildContingentLines({ payerId: ob.terms.payer_id, payeeId: agent.agent_id, currency: ob.terms.currency, amountMinor: amount }),
      });
    }
    return event;
  }

  /** obligation.started and completion.proposed, both signed by the counterparty. */
  appendLifecycleEvent(body: unknown): RecordedEvent {
    const { signed, agent } = this.verify(body, ["obligation.started", "completion.proposed"]);
    const ob = this.obligation(signed.payload.obligation_id);
    const type = signed.payload.event_type;
    if (agent.agent_id !== ob.counterparty_agent_id) throw new LocalRunnerError(`${type} must be signed by the counterparty`);
    const to: ObligationState = type === "obligation.started" ? "active" : "completion_proposed";
    if (type === "completion.proposed" && !["active", "insufficient_evidence"].includes(ob.state)) {
      throw new LocalRunnerError(`cannot propose completion in state ${ob.state}`);
    }
    if (!canTransition(ob.state, to)) throw new LocalRunnerError(`cannot move from ${ob.state} to ${to}`);
    ob.state = to;
    const event = this.append(signed);
    if (type === "completion.proposed") ob.completion_event_id = event.payload.event_id;
    return event;
  }

  /** Stores evidence content and returns its blob URI, addressed by content digest. */
  uploadBlob(content: Uint8Array | string): string {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const digest = sha256Digest(bytes);
    this.blobs.set(digest, bytes);
    return `atcn-blob://sha256/${digest.slice("sha256:".length)}`;
  }

  submitEvidence(body: unknown): RecordedEvent {
    const { signed, agent } = this.verify(body, ["evidence.submitted"]);
    const ob = this.obligation(signed.payload.obligation_id);
    const envelope = (signed.payload.data as { envelope: EvidenceEnvelope }).envelope;
    const allowed = [ob.terms.issuer_agent_id, ob.counterparty_agent_id, ob.terms.principal_id, ...ob.terms.verifier_agent_ids];
    if (!allowed.includes(agent.agent_id)) throw new LocalRunnerError("only parties and agreed verifiers may submit evidence");
    if (envelope.producer_id !== agent.agent_id) throw new LocalRunnerError("envelope.producer_id must be the signing actor");
    if (["draft", "offered", "cancelled", "expired"].includes(ob.state)) throw new LocalRunnerError(`cannot submit evidence in state ${ob.state}`);
    for (const id of envelope.deliverable_ids) {
      if (!ob.terms.deliverables.some((d) => d.deliverable_id === id)) throw new LocalRunnerError(`unknown deliverable ${id}`);
    }
    if (envelope.retrieval_method !== "atcn-blob") throw new LocalRunnerError("the local runner reads evidence from uploaded blobs only (retrieval_method atcn-blob)");
    if (!this.blobs.has(envelope.content_digest)) throw new LocalRunnerError("referenced blob was not uploaded");
    if (this.evidence.some((e) => e.envelope.evidence_id === envelope.evidence_id)) throw new LocalRunnerError(`evidence_id ${envelope.evidence_id} already registered`);
    const event = this.append(signed);
    this.evidence.push({ obligation_id: ob.obligation_id, envelope });
    return event;
  }

  // ---------- Clearing ----------

  /**
   * Runs the agreed verifiers over the submitted evidence and applies the clearing policy. Identical inputs reproduce
   * the same decision digest, and the existing decision is returned. The verifiers parse the submitted reports; they
   * do not execute the delivered code.
   */
  evaluate(obligationId: string): { decision: ClearingDecision; reused: boolean } {
    const ob = this.obligation(obligationId);
    if (!EVALUABLE_STATES.includes(ob.state)) throw new LocalRunnerError(`cannot evaluate in state ${ob.state}; completion must be proposed first`);
    if (!ob.acceptance_event_id) throw new LocalRunnerError("obligation has no acceptance");
    const events = this.eventsFor(ob.obligation_id);
    const cutoff = events[events.length - 1].sequence;
    const evidence = buildEvidenceInputs(events, ob.terms, cutoff);

    for (const item of planChecks({ terms: ob.terms, policy: ob.policy, evidence })) {
      this.verifierResults.push(
        runCheck({
          obligationId: ob.obligation_id,
          deliverableId: item.deliverable_id,
          check: item.check,
          envelope: item.evidence?.envelope ?? null,
          fetchResult: item.evidence ? this.fetchBlob(item.evidence.envelope) : null,
          requireDigestMatch: ob.policy.evidence_admissibility.require_digest_match,
          allowedVerifierIds: ob.terms.verifier_agent_ids,
          resolveKey: (keyId, version) => this.verifierKey(ob.terms.verifier_agent_ids, keyId, version),
        }),
      );
    }

    const body = evaluateClearing({
      terms: ob.terms,
      terms_digest: ob.terms_digest,
      policy: ob.policy,
      policy_digest: digestOf(ob.policy),
      acceptance_event_id: ob.acceptance_event_id,
      completion_event_id: ob.completion_event_id,
      evidence,
      verifier_results: this.verifierResults.filter((r) => r.obligation_id === ob.obligation_id),
    });
    const digest = decisionDigest(body);
    const latest = ob.latest_decision_id ? this.decision(ob.latest_decision_id) : null;
    if (latest && latest.decision_digest === digest) return { decision: latest, reused: true };
    if (body.disputed_amount_minor > 0) {
      throw new LocalRunnerError(`the policy routes ${body.disputed_amount_minor} to dispute review, which the local runner does not support`);
    }

    const decision: ClearingDecision = {
      ...body,
      decision_id: newId("decision"),
      decision_digest: digest,
      decided_at: now(),
      supersedes_decision_id: ob.latest_decision_id,
      input_cutoff_sequence: cutoff,
    };
    const event = this.appendServiceEvent({
      obligationId: ob.obligation_id,
      type: OUTCOME_EVENT[decision.outcome],
      data: {
        decision_id: decision.decision_id,
        decision_digest: digest,
        outcome: decision.outcome,
        accepted_amount_minor: decision.accepted_amount_minor,
        policy_version: decision.policy.policy_version,
        decision_maker: decision.decision_maker,
        supersedes_decision_id: decision.supersedes_decision_id,
      },
      causationIds: decision.input_event_ids,
    });
    this.decisions.push(decision);
    const target = OUTCOME_TO_STATE[decision.outcome];
    if (canTransition(ob.state, target)) ob.state = target;
    ob.latest_decision_id = decision.decision_id;
    if (ob.finalized) this.syncClearing(ob, [event.payload.event_id]);
    return { decision, reused: false };
  }

  /** Creates the final journal postings for the latest decision. Insufficient evidence never creates a payable. */
  finalize(decisionId: string): void {
    const decision = this.decision(decisionId);
    const ob = this.obligation(decision.obligation_id);
    if (ob.latest_decision_id !== decisionId) throw new LocalRunnerError("only the latest decision can be finalized");
    if (["insufficient_evidence", "cancelled", "expired"].includes(decision.outcome)) {
      throw new LocalRunnerError(`a ${decision.outcome} decision cannot create final postings`);
    }
    if (ob.finalized) return;
    ob.finalized = true;
    const event = this.appendServiceEvent({
      obligationId: ob.obligation_id,
      type: "obligation.cleared",
      data: { decision_id: decisionId, outcome: decision.outcome, accepted_amount_minor: decision.accepted_amount_minor },
    });
    this.syncClearing(ob, [event.payload.event_id]);
  }

  // ---------- Settlement (simulated) ----------

  /**
   * Simulates paying the unsettled payable: an instruction to the sandbox adapter and a "paid" report for it,
   * labeled simulated. No money moves and no payment provider is contacted. Returns null when nothing is payable.
   */
  settleInSandbox(obligationId: string): { instruction: SettlementInstruction; settlement_event: SettlementEvent } | null {
    const ob = this.obligation(obligationId);
    if (!ob.finalized || !ob.latest_decision_id || !ob.counterparty_agent_id) throw new LocalRunnerError("obligation has no finalized payable");
    const payee = ob.counterparty_agent_id;
    const open = this.instructions
      .filter((i) => i.obligation_id === obligationId && ["submitted", "processing"].includes(i.status))
      .reduce((sum, i) => sum + i.amount_minor, 0);
    const available = this.balance(obligationId, "payable", payee) + this.balance(obligationId, "reserve_reported", payee) - open;
    if (available <= 0) return null;

    const instructionId = newId("settlementInstruction");
    const instruction: SettlementInstruction = {
      instruction_id: instructionId,
      obligation_id: obligationId,
      decision_id: ob.latest_decision_id,
      beneficiary_party_id: payee,
      beneficiary_ref: "sandbox-beneficiary",
      currency: ob.terms.currency,
      amount_minor: available,
      adapter: "sandbox",
      idempotency_key: `local-${instructionId}`,
      expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      status: "submitted",
      created_at: now(),
    };
    this.instructions.push(instruction);

    const settlementEvent: SettlementEvent = {
      settlement_event_id: newId("settlementEvent"),
      instruction_id: instructionId,
      provider: "sandbox",
      provider_event_id: `sbx_evt_${instructionId}`,
      provider_reference: `sbx_tr_${instructionId}`,
      provider_status: "paid",
      normalized_status: "settled",
      currency: instruction.currency,
      amount_minor: available,
      raw_json: JSON.stringify({ simulated: true, instruction_id: instructionId }),
      reported_at: now(),
    };
    this.settlementEvents.push(settlementEvent);
    const report = this.appendServiceEvent({
      obligationId,
      type: "settlement.reported",
      data: {
        settlement_event_id: settlementEvent.settlement_event_id,
        instruction_id: instructionId,
        provider: settlementEvent.provider,
        provider_reference: settlementEvent.provider_reference,
        provider_status: settlementEvent.provider_status,
        normalized_status: settlementEvent.normalized_status,
        amount_minor: settlementEvent.amount_minor,
        currency: settlementEvent.currency,
      },
    });
    this.postBatch(ob, {
      entryType: "settlement",
      decisionId: instruction.decision_id,
      settlementEventId: settlementEvent.settlement_event_id,
      sourceEventIds: [report.payload.event_id],
      built: buildSettlementLines({ payeeId: payee, currency: instruction.currency, amountMinor: available, reservedMinor: 0 }),
    });
    instruction.status = "settled";
    return { instruction, settlement_event: settlementEvent };
  }

  // ---------- Exports ----------

  /** The obligation's signed closure package: everything needed to replay its decisions and journal offline. */
  exportClosurePackage(obligationId: string): ClosurePackage {
    const ob = this.obligation(obligationId);
    const events = this.eventsFor(obligationId);
    const signerKeys = new Set(events.map((e) => `${e.signature.key_id}#${e.signature.key_version}`));
    const instructionIds = new Set(this.instructions.filter((i) => i.obligation_id === obligationId).map((i) => i.instruction_id));
    const body: ClosurePackageBody = {
      package_version: "1.0",
      generated_at: now(),
      root_obligation_id: obligationId,
      requested_obligation_id: obligationId,
      obligations: [
        { obligation_id: obligationId, parent_obligation_id: null, redacted: false, effective_terms: ob.terms, effective_terms_digest: ob.terms_digest, state: ob.state },
      ],
      events,
      public_keys: this.keys.filter((k) => signerKeys.has(`${k.key_id}#${k.key_version}`) || k.key_id === this.serviceKey.keyId),
      policies: [ob.policy],
      evidence: this.evidence.filter((e) => e.obligation_id === obligationId).map((e) => e.envelope),
      verifier_results: this.verifierResults.filter((r) => r.obligation_id === obligationId),
      decisions: this.decisions.filter((d) => d.obligation_id === obligationId),
      posting_batches: this.batches.filter((b) => b.obligation_id === obligationId),
      settlement_instructions: this.instructions.filter((i) => i.obligation_id === obligationId),
      settlement_events: this.settlementEvents.filter((e) => e.instruction_id !== null && instructionIds.has(e.instruction_id)),
    };
    return signPayload(body, this.serviceKey);
  }

  /** Obligations backing a task's delegations, with each obligation's latest decision, for the task closure. */
  linksForTask(taskId: string): ObligationLink[] {
    return this.links
      .filter((l) => l.task_id === taskId)
      .map((l) => {
        const ob = this.obligation(l.obligation_id);
        const decision = ob.latest_decision_id ? this.decision(ob.latest_decision_id) : null;
        return { delegation_id: l.delegation_id, obligation_id: l.obligation_id, decision_id: decision?.decision_id ?? null, decision_digest: decision?.decision_digest ?? null };
      });
  }

  obligation(obligationId: string): LocalObligation {
    const ob = this.obligations.find((o) => o.obligation_id === obligationId);
    if (!ob) throw new LocalRunnerError(`obligation ${obligationId} not found`);
    return ob;
  }

  decision(decisionId: string): ClearingDecision {
    const decision = this.decisions.find((d) => d.decision_id === decisionId);
    if (!decision) throw new LocalRunnerError(`decision ${decisionId} not found`);
    return decision;
  }

  /** Net credit balance of one account type on an obligation (optionally for one party). */
  balance(obligationId: string, accountType: string, partyId?: string): number {
    return this.batches
      .filter((b) => b.obligation_id === obligationId)
      .flatMap((b) => b.lines)
      .filter((l) => l.account_type === accountType && (partyId === undefined || l.party_id === partyId))
      .reduce((sum, l) => sum + l.credit_minor - l.debit_minor, 0);
  }

  // ---------- Internals ----------

  private agent(agentId: string): LocalAgent {
    const agent = this.agents.find((a) => a.agent_id === agentId);
    if (!agent) throw new LocalRunnerError(`agent ${agentId} is not registered`);
    return agent;
  }

  /** Schema, event data, key ownership and validity, platform binding, and the Ed25519 signature. */
  private verify(body: unknown, expectedTypes: EventType[]): { signed: SignedEvent; agent: LocalAgent } {
    const signed = parseWith(SignedEventSchema, body, "signed event");
    const type = signed.payload.event_type as EventType;
    if (!expectedTypes.includes(type)) throw new LocalRunnerError(`event_type must be one of: ${expectedTypes.join(", ")}`);
    const dataSchema = EventDataSchemas[type as keyof typeof EventDataSchemas];
    if (dataSchema) parseWith(dataSchema, signed.payload.data, `${type} data`);
    const agent = this.agent(signed.payload.actor_id);
    if (signed.payload.actor_platform_id !== agent.platform_id) throw new LocalRunnerError("actor_platform_id does not match the agent's platform");
    const key = this.keys.find((k) => k.key_id === signed.signature.key_id && k.key_version === signed.signature.key_version);
    if (!key) throw new LocalRunnerError("unknown signing key or key version");
    if (key.actor_id !== agent.agent_id) throw new LocalRunnerError("signing key does not belong to the actor");
    const at = now();
    if (key.valid_from > at || (key.revoked_at && key.revoked_at <= at)) throw new LocalRunnerError("signing key is not valid now");
    if (!verifyPayload(signed, key.public_key)) throw new LocalRunnerError("signature does not verify");
    return { signed, agent };
  }

  /** Terms against registered identities, the referenced reference policy, and time bounds. */
  private validateTerms(terms: ObligationTerms): PolicyTemplate {
    const { policy_id, policy_version, policy_digest } = terms.acceptance_policy;
    const policy = REFERENCE_POLICIES.find((p) => p.policy_id === policy_id && p.policy_version === policy_version);
    if (!policy) throw new LocalRunnerError(`policy ${policy_id}@${policy_version} is not one of the reference policies`);
    if (digestOf(policy) !== policy_digest) throw new LocalRunnerError("acceptance_policy.policy_digest does not match the reference policy");
    for (const d of terms.deliverables) {
      for (const checkId of d.required_checks) {
        if (!policy.checks.some((c) => c.check_id === checkId)) throw new LocalRunnerError(`deliverable ${d.deliverable_id} requires unknown check ${checkId}`);
      }
    }
    if (policy.task_type !== terms.scope.task_type) throw new LocalRunnerError("scope.task_type does not match the policy's task_type");
    if (!this.principals.includes(terms.principal_id)) throw new LocalRunnerError(`principal ${terms.principal_id} is not registered`);
    if (terms.payer_id !== terms.principal_id) throw new LocalRunnerError("root obligation payer must be the principal");
    if (!terms.counterparty_agent_id) throw new LocalRunnerError("the local runner needs a named counterparty_agent_id (open offers need the hosted network)");
    this.agent(terms.counterparty_agent_id);
    if (terms.counterparty_agent_id === terms.issuer_agent_id) throw new LocalRunnerError("issuer and counterparty must differ");
    for (const verifierId of terms.verifier_agent_ids) this.agent(verifierId);
    if (Date.parse(terms.deadline) <= Date.now()) throw new LocalRunnerError("deadline must be in the future");
    if (Date.parse(terms.offer_expires_at) > Date.parse(terms.deadline)) throw new LocalRunnerError("offer_expires_at must not be after deadline");
    return policy;
  }

  private eventsFor(obligationId: string): RecordedEvent[] {
    return this.events.filter((e) => e.payload.obligation_id === obligationId);
  }

  private fetchBlob(envelope: EvidenceEnvelope): FetchResult {
    const content = this.blobs.get(envelope.content_digest);
    return content ? { ok: true, content } : { ok: false, error: "evidence not retrievable" };
  }

  private verifierKey(verifierIds: string[], keyId: string, version: number): KeyLookupResult | null {
    const key = this.keys.find((k) => k.key_id === keyId && k.key_version === version && verifierIds.includes(k.actor_id));
    const at = now();
    if (!key || key.valid_from > at || (key.revoked_at && key.revoked_at <= at)) return null;
    return { actor_id: key.actor_id, public_key: key.public_key };
  }

  /** Appends an event to the log, then records it on the linked subledger delegation. */
  private append(signed: SignedEvent): RecordedEvent {
    const payloadHash = digestOf(signed.payload);
    const existing = this.events.find((e) => e.payload.event_id === signed.payload.event_id);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new LocalRunnerError("event_id already used with a different payload");
      return existing;
    }
    const recorded: RecordedEvent = { payload: signed.payload, signature: signed.signature, payload_hash: payloadHash, received_at: now(), sequence: this.events.length + 1 };
    this.events.push(recorded);
    this.bridge(recorded);
    return recorded;
  }

  /** A server-produced fact or decision, signed with the runner's service key. */
  private appendServiceEvent(input: ServiceEventInput): RecordedEvent {
    return this.append(signPayload(serviceEventPayload(input), this.serviceKey));
  }

  /** Writes one balanced posting batch and its journal event. */
  private postBatch(ob: LocalObligation, input: BatchInput): PostingBatch {
    const balance = checkBalanced(input.built.lines);
    if (!balance.balanced) throw new LocalRunnerError(`unbalanced posting batch: ${balance.problems.join("; ")}`);
    const batch: PostingBatch = {
      batch_id: newId("postingBatch"),
      obligation_id: ob.obligation_id,
      entry_type: input.entryType,
      decision_id: input.decisionId ?? null,
      settlement_event_id: input.settlementEventId ?? null,
      reverses_batch_id: input.reversesBatchId ?? null,
      policy_version: input.policyVersion ?? null,
      source_event_ids: input.sourceEventIds,
      rounding: input.built.rounding,
      lines: input.built.lines,
      posted_at: now(),
    };
    this.batches.push(batch);
    this.appendServiceEvent({
      obligationId: ob.obligation_id,
      type: input.entryType === "reversal" ? "journal.reversed" : "journal.posted",
      data: {
        batch_id: batch.batch_id,
        entry_type: batch.entry_type,
        reverses_batch_id: batch.reverses_batch_id,
        decision_id: batch.decision_id,
        totals: Object.fromEntries(Object.entries(balance.byCurrency).map(([currency, totals]) => [currency, totals.debit])),
      },
      causationIds: input.sourceEventIds,
    });
    return batch;
  }

  /** Latest batch of a type for an obligation that has not been reversed. */
  private activeBatch(obligationId: string, entryType: EntryType): PostingBatch | null {
    const reversed = new Set(this.batches.map((b) => b.reverses_batch_id).filter((id) => id !== null));
    return this.batches.filter((b) => b.obligation_id === obligationId && b.entry_type === entryType && !reversed.has(b.batch_id)).at(-1) ?? null;
  }

  private reverseBatch(ob: LocalObligation, batch: PostingBatch, sourceEventIds: string[]): void {
    this.postBatch(ob, {
      entryType: "reversal",
      decisionId: batch.decision_id,
      reversesBatchId: batch.batch_id,
      policyVersion: batch.policy_version,
      sourceEventIds,
      built: buildReversalLines(batch.lines),
    });
  }

  /** Brings the clearing batch in line with the latest decision, by reversal plus replacement, never by editing. */
  private syncClearing(ob: LocalObligation, sourceEventIds: string[]): void {
    if (!ob.finalized || !ob.latest_decision_id || !ob.counterparty_agent_id) return;
    const decision = this.decision(ob.latest_decision_id);
    const payee = this.agent(ob.counterparty_agent_id);
    const built = buildClearingLines({
      payerId: ob.terms.payer_id,
      payeeAgentId: payee.agent_id,
      payeePlatformId: payee.platform_id,
      currency: ob.terms.currency,
      clearableMinor: decision.accepted_amount_minor,
      frozenMinor: decision.disputed_amount_minor,
      childCostMinor: 0,
      platformFeeBps: ob.policy.allocation.platform_fee_bps,
    });
    const active = this.activeBatch(ob.obligation_id, "clearing");
    if (active && active.decision_id === decision.decision_id && canonicalize(active.lines) === canonicalize(built.lines)) return;
    const contingent = this.activeBatch(ob.obligation_id, "contingent");
    if (contingent) this.reverseBatch(ob, contingent, sourceEventIds);
    if (active) this.reverseBatch(ob, active, sourceEventIds);
    if (built.lines.length > 0) {
      this.postBatch(ob, {
        entryType: "clearing",
        decisionId: decision.decision_id,
        policyVersion: decision.policy.policy_version,
        sourceEventIds,
        built,
      });
    }
  }

  // ---------- Bridge to the subledger ----------

  /** Records one appended obligation event on the delegation it backs. Obligations without a task link are ignored. */
  private bridge(event: RecordedEvent): void {
    const link = this.links.find((l) => l.obligation_id === event.payload.obligation_id);
    if (!link) return;
    const ob = this.obligation(link.obligation_id);
    const data = event.payload.data as Record<string, unknown>;
    const type = event.payload.event_type;
    if (type === "obligation.accepted") {
      this.recordClaim(link, event, "acceptance", "provider", `accepted terms version ${ob.terms.terms_version}`);
      const changed = acceptedTermsChanges(this.subledger.delegation(link.delegation_id), linked(ob));
      if (Object.keys(changed).length === 0) return;
      this.subledger.appendDelegationEvent(
        link.delegation_id,
        { type: "terms_update", note: `terms version ${ob.terms.terms_version} accepted on the clearing network`, terms: changed, evidence: networkEventEvidence(event), occurred_at: event.payload.event_time },
        { assertedBy: "buyer" },
      );
    } else if (type === "completion.proposed") {
      this.recordClaim(link, event, "completion", "provider", typeof data.note === "string" ? data.note : null);
    } else if (CLAIM_BY_OUTCOME_EVENT[type]) {
      const claim = decisionClaim(data as unknown as DecisionEventData, ob.policy.policy_id);
      this.recordClaim(link, event, CLAIM_BY_OUTCOME_EVENT[type], claim.asserted_by, claim.note);
    } else if (type === "journal.posted" || type === "journal.reversed") {
      this.recordJournalBatch(link, String(data.batch_id));
    }
  }

  private recordClaim(link: TaskLink, event: RecordedEvent, type: DeliveryEventType, assertedBy: ClaimAsserter, note: string | null): void {
    this.subledger.appendDelegationEvent(
      link.delegation_id,
      { type, note: note?.slice(0, 2000) ?? null, evidence: networkEventEvidence(event), occurred_at: event.payload.event_time },
      { assertedBy },
    );
  }

  /** Turns one journal batch into financial events on the delegation (see clearingFacts). */
  private recordJournalBatch(link: TaskLink, batchId: string): void {
    const batches = this.batches.filter((b) => b.obligation_id === link.obligation_id);
    const batch = batches.find((b) => b.batch_id === batchId);
    if (!batch) return;
    const instructionIds = new Set(this.instructions.filter((i) => i.obligation_id === link.obligation_id).map((i) => i.instruction_id));
    const settlementEvents = this.settlementEvents.filter((e) => e.instruction_id !== null && instructionIds.has(e.instruction_id));
    const delegation = this.subledger.delegation(link.delegation_id);
    for (const fact of clearingFacts(batch, undoneBatch(batch, batches, settlementEvents))) {
      let reversesEventId: string | null = null;
      if (fact.reverses_key) {
        const target = this.subledger.findEventBySource(CLEARING_SOURCE, fact.reverses_key);
        if (!target) continue;
        reversesEventId = target.financial_event_id;
      }
      this.subledger.recordFinancialEvent(
        clearingFactEvent(fact, { batch, settlementEvents, obligationId: link.obligation_id, delegationId: link.delegation_id, providerId: delegation.provider_id, reversesEventId }),
      );
    }
  }
}

function linked(ob: LocalObligation): LinkedObligation {
  return { obligation_id: ob.obligation_id, terms: ob.terms, terms_digest: ob.terms_digest };
}
