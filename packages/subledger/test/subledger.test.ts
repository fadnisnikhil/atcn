import { describe, expect, it } from "vitest";
import { digestOf, executionBinding, generateKeyPair, signPayload, type ExecutionDescriptor, type PublicKeyRecord } from "@atcn/schema";
import {
  buildClosurePayload,
  buildReceiptPayload,
  buildResponseStatement,
  completeManualAllocation,
  computeRollup,
  convertNetCost,
  countersignPayload,
  deriveTaskExceptions,
  signStatement,
  splitByWeights,
  SUBLEDGER_SCHEMA_VERSION,
  SUBLEDGER_VERIFIER_VERSION,
  verifySubledgerDocument,
  type AllocationRecord,
  type ClosureDelegation,
  type DelegationRecord,
  type FinancialEventRecord,
  type Issuer,
  type KeyBindingRecord,
  type ResponseRecord,
  type TaskRecord,
} from "../src/index.js";
import subledgerPackage from "../package.json";
import vectors from "../test-vectors/vectors.json";

const T0 = "2026-10-01T00:00:00.000Z";
const issuer: Issuer = { operator_id: "tnt_op", operator_name: "Operator", signed_by: "atcn-hosted-service" };
const serviceKeys = generateKeyPair();
const signingKey = { keyId: "key_atcn_service", keyVersion: 1, privateKey: serviceKeys.privateKey };
const trustedKeys: PublicKeyRecord[] = [
  { key_id: "key_atcn_service", key_version: 1, actor_id: "svc_atcn", algorithm: "Ed25519", public_key: serviceKeys.publicKey, valid_from: "2026-01-01T00:00:00.000Z", revoked_at: null },
];

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
    const kinds = deriveTaskExceptions({ task, delegations, claims: [], rollup, now: T0 }).map((e) => e.kind);
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
      buildClosurePayload({
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
      }),
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
      const old = signPayload({ ...structuredClone(receipt.payload), schema_version: "1.3" }, signingKey);
      expect(verifySubledgerDocument(old, { trustedKeys }).checks[0]).toEqual({ name: "schema", ok: false, details: ["schema 1.3 does not allow execution on delegation dlg_a"] });
    });
  });

  describe("schema versions", () => {
    function resigned(doc: { payload: object }, changes: Record<string, unknown>) {
      return signPayload({ ...structuredClone(doc.payload), ...changes }, signingKey);
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

    it("emits 1.4 and still verifies documents that declare 1.2 or 1.3", () => {
      const receipt = receiptFor(dA);
      expect(receipt.payload.schema_version).toBe(SUBLEDGER_SCHEMA_VERSION);
      expect(SUBLEDGER_SCHEMA_VERSION).toBe("1.4");
      for (const version of ["1.2", "1.3"]) {
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
      for (const doc of [resigned(closure(), { schema_version: "1.5" }), resigned(receiptFor(dA), { schema_version: "2.0" })]) {
        const report = verifySubledgerDocument(doc, { trustedKeys });
        expect(report.valid).toBe(false);
        expect(report.unsupported_schema_version).toBe(doc.payload.schema_version);
        expect(report.checks.map((c) => c.name)).toEqual(["schema_version"]);
        expect(report.checks[0].details[0]).toContain(`unsupported schema_version ${doc.payload.schema_version}: this verifier (@atcn/subledger ${SUBLEDGER_VERIFIER_VERSION}) supports 1.2, 1.3 and 1.4`);
      }
    });

    it("reports the verifier version published in package.json", () => {
      expect(SUBLEDGER_VERIFIER_VERSION).toBe(subledgerPackage.version);
    });
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
