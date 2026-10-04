import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  bytesToBase64Url,
  canonicalize,
  digestOf,
  executionBinding,
  publicKeyFromPrivate,
  signPayload,
  summarizeTrace,
  traceDigest,
  utf8Encode,
  type AgentTrace,
  type ExecutionDescriptor,
  type PublicKeyRecord,
} from "@atcn/schema";
import {
  A2A_SE_REFUND_SCHEME,
  A2A_SE_RELEASE_SCHEME,
  SIGNED_BY_HOSTED_SERVICE,
  X402_EXACT_EVM_SCHEME,
  buildClosurePayload,
  closureDerivedExceptions,
  buildExpectationStatement,
  buildReceiptPayload,
  buildResponseStatement,
  buildOutcomeStatement,
  countersignPayload,
  deliveryStatus,
  eip3009Digest,
  expectationStatementOf,
  financialEventFromRailAttestation,
  signExpectation,
  signStatement,
  signOutcomeStatement,
  verifySubledgerDocument,
  type AllocationRecord,
  type ClosureDelegation,
  type ClosureInput,
  type DelegationRecord,
  type DeliveryClaim,
  type ExpectationStatementInput,
  type FinancialEventRecord,
  type Issuer,
  type KeyBindingRecord,
  type OperatorKeyRecord,
  type RailAttestation,
  type ReceiptInput,
  type ResponseRecord,
  type SignedClosure,
  type SignedReceipt,
  type StatementInput,
  type TaskRecord,
} from "../src/index.js";

// Same fixed seed as the schema vectors. Never use for real keys.
const privateKey = bytesToBase64Url(new Uint8Array(32).map((_, i) => i + 1));

const statementInputs: StatementInput[] = [
  {
    receipt: { receipt_id: "rcp_01J00000000000000000000001", digest: `sha256:${"a".repeat(64)}`, revision: 2, issuer_operator_id: "ten_01J00000000000000000000001" },
    response_type: "signed_attestation",
    fields: ["financial.amounts", "delivery.status", "delivery.status"],
  },
  {
    receipt: { receipt_id: "rcp_01J00000000000000000000002", digest: `sha256:${"b".repeat(64)}`, revision: 1, issuer_operator_id: "ten_01J00000000000000000000001" },
    response_type: "propose_correction",
    fields: [],
    note: "caf\u00e9: two of three files",
    evidence: [{ uri: "https://provider.example/delivery/7", digest: null, evidence_type: "delivery_log" }],
    corrections: [{ field: "delivery.status", proposed_value: "partial_completion", reason: "file 3 missing" }],
  },
];

const execution: ExecutionDescriptor = {
  execution_id: "run_01J00000000000000000000001",
  protocol: { name: "a2a", task_id: "task-7", context_id: "ctx-7" },
  agent: { agent_id: "agt_01J00000000000000000000002", agent_version: "2.1.0", card_digest: `sha256:${"c".repeat(64)}`, model: { provider: "example", name: "coder", version: "2026-09" } },
  skill: { namespace: "a2a", skill_id: "code-fix" },
};

statementInputs.push({
  receipt: { receipt_id: "rcp_01J00000000000000000000003", digest: `sha256:${"d".repeat(64)}`, revision: 1, issuer_operator_id: "ten_01J00000000000000000000001" },
  response_type: "signed_attestation",
  fields: ["delivery.status"],
  execution: executionBinding(execution),
  issued_at: "2026-10-01T00:00:00.000Z",
  expires_at: "2026-11-01T00:00:00.000Z",
  refs: [{ relation: "revokes", attestation_digest: `sha256:${"e".repeat(64)}`, reason: "attested the wrong run" }],
});

statementInputs.push({
  receipt: { receipt_id: "rcp_01J00000000000000000000003", digest: `sha256:${"d".repeat(64)}`, revision: 1, issuer_operator_id: "ten_01J00000000000000000000001" },
  response_type: "signed_attestation",
  fields: ["delivery.status"],
  evidence: [{ uri: "https://gateway.example/runs/run_01J00000000000000000000001", digest: `sha256:${"f".repeat(64)}`, evidence_type: "gateway_log" }],
  execution: executionBinding(execution),
  issued_at: "2026-10-01T00:00:00.000Z",
  role: "witness",
});

const expectationInputs: ExpectationStatementInput[] = [
  {
    type: "estimate",
    source: "beta-agent",
    source_event_id: "est-1",
    provider_reference: "task-7",
    amount_minor: 9_500,
    currency: "USD",
    issued_at: "2026-10-01T09:00:00Z",
    expectation: { issued_by: "agent", source_ref: null, basis: "fixed fee plus model usage at cost, caf\u00e9 rate", expires_at: null, supersedes: null },
  },
  {
    type: "hold",
    source: "cost-gateway",
    source_event_id: "hold-2",
    amount_minor: 100,
    currency: "USD",
    issued_at: "2026-10-01T09:00:00.250Z",
    expectation: { issued_by: "gateway", source_ref: "req-42", basis: "max tokens x rate", expires_at: "2026-10-01T10:00:00Z", supersedes: "hold-1", hold_status: "captured" },
  },
];

const outcomeInputs: Parameters<typeof buildOutcomeStatement>[0][] = [
  { type: "provider_failure", provider_job_ref: "a2a-task-7", occurred_at: "2026-10-01T12:05:00Z", note: "search index unavailable; caf\u00e9 refunded" },
  { type: "cancellation", provider_job_ref: "a2a-task-8", occurred_at: "2026-10-01T12:05:00.250Z" },
  {
    type: "completion",
    provider_job_ref: "a2a-task-9",
    occurred_at: "2026-10-01T12:06:00Z",
    note: "sub-task done",
    evidence: [{ uri: "https://worker.example/runs/9/report.json", digest: `sha256:${"9".repeat(64)}`, evidence_type: "test_report" }],
  },
];

