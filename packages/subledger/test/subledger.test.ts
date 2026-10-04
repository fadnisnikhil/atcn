import { describe, expect, it } from "vitest";
import {
  allowedDifference,
  digestOf,
  executionBinding,
  expectedCostFromUsage,
  generateKeyPair,
  signPayload,
  summarizeTrace,
  traceDigest,
  utf8Encode,
  type AgentTrace,
  type ExecutionDescriptor,
  type Pricing,
  type PublicKeyRecord,
  type RefundTerms,
} from "@atcn/schema";
import {
  buildClosurePayload,
  closureDerivedExceptions,
  buildReceiptPayload,
  buildResponseStatement,
  completeManualAllocation,
  computeRollup,
  convertNetCost,
  countersignPayload,
  delegationEventProblems,
  deliveryStatus,
  deriveTaskExceptions,
  FinancialEventInputSchema,
  rollupFor,
  signStatement,
  splitByWeights,
  SUBLEDGER_SCHEMA_VERSION,
  SUBLEDGER_VERIFIER_VERSION,
  verifySubledgerDocument,
  type AllocationRecord,
  type ClosureDelegation,
  type DelegationRecord,
  type DeliveryClaim,
  type FinancialEventRecord,
  type Issuer,
  type KeyBindingRecord,
  type ResponseRecord,
  type TaskRecord,
} from "../src/index.js";
import subledgerPackage from "../package.json";
import vectors from "../test-vectors/vectors.json";
import traceVectors from "../../sdk-ts/test-vectors/traces.json";

const T0 = "2026-10-01T00:00:00.000Z";

/** Lists the derived exceptions a closure's records imply at close as open, as a service does when it closes a task. */
function withDerivedExceptions(payload: ReturnType<typeof buildClosurePayload>): ReturnType<typeof buildClosurePayload> {
  const openExceptions = closureDerivedExceptions(payload).map((d, i) => ({
    exception_id: `sle_${i + 1}`,
    kind: d.kind,
    status: "open" as const,
    delegation_id: d.delegation_id,
    financial_event_id: null,
    detail: d.detail,
    created_at: T0,
  }));
  return { ...payload, open_exceptions: openExceptions };
}
const issuer: Issuer = { operator_id: "tnt_op", operator_name: "Operator", signed_by: "atcn-hosted-service" };
const serviceKeys = generateKeyPair();
const signingKey = { keyId: "key_atcn_service", keyVersion: 1, privateKey: serviceKeys.privateKey };
const trustedKeys: PublicKeyRecord[] = [
  { key_id: "key_atcn_service", key_version: 1, actor_id: "svc_atcn", algorithm: "Ed25519", public_key: serviceKeys.publicKey, valid_from: "2026-01-01T00:00:00.000Z", revoked_at: null },
];

/** A copy of a current document's payload without the 1.5 delivery.usage field status, for re-signing as an older version. */
function withoutUsageField<T extends object>(payload: T): T {
  const copy = structuredClone(payload) as T & { field_status?: Record<string, unknown> };
  if (copy.field_status) delete copy.field_status["delivery.usage"];
  return copy;
}

function event(id: string, type: FinancialEventRecord["type"], amount: number, extra: Partial<FinancialEventRecord> = {}): FinancialEventRecord {
  return {
    financial_event_id: id,
    type,
    source: "test",
    source_event_id: id,
    provider_id: null,
    provider_reference: null,
    amount_minor: amount,
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
    ...extra,
  };
}

function delegation(id: string, parent: string | null, depth: number, extra: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    delegation_id: id,
    root_task_id: "tsk_root",
    parent_delegation_id: parent,
    depth,
    provider_id: `prv_${id}`,
    provider_name_stated: `Provider ${id}`,
    provider_own_id: null,
    external_ref: `ext_${id}`,
    provider_job_ref: null,
    scope_ref: null,
    shared_description: null,
    currency: "USD",
    quoted_max_minor: null,
    quote_basis: null,
    quote_valid_until: null,
    accepted_amount_minor: null,
    terms_digest: null,
    expected_delivery: null,
    downstream_visibility: "unknown",
    delivery_status: "delegated",
    retrospective: false,
    created_at: T0,
    ...extra,
  };
}

const task: TaskRecord = {
  task_id: "tsk_root",
  external_ref: "job-1",
  currency: "USD",
  budget_minor: 1000,
  customer_ref: "cust-secret",
  project_ref: null,
  cost_center: "cc-1",
  scope_ref: null,
  retrospective: false,
  created_at: T0,
};

describe("allocation", () => {
  it("splits by weights with deterministic largest-remainder rounding", () => {
    const result = splitByWeights(100, [
      { target: { type: "cost_center", id: "a" }, weight_bps: 3333 },
      { target: { type: "cost_center", id: "b" }, weight_bps: 3333 },
      { target: { type: "cost_center", id: "c" }, weight_bps: 3334 },
    ]);
    expect(result.lines.map((l) => l.amount_minor)).toEqual([33, 33, 34]);
    expect(result.lines.reduce((s, l) => s + l.amount_minor, 0)).toBe(100);
    const odd = splitByWeights(10, [
      { target: { type: "task", id: "x" }, weight_bps: 5000 },
      { target: { type: "task", id: "y" }, weight_bps: 5000 },
    ]);
    expect(odd.lines.map((l) => l.amount_minor)).toEqual([5, 5]);
    const uneven = splitByWeights(1, [
      { target: { type: "task", id: "x" }, weight_bps: 5000 },
      { target: { type: "task", id: "y" }, weight_bps: 5000 },
    ]);
    expect(uneven.lines.map((l) => l.amount_minor)).toEqual([1, 0]);
    expect(uneven.rounding.remainder_units).toEqual([{ line_index: 0, units: 1 }]);
  });

  it("rejects over-allocation and makes any shortfall visible as unallocated (acceptance 4)", () => {
    expect(() => completeManualAllocation(100, [{ target: { type: "task", id: "t" }, amount_minor: 101 }])).toThrow(/more than the source/);
    const result = completeManualAllocation(100, [{ target: { type: "cost_center", id: "cc" }, amount_minor: 60 }]);
    expect(result.lines).toEqual([
      { target: { type: "cost_center", id: "cc" }, amount_minor: 60 },
      { target: { type: "unallocated", id: null }, amount_minor: 40 },
    ]);
  });
});

