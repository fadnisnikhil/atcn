import { digestOf, resolveAttestations, type AttestationItem } from "@atcn/schema";
import { computeRollup, costSign, type Rollup } from "./rollup.js";
import {
  CLOSURE_DOCUMENT_TYPE,
  RECEIPT_DOCUMENT_TYPE,
  SUBLEDGER_SCHEMA_VERSION,
  type AllocationRecord,
  type CaptureGap,
  type ClosureDelegation,
  type ClosurePayload,
  type DeliveryClaim,
  type Disclosure,
  type ExceptionRecord,
  type FieldState,
  type Issuer,
  type KeyBindingRecord,
  type ObligationLink,
  type ReceiptPayload,
  type ReceiptTotals,
  type ResponseRecord,
} from "./documents.js";
import { ATTESTABLE_FIELDS, type AttestableField, type FinancialEventRecord } from "./types.js";

/**
 * Pure builders for the two projections of one root task (PRD §16): the private closure snapshot
 * and the provider-specific receipt. The service loads rows; these functions decide what is disclosed.
 */

export interface TaskRecord {
  task_id: string;
  external_ref: string;
  currency: string;
  budget_minor: number | null;
  customer_ref: string | null;
  project_ref: string | null;
  cost_center: string | null;
  scope_ref: string | null;
  retrospective: boolean;
  created_at: string;
}

export type DelegationRecord = ClosureDelegation & { root_task_id: string; shared_description: string | null };

/** Claims superseded by a later correction stay visible and gain the "superseded" label. */
export function labelClaims(claims: DeliveryClaim[]): DeliveryClaim[] {
  const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
  return claims.map((c) => (superseded.has(c.event_id) && !c.assurance.includes("superseded") ? { ...c, assurance: [...c.assurance, "superseded"] } : c));
}

/** A response as an attestation. Only a key-signed statement has a signer, so only it can revoke or be revoked. */
export function responseAttestation(response: ResponseRecord): AttestationItem {
  const s = response.statement;
  return {
    digest: response.statement_digest,
    signer: response.assurance.includes("provider_key_signed") ? response.provider_id : null,
    issued_at: s.issued_at,
    expires_at: s.expires_at,
    refs: s.refs,
  };
}

const TIME_LABELS: readonly string[] = ["expired", "revoked"];

/** Recomputes the "expired" and "revoked" labels as of `at`. Revoked and expired responses stay visible. */
export function labelResponses(responses: ResponseRecord[], at: string): ResponseRecord[] {
  const { status } = resolveAttestations(responses.map(responseAttestation), at);
  return responses.map((r) => {
    const kept = r.assurance.filter((label) => !TIME_LABELS.includes(label));
    const added: ResponseRecord["assurance"] = [];
    if (status[r.statement_digest].time === "expired") added.push("expired");
    if (status[r.statement_digest].revoked_by !== null) added.push("revoked");
    const assurance = [...kept, ...added];
    return assurance.length === r.assurance.length && assurance.every((label, i) => label === r.assurance[i]) ? r : { ...r, assurance };
  });
}

const STATUS_BY_CLAIM: Record<string, string> = {
  acceptance: "accepted",
  completion: "completed",
  partial_completion: "partially_completed",
  cancellation: "cancelled",
  provider_failure: "provider_failed",
};

/** Delivery status is the latest non-superseded status claim. It is a recorded claim, not an adjudicated truth. */
export function deliveryStatus(claims: DeliveryClaim[]): string {
  const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
  const active = claims.filter((c) => STATUS_BY_CLAIM[c.type] && !superseded.has(c.event_id));
  const latest = active.at(-1);
  return latest ? STATUS_BY_CLAIM[latest.type] : "delegated";
}

/** Totals for a single delegation's own events (no allocation detail, which may name other cost centers). */
export function receiptTotals(delegation: Pick<DelegationRecord, "delegation_id" | "currency" | "quoted_max_minor" | "accepted_amount_minor">, events: FinancialEventRecord[]): ReceiptTotals {
  const rollup = computeRollup({
    root: { task_id: "receipt_scope", currency: delegation.currency, budget_minor: null },
    delegations: [{ ...delegation, parent_delegation_id: null }],
    events,
    attribution: Object.fromEntries(events.map((e) => [e.financial_event_id, delegation.delegation_id])),
    allocations: {},
  });
  const direct = rollup.nodes.find((n) => n.node_id === delegation.delegation_id)!.direct;
  const result: ReceiptTotals = {};
  for (const [currency, { allocated: _allocated, unallocated: _unallocated, ...rest }] of Object.entries(direct)) result[currency] = rest;
  return result;
}

function openCorrectionFields(responses: ResponseRecord[]): Set<AttestableField> {
  const fields = new Set<AttestableField>();
  for (const r of responses) {
    if (r.statement.response_type !== "propose_correction") continue;
    if (r.decision?.status === "accepted") continue;
    for (const c of r.statement.corrections) fields.add(c.field);
  }
  return fields;
}