const countersignedPayload = { document_type: "atcn.subledger.closure", closure_id: "cls_01J00000000000000000000001", version: 1, totals: { USD: { net_cost: 1500 } } };

// ---------- Signed closures and receipts, each with the verifier's report ----------
// Built from fixed records, keys and times with the pure builders, so regenerating gives the same bytes.

const seed = (start: number) => bytesToBase64Url(new Uint8Array(32).map((_, i) => i + start));
const serviceKey = { keyId: "key_atcn_service", keyVersion: 1, privateKey };
const gammaKey = seed(101);
const betaKey = seed(121);
const gatewayKey = seed(151);
const operatorKey = seed(201);
const payerKey = hexToBytes("11".repeat(32));

const trustedKeys: PublicKeyRecord[] = [
  { key_id: serviceKey.keyId, key_version: 1, actor_id: "svc_atcn", algorithm: "Ed25519", public_key: publicKeyFromPrivate(privateKey), valid_from: "2026-01-01T00:00:00.000Z", revoked_at: null },
];
const T0 = "2026-10-01T09:00:00.000Z";
const CLOSED_AT = "2026-10-02T00:00:00.000Z";
const issuer: Issuer = { operator_id: "ten_01J00000000000000000000001", operator_name: "Acme", signed_by: SIGNED_BY_HOSTED_SERVICE };
const operatorKeys: OperatorKeyRecord[] = [
  { operator_id: issuer.operator_id, key_id: "opk_acme", algorithm: "Ed25519", public_key: publicKeyFromPrivate(operatorKey), created_at: "2026-09-01T00:00:00.000Z", revoked_at: null },
];

function taskRecord(task_id: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return { task_id, external_ref: `job-${task_id}`, currency: "USD", budget_minor: null, customer_ref: null, project_ref: null, cost_center: null, scope_ref: null, retrospective: false, created_at: T0, ...fields };
}

function delegationRecord(delegation_id: string, fields: Partial<ClosureDelegation> = {}): ClosureDelegation {
  return {
    delegation_id,
    parent_delegation_id: null,
    depth: 1,
    provider_id: null,
    provider_name_stated: null,
    provider_own_id: null,
    external_ref: delegation_id,
    provider_job_ref: null,
    scope_ref: null,
    currency: "USD",
    quoted_max_minor: null,
    quote_basis: null,
    quote_valid_until: null,
    accepted_amount_minor: null,
    terms_digest: null,
    expected_delivery: null,
    downstream_visibility: "none",
    delivery_status: "delegated",
    retrospective: false,
    created_at: T0,
    ...fields,
  };
}

function claimRecord(event_id: string, delegation_id: string, type: DeliveryClaim["type"], fields: Partial<DeliveryClaim> = {}): DeliveryClaim {
  return { event_id, delegation_id, type, asserted_by: "buyer", assurance: ["buyer_recorded"], note: null, evidence: [], supersedes_event_id: null, reason: null, retrospective: false, occurred_at: T0, recorded_at: T0, ...fields };
}

function eventRecord(financial_event_id: string, type: FinancialEventRecord["type"], amount_minor: number, fields: Partial<FinancialEventRecord> = {}): FinancialEventRecord {
  return {
    financial_event_id,
    type,
    source: "gamma",
    source_event_id: financial_event_id,
    provider_id: null,
    provider_reference: null,
    amount_minor,
    currency: "USD",
    event_date: T0,
    imported_at: T0,
    provider_status: null,
    normalized_status: "unknown",
    evidence: null,
    retrospective: false,
    payer: "buyer",
    liability_owner: null,
    economic_event_id: null,
    included_in_event_id: null,
    reverses_event_id: null,
    settles_event_id: null,
    fx: null,
    reason: null,
    ...fields,
  };
}

function bindingRecord(binding_id: string, provider_id: string, key_id: string, key: string): KeyBindingRecord {
  return { binding_id, provider_id, key_id, public_key: publicKeyFromPrivate(key), method: "operator_configured", created_by: "usr_admin", created_at: "2026-09-01T00:00:00.000Z", revoked_at: null };
}

type ClosureParts = Pick<ClosureInput, "task" | "delegations" | "claims" | "events"> & Partial<ClosureInput>;

/**
 * Signs a closure built from fixed records; each delegation's delivery status follows from its claims, and unless the
 * parts list them, the open exceptions are the ones the records imply at close.
 */
function signedClosure(parts: ClosureParts): SignedClosure {
  const delegations = parts.delegations.map((d) => ({ ...d, delivery_status: deliveryStatus(parts.claims.filter((c) => c.delegation_id === d.delegation_id)) }));
  const payload = buildClosurePayload({
    closure_id: `cls_${parts.task.task_id}`,
    version: 1,
    previous: null,
    generated_at: CLOSED_AT,
    issuer,
    allocations: [],
    open_exceptions: [],
    receipts: [],
    responses: [],
    key_bindings: [],
    capture_gaps: [],
    ...parts,
    delegations,
  });
  const openExceptions = parts.open_exceptions ?? closureDerivedExceptions(payload).map((d, i) => ({
    exception_id: `sle_${parts.task.task_id}_${i + 1}`,
    kind: d.kind,
    status: "open" as const,
    delegation_id: d.delegation_id,
    financial_event_id: null,
    detail: d.detail,
    created_at: T0,
  }));
  return signPayload({ ...payload, open_exceptions: openExceptions }, serviceKey) as SignedClosure;
}