describe("roll-up", () => {
  it("counts each event once and separates direct from descendant cost (acceptance 1)", () => {
    const delegations = [delegation("dlg_a", null, 1), delegation("dlg_b", null, 1), delegation("dlg_c", "dlg_a", 2)];
    const events = [event("fev_1", "charge", 100), event("fev_2", "invoice", 200), event("fev_3", "charge", 50), event("fev_4", "refund", 20)];
    const rollup = computeRollup({
      root: task,
      delegations,
      events,
      attribution: { fev_1: "dlg_a", fev_2: "dlg_b", fev_3: "dlg_c", fev_4: "dlg_c" },
      allocations: {},
    });
    const a = rollup.nodes.find((n) => n.node_id === "dlg_a")!;
    expect(a.direct.USD.net_cost).toBe(100);
    expect(a.descendant.USD.net_cost).toBe(30);
    expect(a.total.USD.net_cost).toBe(130);
    expect(rollup.root_total.USD.net_cost).toBe(330);
    expect(rollup.root_total.USD.refunded).toBe(20);
    expect(rollup.nodes.find((n) => n.node_id === "dlg_c")!.event_ids).toEqual(["fev_3", "fev_4"]);
  });

  it("does not add an invoice included in a parent fee to buyer expense (acceptance 25)", () => {
    const delegations = [delegation("dlg_a", null, 1), delegation("dlg_c", "dlg_a", 2)];
    const events = [event("fev_parent", "invoice", 500), event("fev_child", "invoice", 200, { payer: "provider", included_in_event_id: "fev_parent" })];
    const rollup = computeRollup({ root: task, delegations, events, attribution: { fev_parent: "dlg_a", fev_child: "dlg_c" }, allocations: {} });
    expect(rollup.root_total.USD.net_cost).toBe(500);
    expect(rollup.root_total.USD.downstream_reported).toBe(200);
  });

  it("excludes reversed events and keeps currencies separate without a rate (acceptance 5)", () => {
    const delegations = [delegation("dlg_a", null, 1)];
    const events = [
      event("fev_usd", "charge", 1000),
      event("fev_inr", "charge", 83000, { currency: "INR" }),
      event("fev_bad", "charge", 999),
      event("fev_rev", "reversal", 999, { reverses_event_id: "fev_bad", reason: "duplicate" }),
    ];
    const rollup = computeRollup({ root: task, delegations, events, attribution: { fev_usd: "dlg_a", fev_inr: "dlg_a", fev_bad: "dlg_a", fev_rev: "dlg_a" }, allocations: {} });
    expect(rollup.root_total.USD.net_cost).toBe(1000);
    expect(rollup.root_total.INR.net_cost).toBe(83000);
    expect(rollup.excluded_event_ids.reversed).toEqual(["fev_bad"]);

    const noRate = convertNetCost(rollup.root_total, "USD", [], "2026-10-02T00:00:00.000Z");
    expect(noRate.converted_net_cost).toBeNull();
    expect(noRate.missing_rates).toEqual(["INR"]);
    const rate = event("fev_fx", "fx_rate", 0, { fx: { base_currency: "INR", quote_currency: "USD", rate_numerator: 1, rate_denominator: 83 } });
    const converted = convertNetCost(rollup.root_total, "USD", [rate], "2026-10-02T00:00:00.000Z");
    expect(converted.converted_net_cost).toBe(2000);
    expect(converted.rates_used[0].fx_event_id).toBe("fev_fx");
    const tooEarly = convertNetCost(rollup.root_total, "USD", [rate], "2026-09-01T00:00:00.000Z");
    expect(tooEarly.converted_net_cost).toBeNull();
  });

  it("flags budget overrun and amount mismatch without claiming prevention (acceptance 11)", () => {
    const delegations = [delegation("dlg_a", null, 1, { accepted_amount_minor: 800 })];
    const events = [event("fev_1", "charge", 1200)];
    const rollup = computeRollup({ root: task, delegations, events, attribution: { fev_1: "dlg_a" }, allocations: {} });
    const kinds = deriveTaskExceptions({ task, delegations, claims: [], events: [], rollup, now: T0 }).map((e) => e.kind);
    expect(kinds).toEqual(["budget_overrun", "missing_receipt", "amount_mismatch"]);
  });
});

