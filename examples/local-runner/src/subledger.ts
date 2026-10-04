import { digestOf, newId, signPayload } from "@atcn/schema";
import {
  CaptureGapInputSchema,
  DERIVED_EXCEPTION_KINDS,
  EXPECTATION_EVENT_TYPES,
  DelegationEventInputSchema,
  DelegationInputSchema,
  FinancialEventInputSchema,
  SIGNED_BY_LOCAL_RUNNER,
  TaskInputSchema,
  buildClosurePayload,
  delegationEventProblems,
  deliveryStatus,
  deriveTaskExceptions,
  derivedExceptionAction,
  expectationSignatureProblem,
  mergeMatchCandidates,
  railAttestationProblem,
  rollupFor,
  outcomeSignatureProblem,
  type CaptureGap,
  type ClaimAsserter,
  type DelegationRecord,
  type DeliveryClaim,
  type ExceptionKind,
  type ExceptionRecord,
  type FinancialEventRecord,
  type KeyBindingRecord,
  type MatchCandidate,
  type ObligationLink,
  type Rollup,
  type SignedClosure,
  type TaskRecord,
} from "@atcn/subledger";
import { LocalRunnerError, parseWith } from "./errors.js";
import type { ServiceKey } from "./keys.js";

/**
 * The buyer's subledger, kept in memory: tasks, delegations, delivery claims, financial events, exceptions, and
 * signed closures. It applies the same validation, matching, roll-up, and exception rules as the hosted API, using
 * the shared functions from @atcn/subledger, so its closures pass the same offline verifier.
 */

export interface LocalTask extends TaskRecord {
  status: "open" | "closed";
  shared_description: string | null;
}

export interface Provider {
  provider_id: string;
  name: string;
  provider_own_id: string | null;
}

export interface Attribution {
  task_id: string;
  delegation_id: string | null;
}

export interface LocalException extends ExceptionRecord {
  task_id: string | null;
  dedupe_key: string;
  resolved_by: string | null;
}

export interface FinancialEventResult {
  financial_event: FinancialEventRecord;
  deduplicated: boolean;
  attribution: Attribution | null;
  exception_ids: string[];
}

type StoredDelegation = Omit<DelegationRecord, "delivery_status">;

interface StoredFinancialEvent {
  record: FinancialEventRecord;
  content_digest: string;
  attribution: Attribution | null;
}

interface OpenExceptionInput {
  kind: ExceptionKind;
  dedupeKey: string;
  detail: string;
  taskId?: string | null;
  delegationId?: string | null;
  financialEventId?: string | null;
}

const now = () => new Date().toISOString();
const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

export class LocalSubledger {
  readonly tasks: LocalTask[] = [];
  readonly providers: Provider[] = [];
  readonly delegations: StoredDelegation[] = [];
  readonly claims: DeliveryClaim[] = [];
  readonly financialEvents: StoredFinancialEvent[] = [];
  readonly exceptions: LocalException[] = [];
  readonly closures: { task_id: string; closure: SignedClosure; digest: string }[] = [];
  readonly keyBindings: KeyBindingRecord[] = [];
  readonly captureGaps: (CaptureGap & { task_id: string })[] = [];

  constructor(
    private readonly serviceKey: ServiceKey,
    private readonly operatorName: string,
  ) {}

  createTask(body: unknown): LocalTask {
    const input = parseWith(TaskInputSchema, body, "task");
    if (this.tasks.some((t) => t.external_ref === input.external_ref)) throw new LocalRunnerError(`task external_ref ${input.external_ref} is already used`);
    const task: LocalTask = {
      task_id: newId("task"),
      external_ref: input.external_ref,
      currency: input.currency,
      budget_minor: input.budget_minor,
      customer_ref: input.customer_ref,
      project_ref: input.project_ref,
      cost_center: input.cost_center,
      scope_ref: input.scope_ref,
      shared_description: input.shared_description,
      retrospective: input.retrospective,
      status: "open",
      created_at: now(),
      ...(input.estimate_tolerance_bps !== undefined ? { estimate_tolerance_bps: input.estimate_tolerance_bps } : {}),
    };
    this.tasks.push(task);
    return task;
  }