// A plain closure: quote, invoice, payment, a reversed charge, a task-level fee, two allocation versions, and an
// operator countersignature. Version 2 links to version 1.
const plainTask = taskRecord("tsk_plain", { budget_minor: 5_000, customer_ref: "cust-1", cost_center: "cc-research" });
const plainDelegation = delegationRecord("dlg_plain", {
  provider_id: "prv_gamma",
  provider_name_stated: "Gamma Search",
  provider_job_ref: "job-1",
  quoted_max_minor: 2_000,
  accepted_amount_minor: 1_500,
  terms_digest: digestOf({ terms: "web search, 1500 USD" }),
});
const plainInvoice = eventRecord("fev_plain_invoice", "invoice", 1_500, {
  provider_id: "prv_gamma",
  provider_reference: "inv-1",
  normalized_status: "issued",
  evidence: { uri: "https://gamma.example/invoices/1", digest: null, evidence_type: "invoice" },
});
const plainAllocation = (version: number, lines: AllocationRecord["lines"]): AllocationRecord => ({
  allocation_id: `alc_plain_${version}`,
  financial_event_id: plainInvoice.financial_event_id,
  version,
  source_event_digest: digestOf(plainInvoice),
  source_amount_minor: plainInvoice.amount_minor,
  currency: "USD",
  lines,
  rounding: { method: "none", remainder_units: [] },
  rule: null,
  reason: "research share",
  after_close: false,
  created_by: "usr_admin",
  created_at: T0,
});
const plainParts: ClosureParts = {
  task: plainTask,
  delegations: [plainDelegation],
  claims: [
    claimRecord("dev_plain_accept", "dlg_plain", "acceptance"),
    claimRecord("dev_plain_done", "dlg_plain", "completion", {
      asserted_by: "provider",
      evidence: [{ uri: "https://gamma.example/runs/1", digest: `sha256:${"1".repeat(64)}`, evidence_type: "delivery_log" }],
      occurred_at: "2026-10-01T11:00:00.000Z",
    }),
  ],
  events: [
    { record: eventRecord("fev_plain_quote", "quote", 2_000, { normalized_status: "quoted" }), attributed_to: "dlg_plain" },
    { record: plainInvoice, attributed_to: "dlg_plain" },
    { record: eventRecord("fev_plain_paid", "payment_reported", 1_500, { normalized_status: "reported_paid", settles_event_id: plainInvoice.financial_event_id }), attributed_to: "dlg_plain" },
    { record: eventRecord("fev_plain_charge", "charge", 200), attributed_to: "dlg_plain" },
    { record: eventRecord("fev_plain_reversal", "reversal", 200, { reverses_event_id: "fev_plain_charge", reason: "duplicate charge" }), attributed_to: "dlg_plain" },
    { record: eventRecord("fev_plain_fee", "fee", 50, { source: "card", event_date: "2026-10-01T10:00:00.000Z" }), attributed_to: "tsk_plain" },
  ],
  allocations: [
    plainAllocation(1, [{ target: { type: "cost_center", id: "cc-research" }, amount_minor: 1_500 }]),
    plainAllocation(2, [
      { target: { type: "cost_center", id: "cc-research" }, amount_minor: 1_000 },
      { target: { type: "unallocated", id: null }, amount_minor: 500 },
    ]),
  ],
};
const plainUnsigned = signedClosure(plainParts);
const plainClosure: SignedClosure = {
  ...plainUnsigned,
  operator_signatures: [{ key_id: "opk_acme", algorithm: "Ed25519", value: countersignPayload(plainUnsigned.payload, operatorKey), signed_at: "2026-10-02T01:00:00.000Z" }],
};
const plainClosureV2 = signedClosure({
  ...plainParts,
  closure_id: "cls_tsk_plain_v2",
  version: 2,
  previous: { closure_id: plainClosure.payload.closure_id, digest: digestOf(plainClosure.payload) },
  generated_at: "2026-10-03T00:00:00.000Z",
  events: [...plainParts.events, { record: eventRecord("fev_plain_credit", "credit", 100, { event_date: "2026-10-02T12:00:00.000Z" }), attributed_to: "dlg_plain" }],
});

// Estimates and holds: an agent estimate signed by the provider's key and replaced by a later one, an operator estimate
// on the task, a gateway-signed hold, and an estimate issued after the first charge.
function signedExpectation(record: FinancialEventRecord, signer: { provider_id: string; binding_id: string; key_id: string }, key: string): FinancialEventRecord {
  return { ...record, expectation: { ...record.expectation!, signer: { ...signer, value: signExpectation(expectationStatementOf(record), key) } } };
}
const betaSigner = { provider_id: "prv_beta", binding_id: "pkb_beta", key_id: "beta-key" };
const agentEstimate = (id: string, amount: number, eventDate: string, supersedes: string | null) =>
  signedExpectation(
    eventRecord(id, "estimate", amount, { source: "beta-agent", provider_reference: "a2a-task-21", event_date: eventDate, imported_at: eventDate, expectation: { issued_by: "agent", source_ref: null, basis: "fixed fee plus model usage", expires_at: null, supersedes } }),
    betaSigner,
    betaKey,
  );