describe("projections and offline verification", () => {
  const dA = delegation("dlg_a", null, 1, { accepted_amount_minor: 300 });
  const dB = delegation("dlg_b", null, 1);
  const events = [event("fev_a", "charge", 300, { provider_id: "prv_dlg_a" }), event("fev_b", "charge", 700, { provider_id: "prv_dlg_b", evidence: { uri: "https://b.example/inv", digest: null, evidence_type: "invoice" } })];
  const attribution = { fev_a: "dlg_a", fev_b: "dlg_b" };

  function closure(
    allocations: AllocationRecord[] = [],
    responses: ResponseRecord[] = [],
    receipts: { receipt_id: string; delegation_id: string; revision: number; digest: string }[] = [],
    options: { keyBindings?: KeyBindingRecord[]; delegationRecords?: DelegationRecord[]; generatedAt?: string } = {},
  ) {
    const delegations: ClosureDelegation[] = (options.delegationRecords ?? [dA, dB]).map(({ root_task_id: _r, shared_description: _s, ...d }) => d);
    return signPayload(
      withDerivedExceptions(buildClosurePayload({
        closure_id: "cls_1",
        version: 1,
        previous: null,
        generated_at: options.generatedAt ?? T0,
        issuer,
        task,
        delegations,
        claims: [],
        events: events.map((e) => ({ record: e, attributed_to: attribution[e.financial_event_id as keyof typeof attribution] })),
        allocations,
        open_exceptions: [],
        receipts,
        responses,
        key_bindings: options.keyBindings ?? [],
        capture_gaps: [],
      })),
      signingKey,
    );
  }

  function receiptFor(d: DelegationRecord, revision = 1, previous: { receipt_id: string; digest: string } | null = null) {
    return signPayload(
      buildReceiptPayload({
        receipt_id: `rcp_${d.delegation_id}_${revision}`,
        revision,
        previous,
        issued_at: T0,
        expires_at: null,
        issuer,
        delegation: d,
        provider: { provider_id: d.provider_id!, name: d.provider_name_stated!, provider_own_id: null },
        provider_key_bound: false,
        claims: [],
        events: events.filter((e) => attribution[e.financial_event_id as keyof typeof attribution] === d.delegation_id),
        allocation_versions: {},
        prior_responses: [],
        capture_gaps: [],
        key_bindings: [],
      }),
      signingKey,
    );
  }

  it("verifies a closure offline and detects tampering (acceptance 9)", () => {
    const allocation: AllocationRecord = {
      allocation_id: "alc_1",
      financial_event_id: "fev_b",
      version: 1,
      source_event_digest: digestOf(events[1]),
      source_amount_minor: 700,
      currency: "USD",
      lines: [
        { target: { type: "cost_center", id: "cc-1" }, amount_minor: 500 },
        { target: { type: "unallocated", id: null }, amount_minor: 200 },
      ],
      rounding: { method: "none", remainder_units: [] },
      rule: null,
      reason: "manual",
      after_close: false,
      created_by: "usr_1",
      created_at: T0,
    };
    const doc = closure([allocation]);
    const report = verifySubledgerDocument(doc, { trustedKeys });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.valid).toBe(true);
    expect(doc.payload.rollup.root_total.USD.allocated).toBe(500);
    expect(doc.payload.rollup.root_total.USD.unallocated).toBe(500);

    const tampered = structuredClone(doc);
    tampered.payload.financial_events[0].record.amount_minor = 1;
    const bad = verifySubledgerDocument(tampered, { trustedKeys });
    expect(bad.valid).toBe(false);
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(expect.arrayContaining(["issuer_signature", "event_digests", "totals"]));
  });

  it("projects a provider receipt without sibling or customer data (acceptance 8, 19)", () => {
    const receipt = receiptFor(dA);
    const text = JSON.stringify(receipt);
    expect(text).not.toContain("dlg_b");
    expect(text).not.toContain("fev_b");
    expect(text).not.toContain("cust-secret");
    expect(text).not.toContain("cc-1");
    expect(receipt.payload.totals.USD.net_cost).toBe(300);
    expect(receipt.payload.field_status["financial.amounts"]).toBe("imported");
    expect(receipt.payload.field_status["delivery.status"]).toBe("missing");
    expect(verifySubledgerDocument(receipt, { trustedKeys }).valid).toBe(true);
  });

  it("checks the receipt revision chain", () => {
    const first = receiptFor(dA);
    const second = receiptFor(dA, 2, { receipt_id: first.payload.receipt_id, digest: digestOf(first.payload) });
    expect(verifySubledgerDocument(second, { trustedKeys, previous: first }).valid).toBe(true);
    const forged = receiptFor(dA, 2, { receipt_id: first.payload.receipt_id, digest: digestOf({ other: true }) });
    const report = verifySubledgerDocument(forged, { trustedKeys, previous: first });
    expect(report.checks.find((c) => c.name === "revision_chain")!.ok).toBe(false);
  });

  it("rejects a provider-key-signed label without a valid binding", () => {
    const receipt = receiptFor(dA);
    const digest = digestOf(receipt.payload);
    const statement = buildResponseStatement({
      receipt: { receipt_id: receipt.payload.receipt_id, digest, revision: 1, issuer_operator_id: issuer.operator_id },
      response_type: "signed_attestation",
      fields: ["delivery.status"],
    });
    const providerKeys = generateKeyPair();
    const response: ResponseRecord = {
      response_id: "rsp_1",
      receipt_id: receipt.payload.receipt_id,
      receipt_revision: 1,
      provider_id: "prv_dlg_a",
      statement,
      statement_digest: digestOf(statement),
      provider_signature: { key_id: "pk1", binding_id: "pkb_1", value: signStatement(statement, providerKeys.privateKey) },
      assurance: ["link_authenticated_response", "provider_key_signed"],
      decision: null,
      created_at: T0,
    };
    const doc = closure([], [response], [{ receipt_id: receipt.payload.receipt_id, delegation_id: "dlg_a", revision: 1, digest }]);
    const report = verifySubledgerDocument(doc, { trustedKeys });
    expect(report.checks.find((c) => c.name === "provider_responses")!.details[0]).toMatch(/without a listed key binding/);
  });

  describe("schema 1.4 runs, expiry and revocation", () => {
    const H1 = "2026-10-01T01:00:00.000Z";
    const D2 = "2026-10-02T00:00:00.000Z";
    const run: ExecutionDescriptor = { execution_id: "run_1", agent: { agent_id: "agt_a", agent_version: "1.0.0" } };
    const otherRun: ExecutionDescriptor = { execution_id: "run_2", agent: { agent_id: "agt_a", agent_version: "1.0.1" } };
    const providerKeys = generateKeyPair();
    const keyBindings: KeyBindingRecord[] = [
      { binding_id: "pkb_1", provider_id: "prv_dlg_a", key_id: "pk1", public_key: providerKeys.publicKey, method: "operator_configured", created_by: "usr_1", created_at: T0, revoked_at: null },
    ];
    const dARun = delegation("dlg_a", null, 1, { accepted_amount_minor: 300, execution: run });
    const receipt = receiptFor(dARun);
    const receiptRef = { receipt_id: receipt.payload.receipt_id, digest: digestOf(receipt.payload), revision: 1, issuer_operator_id: issuer.operator_id };
    const receiptLink = { receipt_id: receipt.payload.receipt_id, delegation_id: "dlg_a", revision: 1, digest: receiptRef.digest };

    function respond(id: string, extra: Partial<Parameters<typeof buildResponseStatement>[0]>, keySigned = true): ResponseRecord {
      const statement = buildResponseStatement({ receipt: receiptRef, response_type: "signed_attestation", fields: ["delivery.status"], ...extra });
      return {
        response_id: id,
        receipt_id: receipt.payload.receipt_id,
        receipt_revision: 1,
        provider_id: "prv_dlg_a",
        statement,
        statement_digest: digestOf(statement),
        provider_signature: keySigned ? { key_id: "pk1", binding_id: "pkb_1", value: signStatement(statement, providerKeys.privateKey) } : null,
        assurance: keySigned ? ["link_authenticated_response", "provider_key_signed"] : ["link_authenticated_response"],
        decision: null,
        created_at: T0,
      };
    }

    function verifyResponses(responses: ResponseRecord[], generatedAt = T0, delegationRecords = [dARun, dB]) {
      const doc = closure([], responses, [receiptLink], { keyBindings, delegationRecords, generatedAt });
      return { doc, check: verifySubledgerDocument(doc, { trustedKeys }).checks.find((c) => c.name === "provider_responses")! };
    }

    it("carries the run on the receipt and closure delegation", () => {
      expect(receipt.payload.delegation.execution).toEqual(run);
      expect(verifyResponses([]).doc.payload.delegations[0].execution).toEqual(run);
    });

    it("accepts a response bound to the delegation's run and rejects any other run", () => {
      expect(verifyResponses([respond("rsp_1", { execution: executionBinding(run) })]).check).toEqual({ name: "provider_responses", ok: true, details: [] });
      const wrong = verifyResponses([respond("rsp_1", { execution: executionBinding(otherRun) })]).check;
      expect(wrong.ok).toBe(false);
      expect(wrong.details[0]).toMatch(/cites run run_2, which is not the run recorded on delegation dlg_a/);
      const none = verifyResponses([respond("rsp_1", { execution: executionBinding(run) })], T0, [dA, dB]).check;
      expect(none.details[0]).toMatch(/delegation dlg_a records none/);
    });

    it("labels an expired response, keeps it visible and checks the label", () => {
      const response = respond("rsp_1", { issued_at: T0, expires_at: H1 });
      const fresh = verifyResponses([response]);
      expect(fresh.doc.payload.responses[0].assurance).not.toContain("expired");
      expect(fresh.check.ok).toBe(true);
      const later = verifyResponses([response], D2);
      expect(later.doc.payload.responses[0].assurance).toContain("expired");
      expect(later.check.ok).toBe(true);
      const unlabeled = structuredClone(later.doc.payload);
      unlabeled.responses[0].assurance = unlabeled.responses[0].assurance.filter((label) => label !== "expired");
      const report = verifySubledgerDocument(signPayload(unlabeled, signingKey), { trustedKeys });
      expect(report.checks.find((c) => c.name === "provider_responses")!.details).toEqual([`response rsp_1 lacks assurance expired, which does not match its expiry and revocations at ${D2}`]);
    });

    it("rejects expires_at without issued_at, expiry before issue, and a response issued after the closure", () => {
      const noIssued = verifyResponses([respond("rsp_1", { expires_at: H1 })]).check;
      expect(noIssued.details).toContain("response rsp_1 needs issued_at with expires_at or refs");
      const backwards = verifyResponses([respond("rsp_1", { issued_at: H1, expires_at: T0 })], D2).check;
      expect(backwards.details).toContain("response rsp_1 expires before it was issued");
      const future = verifyResponses([respond("rsp_1", { issued_at: D2 })]).check;
      expect(future.details).toContain("response rsp_1 was issued after the closure was generated");
    });

    it("marks a response revoked only when the same provider key revokes it", () => {
      const original = respond("rsp_1", { issued_at: T0 });
      const revocation = respond("rsp_2", { issued_at: H1, refs: [{ relation: "revokes", attestation_digest: original.statement_digest, reason: "wrong run" }] });
      const revoked = verifyResponses([original, revocation], D2);
      expect(revoked.doc.payload.responses.map((r) => r.assurance.includes("revoked"))).toEqual([true, false]);
      expect(revoked.check.ok).toBe(true);

      const linkOnly = respond("rsp_2", { issued_at: H1, refs: [{ relation: "revokes", attestation_digest: original.statement_digest, reason: "wrong run" }] }, false);
      const refused = verifyResponses([original, linkOnly], D2);
      expect(refused.doc.payload.responses[0].assurance).not.toContain("revoked");
      expect(refused.check.details).toEqual([`response rsp_2 revokes ${original.statement_digest}, which its provider key did not sign`]);
    });

    it("notes a reference to a statement outside the closure without failing", () => {
      const missing = digestOf({ elsewhere: true });
      const check = verifyResponses([respond("rsp_1", { issued_at: T0, refs: [{ relation: "disputes", attestation_digest: missing, reason: "see other task" }] })]).check;
      expect(check).toEqual({ name: "provider_responses", ok: true, details: [`response rsp_1 references ${missing}, which is not in this closure`] });
    });

    it("fails a receipt checked after its expiry", () => {
      const expiring = signPayload({ ...structuredClone(receipt.payload), expires_at: H1 }, signingKey);
      const before = verifySubledgerDocument(expiring, { trustedKeys, at: T0 });
      expect(before.valid).toBe(true);
      expect(before.checks.find((c) => c.name === "expiry")!.details).toEqual([`valid until ${H1} (checked at ${T0})`]);
      const after = verifySubledgerDocument(expiring, { trustedKeys, at: D2 });
      expect(after.valid).toBe(false);
      expect(after.checks.find((c) => c.name === "expiry")!.details).toEqual([`receipt expired at ${H1} (checked at ${D2})`]);
    });

    it("rejects 1.4 fields in a document that declares 1.3", () => {
      const old = signPayload({ ...withoutUsageField(receipt.payload), schema_version: "1.3" }, signingKey);
      expect(verifySubledgerDocument(old, { trustedKeys }).checks[0]).toEqual({ name: "schema", ok: false, details: ["schema 1.3 does not allow execution on delegation dlg_a"] });
    });
  });

  describe("schema versions", () => {
    function resigned(doc: { payload: object }, changes: Record<string, unknown>) {
      const older = ["1.2", "1.3", "1.4"].includes(String(changes.schema_version));
      return signPayload({ ...(older ? withoutUsageField(doc.payload) : structuredClone(doc.payload)), ...changes }, signingKey);
    }
    const policyClaim = {
      event_id: "dev_1",
      type: "completion",
      asserted_by: "clearing_policy",
      assurance: ["network_recorded"],
      note: null,
      evidence: [],
      supersedes_event_id: null,
      reason: null,
      retrospective: false,
      occurred_at: T0,
      recorded_at: T0,
    };

    it("emits 1.5 and still verifies documents that declare 1.2, 1.3 or 1.4", () => {
      const receipt = receiptFor(dA);
      expect(receipt.payload.schema_version).toBe(SUBLEDGER_SCHEMA_VERSION);
      expect(SUBLEDGER_SCHEMA_VERSION).toBe("1.5");
      for (const version of ["1.2", "1.3", "1.4"]) {
        expect(verifySubledgerDocument(resigned(receipt, { schema_version: version }), { trustedKeys }).valid).toBe(true);
        expect(verifySubledgerDocument(resigned(closure(), { schema_version: version }), { trustedKeys }).valid).toBe(true);
      }
    });

    it("rejects 1.3 fields in a document that declares 1.2", () => {
      const receipt = resigned(receiptFor(dA), { schema_version: "1.2", delivery_claims: [policyClaim] });
      expect(verifySubledgerDocument(receipt, { trustedKeys }).checks[0]).toEqual({
        name: "schema",
        ok: false,
        details: ["schema 1.2 does not allow asserted_by clearing_policy", "schema 1.2 does not allow assurance network_recorded"],
      });
      const doc = resigned(closure(), { schema_version: "1.2", obligation_links: [] });
      expect(verifySubledgerDocument(doc, { trustedKeys }).checks[0]).toEqual({ name: "schema", ok: false, details: ["schema 1.2 does not allow obligation_links"] });
      const current = resigned(receiptFor(dA), { delivery_claims: [policyClaim] });
      expect(verifySubledgerDocument(current, { trustedKeys }).checks[0].ok).toBe(true);
    });

    it("names an unsupported schema version explicitly instead of failing on schema or signature", () => {
      for (const doc of [resigned(closure(), { schema_version: "1.6" }), resigned(receiptFor(dA), { schema_version: "2.0" })]) {
        const report = verifySubledgerDocument(doc, { trustedKeys });
        expect(report.valid).toBe(false);
        expect(report.unsupported_schema_version).toBe(doc.payload.schema_version);
        expect(report.checks.map((c) => c.name)).toEqual(["schema_version"]);
        expect(report.checks[0].details[0]).toContain(`unsupported schema_version ${doc.payload.schema_version}: this verifier (@atcn/subledger ${SUBLEDGER_VERIFIER_VERSION}) supports 1.2, 1.3, 1.4 and 1.5`);
      }
    });

    it("reports the verifier version published in package.json", () => {
      expect(SUBLEDGER_VERIFIER_VERSION).toBe(subledgerPackage.version);
    });
  });
});