  task(taskId: string): LocalTask {
    const task = this.tasks.find((t) => t.task_id === taskId);
    if (!task) throw new LocalRunnerError(`task ${taskId} not found`);
    return task;
  }

  /** One provider per stable identifier; a taken name gets the identifier appended, as in the hosted API. */
  addProvider(name: string, providerOwnId: string | null): Provider {
    const existing = providerOwnId ? this.providers.find((p) => p.provider_own_id === providerOwnId) : undefined;
    if (existing) return existing;
    const names = providerOwnId ? [name, `${name} (${providerOwnId})`] : [name];
    const free = names.find((candidate) => !this.providers.some((p) => p.name === candidate));
    if (!free) throw new LocalRunnerError(`provider name ${name} is already taken`);
    const provider: Provider = { provider_id: newId("provider"), name: free, provider_own_id: providerOwnId };
    this.providers.push(provider);
    return provider;
  }

  /**
   * Binds a public key to a provider (an agent's provider or a budget gateway), as the operator configured it. Signed
   * estimates and holds name the binding; the closure lists it so the signature verifies offline.
   */
  bindProviderKey(providerId: string, publicKey: string, keyId: string): KeyBindingRecord {
    if (!this.providers.some((p) => p.provider_id === providerId)) throw new LocalRunnerError(`provider ${providerId} not found`);
    const binding: KeyBindingRecord = {
      binding_id: newId("providerKeyBinding"),
      provider_id: providerId,
      key_id: keyId,
      public_key: publicKey,
      method: "operator_configured",
      created_by: "local",
      created_at: now(),
      revoked_at: null,
    };
    this.keyBindings.push(binding);
    return binding;
  }

  /** Callers may address a delegation by their own reference as "ext:<external_ref>", as in the hosted API. */
  resolveDelegationId(ref: string): string {
    if (!ref.startsWith("ext:")) return ref;
    const delegation = this.delegations.find((d) => d.external_ref === ref.slice(4));
    if (!delegation) throw new LocalRunnerError(`delegation ${ref} not found`);
    return delegation.delegation_id;
  }

  createDelegation(taskId: string, body: unknown): DelegationRecord {
    const input = parseWith(DelegationInputSchema, body, "delegation");
    this.task(taskId);
    if (input.parent_delegation_id) input.parent_delegation_id = this.resolveDelegationId(input.parent_delegation_id);
    let depth = 1;
    if (input.parent_delegation_id) {
      const parent = this.delegations.find((d) => d.delegation_id === input.parent_delegation_id && d.root_task_id === taskId);
      if (!parent) throw new LocalRunnerError(`parent delegation ${input.parent_delegation_id} not found in this task`);
      depth = parent.depth + 1;
    }
    if (input.provider_id && !this.providers.some((p) => p.provider_id === input.provider_id)) throw new LocalRunnerError(`provider ${input.provider_id} not found`);
    if (input.external_ref && this.delegations.some((d) => d.external_ref === input.external_ref)) {
      throw new LocalRunnerError(`delegation external_ref ${input.external_ref} is already used`);
    }
    const delegation: StoredDelegation = {
      delegation_id: newId("delegation"),
      root_task_id: taskId,
      parent_delegation_id: input.parent_delegation_id,
      depth,
      provider_id: input.provider_id,
      provider_name_stated: input.provider_name_stated,
      provider_own_id: input.provider_own_id,
      external_ref: input.external_ref,
      provider_job_ref: input.provider_job_ref,
      scope_ref: input.scope_ref,
      shared_description: input.shared_description,
      currency: input.currency,
      quoted_max_minor: input.quoted_max_minor,
      quote_basis: input.quote_basis,
      quote_valid_until: iso(input.quote_valid_until),
      accepted_amount_minor: input.accepted_amount_minor,
      terms_digest: input.terms_digest,
      expected_delivery: iso(input.expected_delivery),
      downstream_visibility: input.downstream_visibility,
      retrospective: input.retrospective,
      ...(input.execution ? { execution: input.execution } : {}),
      ...(input.pricing ? { pricing: input.pricing } : {}),
      ...(input.refund_terms ? { refund_terms: input.refund_terms } : {}),
      ...(input.witness_policy ? { witness_policy: input.witness_policy } : {}),
      created_at: now(),
    };
    this.delegations.push(delegation);
    this.refreshExceptions(taskId);
    return this.delegation(delegation.delegation_id);
  }