const expectationsClosure = signedClosure({
  task: taskRecord("tsk_expect", { estimate_tolerance_bps: 500 }),
  delegations: [delegationRecord("dlg_beta", { provider_id: "prv_beta", provider_name_stated: "Beta Agent", provider_job_ref: "a2a-task-21" })],
  claims: [claimRecord("dev_beta_done", "dlg_beta", "completion", { asserted_by: "provider", occurred_at: "2026-10-01T11:00:00.000Z" })],
  events: [
    { record: agentEstimate("est-0", 9_000, "2026-10-01T08:00:00.000Z", null), attributed_to: "dlg_beta" },
    { record: agentEstimate("est-1", 9_500, "2026-10-01T08:30:00.000Z", "est-0"), attributed_to: "dlg_beta" },
    {
      record: eventRecord("est-task", "estimate", 1_000, { source: "acme-budget", event_date: "2026-10-01T08:00:00.000Z", expectation: { issued_by: "operator", source_ref: "budget-7", basis: "planning figure", expires_at: null, supersedes: null } }),
      attributed_to: "tsk_expect",
    },
    {
      record: signedExpectation(
        eventRecord("hold-1", "hold", 10_000, {
          source: "cost-gateway",
          event_date: "2026-10-01T08:45:00.000Z",
          imported_at: "2026-10-01T08:45:00.000Z",
          expectation: { issued_by: "gateway", source_ref: "req-42", basis: "max tokens x rate", expires_at: "2026-10-01T12:00:00.000Z", supersedes: null, hold_status: "open" },
        }),
        { provider_id: "prv_gateway", binding_id: "pkb_gateway", key_id: "gateway-key" },
        gatewayKey,
      ),
      attributed_to: "dlg_beta",
    },
    { record: eventRecord("fev_beta_charge", "charge", 9_800, { source: "beta-agent", event_date: "2026-10-01T09:30:00.000Z", imported_at: "2026-10-01T09:30:00.000Z" }), attributed_to: "dlg_beta" },
    { record: agentEstimate("est-late", 9_900, "2026-10-01T10:00:00.000Z", null), attributed_to: "dlg_beta" },
  ],
  key_bindings: [bindingRecord("pkb_beta", "prv_beta", "beta-key", betaKey), bindingRecord("pkb_gateway", "prv_gateway", "gateway-key", gatewayKey)],
});