describe("usage and pricing (schema 1.5)", () => {
  const trace = traceVectors.otel.trace as AgentTrace;
  const retry = traceVectors.traces.find((t) => t.name === "retry")!.trace as AgentTrace;
  const pricing = traceVectors.pricings.full as Pricing;
  const expected = expectedCostFromUsage(pricing, [summarizeTrace(trace)]).expected_minor!;
  const allowed = allowedDifference(expected, pricing.tolerance_bps);
  const priced = delegation("dlg_p", null, 1, { pricing });

  function usageClaim(id: string, usageTrace: AgentTrace, extra: Partial<DeliveryClaim> = {}): DeliveryClaim {
    return {
      event_id: id,
      delegation_id: "dlg_p",
      type: "completion",
      asserted_by: "provider",
      assurance: ["buyer_recorded"],
      note: null,
      evidence: [],
      usage: { trace_digest: traceDigest(usageTrace), summary: summarizeTrace(usageTrace) },
      supersedes_event_id: null,
      reason: null,
      retrospective: false,
      occurred_at: T0,
      recorded_at: T0,
      ...extra,
    };
  }

  function exceptionsFor(billed: number, claims: DeliveryClaim[], pricingOverride: Pricing = pricing) {
    const delegations = [{ ...priced, pricing: pricingOverride }];
    const rollup = computeRollup({ root: task, delegations, events: [event("fev_p", "charge", billed)], attribution: { fev_p: "dlg_p" }, allocations: {} });
    return deriveTaskExceptions({ task, delegations, claims, events: [], rollup, now: T0 }).filter((e) => e.kind.startsWith("usage_"));
  }

  function usageClosure(billed: number, claims: DeliveryClaim[]) {
    const { root_task_id: _r, shared_description: _s, ...d } = priced;
    return signPayload(
      buildClosurePayload({
        closure_id: "cls_u",
        version: 1,
        previous: null,
        generated_at: T0,
        issuer,
        task,
        delegations: [{ ...d, delivery_status: deliveryStatus(claims) }],
        claims,
        events: [{ record: event("fev_p", "charge", billed), attributed_to: "dlg_p" }],
        allocations: [],
        open_exceptions: [],
        receipts: [],
        responses: [],
        key_bindings: [],
        capture_gaps: [],
      }),
      signingKey,
    );
  }

  function usageReceipt(claims: DeliveryClaim[]) {
    return signPayload(
      buildReceiptPayload({
        receipt_id: "rcp_dlg_p_1",
        revision: 1,
        previous: null,
        issued_at: T0,
        expires_at: null,
        issuer,
        delegation: priced,
        provider: { provider_id: "prv_dlg_p", name: "Provider dlg_p", provider_own_id: null },
        provider_key_bound: false,
        claims,
        events: [event("fev_p", "charge", expected)],
        allocation_versions: {},
        prior_responses: [],
        capture_gaps: [],
        key_bindings: [],
      }),
      signingKey,
    );
  }

  it("raises usage_cost_mismatch above or below tolerance, and nothing within it (fixture 7)", () => {
    const claims = [usageClaim("dev_1", trace)];
    expect(exceptionsFor(expected + allowed, claims)).toEqual([]);
    expect(exceptionsFor(expected - allowed, claims)).toEqual([]);
    const over = exceptionsFor(expected + allowed + 1, claims);
    expect(over.map((e) => e.kind)).toEqual(["usage_cost_mismatch"]);
    expect(over[0].detail).toContain(`is above usage cost ${expected} by ${allowed + 1}`);
    expect(exceptionsFor(10, claims)[0].detail).toContain(`is below usage cost ${expected}`);
  });

  it("raises usage_unpriced without computing a mismatch (fixture 8)", () => {
    const unpriced = exceptionsFor(1, [usageClaim("dev_1", trace)], traceVectors.pricings.no_tool_rate as Pricing);
    expect(unpriced).toEqual([{ kind: "usage_unpriced", dedupe_key: "usage_unpriced:dlg_p", delegation_id: "dlg_p", detail: "usage has no agreed rate: tool:run_tests:tool_call" }]);
  });

  it("ignores superseded usage and counts the replacement claim (fixture 11)", () => {
    const claims = [
      usageClaim("dev_1", retry),
      usageClaim("dev_2", retry, { type: "correction", usage: undefined, supersedes_event_id: "dev_1", reason: "wrong trace" }),
      usageClaim("dev_3", trace),
    ];
    const check = usageClosure(expected, claims).payload.usage_checks![0];
    expect(check.trace_digests).toEqual([traceDigest(trace)]);
    expect(check.expected_minor).toBe(expected);
  });

  it("counts a trace recorded by both buyer and network once, labelled by its latest claim (fixture 18)", () => {
    const claims = [usageClaim("dev_1", trace, { asserted_by: "buyer" }), usageClaim("dev_2", trace, { asserted_by: "clearing_network", assurance: ["network_recorded"] })];
    const check = usageClosure(expected, claims).payload.usage_checks![0];
    expect(check.trace_digests).toEqual([traceDigest(trace)]);
    expect(check.assurance).toEqual(["network_recorded"]);
    expect(check.within_tolerance).toBe(true);
  });

  it("records usage_checks in the closure and fails verification when one is removed (fixture 13)", () => {
    const doc = usageClosure(expected + 1, [usageClaim("dev_1", trace)]);
    expect(doc.payload.schema_version).toBe("1.5");
    expect(doc.payload.usage_checks).toEqual([
      expect.objectContaining({ delegation_id: "dlg_p", expected_minor: expected, billed_minor: expected + 1, difference_minor: 1, allowed_difference_minor: allowed, within_tolerance: true }),
    ]);
    const report = verifySubledgerDocument(doc, { trustedKeys });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const { usage_checks: _removed, ...stripped } = structuredClone(doc.payload);
    const tampered = verifySubledgerDocument(signPayload(stripped, signingKey), { trustedKeys });
    expect(tampered.valid).toBe(false);
    expect(tampered.checks.find((c) => c.name === "usage_checks")!.ok).toBe(false);
  });

  it("recomputes recorded usage from the trace file offline (fixture 12)", () => {
    const receipt = usageReceipt([usageClaim("dev_1", trace)]);
    expect(receipt.payload.field_status["delivery.usage"]).toBe("provider_reported");
    const supplied = verifySubledgerDocument(receipt, { trustedKeys, traces: [utf8Encode(JSON.stringify(trace, null, 2))] });
    expect(supplied.valid).toBe(true);
    expect(supplied.checks.find((c) => c.name === "trace_summary")).toEqual({ name: "trace_summary", ok: true, details: ["1 recorded usage summary(ies) match their traces"] });

    const notSupplied = verifySubledgerDocument(receipt, { trustedKeys }).checks.find((c) => c.name === "trace_summary")!;
    expect(notSupplied.state).toBe("not_inspected");
    expect(notSupplied.ok).toBe(true);

    const edited = structuredClone(trace);
    edited.steps[0].usage!.output_tokens += 1;
    const editedDigest = traceDigest(edited);
    const tamperedClaim = usageClaim("dev_1", trace, { usage: { trace_digest: editedDigest, summary: summarizeTrace(trace) } });
    const forged = verifySubledgerDocument(usageReceipt([tamperedClaim]), { trustedKeys, traces: [utf8Encode(JSON.stringify(edited))] });
    expect(forged.valid).toBe(false);
    expect(forged.checks.find((c) => c.name === "trace_summary")!.details).toEqual([`delivery claim dev_1: recorded usage does not match its trace ${editedDigest}`]);
  });

  it("refuses 1.5 fields in a document that declares 1.4 (fixture 14)", () => {
    const doc = usageClosure(expected, [usageClaim("dev_1", trace)]);
    const old = signPayload({ ...structuredClone(doc.payload), schema_version: "1.4" }, signingKey);
    expect(verifySubledgerDocument(old, { trustedKeys }).checks[0]).toEqual({
      name: "schema",
      ok: false,
      details: ["schema 1.4 does not allow pricing on delegation dlg_p", "schema 1.4 does not allow usage on delivery claim dev_1", "schema 1.4 does not allow usage_checks"],
    });
  });

  it("allows usage only on completion and partial_completion events", () => {
    const usage = { trace_digest: traceDigest(trace), summary: summarizeTrace(trace) };
    expect(delegationEventProblems({ type: "completion", usage })).toEqual([]);
    expect(delegationEventProblems({ type: "terms_update", usage })).toEqual(["usage is allowed only on completion and partial_completion events"]);
  });
});

