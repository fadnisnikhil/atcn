import { digestOf, newId, signPayload } from "@atcn/schema";
import {
  DERIVED_EXCEPTION_KINDS,
  DelegationEventInputSchema,
  DelegationInputSchema,
  FinancialEventInputSchema,
  SIGNED_BY_LOCAL_RUNNER,
  TaskInputSchema,
  buildClosurePayload,
  deliveryStatus,
  deriveTaskExceptions,
  derivedExceptionAction,
  mergeMatchCandidates,
  rollupFor,
  type ClaimAsserter,
  type DelegationRecord,
  type DeliveryClaim,
  type ExceptionKind,
  type ExceptionRecord,
  type FinancialEventRecord,
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
        Object.assign(delegation, { [field]: normalized });
      }
    } else if (input.terms) {
      throw new LocalRunnerError("only terms_update carries terms");
    }
    const claim: DeliveryClaim = {
      event_id: newId("delegationEvent"),
      delegation_id: delegationId,
      type: input.type,
      asserted_by: networkRecord?.assertedBy ?? input.asserted_by,
      assurance: [networkRecord ? "network_recorded" : "buyer_recorded"],
      note: input.note,
      evidence: input.evidence,
      supersedes_event_id: input.supersedes_event_id,
      reason: input.reason,
      retrospective: input.retrospective,
      occurred_at: iso(input.occurred_at) ?? now(),
      recorded_at: now(),
    };
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
    } else if (input.reverses_event_id) {
      throw new LocalRunnerError("only a reversal may set reverses_event_id");
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
    };
    const stored: StoredFinancialEvent = { record, content_digest: contentDigest, attribution: null };
    this.financialEvents.push(stored);

    const exceptionIds: string[] = [];
    if (reversed) {
      stored.attribution = reversed.attribution;
    } else if (input.type !== "fx_rate") {
      const candidates = this.matchCandidates(input);
      if (candidates.length === 1) {
        stored.attribution = { task_id: candidates[0].task_id, delegation_id: candidates[0].delegation_id };
      } else {
        const kind = candidates.length > 1 ? "ambiguous_match" : "unmatched_charge";
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

  /** Recomputes condition-based exceptions for one task and resolves those whose condition cleared. */
  refreshExceptions(taskId: string): void {
    const { task, claims, delegations, rollup } = this.state(taskId);
    const derived = deriveTaskExceptions({ task, delegations, claims, rollup, now: now() });
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
   * Closes the task: a signed, versioned snapshot of lineage, claims, events, the roll-up, open exceptions, and the
   * obligations backing delegations. Closing again creates the next version. Signed by the runner's own key.
   */
  closeTask(taskId: string, obligationLinks: ObligationLink[]): { closure: SignedClosure; digest: string } {
    this.refreshExceptions(taskId);
    const { task, claims, delegations, events } = this.state(taskId);
    const previous = this.closures.filter((c) => c.task_id === taskId).at(-1) ?? null;
    const eventIds = new Set(events.map((e) => e.record.financial_event_id));
    const openExceptions = this.exceptions.filter((x) => x.status === "open" && (x.task_id === taskId || (x.financial_event_id !== null && eventIds.has(x.financial_event_id))));
    const payload = buildClosurePayload({
      closure_id: newId("closure"),
      version: previous ? previous.closure.payload.version + 1 : 1,
      previous: previous ? { closure_id: previous.closure.payload.closure_id, digest: previous.digest } : null,
      generated_at: now(),
      issuer: { operator_id: "local", operator_name: this.operatorName, signed_by: SIGNED_BY_LOCAL_RUNNER },
      task: taskRecord(task),
      delegations: delegations.map(({ root_task_id: _root, shared_description: _shared, ...d }) => d),
      claims,
      events,
      allocations: [],
      open_exceptions: openExceptions.map(({ task_id: _task, dedupe_key: _key, resolved_by: _by, ...x }) => x),
      receipts: [],
      responses: [],
      key_bindings: [],
      capture_gaps: [],
      obligation_links: obligationLinks,
    });
    const closure = signPayload(payload, this.serviceKey) as SignedClosure;
    const digest = digestOf(payload);
    this.closures.push({ task_id: taskId, closure, digest });
    task.status = "closed";
    return { closure, digest };
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