// Provider-signed outcome claim, pricing with recorded usage from a trace, and key-signed provider responses that
// equivocate on one field and revoke an earlier statement.
const gammaRun: ExecutionDescriptor = {
  execution_id: "a2a:a2a-task-7",
  protocol: { name: "a2a", task_id: "a2a-task-7" },
  agent: { agent_id: "gamma", agent_version: "1.0.0", model: { provider: "example", name: "coder", version: "2026-09" } },
};
const gammaTrace: AgentTrace = {
  trace_version: "1.0",
  execution: executionBinding(gammaRun),
  steps: [
    { seq: 0, kind: "model_call", started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T10:00:05.000Z", model: { provider: "example", name: "coder" }, usage: { input_tokens: 1_000, output_tokens: 500 } },
    { seq: 1, kind: "tool_call", started_at: "2026-10-01T10:00:06.000Z", ended_at: "2026-10-01T10:00:07.000Z", tool: { name: "search" } },
  ],
};
const failure = buildOutcomeStatement({ type: "provider_failure", provider_job_ref: "a2a-task-8", occurred_at: "2026-10-01T12:05:00Z", note: "search index unavailable" });
const outcomeReceipt = { receipt_id: "rcp_outcome_1", digest: digestOf({ receipt: "rcp_outcome_1" }), revision: 1, issuer_operator_id: issuer.operator_id };
function gammaResponse(response_id: string, input: Omit<StatementInput, "receipt">, created_at: string): ResponseRecord {
  const statement = buildResponseStatement({ receipt: outcomeReceipt, ...input });
  return {
    response_id,
    receipt_id: outcomeReceipt.receipt_id,
    receipt_revision: 1,
    provider_id: "prv_gamma",
    statement,
    statement_digest: digestOf(statement),
    provider_signature: { key_id: "gamma-key", binding_id: "pkb_gamma", value: signStatement(statement, gammaKey) },
    assurance: ["link_authenticated_response", "provider_key_signed"],
    decision: null,
    created_at,
  };
}
const attestsAmounts = gammaResponse("rsp_3", { response_type: "signed_attestation", fields: ["financial.amounts"], issued_at: "2026-10-01T14:00:00.000Z", expires_at: "2026-12-01T00:00:00.000Z" }, "2026-10-01T14:00:00.000Z");
const outcomeClosure = signedClosure({
  task: taskRecord("tsk_outcome"),
  delegations: [
    delegationRecord("dlg_usage", {
      provider_id: "prv_gamma",
      provider_name_stated: "Gamma Search",
      provider_job_ref: "a2a-task-7",
      execution: gammaRun,
      pricing: {
        rates: [
          { meter: "input_tokens", model: { provider: "example", name: "coder" }, price_numerator: 1, price_denominator: 100 },
          { meter: "output_tokens", price_numerator: 4, price_denominator: 100 },
          { meter: "tool_call", tool_name: "search", price_numerator: 5, price_denominator: 1 },
        ],
        fixed_minor: 100,
        tolerance_bps: 500,
      },
    }),
    delegationRecord("dlg_failed", { provider_id: "prv_gamma", provider_name_stated: "Gamma Search", provider_job_ref: "a2a-task-8" }),
  ],
  claims: [
    claimRecord("dev_usage_done", "dlg_usage", "completion", { usage: { trace_digest: traceDigest(gammaTrace), summary: summarizeTrace(gammaTrace) }, occurred_at: "2026-10-01T10:01:00.000Z" }),
    claimRecord("dev_failed", "dlg_failed", "provider_failure", {
      asserted_by: "provider",
      assurance: ["provider_key_signed"],
      note: failure.note,
      occurred_at: failure.occurred_at,
      signer: { provider_id: "prv_gamma", binding_id: "pkb_gamma", key_id: "gamma-key", value: signOutcomeStatement(failure, gammaKey) },
    }),
  ],
  events: [
    { record: eventRecord("fev_usage_charge", "charge", 140), attributed_to: "dlg_usage" },
    { record: eventRecord("fev_failed_charge", "charge", 500), attributed_to: "dlg_failed" },
    { record: eventRecord("fev_failed_refund", "refund", 500, { event_date: "2026-10-01T12:10:00.000Z" }), attributed_to: "dlg_failed" },
  ],
  receipts: [{ receipt_id: outcomeReceipt.receipt_id, delegation_id: "dlg_usage", revision: 1, digest: outcomeReceipt.digest }],
  responses: [
    gammaResponse("rsp_1", { response_type: "signed_attestation", fields: ["delivery.usage", "delivery.status"], execution: executionBinding(gammaRun), issued_at: "2026-10-01T13:00:00.000Z" }, "2026-10-01T13:00:00.000Z"),
    gammaResponse(
      "rsp_2",
      { response_type: "propose_correction", fields: [], corrections: [{ field: "delivery.status", proposed_value: "partial_completion", reason: "one result page missing" }], issued_at: "2026-10-01T13:30:00.000Z" },
      "2026-10-01T13:30:00.000Z",
    ),
    attestsAmounts,
    gammaResponse(
      "rsp_4",
      { response_type: "signed_attestation", fields: ["financial.status"], issued_at: "2026-10-01T14:30:00.000Z", refs: [{ relation: "revokes", attestation_digest: attestsAmounts.statement_digest, reason: "attested the wrong amount" }] },
      "2026-10-01T14:30:00.000Z",
    ),
  ],
  key_bindings: [bindingRecord("pkb_gamma", "prv_gamma", "gamma-key", gammaKey)],
});

// Rail attestations: an A2A-SE escrow release and refund (records from the reference implementation), and an x402
// exact-evm payment signed by a fixed payer key.
const a2aSe = JSON.parse(readFileSync(new URL("../test/fixtures/a2a-se-attestations.json", import.meta.url), "utf8"));
function railEvent(financial_event_id: string, body: Record<string, unknown>): FinancialEventRecord {
  return eventRecord(financial_event_id, body.type as FinancialEventRecord["type"], body.amount_minor as number, {
    source: body.source as string,
    source_event_id: body.source_event_id as string,
    provider_reference: body.provider_reference as string,
    currency: body.currency as string,
    event_date: body.event_date as string,
    normalized_status: body.normalized_status as FinancialEventRecord["normalized_status"],
    rail_attestation: body.rail_attestation as RailAttestation,
  });
}
const a2aSeClosure = signedClosure({
  task: taskRecord("tsk_a2a_se"),
  delegations: [delegationRecord("dlg_search", { provider_job_ref: "a2a-task-7" }), delegationRecord("dlg_retry", { provider_job_ref: "a2a-task-8" })],
  claims: [],
  events: [
    { record: eventRecord("fev_search_charge", "charge", 1_200, { event_date: "2026-10-01T11:00:00.000Z" }), attributed_to: "dlg_search" },
    { record: railEvent("fev_search_paid", financialEventFromRailAttestation({ scheme: A2A_SE_RELEASE_SCHEME, record: a2aSe.release }, { source: "a2a-se" })), attributed_to: "dlg_search" },
    { record: railEvent("fev_retry_refund", financialEventFromRailAttestation({ scheme: A2A_SE_REFUND_SCHEME, record: a2aSe.refund }, { source: "a2a-se" })), attributed_to: "dlg_retry" },
  ],
});

const payer = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(payerKey, false).slice(1)).slice(-20))}`;
const x402Requirements = { scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "1200000", payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", extra: { name: "USDC", version: "2" } };
const x402Authorization = { from: payer, to: x402Requirements.payTo, value: "1200000", validAfter: "0", validBefore: "1893456000", nonce: `0x${"ab".repeat(32)}` };
const x402Signature = secp256k1.sign(eip3009Digest(x402Authorization, { name: "USDC", version: "2", chainId: 84532n, verifyingContract: x402Requirements.asset }), payerKey);
const x402Attestation: RailAttestation = {
  scheme: X402_EXACT_EVM_SCHEME,
  record: {
    requirements: x402Requirements,
    payload: { signature: `0x${bytesToHex(x402Signature.toCompactRawBytes())}${(27 + x402Signature.recovery).toString(16)}`, authorization: x402Authorization },
    settlement: { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:84532", payer },
  },
};
const x402Closure = signedClosure({
  task: taskRecord("tsk_x402"),
  delegations: [delegationRecord("dlg_paid", { provider_job_ref: x402Authorization.nonce })],
  claims: [],
  events: [
    { record: eventRecord("fev_paid_charge", "charge", 120), attributed_to: "dlg_paid" },
    { record: railEvent("fev_paid_x402", financialEventFromRailAttestation(x402Attestation, { source: "x402:eip155:84532", eventDate: "2026-10-01T12:00:00Z" })), attributed_to: "dlg_paid" },
  ],
});

// Incomplete lineage: a sub-task reported by the provider arrived with no outcome (a broken edge).
const gapClosure = signedClosure({
  task: taskRecord("tsk_gap"),
  delegations: [
    delegationRecord("dlg_alpha", { provider_id: "prv_alpha", provider_name_stated: "Alpha Research", provider_job_ref: "a2a-task-30", downstream_visibility: "disclosed" }),
    delegationRecord("dlg_delta", { parent_delegation_id: "dlg_alpha", depth: 2, provider_name_stated: "Delta Worker", provider_job_ref: "a2a-task-31", downstream_visibility: "unknown" }),
  ],
  claims: [claimRecord("dev_alpha_done", "dlg_alpha", "completion", { asserted_by: "provider" })],
  events: [
    { record: eventRecord("fev_alpha_charge", "charge", 300), attributed_to: "dlg_alpha" },
    { record: eventRecord("fev_delta_cost", "charge", 100, { payer: "provider", included_in_event_id: "fev_alpha_charge" }), attributed_to: "dlg_delta" },
  ],
  capture_gaps: [{ gap_id: "gap_delta", delegation_id: "dlg_delta", kind: "broken_edge", detail: "Delta Worker task a2a-task-31 reported no outcome", reported_at: T0 }],
});

// A provider receipt and its second revision, which carries an open correction from the provider's receipt link.
const receiptDelegation: DelegationRecord = {
  ...delegationRecord("dlg_receipt", {
    provider_id: "prv_gamma",
    provider_name_stated: "Gamma Search",
    provider_job_ref: "job-9",
    accepted_amount_minor: 900,
    terms_digest: digestOf({ terms: "search, 900 USD" }),
    execution: gammaRun,
  }),
  root_task_id: "tsk_receipt",
  shared_description: "web search for the quarterly report",
};
function receiptInput(revision: number, previous: ReceiptInput["previous"], priorResponses: ResponseRecord[]): ReceiptInput {
  return {
    receipt_id: revision === 1 ? "rcp_receipt_1" : `rcp_receipt_1_r${revision}`,
    revision,
    previous,
    issued_at: `2026-10-0${revision + 1}T00:00:00.000Z`,
    expires_at: "2026-12-01T00:00:00.000Z",
    issuer,
    delegation: receiptDelegation,
    provider: { provider_id: "prv_gamma", name: "Gamma Search", provider_own_id: "gamma" },
    provider_key_bound: true,
    claims: [
      claimRecord("dev_receipt_accept", "dlg_receipt", "acceptance"),
      claimRecord("dev_receipt_done", "dlg_receipt", "completion", { asserted_by: "provider", usage: { trace_digest: traceDigest(gammaTrace), summary: summarizeTrace(gammaTrace) } }),
    ],
    events: [
      eventRecord("fev_receipt_invoice", "invoice", 900, { normalized_status: "issued" }),
      eventRecord("fev_receipt_paid", "payment_reported", 900, { normalized_status: "reported_paid" }),
      eventRecord("fev_receipt_refund", "refund", 100, { event_date: "2026-10-01T15:00:00.000Z" }),
    ],
    allocation_versions: { fev_receipt_invoice: 1 },
    prior_responses: priorResponses,
    capture_gaps: [],
    key_bindings: [],
  };
}
const signedReceipt = (input: ReceiptInput) => signPayload(buildReceiptPayload(input), serviceKey) as SignedReceipt;
const receipt = signedReceipt(receiptInput(1, null, []));
const correctionStatement = buildResponseStatement({
  receipt: { receipt_id: receipt.payload.receipt_id, digest: digestOf(receipt.payload), revision: 1, issuer_operator_id: issuer.operator_id },
  response_type: "propose_correction",
  fields: ["financial.amounts"],
  corrections: [{ field: "financial.amounts", proposed_value: "800", reason: "the refund was 200" }],
});
const receiptV2 = signedReceipt(
  receiptInput(2, { receipt_id: receipt.payload.receipt_id, digest: digestOf(receipt.payload) }, [
    {
      response_id: "rsp_receipt_1",
      receipt_id: receipt.payload.receipt_id,
      receipt_revision: 1,
      provider_id: "prv_gamma",
      statement: correctionStatement,
      statement_digest: digestOf(correctionStatement),
      provider_signature: null,
      assurance: ["link_authenticated_response"],
      decision: null,
      created_at: "2026-10-02T12:00:00.000Z",
    },
  ]),
);

// A receipt with a provider-signed failure claim and an estimate signed by the same provider. Only the binding the
// signers name is listed; the beta binding the issuer also knows is left out.
const gammaSigner = { provider_id: "prv_gamma", binding_id: "pkb_gamma", key_id: "gamma-key" };
const signedRecordsReceipt = signedReceipt({
  ...receiptInput(1, null, []),
  receipt_id: "rcp_failed_1",
  delegation: { ...delegationRecord("dlg_failed", { provider_id: "prv_gamma", provider_name_stated: "Gamma Search", provider_job_ref: "a2a-task-8" }), root_task_id: "tsk_outcome", shared_description: null },
  claims: [
    claimRecord("dev_failed", "dlg_failed", "provider_failure", {
      asserted_by: "provider",
      assurance: ["provider_key_signed"],
      note: failure.note,
      occurred_at: failure.occurred_at,
      signer: { ...gammaSigner, value: signOutcomeStatement(failure, gammaKey) },
    }),
  ],
  events: [
    signedExpectation(
      eventRecord("est-gamma", "estimate", 600, { source: "gamma-agent", provider_reference: "a2a-task-8", event_date: "2026-10-01T09:00:00.000Z", expectation: { issued_by: "agent", source_ref: null, basis: "flat fee", expires_at: null, supersedes: null } }),
      gammaSigner,
      gammaKey,
    ),
    eventRecord("fev_failed_charge", "charge", 500),
  ],
  allocation_versions: {},
  key_bindings: [bindingRecord("pkb_gamma", "prv_gamma", "gamma-key", gammaKey), bindingRecord("pkb_beta", "prv_beta", "beta-key", betaKey)],
});

interface DocumentOptions {
  at?: string;
  previous?: unknown;
  operator_keys?: OperatorKeyRecord[];
  require_operator_signature?: boolean;
  /** Trace files as UTF-8 text. */
  traces?: string[];
}

/** Copies a document and changes it after signing. */
function tampered<T>(document: T, change: (copy: any) => void): T {
  const copy = structuredClone(document);
  change(copy);
  return copy;
}

// A closure whose records raise most derived exception kinds, so every verifier recomputes the same details: over
// budget; an expired quote never accepted, billed above its quote for another skill; and a failed delegation still
// billed, whose refund terms required a refund that came late and short.
const exceptionsClosure = signedClosure({
  task: taskRecord("tsk_exceptions", { budget_minor: 200 }),
  delegations: [
    delegationRecord("dlg_skill", {
      quoted_max_minor: 100,
      quote_valid_until: "2026-10-01T08:00:00.000Z",
      execution: { execution_id: "run_skill", agent: { agent_id: "agt_skill", agent_version: "1.0.0" }, skill: { namespace: "a2a", skill_id: "search" } },
    }),
    delegationRecord("dlg_refund", { refund_terms: { on_failure: "refund", on_timeout: "dispute", after_settlement: { cap_minor: 500, window_seconds: 3_600 } } }),
  ],
  claims: [claimRecord("dev_refund_failed", "dlg_refund", "provider_failure", { occurred_at: "2026-10-01T10:00:00.000Z" })],
  events: [
    { record: eventRecord("fev_skill_charge", "charge", 300, { skill: { namespace: "a2a", skill_id: "translate" } }), attributed_to: "dlg_skill" },
    { record: eventRecord("fev_refund_charge", "charge", 500), attributed_to: "dlg_refund" },
    { record: eventRecord("fev_refund_paid", "payment_reported", 500, { normalized_status: "reported_paid" }), attributed_to: "dlg_refund" },
    { record: eventRecord("fev_refund_late", "refund", 100, { event_date: "2026-10-01T20:00:00.000Z" }), attributed_to: "dlg_refund" },
  ],
});

// The same closure after a person dismissed the open hold exception: it moves from open_exceptions to resolved_exceptions.
const heldException = expectationsClosure.payload.open_exceptions.find((x) => x.kind === "hold_not_released")!;
const resolvedClosure = signPayload(
  {
    ...expectationsClosure.payload,
    open_exceptions: expectationsClosure.payload.open_exceptions.filter((x) => x !== heldException),
    resolved_exceptions: [{ ...heldException, status: "dismissed", resolved_by: "usr_admin", resolved_at: CLOSED_AT, resolution: "provider confirmed the hold was released" }],
  },
  serviceKey,
) as SignedClosure;
const staleException = { exception_id: "sle_stale", kind: "missing_receipt", status: "open" as const, delegation_id: "dlg_beta", financial_event_id: null, detail: "billed 9800 USD with no completion receipt recorded", created_at: T0 };

const RECEIPT_AT = "2026-10-15T00:00:00.000Z";
const documentCases: { name: string; document: unknown; options: DocumentOptions }[] = [
  { name: "plain closure, countersigned", document: plainClosure, options: { operator_keys: operatorKeys, require_operator_signature: true } },
  { name: "plain closure, operator keys not supplied", document: plainClosure, options: { require_operator_signature: true } },
  {
    name: "plain closure, unknown fields are dropped before checking",
    document: tampered(plainClosure, (d) => {
      d.payload.internal_note = "not signed";
      d.payload.delegations[0].internal_note = "not signed";
    }),
    options: {},
  },
  { name: "plain closure, invoice amount changed", document: tampered(plainClosure, (d) => (d.payload.financial_events[1].record.amount_minor = 1_000)), options: { operator_keys: operatorKeys } },
  { name: "plain closure, roll-up changed", document: tampered(plainClosure, (d) => (d.payload.rollup.root_total.USD.net_cost = 1)), options: {} },
  { name: "plain closure version 2 with its previous version", document: plainClosureV2, options: { previous: plainClosure } },
  { name: "plain closure version 2 without its previous version", document: plainClosureV2, options: {} },
  { name: "plain closure version 2 with the wrong previous version", document: plainClosureV2, options: { previous: expectationsClosure } },
  { name: "estimates and holds", document: expectationsClosure, options: {} },
  { name: "estimates and holds, signed estimate amount changed", document: tampered(expectationsClosure, (d) => (d.payload.financial_events[1].record.amount_minor = 5_000)), options: {} },
  { name: "estimates and holds, expectation report changed", document: tampered(expectationsClosure, (d) => (d.payload.expectation_report.task.actual_minor += 1)), options: {} },
  { name: "estimates and holds, declared as schema 1.4 and re-signed", document: signPayload({ ...expectationsClosure.payload, schema_version: "1.4" }, serviceKey), options: {} },
  { name: "estimates and holds, an open exception omitted and re-signed", document: signPayload({ ...expectationsClosure.payload, open_exceptions: expectationsClosure.payload.open_exceptions.filter((x) => x !== heldException) }, serviceKey), options: {} },
  { name: "estimates and holds, an exception listed open whose condition does not hold, re-signed", document: signPayload({ ...expectationsClosure.payload, open_exceptions: [...expectationsClosure.payload.open_exceptions, staleException] }, serviceKey), options: {} },
  { name: "estimates and holds, hold exception dismissed by a person", document: resolvedClosure, options: {} },
  { name: "derived exceptions of most kinds", document: exceptionsClosure, options: {} },
  { name: "estimates and holds, resolution changed", document: tampered(resolvedClosure, (d) => (d.payload.resolved_exceptions[0].resolution = "never mind")), options: {} },
  {
    name: "estimates and holds, dismissal attributed to the system and re-signed",
    document: signPayload({ ...resolvedClosure.payload, resolved_exceptions: resolvedClosure.payload.resolved_exceptions!.map((x) => ({ ...x, resolved_by: "system" })) }, serviceKey),
    options: {},
  },
  { name: "signed outcome, usage and provider responses, with the trace", document: outcomeClosure, options: { traces: [JSON.stringify(gammaTrace, null, 2)] } },
  { name: "signed outcome, usage and provider responses, without the trace", document: outcomeClosure, options: {} },
  { name: "signed outcome, an unrelated trace", document: outcomeClosure, options: { traces: [JSON.stringify({ ...gammaTrace, steps: gammaTrace.steps.slice(0, 1) })] } },
  { name: "signed outcome, a malformed trace file", document: outcomeClosure, options: { traces: ["not json", JSON.stringify({ ...gammaTrace, trace_version: "2.0" })] } },
  { name: "signed outcome, claim note changed", document: tampered(outcomeClosure, (d) => (d.payload.delivery_claims[1].note = "completed")), options: {} },
  { name: "signed outcome, revoked label removed", document: tampered(outcomeClosure, (d) => (d.payload.responses[2].assurance = ["link_authenticated_response", "provider_key_signed"])), options: {} },
  { name: "A2A-SE escrow release and refund", document: a2aSeClosure, options: {} },
  { name: "A2A-SE release amount changed", document: tampered(a2aSeClosure, (d) => (d.payload.financial_events[1].record.rail_attestation.record.payload.amount_paid = 1)), options: {} },
  { name: "x402 exact-evm payment", document: x402Closure, options: {} },
  { name: "x402 authorization validBefore changed", document: tampered(x402Closure, (d) => (d.payload.financial_events[1].record.rail_attestation.record.payload.authorization.validBefore = "1893456001")), options: {} },
  { name: "broken edge capture gap", document: gapClosure, options: {} },
  { name: "broken edge capture gap, lineage marked complete", document: tampered(gapClosure, (d) => (d.payload.lineage.complete = true)), options: {} },
  { name: "receipt", document: receipt, options: { at: RECEIPT_AT } },
  { name: "receipt, past its expiry", document: receipt, options: { at: "2027-01-01T00:00:00.000Z" } },
  { name: "receipt, totals changed", document: tampered(receipt, (d) => (d.payload.totals.USD.net_cost = 900)), options: { at: RECEIPT_AT } },
  { name: "receipt revision 2 with its previous revision", document: receiptV2, options: { at: RECEIPT_AT, previous: receipt } },
  { name: "receipt with a signed outcome and a signed estimate", document: signedRecordsReceipt, options: { at: RECEIPT_AT } },
  { name: "receipt with signed records, claim note changed", document: tampered(signedRecordsReceipt, (d) => (d.payload.delivery_claims[0].note = "index back up")), options: { at: RECEIPT_AT } },
  {
    name: "receipt with signed records, key bindings dropped and re-signed",
    document: signPayload({ ...signedRecordsReceipt.payload, key_bindings: undefined }, serviceKey),
    options: { at: RECEIPT_AT },
  },
  {
    name: "receipt with signed records, an extra key binding listed and re-signed",
    document: signPayload({ ...signedRecordsReceipt.payload, key_bindings: [...signedRecordsReceipt.payload.key_bindings!, bindingRecord("pkb_beta", "prv_beta", "beta-key", betaKey)] }, serviceKey),
    options: { at: RECEIPT_AT },
  },
  { name: "receipt with signed records, declared as schema 1.4 and re-signed", document: signPayload({ ...signedRecordsReceipt.payload, schema_version: "1.4" }, serviceKey), options: { at: RECEIPT_AT } },
  { name: "receipt revision 2, unverified fields changed", document: tampered(receiptV2, (d) => (d.payload.unverified_fields = ["delivery.status"])), options: { at: RECEIPT_AT, previous: receipt } },
  { name: "unsupported schema version", document: tampered(plainClosure, (d) => (d.payload.schema_version = "9.9")), options: {} },
  { name: "unknown document type", document: { payload: { document_type: "atcn.subledger.invoice" } }, options: {} },
  {
    name: "closure that does not match the schema",
    document: tampered(plainClosure, (d) => {
      delete d.payload.closure_id;
      d.payload.task.currency = "usd";
      d.payload.delegations[0].depth = "1";
    }),
    options: {},
  },
];

const documents = {
  description:
    "Signed subledger closures and receipts with the TypeScript verifier's report for each (verifySubledgerDocument). Options are snake_case; traces are UTF-8 trace files. Every SDK's offline verifier must give the same report.",
  trusted_keys: trustedKeys,
  cases: documentCases.map(({ name, document, options }) => ({
    name,
    document,
    options,
    report: verifySubledgerDocument(document, {
      trustedKeys,
      at: options.at,
      previous: options.previous,
      operatorKeys: options.operator_keys,
      requireOperatorSignature: options.require_operator_signature,
      traces: options.traces?.map(utf8Encode),
    }),
  })),
};

const vectors = {
  description: "Subledger response statements, estimate and hold statements, provider-signed outcome statements, and operator countersignatures. Every SDK must reproduce statement, canonical, digest, and signature exactly.",
  private_key: privateKey,
  public_key: publicKeyFromPrivate(privateKey),
  statements: statementInputs.map((input) => {
    const statement = buildResponseStatement(input);
    return { input, statement, canonical: canonicalize(statement), digest: digestOf(statement), signature: signStatement(statement, privateKey) };
  }),
  expectations: expectationInputs.map((input) => {
    const statement = buildExpectationStatement(input);
    return { input, statement, canonical: canonicalize(statement), signature: signExpectation(statement, privateKey) };
  }),
  outcome_statements: outcomeInputs.map((input) => {
    const statement = buildOutcomeStatement(input);
    return { input, statement, canonical: canonicalize(statement), signature: signOutcomeStatement(statement, privateKey) };
  }),
  countersignature: { payload: countersignedPayload, signature: countersignPayload(countersignedPayload, privateKey) },
  execution_binding: { descriptor: execution, binding: executionBinding(execution) },
  documents,
};

const dir = fileURLToPath(new URL("../test-vectors/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}vectors.json`, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${dir}vectors.json`);