  delegation(delegationId: string): DelegationRecord {
    const stored = this.delegations.find((d) => d.delegation_id === delegationId);
    if (!stored) throw new LocalRunnerError(`delegation ${delegationId} not found`);
    return { ...stored, delivery_status: deliveryStatus(this.claims.filter((c) => c.delegation_id === delegationId)) };
  }

  /**
   * Appends a delivery claim, terms update, or correction. Nothing is overwritten; corrections supersede.
   * Only the clearing-network side passes `networkRecord`, which labels the claim `network_recorded`.
   */
  appendDelegationEvent(delegationId: string, body: unknown, networkRecord?: { assertedBy: ClaimAsserter }): DeliveryClaim {
    const input = parseWith(DelegationEventInputSchema, body, "delegation event");
    const problems = delegationEventProblems(input);
    if (problems.length > 0) throw new LocalRunnerError(`invalid delegation event: ${problems.join("; ")}`);
    const delegation = this.delegations.find((d) => d.delegation_id === delegationId);
    if (!delegation) throw new LocalRunnerError(`delegation ${delegationId} not found`);
    if (input.type === "correction") {
      if (!input.supersedes_event_id || !input.reason) throw new LocalRunnerError("a correction needs supersedes_event_id and reason");
      if (!this.claims.some((c) => c.event_id === input.supersedes_event_id && c.delegation_id === delegationId)) {
        throw new LocalRunnerError(`superseded event ${input.supersedes_event_id} not found on this delegation`);
      }
    } else if (input.supersedes_event_id) {
      throw new LocalRunnerError("only a correction may supersede an event");
    }
    if (input.type === "terms_update") {
      if (!input.terms || Object.keys(input.terms).length === 0) throw new LocalRunnerError("terms_update needs terms");
      for (const [field, value] of Object.entries(input.terms)) {
        if (value === undefined) continue;
        const normalized = field === "quote_valid_until" || field === "expected_delivery" ? iso(value as string | null) : value;
        if (field === "pricing" && value === null) delete delegation.pricing;
        else if (field === "refund_terms" && value === null) delete delegation.refund_terms;
        else if (field === "witness_policy" && value === null) delete delegation.witness_policy;
        else Object.assign(delegation, { [field]: normalized });
      }
    } else if (input.terms) {
      throw new LocalRunnerError("only terms_update carries terms");
    }
    const claim: DeliveryClaim = {
      event_id: newId("delegationEvent"),
      delegation_id: delegationId,
      type: input.type,
      asserted_by: networkRecord?.assertedBy ?? input.asserted_by,
      assurance: [networkRecord ? "network_recorded" : input.signer ? "provider_key_signed" : "buyer_recorded"],
      note: input.note,
      evidence: input.evidence,
      ...(input.usage ? { usage: input.usage } : {}),
      supersedes_event_id: input.supersedes_event_id,
      reason: input.reason,
      retrospective: input.retrospective,
      occurred_at: iso(input.occurred_at) ?? now(),
      recorded_at: now(),
      ...(input.signer ? { signer: input.signer } : {}),
    };
    const signatureProblem = outcomeSignatureProblem(claim, delegation, this.keyBindings);
    if (signatureProblem) throw new LocalRunnerError(signatureProblem);
    this.claims.push(claim);
    this.refreshExceptions(delegation.root_task_id);
    return claim;
  }