export function receiptFieldStatus(delegation: Pick<DelegationRecord, "terms_digest">, claims: DeliveryClaim[], events: FinancialEventRecord[], priorResponses: ResponseRecord[]): Record<AttestableField, FieldState> {
  const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
  const active = claims.filter((c) => !superseded.has(c.event_id) && c.type !== "correction");
  const stateOf = (claim: DeliveryClaim | undefined): FieldState => {
    if (!claim) return "missing";
    if (claim.asserted_by === "provider") return "provider_reported";
    if (claim.asserted_by === "buyer") return "buyer_asserted";
    return "imported";
  };
  const status: Record<AttestableField, FieldState> = {
    "delivery.status": stateOf(active.filter((c) => STATUS_BY_CLAIM[c.type]).at(-1)),
    "delivery.evidence": stateOf(active.filter((c) => c.evidence.length > 0).at(-1)),
    "scope.terms_digest": delegation.terms_digest ? "buyer_asserted" : "missing",
    "financial.amounts": events.some((e) => costSign(e.type) !== 0 || e.type === "quote") ? "imported" : "missing",
    "financial.status": events.some((e) => e.normalized_status !== "unknown") ? "imported" : "missing",
  };
  for (const field of openCorrectionFields(priorResponses)) status[field] = "contested";
  return status;
}

export interface ReceiptInput {
  receipt_id: string;
  revision: number;
  previous: { receipt_id: string; digest: string } | null;
  issued_at: string;
  expires_at: string | null;
  issuer: Issuer;
  delegation: DelegationRecord;
  provider: { provider_id: string; name: string; provider_own_id: string | null } | null;
  provider_key_bound: boolean;
  claims: DeliveryClaim[];
  /** Only events attributed to this delegation, including reversals of them. */
  events: FinancialEventRecord[];
  /** Current allocation version per financial event (0 = never allocated). */
  allocation_versions: Record<string, number>;
  /** Responses to earlier revisions of this receipt chain. */
  prior_responses: ResponseRecord[];
  capture_gaps: CaptureGap[];
}

/**
 * Provider receipt: one delegation only. Omits sibling delegations, root customer/project/cost-center data,
 * allocation lines, liability and economic-event IDs, and private event hashes (acceptance 8, 19).
 */
export function buildReceiptPayload(input: ReceiptInput): ReceiptPayload {
  const d = input.delegation;
  const claims = labelClaims(input.claims);
  const fieldStatus = receiptFieldStatus(d, claims, input.events, input.prior_responses);
  return {
    document_type: RECEIPT_DOCUMENT_TYPE,
    schema_version: SUBLEDGER_SCHEMA_VERSION,
    receipt_id: input.receipt_id,
    revision: input.revision,
    previous_receipt_id: input.previous?.receipt_id ?? null,
    previous_receipt_digest: input.previous?.digest ?? null,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    issuer: input.issuer,
    delegation: {
      delegation_id: d.delegation_id,
      root_task_id: d.root_task_id,
      external_ref: d.external_ref,
      provider_job_ref: d.provider_job_ref,
      shared_description: d.shared_description,
      terms_digest: d.terms_digest,
      currency: d.currency,
      quoted_max_minor: d.quoted_max_minor,
      quote_basis: d.quote_basis,
      accepted_amount_minor: d.accepted_amount_minor,
      expected_delivery: d.expected_delivery,
      retrospective: d.retrospective,
      downstream_visibility: d.downstream_visibility,
      ...(d.execution ? { execution: d.execution } : {}),
    },
    provider: {
      provider_id: input.provider?.provider_id ?? null,
      name_stated: input.provider?.name ?? d.provider_name_stated,
      provider_own_id: input.provider?.provider_own_id ?? d.provider_own_id,
      identity_binding: input.provider_key_bound ? "key_bound" : "not_bound",
    },
    delivery_claims: claims.map(({ delegation_id: _delegationId, ...claim }) => claim),
    financial_events: input.events.map(({ liability_owner: _liabilityOwner, economic_event_id: _economicEventId, fx: _fx, ...event }) => ({
      ...event,
      allocation_version: input.allocation_versions[event.financial_event_id] ?? 0,
    })),
    totals: receiptTotals(d, input.events),
    field_status: fieldStatus,
    unverified_fields: ATTESTABLE_FIELDS.filter((f) => fieldStatus[f] !== "missing"),
    corrections: input.prior_responses
      .filter((r) => r.statement.response_type === "propose_correction")
      .map((r) => ({ response_id: r.response_id, receipt_revision: r.receipt_revision, fields: r.statement.fields, decision: r.decision?.status ?? "open" })),
    lineage: { complete: input.capture_gaps.length === 0, capture_gaps: input.capture_gaps.map(({ delegation_id: _delegationId, ...gap }) => gap) },
  };
}

/** Latest allocation lines per financial event, the input the roll-up uses. */
export function latestAllocations(allocations: AllocationRecord[]): Record<string, AllocationRecord> {
  const latest: Record<string, AllocationRecord> = {};
  for (const a of allocations) if (!latest[a.financial_event_id] || latest[a.financial_event_id].version < a.version) latest[a.financial_event_id] = a;
  return latest;
}