describe("cross-language vectors", () => {
  it("statements and countersignatures reproduce the published vectors (the Python SDK checks the same file)", () => {
    for (const c of vectors.statements) {
      const statement = buildResponseStatement(c.input as Parameters<typeof buildResponseStatement>[0]);
      expect(statement).toEqual(c.statement);
      expect(digestOf(statement)).toBe(c.digest);
      expect(signStatement(statement, vectors.private_key)).toBe(c.signature);
    }
    expect(countersignPayload(vectors.countersignature.payload, vectors.private_key)).toBe(vectors.countersignature.signature);
  });
});

describe("refund terms, skill pricing and finality (schema 1.5, A2A discussions #1969, #2124 and #1576)", () => {
  const DAY = 24 * 3600 * 1000;
  const at = (days: number) => new Date(Date.parse(T0) + days * DAY).toISOString();
  const refundTerms: RefundTerms = { on_failure: "refund", on_timeout: "refund", after_settlement: { cap_minor: 500, window_seconds: 7 * 24 * 3600 } };

  function claim(id: string, type: DeliveryClaim["type"], occurredAt: string): DeliveryClaim {
    return { event_id: id, delegation_id: "dlg_r", type, asserted_by: "buyer", assurance: ["buyer_recorded"], note: null, evidence: [], supersedes_event_id: null, reason: null, retrospective: false, occurred_at: occurredAt, recorded_at: occurredAt };
  }

  function exceptionsAt(now: string, records: FinancialEventRecord[], claims: DeliveryClaim[], extra: Partial<DelegationRecord> = {}) {
    const delegations = [delegation("dlg_r", null, 1, { accepted_amount_minor: 500, refund_terms: refundTerms, ...extra })];
    const attributed = records.map((record) => ({ record, attributed_to: "dlg_r" }));
    const rollup = rollupFor(task, delegations, attributed, []);
    return deriveTaskExceptions({ task, delegations, claims, events: attributed, rollup, now }).filter((e) => e.kind === "refund_terms_breach" || e.kind === "skill_price_mismatch");
  }

  const charge = event("fev_c", "charge", 500, { event_date: at(0) });
  const payment = event("fev_pay", "payment_reported", 500, { event_date: at(1), normalized_status: "reported_paid" });

  it("flags refunds above the post-settlement cap or after the window", () => {
    const over = exceptionsAt(at(3), [charge, payment, event("fev_r1", "refund", 600, { event_date: at(2) })], []);
    expect(over.map((e) => e.detail)).toEqual(["refunded 600 USD, more than the agreed cap of 500"]);
    const late = exceptionsAt(at(20), [charge, payment, event("fev_r2", "refund", 100, { event_date: at(10) })], []);
    expect(late[0].detail).toBe(`refund fev_r2 on ${at(10)} is after the refund window ended at ${at(8)}`);
    expect(exceptionsAt(at(5), [charge, payment, event("fev_r3", "refund", 100, { event_date: at(4) })], [])).toEqual([]);
  });

  it("flags a refund the terms require on failure once the window has passed, and clears when it is made", () => {
    const failed = [claim("dev_f", "provider_failure", at(2))];
    expect(exceptionsAt(at(5), [charge, payment], failed)).toEqual([]);
    const due = exceptionsAt(at(10), [charge, payment], failed);
    expect(due).toEqual([
      { kind: "refund_terms_breach", dedupe_key: "refund_terms_breach:dlg_r", delegation_id: "dlg_r", detail: `the terms require a refund on failure: 500 USD was due by ${at(9)}, 0 was refunded` },
    ]);
    expect(exceptionsAt(at(10), [charge, payment, event("fev_r4", "refund", 500, { event_date: at(8) })], failed)).toEqual([]);
    expect(exceptionsAt(at(10), [charge, payment], failed, { refund_terms: { ...refundTerms, on_failure: "dispute" } })).toEqual([]);
  });

  it("flags a refund the terms require when the expected delivery passes without delivery", () => {
    const due = exceptionsAt(at(20), [charge, payment], [], { expected_delivery: at(3) });
    expect(due[0].detail).toBe(`the terms require a refund on timeout: 500 USD was due by ${at(10)}, 0 was refunded`);
    expect(exceptionsAt(at(20), [charge, payment], [claim("dev_c", "completion", at(2))], { expected_delivery: at(3) })).toEqual([]);
  });

  it("flags a charge for a different skill from the one delegated (intake vector skill-pricing-bait-001)", () => {
    const execution = { execution_id: "run-1", agent: { agent_id: "beta", agent_version: "1.0.0" }, skill: { namespace: "a2a", skill_id: "summarize" } };
    const bait = event("fev_bait", "charge", 165, { skill: { namespace: "a2a", skill_id: "deep-research" } });
    const found = exceptionsAt(T0, [bait], [], { execution, refund_terms: undefined, accepted_amount_minor: 100 });
    expect(found).toEqual([
      { kind: "skill_price_mismatch", dedupe_key: "skill_price_mismatch:dlg_r", delegation_id: "dlg_r", detail: "charge fev_bait bills a2a/deep-research for 165 USD; the delegation agreed a2a/summarize at 100 USD" },
    ]);
    const sameSkill = event("fev_ok", "charge", 100, { skill: { namespace: "a2a", skill_id: "summarize" } });
    expect(exceptionsAt(T0, [sameSkill], [], { execution, refund_terms: undefined })).toEqual([]);
  });

  it("allows skill only on billing events", () => {
    const base = { type: "payment_reported", source: "psp", source_event_id: "p1", amount_minor: 1, currency: "USD", event_date: T0 } as const;
    expect(FinancialEventInputSchema.safeParse({ ...base, skill: { namespace: "a2a", skill_id: "x" } }).success).toBe(false);
    expect(FinancialEventInputSchema.safeParse({ ...base, type: "charge", skill: { namespace: "a2a", skill_id: "x" } }).success).toBe(true);
  });

  it("refuses refund_terms, financial event skill and pending_finality in a document that declares 1.4", () => {
    const d = delegation("dlg_r", null, 1, { refund_terms: refundTerms });
    const { root_task_id: _r, shared_description: _s, ...closureDelegation } = d;
    const records = [event("fev_s", "charge", 10, { skill: { namespace: "a2a", skill_id: "x" } }), event("fev_f", "payment_reported", 10, { normalized_status: "pending_finality" })];
    const payload = withDerivedExceptions(buildClosurePayload({
      closure_id: "cls_r", version: 1, previous: null, generated_at: T0, issuer, task, delegations: [closureDelegation], claims: [],
      events: records.map((record) => ({ record, attributed_to: "dlg_r" })), allocations: [], open_exceptions: [], receipts: [], responses: [], key_bindings: [], capture_gaps: [],
    }));
    expect(verifySubledgerDocument(signPayload(payload, signingKey), { trustedKeys }).valid).toBe(true);
    const old = verifySubledgerDocument(signPayload({ ...payload, schema_version: "1.4" }, signingKey), { trustedKeys });
    expect(old.checks[0]).toEqual({
      name: "schema",
      ok: false,
      details: [
        "schema 1.4 does not allow refund_terms on delegation dlg_r",
        "schema 1.4 does not allow skill on financial event fev_s",
        "schema 1.4 does not allow status pending_finality on financial event fev_f",
      ],
    });
  });
});