  /**
   * Appends one financial event. A retry of the same source event returns the original; a conflicting duplicate
   * is refused and recorded as a duplicate_event exception. Only a unique stable-reference match is applied.
   */
  recordFinancialEvent(body: unknown): FinancialEventResult {
    const input = parseWith(FinancialEventInputSchema, body, "financial event");
    const contentDigest = digestOf(input);
    const existing = this.financialEvents.find((e) => e.record.source === input.source && e.record.source_event_id === input.source_event_id);
    if (existing) {
      if (existing.content_digest === contentDigest) return { financial_event: existing.record, deduplicated: true, attribution: existing.attribution, exception_ids: [] };
      this.openException({
        kind: "duplicate_event",
        dedupeKey: `duplicate_event:${input.source}:${input.source_event_id}:${contentDigest}`,
        detail: `source event ${input.source}/${input.source_event_id} was re-sent with different content; the original is kept`,
        financialEventId: existing.record.financial_event_id,
      });
      throw new LocalRunnerError(`a different event with source ${input.source} and source_event_id ${input.source_event_id} already exists`);
    }
    if (input.provider_id && !this.providers.some((p) => p.provider_id === input.provider_id)) throw new LocalRunnerError(`provider ${input.provider_id} not found`);
    for (const ref of [input.included_in_event_id, input.settles_event_id]) {
      if (ref && !this.findEvent(ref)) throw new LocalRunnerError(`referenced financial event ${ref} not found`);
    }
    let reversed: StoredFinancialEvent | null = null;
    if (input.type === "reversal") {
      reversed = this.findEvent(input.reverses_event_id!) ?? null;
      if (!reversed) throw new LocalRunnerError(`reversed financial event ${input.reverses_event_id} not found`);
      if (reversed.record.type === "reversal") throw new LocalRunnerError("a reversal cannot be reversed; append a new event instead");
      if (reversed.record.amount_minor !== input.amount_minor || reversed.record.currency !== input.currency) {
        throw new LocalRunnerError("a reversal must match the reversed event's amount and currency");
      }
      if (EXPECTATION_EVENT_TYPES.includes(reversed.record.type)) throw new LocalRunnerError("estimates and holds are revised by a superseding record, not reversed");
    } else if (input.reverses_event_id) {
      throw new LocalRunnerError("only a reversal may set reverses_event_id");
    }
    const supersedes = input.expectation?.supersedes ?? null;
    if (supersedes !== null && !this.financialEvents.some((e) => e.record.source === input.source && e.record.type === input.type && e.record.source_event_id === supersedes)) {
      throw new LocalRunnerError(`superseded ${input.type} ${input.source}/${supersedes} not found`);
    }

    const record: FinancialEventRecord = {
      financial_event_id: newId("financialEvent"),
      type: input.type,
      source: input.source,
      source_event_id: input.source_event_id,
      provider_id: input.provider_id,
      provider_reference: input.provider_reference,
      amount_minor: input.amount_minor,
      currency: input.currency,
      event_date: iso(input.event_date)!,
      imported_at: now(),
      provider_status: input.provider_status,
      normalized_status: input.normalized_status,
      evidence: input.evidence,
      retrospective: input.retrospective,
      payer: input.payer,
      liability_owner: input.liability_owner,
      economic_event_id: input.economic_event_id,
      included_in_event_id: input.included_in_event_id,
      reverses_event_id: input.reverses_event_id,
      settles_event_id: input.settles_event_id,
      fx: input.fx,
      reason: input.reason,
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.expectation ? { expectation: input.expectation } : {}),
      ...(input.rail_attestation ? { rail_attestation: input.rail_attestation } : {}),
    };
    const railProblem = railAttestationProblem(record);
    if (railProblem) throw new LocalRunnerError(`rail attestation refused (${railProblem.code}): ${railProblem.detail}`);
    const candidates = reversed || input.type === "fx_rate" ? [] : this.matchCandidates(input);
    if (record.expectation?.signer) {
      const matchedDelegation = candidates.length === 1 && candidates[0].delegation_id ? this.delegation(candidates[0].delegation_id) : null;
      const problem = expectationSignatureProblem(record, matchedDelegation ? matchedDelegation.provider_id : record.expectation.signer.provider_id, this.keyBindings);
      if (problem) throw new LocalRunnerError(problem);
    }
    const stored: StoredFinancialEvent = { record, content_digest: contentDigest, attribution: null };
    this.financialEvents.push(stored);