export function rollupFor(task: TaskRecord, delegations: ClosureDelegation[], events: { record: FinancialEventRecord; attributed_to: string }[], allocations: AllocationRecord[]): Rollup {
  const latest = latestAllocations(allocations);
  return computeRollup({
    root: { task_id: task.task_id, currency: task.currency, budget_minor: task.budget_minor },
    delegations,
    events: events.map((e) => e.record),
    attribution: Object.fromEntries(events.map((e) => [e.record.financial_event_id, e.attributed_to])),
    allocations: Object.fromEntries(Object.entries(latest).map(([id, a]) => [id, a.lines])),
  });
}

export interface ClosureInput {
  closure_id: string;
  version: number;
  previous: { closure_id: string; digest: string } | null;
  generated_at: string;
  issuer: Issuer;
  task: TaskRecord;
  delegations: ClosureDelegation[];
  claims: DeliveryClaim[];
  events: { record: FinancialEventRecord; attributed_to: string }[];
  allocations: AllocationRecord[];
  open_exceptions: ExceptionRecord[];
  receipts: { receipt_id: string; delegation_id: string; revision: number; digest: string }[];
  responses: ResponseRecord[];
  key_bindings: KeyBindingRecord[];
  capture_gaps: CaptureGap[];
  obligation_links?: ObligationLink[];
}

export function closureDisclosure(input: Pick<ClosureInput, "task" | "delegations" | "claims" | "events" | "responses" | "receipts">): Disclosure {
  const missing: string[] = [];
  const unverified: string[] = [];
  const contested: string[] = [];
  const providerReported: string[] = [];
  const retrospective: string[] = [];
  if (input.task.retrospective) retrospective.push(`task:${input.task.task_id}`);
  for (const d of input.delegations) {
    if (!d.provider_id) missing.push(`delegation:${d.delegation_id}.provider`);
    if (!d.terms_digest) missing.push(`delegation:${d.delegation_id}.terms_digest`);
    if (!input.claims.some((c) => c.delegation_id === d.delegation_id && STATUS_BY_CLAIM[c.type])) missing.push(`delegation:${d.delegation_id}.delivery_status`);
    if (d.downstream_visibility === "unknown") missing.push(`delegation:${d.delegation_id}.downstream_work`);
    if (d.retrospective) retrospective.push(`delegation:${d.delegation_id}`);
  }
  for (const c of input.claims) {
    if (c.evidence.length === 0) unverified.push(`delivery_claim:${c.event_id}.evidence`);
    if (c.asserted_by === "provider") providerReported.push(`delivery_claim:${c.event_id}`);
    if (c.retrospective) retrospective.push(`delivery_claim:${c.event_id}`);
  }
  for (const { record } of input.events) {
    if (!record.evidence) unverified.push(`financial_event:${record.financial_event_id}.evidence`);
    if (record.retrospective) retrospective.push(`financial_event:${record.financial_event_id}`);
  }
  for (const r of input.responses) {
    if (r.statement.response_type === "submit_evidence") providerReported.push(`response:${r.response_id}`);
    if (r.statement.response_type === "propose_correction" && r.decision?.status !== "accepted") {
      for (const c of r.statement.corrections) contested.push(`receipt:${r.receipt_id}.${c.field}`);
    }
  }
  return { missing, unverified, contested, provider_reported: providerReported, retrospective };
}

/** Private closure snapshot of the full root task: lineage, event digests, all allocation versions, roll-up, and open exceptions. */
export function buildClosurePayload(input: ClosureInput): ClosurePayload {
  return {
    document_type: CLOSURE_DOCUMENT_TYPE,
    schema_version: SUBLEDGER_SCHEMA_VERSION,
    closure_id: input.closure_id,
    version: input.version,
    previous_closure_id: input.previous?.closure_id ?? null,
    previous_closure_digest: input.previous?.digest ?? null,
    generated_at: input.generated_at,
    issuer: input.issuer,
    task: input.task,
    delegations: input.delegations,
    delivery_claims: labelClaims(input.claims),
    financial_events: input.events.map((e) => ({ record: e.record, event_digest: digestOf(e.record), attributed_to: e.attributed_to })),
    allocations: input.allocations,
    rollup: rollupFor(input.task, input.delegations, input.events, input.allocations),
    open_exceptions: input.open_exceptions,
    receipts: input.receipts,
    responses: labelResponses(input.responses, input.generated_at),
    key_bindings: input.key_bindings,
    lineage: {
      complete: input.capture_gaps.length === 0,
      capture_gaps: input.capture_gaps,
      unknown_downstream: input.delegations.filter((d) => d.downstream_visibility === "unknown").map((d) => d.delegation_id),
    },
    disclosure: closureDisclosure(input),
    ...(input.obligation_links && input.obligation_links.length > 0 ? { obligation_links: input.obligation_links } : {}),
  };
}