describe("witnesses and conflicting statements (schema 1.5, evidence plan phases 3 and 4)", () => {
  const run: ExecutionDescriptor = { execution_id: "run_w", agent: { agent_id: "agt_w", agent_version: "1.0.0" } };
  const witnessPolicy = { min_independent_witnesses: 1, independence: "distinct_verified_domain" as const };
  const providerKeys = generateKeyPair();
  const witnessKeys = generateKeyPair();
  const keyBindings: KeyBindingRecord[] = [
    { binding_id: "pkb_p", provider_id: "prv_dlg_w", key_id: "pk_p", public_key: providerKeys.publicKey, method: "domain_challenge", domain: "provider.example", created_by: "usr_1", created_at: T0, revoked_at: null },
    { binding_id: "pkb_w", provider_id: "prv_witness", key_id: "pk_w", public_key: witnessKeys.publicKey, method: "domain_challenge", domain: "gateway.example", created_by: "usr_1", created_at: T0, revoked_at: null },
  ];
  const d = delegation("dlg_w", null, 1, { execution: run, witness_policy: witnessPolicy });
  const { root_task_id: _r, shared_description: _s, ...closureDelegation } = d;
  const receiptRef = { receipt_id: "rcp_w", digest: digestOf({ receipt: "w" }), revision: 1, issuer_operator_id: issuer.operator_id };
  const receipts = [{ receipt_id: "rcp_w", delegation_id: "dlg_w", revision: 1, digest: receiptRef.digest }];
  const sawRun = [{ uri: "https://gateway.example/runs/run_w", digest: null, evidence_type: "gateway_log" }];

  function respond(id: string, signer: "provider" | "witness", extra: Partial<Parameters<typeof buildResponseStatement>[0]>): ResponseRecord {
    const statement = buildResponseStatement({ receipt: receiptRef, response_type: "signed_attestation", fields: ["delivery.status"], ...extra });
    const byProvider = signer === "provider";
    return {
      response_id: id,
      receipt_id: "rcp_w",
      receipt_revision: 1,
      provider_id: byProvider ? "prv_dlg_w" : "prv_witness",
      statement,
      statement_digest: digestOf(statement),
      provider_signature: {
        key_id: byProvider ? "pk_p" : "pk_w",
        binding_id: byProvider ? "pkb_p" : "pkb_w",
        value: signStatement(statement, (byProvider ? providerKeys : witnessKeys).privateKey),
      },
      assurance: ["link_authenticated_response", "provider_key_signed"],
      decision: null,
      created_at: T0,
    };
  }

  const witnessStatement = (extra: Partial<Parameters<typeof buildResponseStatement>[0]> = {}) =>
    respond("rsp_w", "witness", { role: "witness", execution: executionBinding(run), evidence: sawRun, ...extra });

  function closureWith(responses: ResponseRecord[]) {
    return signPayload(
      withDerivedExceptions(buildClosurePayload({
        closure_id: "cls_w", version: 1, previous: null, generated_at: T0, issuer, task, delegations: [closureDelegation], claims: [],
        events: [], allocations: [], open_exceptions: [], receipts, responses, key_bindings: keyBindings, capture_gaps: [],
      })),
      signingKey,
    );
  }

  function responseProblems(responses: ResponseRecord[]) {
    return verifySubledgerDocument(closureWith(responses), { trustedKeys }).checks.find((c) => c.name === "provider_responses")!.details;
  }

  function exceptions(extra: Partial<Parameters<typeof deriveTaskExceptions>[0]>) {
    const delegations = [d];
    return deriveTaskExceptions({ task, delegations, claims: [], events: [], rollup: rollupFor(task, delegations, [], []), now: T0, ...extra }).filter(
      (e) => e.kind === "witness_quorum_not_met" || e.kind === "conflicting_statements",
    );
  }

  it("raises witness_quorum_not_met until an independent witness attests, and says why one did not count", () => {
    const parties = { operator: "buyer.example", providers: { prv_dlg_w: "provider.example" } };
    const gateway = { delegation_id: "dlg_w", witness_id: "prv_witness", domain: "gateway.example" };
    expect(exceptions({ party_domains: parties }).map((e) => e.detail)).toEqual(["0 of 1 required independent witnesses attested"]);
    expect(exceptions({ party_domains: parties, witnesses: [gateway] })).toEqual([]);
    expect(exceptions({ party_domains: parties, witnesses: [{ ...gateway, domain: "provider.example" }] }).map((e) => e.detail)).toEqual([
      "0 of 1 required independent witnesses attested; not counted: prv_witness shares the domain provider.example with a party",
    ]);
    expect(exceptions({ party_domains: { ...parties, operator: null }, witnesses: [gateway] }).map((e) => e.detail)).toEqual([
      "witness independence cannot be checked: the buyer operator has no verified domain",
    ]);
  });

  it("accepts a witness statement and rejects one that breaks the witness rules", () => {
    expect(responseProblems([witnessStatement()])).toEqual([]);
    expect(responseProblems([witnessStatement({ response_type: "acknowledge_delivery", fields: [], evidence: [] })])).toEqual([
      "witness response rsp_w must be a signed_attestation",
      "witness response rsp_w must cite the evidence it saw",
    ]);
    const ownProvider = respond("rsp_o", "provider", { role: "witness", execution: executionBinding(run), evidence: sawRun });
    expect(responseProblems([ownProvider])).toEqual(["witness response rsp_o is from the delegation's own provider"]);
    const unsigned = { ...witnessStatement(), provider_signature: null, assurance: ["link_authenticated_response" as const] };
    expect(responseProblems([unsigned])).toEqual(["witness response rsp_w must be signed with a listed key binding"]);
  });

  it("marks a field contested when a witness disputes the provider's signed statement, and raises conflicting_statements", () => {
    const provider = respond("rsp_p", "provider", { fields: ["delivery.status"] });
    const dispute = witnessStatement({
      issued_at: T0,
      fields: ["delivery.evidence"],
      refs: [{ relation: "disputes", attestation_digest: provider.statement_digest, reason: "the gateway log shows the run failed" }],
    });
    const doc = closureWith([provider, dispute]);
    expect(doc.payload.disclosure.contested).toEqual(["receipt:rcp_w.delivery.status"]);
    expect(verifySubledgerDocument(doc, { trustedKeys }).checks.filter((c) => !c.ok)).toEqual([]);

    const hidden = structuredClone(doc.payload);
    hidden.disclosure.contested = [];
    const report = verifySubledgerDocument(signPayload(hidden, signingKey), { trustedKeys });
    expect(report.checks.find((c) => c.name === "derived_fields")!.ok).toBe(false);

    expect(exceptions({ responses: [provider, dispute], receipts }).filter((e) => e.kind === "conflicting_statements")).toEqual([
      {
        kind: "conflicting_statements",
        dedupe_key: "conflicting_statements:dlg_w",
        delegation_id: "dlg_w",
        detail: "disputed on receipt:rcp_w@1.delivery.status between prv_dlg_w, prv_witness",
      },
    ]);
  });

  it("refuses witness_policy and statement role in a document that declares 1.4", () => {
    const payload = closureWith([witnessStatement()]).payload;
    const old = verifySubledgerDocument(signPayload(withoutUsageField({ ...payload, schema_version: "1.4" }), signingKey), { trustedKeys });
    expect(old.checks[0].details).toEqual(
      expect.arrayContaining(["schema 1.4 does not allow witness_policy on delegation dlg_w", "schema 1.4 does not allow statement role (response rsp_w)"]),
    );
  });
});