    const exceptionIds: string[] = [];
    if (reversed) {
      stored.attribution = reversed.attribution;
    } else if (input.type !== "fx_rate") {
      if (candidates.length === 1) {
        stored.attribution = { task_id: candidates[0].task_id, delegation_id: candidates[0].delegation_id };
      } else {
        const unmatchedKind = EXPECTATION_EVENT_TYPES.includes(input.type) ? "unmatched_estimate" : "unmatched_charge";
        const kind = candidates.length > 1 ? "ambiguous_match" : unmatchedKind;
        exceptionIds.push(
          this.openException({
            kind,
            dedupeKey: `${kind}:${record.financial_event_id}`,
            detail: candidates.length > 1 ? `${candidates.length} candidate nodes; none selected automatically` : "no task or delegation has a matching stable reference",
            financialEventId: record.financial_event_id,
          }),
        );
      }
    }
    if (stored.attribution) this.afterAttribution(record, stored.attribution);
    return { financial_event: record, deduplicated: false, attribution: stored.attribution, exception_ids: exceptionIds };
  }

  findEventBySource(source: string, sourceEventId: string): FinancialEventRecord | null {
    return this.financialEvents.find((e) => e.record.source === source && e.record.source_event_id === sourceEventId)?.record ?? null;
  }

  /** The task roll-up by currency, with its open exceptions. */
  summary(taskId: string): { task: LocalTask; rollup: Rollup; open_exceptions: LocalException[] } {
    const { task, rollup } = this.state(taskId);
    return { task, rollup, open_exceptions: this.exceptions.filter((x) => x.task_id === taskId && x.status === "open") };
  }

  /**
   * Recomputes condition-based exceptions for one task and resolves those whose condition cleared. `closing` is true
   * while the task is being closed (and stays true once it is closed).
   */
  refreshExceptions(taskId: string, closing = false, at = now()): void {
    const { task, claims, delegations, events, rollup } = this.state(taskId);
    const derived = deriveTaskExceptions({ task, delegations, claims, events, rollup, now: at, key_bindings: this.keyBindings, closing: closing || task.status === "closed" });
    for (const d of derived) {
      const latest = this.exceptions.filter((x) => x.dedupe_key === d.dedupe_key).at(-1) ?? null;
      const action = derivedExceptionAction(latest, d);
      if (action === "update_detail") latest!.detail = d.detail;
      else if (action === "open") this.openException({ kind: d.kind, dedupeKey: d.dedupe_key, detail: d.detail, taskId, delegationId: d.delegation_id });
    }
    const stillDerived = new Set(derived.map((d) => d.dedupe_key));
    for (const x of this.exceptions) {
      if (x.task_id === taskId && x.status === "open" && DERIVED_EXCEPTION_KINDS.includes(x.kind as ExceptionKind) && !stillDerived.has(x.dedupe_key)) {
        x.status = "resolved";
        x.resolved_by = "system";
      }
    }
  }

  /**
   * Records part of the delegation chain that was not captured (for example a reported sub-task with no outcome). The
   * closure then shows lineage as incomplete, and an incomplete_lineage exception stays open, as in the hosted API.
   */
  reportCaptureGap(taskId: string, body: unknown): CaptureGap {
    const input = parseWith(CaptureGapInputSchema, body, "capture gap");
    this.task(taskId);
    if (input.delegation_id) {
      input.delegation_id = this.resolveDelegationId(input.delegation_id);
      if (!this.delegations.some((d) => d.delegation_id === input.delegation_id && d.root_task_id === taskId)) throw new LocalRunnerError(`delegation ${input.delegation_id} not found in this task`);
    }
    const gap = { gap_id: newId("captureGap"), task_id: taskId, delegation_id: input.delegation_id, kind: input.kind, detail: input.detail, reported_at: now() };
    this.captureGaps.push(gap);
    this.openException({ kind: "incomplete_lineage", dedupeKey: `incomplete_lineage:${gap.gap_id}`, detail: `${input.kind}: ${input.detail}`, taskId, delegationId: input.delegation_id });
    const { task_id: _task, ...captureGap } = gap;
    return captureGap;
  }

  /**
   * Closes the task: a signed, versioned snapshot of lineage, claims, events, the roll-up, open exceptions, and the
   * obligations backing delegations. Closing again creates the next version. Signed by the runner's own key.
   */
  closeTask(taskId: string, obligationLinks: ObligationLink[]): { closure: SignedClosure; digest: string } {
    // The verifier recomputes derived exceptions as of generated_at, so they are derived at that same instant.
    const generatedAt = now();
    this.refreshExceptions(taskId, true, generatedAt);
    const { task, claims, delegations, events } = this.state(taskId);
    const previous = this.closures.filter((c) => c.task_id === taskId).at(-1) ?? null;
    const eventIds = new Set(events.map((e) => e.record.financial_event_id));
    const openExceptions = this.exceptions.filter((x) => x.status === "open" && (x.task_id === taskId || (x.financial_event_id !== null && eventIds.has(x.financial_event_id))));
    const payload = buildClosurePayload({
      closure_id: newId("closure"),
      version: previous ? previous.closure.payload.version + 1 : 1,
      previous: previous ? { closure_id: previous.closure.payload.closure_id, digest: previous.digest } : null,
      generated_at: generatedAt,
      issuer: { operator_id: "local", operator_name: this.operatorName, signed_by: SIGNED_BY_LOCAL_RUNNER },
      task: taskRecord(task),
      delegations: delegations.map(({ root_task_id: _root, shared_description: _shared, ...d }) => d),
      claims,
      events,
      allocations: [],
      open_exceptions: openExceptions.map(({ task_id: _task, dedupe_key: _key, resolved_by: _by, ...x }) => x),
      receipts: [],
      responses: [],
      key_bindings: this.keyBindingsFor(delegations, events),
      capture_gaps: this.captureGaps.filter((g) => g.task_id === taskId).map(({ task_id: _task, ...gap }) => gap),
      obligation_links: obligationLinks,
    });
    const closure = signPayload(payload, this.serviceKey) as SignedClosure;
    const digest = digestOf(payload);
    this.closures.push({ task_id: taskId, closure, digest });
    task.status = "closed";
    return { closure, digest };
  }

  /** Bindings of the task's providers and of the signers of its estimates and holds. */
  private keyBindingsFor(delegations: DelegationRecord[], events: { record: FinancialEventRecord }[]): KeyBindingRecord[] {
    const providerIds = new Set([
      ...delegations.map((d) => d.provider_id).filter((id): id is string => id !== null),
      ...events.map((e) => e.record.expectation?.signer?.provider_id).filter((id): id is string => id !== undefined),
    ]);
    return this.keyBindings.filter((b) => providerIds.has(b.provider_id));
  }

  private findEvent(financialEventId: string): StoredFinancialEvent | undefined {
    return this.financialEvents.find((e) => e.record.financial_event_id === financialEventId);
  }

  private state(taskId: string) {
    const task = this.task(taskId);
    const delegations = this.delegations
      .filter((d) => d.root_task_id === taskId)
      .sort((a, b) => a.depth - b.depth)
      .map((d) => this.delegation(d.delegation_id));
    const delegationIds = new Set(delegations.map((d) => d.delegation_id));
    const claims = this.claims.filter((c) => delegationIds.has(c.delegation_id));
    const events = this.financialEvents
      .filter((e) => e.attribution?.task_id === taskId)
      .map((e) => ({ record: e.record, attributed_to: e.attribution!.delegation_id ?? e.attribution!.task_id }));
    const rollup = rollupFor(taskRecord(task), delegations, events, []);
    return { task, claims, delegations, events, rollup };
  }

  /** Candidate nodes from stable references only (see mergeMatchCandidates). No fuzzy matching on amounts, dates, or names. */
  private matchCandidates(input: { provider_id: string | null; match: Record<string, string | null> }): MatchCandidate[] {
    const m = input.match;
    const found: MatchCandidate[] = [];
    const addDelegations = (matches: StoredDelegation[], reason: string) => {
      for (const d of matches) found.push({ task_id: d.root_task_id, delegation_id: d.delegation_id, reason });
    };
    const addTasks = (matches: LocalTask[], reason: string) => {
      for (const t of matches) found.push({ task_id: t.task_id, delegation_id: null, reason });
    };
    if (m.delegation_id) addDelegations(this.delegations.filter((d) => d.delegation_id === m.delegation_id), "delegation_id");
    if (m.delegation_external_ref) addDelegations(this.delegations.filter((d) => d.external_ref === m.delegation_external_ref), "delegation_external_ref");
    if (m.provider_job_ref) {
      const sameProvider = (d: StoredDelegation) => !input.provider_id || d.provider_id === null || d.provider_id === input.provider_id;
      addDelegations(this.delegations.filter((d) => d.provider_job_ref === m.provider_job_ref && sameProvider(d)), "provider_job_ref");
    }
    if (m.task_id) addTasks(this.tasks.filter((t) => t.task_id === m.task_id), "task_id");
    if (m.task_external_ref) addTasks(this.tasks.filter((t) => t.external_ref === m.task_external_ref), "task_external_ref");
    return mergeMatchCandidates(found);
  }

  /** Exceptions that depend on where an event landed: currency mismatch and refund after close. */
  private afterAttribution(record: FinancialEventRecord, node: Attribution): void {
    const owner = node.delegation_id ? this.delegation(node.delegation_id) : this.task(node.task_id);
    if (owner.currency !== record.currency && record.type !== "reversal") {
      this.openException({
        kind: "currency_mismatch",
        dedupeKey: `currency_mismatch:${record.financial_event_id}`,
        detail: `${record.type} in ${record.currency} recorded against a ${owner.currency} ${node.delegation_id ? "delegation" : "task"}; amounts stay separate by currency`,
        taskId: node.task_id,
        delegationId: node.delegation_id,
        financialEventId: record.financial_event_id,
      });
    }
    if (this.task(node.task_id).status === "closed" && (record.type === "refund" || record.type === "credit")) {
      this.openException({
        kind: "refund_after_close",
        dedupeKey: `refund_after_close:${record.financial_event_id}`,
        detail: `${record.type} of ${record.amount_minor} ${record.currency} arrived after the task was closed; prior closures remain unchanged`,
        taskId: node.task_id,
        delegationId: node.delegation_id,
        financialEventId: record.financial_event_id,
      });
    }
    this.refreshExceptions(node.task_id);
  }

  /** Opens an exception unless one with the same dedupe key is already open. Returns the open exception's ID. */
  private openException(input: OpenExceptionInput): string {
    const open = this.exceptions.find((x) => x.dedupe_key === input.dedupeKey && x.status === "open");
    if (open) return open.exception_id;
    const exception: LocalException = {
      exception_id: newId("subledgerException"),
      kind: input.kind,
      status: "open",
      task_id: input.taskId ?? null,
      delegation_id: input.delegationId ?? null,
      financial_event_id: input.financialEventId ?? null,
      dedupe_key: input.dedupeKey,
      detail: input.detail,
      resolved_by: null,
      created_at: now(),
    };
    this.exceptions.push(exception);
    return exception.exception_id;
  }
}

/** The closure snapshot's task shape (no shared description, no status). */
function taskRecord(task: LocalTask): TaskRecord {
  const { status: _status, shared_description: _shared, ...record } = task;
  return record;
}
