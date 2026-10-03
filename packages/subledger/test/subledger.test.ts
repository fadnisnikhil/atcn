import { describe, expect, it } from "vitest";
import { digestOf, generateKeyPair, signPayload, type PublicKeyRecord } from "@atcn/schema";
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

  function closure(allocations: AllocationRecord[] = [], responses: ResponseRecord[] = [], receipts: { receipt_id: string; delegation_id: string; revision: number; digest: string }[] = []) {
    const delegations: ClosureDelegation[] = [dA, dB].map(({ root_task_id: _r, shared_description: _s, ...d }) => d);
    return signPayload(
      buildClosurePayload({
        closure_id: "cls_1",
        version: 1,
        previous: null,
        generated_at: T0,
        issuer,
        task,
        delegations,
        claims: [],
        events: events.map((e) => ({ record: e, attributed_to: attribution[e.financial_event_id as keyof typeof attribution] })),
        allocations,
        open_exceptions: [],
        receipts,
        responses,
        key_bindings: [],
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

    it("emits 1.3 and still verifies documents that declare 1.2", () => {
      const receipt = receiptFor(dA);
      expect(receipt.payload.schema_version).toBe(SUBLEDGER_SCHEMA_VERSION);
      expect(SUBLEDGER_SCHEMA_VERSION).toBe("1.3");
      expect(verifySubledgerDocument(resigned(receipt, { schema_version: "1.2" }), { trustedKeys }).valid).toBe(true);
      expect(verifySubledgerDocument(resigned(closure(), { schema_version: "1.2" }), { trustedKeys }).valid).toBe(true);
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
      for (const doc of [resigned(closure(), { schema_version: "1.4" }), resigned(receiptFor(dA), { schema_version: "2.0" })]) {
        const report = verifySubledgerDocument(doc, { trustedKeys });
        expect(report.valid).toBe(false);
        expect(report.unsupported_schema_version).toBe(doc.payload.schema_version);
        expect(report.checks.map((c) => c.name)).toEqual(["schema_version"]);
        expect(report.checks[0].details[0]).toContain(`unsupported schema_version ${doc.payload.schema_version}: this verifier (@atcn/subledger ${SUBLEDGER_VERIFIER_VERSION}) supports 1.2 and 1.3`);
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
