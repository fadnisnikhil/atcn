import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, signPayload } from "@atcn/schema";
import { buildExpectationStatement, signExpectation, verifySubledgerDocument, type Expectation, type SignedClosure } from "@atcn/subledger";
import { describe, expect, it } from "vitest";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "../src/index.js";

function setup() {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-expect-")), "service-key.json"));
  const subledger = new LocalSubledger(serviceKey, "Acme Robotics");
  const verify = (closure: SignedClosure) => verifySubledgerDocument(closure, { trustedKeys: [servicePublicKey(serviceKey)] });
  return { serviceKey, subledger, verify };
}

const charge = (sourceEventId: string, amount: number, jobRef: string, eventDate = "2026-10-01T12:00:00.000Z") => ({
  type: "charge",
  source: "provider-billing",
  source_event_id: sourceEventId,
  amount_minor: amount,
  currency: "USD",
  event_date: eventDate,
  match: { provider_job_ref: jobRef },
});

const expectationEvent = (type: "estimate" | "hold", sourceEventId: string, amount: number, jobRef: string, expectation: Expectation, eventDate = "2026-10-01T09:00:00.000Z", source = "orchestrator") => ({
  type,
  source,
  source_event_id: sourceEventId,
  amount_minor: amount,
  currency: "USD",
  event_date: eventDate,
  match: { provider_job_ref: jobRef },
  expectation,
});

const operatorEstimate: Expectation = { issued_by: "operator", source_ref: null, basis: "last month's average", expires_at: null, supersedes: null };

/** An agent whose provider has a bound key, and a signed estimate from it. */
function signedAgentEstimate(subledger: LocalSubledger, jobRef: string, amount: number) {
  const keys = generateKeyPair();
  const provider = subledger.addProvider("Beta Workers", "beta");
  const binding = subledger.bindProviderKey(provider.provider_id, keys.publicKey, "beta-key-1");
  const expectation: Omit<Expectation, "signer"> = { issued_by: "agent", source_ref: "card:code-fix", basis: "fixed fee plus usage at cost", expires_at: null, supersedes: null };
  const statement = buildExpectationStatement({ type: "estimate", source: "beta-agent", source_event_id: "est-beta-1", amount_minor: amount, currency: "USD", issued_at: "2026-10-01T09:00:00.000Z", expectation });
  const event = expectationEvent("estimate", "est-beta-1", amount, jobRef, {
    ...expectation,
    signer: { provider_id: provider.provider_id, binding_id: binding.binding_id, key_id: binding.key_id, value: signExpectation(statement, keys.privateKey) },
  }, "2026-10-01T09:00:00.000Z", "beta-agent");
  return { provider, event };
}

describe("estimates and holds (record only)", () => {
  it("reports estimate 105 against actual 112 (+7, +667 bps) without changing net cost, and verifies", () => {
    const { subledger, verify } = setup();
    const task = subledger.createTask({ external_ref: "fix-with-research", currency: "USD", budget_minor: 15_000 });
    const { provider, event } = signedAgentEstimate(subledger, "beta-job", 9_500);
    const codeFix = subledger.createDelegation(task.task_id, { external_ref: "code-fix", provider_id: provider.provider_id, provider_job_ref: "beta-job", currency: "USD" });
    const search = subledger.createDelegation(task.task_id, { external_ref: "search", provider_job_ref: "gamma-job", currency: "USD" });
    subledger.recordFinancialEvent(event);
    subledger.recordFinancialEvent(expectationEvent("estimate", "est-search", 1_000, "gamma-job", operatorEstimate));
    subledger.recordFinancialEvent(charge("ch-beta", 10_000, "beta-job"));
    subledger.recordFinancialEvent(charge("ch-gamma", 1_200, "gamma-job"));

    const { closure } = subledger.closeTask(task.task_id, []);
    const report = closure.payload.expectation_report!;
    expect(closure.payload.rollup.root_total.USD.net_cost).toBe(11_200);
    expect(report.task).toMatchObject({ estimated_minor: 10_500, actual_minor: 11_200, variance_vs_estimate_minor: 700, variance_vs_estimate_bps: 667, unestimated_minor: 0 });
    expect(report.nodes.map((n) => [n.node_id, n.estimated_minor, n.actual_minor])).toEqual([
      [codeFix.delegation_id, 9_500, 10_000],
      [search.delegation_id, 1_000, 1_200],
    ]);
    expect(report.records.map((r) => [r.issued_by, r.assurance])).toEqual([
      ["agent", ["provider_key_signed"]],
      ["operator", ["buyer_recorded"]],
    ]);
    const overEstimate = closure.payload.open_exceptions.filter((x) => x.kind === "actual_exceeds_estimate");
    expect(overEstimate.map((x) => x.delegation_id).sort()).toEqual([codeFix.delegation_id, search.delegation_id].sort());
    expect(closure.payload.key_bindings).toHaveLength(1);
    const verification = verify(closure);
    expect(verification.valid).toBe(true);
    expect(verification.checks.find((c) => c.name === "expectations")!.details).toContain("recorded only: nothing was enforced, blocked or reserved");
  });

  it("records 5 gateway holds against a budget of 1 and blocks nothing", () => {
    const { subledger, verify } = setup();
    const task = subledger.createTask({ external_ref: "gateway-run", currency: "USD", budget_minor: 100 });
    for (let i = 1; i <= 5; i++) subledger.createDelegation(task.task_id, { external_ref: `handoff-${i}`, provider_job_ref: `job-${i}`, currency: "USD" });
    const gatewayHold: Expectation = { issued_by: "gateway", source_ref: null, basis: "max tokens x rate", expires_at: null, supersedes: null, hold_status: "open" };
    for (let i = 1; i <= 5; i++) subledger.recordFinancialEvent(expectationEvent("hold", `hold-${i}`, 100, `job-${i}`, { ...gatewayHold, source_ref: `req-${i}` }, "2026-10-01T09:00:00.000Z", "cost-gateway"));
    for (let i = 1; i <= 5; i++) subledger.recordFinancialEvent(charge(`ch-${i}`, 100, `job-${i}`));

    const { closure } = subledger.closeTask(task.task_id, []);
    const report = closure.payload.expectation_report!;
    expect(report.task).toMatchObject({ held_minor: 500, actual_minor: 500, variance_vs_hold_minor: 0 });
    expect(report.nodes).toHaveLength(5);
    expect(report.nodes.every((n) => n.held_minor === 100 && n.actual_minor === 100 && n.variance_vs_hold_minor === 0)).toBe(true);
    expect(report.records.every((r) => r.assurance.includes("buyer_recorded"))).toBe(true);
    const kinds = closure.payload.open_exceptions.map((x) => x.kind);
    expect(kinds).toContain("budget_overrun");
    expect(kinds).not.toContain("hold_not_released");
    expect(verify(closure).valid).toBe(true);
  });

  it("labels a gateway-signed hold gateway_signed, and a tampered or unsigned copy fails verification", () => {
    const { serviceKey, subledger, verify } = setup();
    const task = subledger.createTask({ external_ref: "signed-hold", currency: "USD" });
    subledger.createDelegation(task.task_id, { external_ref: "handoff", provider_job_ref: "job-1", currency: "USD" });
    const keys = generateKeyPair();
    const gateway = subledger.addProvider("Cost Gateway", "gateway");
    const binding = subledger.bindProviderKey(gateway.provider_id, keys.publicKey, "gw-1");
    const expectation: Omit<Expectation, "signer"> = { issued_by: "gateway", source_ref: "req-1", basis: null, expires_at: null, supersedes: null, hold_status: "open" };
    const statement = buildExpectationStatement({ type: "hold", source: "cost-gateway", source_event_id: "hold-1", amount_minor: 300, currency: "USD", issued_at: "2026-10-01T09:00:00.000Z", expectation });
    const signer = { provider_id: gateway.provider_id, binding_id: binding.binding_id, key_id: binding.key_id, value: signExpectation(statement, keys.privateKey) };
    subledger.recordFinancialEvent(expectationEvent("hold", "hold-1", 300, "job-1", { ...expectation, signer }, "2026-10-01T09:00:00.000Z", "cost-gateway"));
    subledger.recordFinancialEvent(charge("ch-1", 250, "job-1"));

    const { closure } = subledger.closeTask(task.task_id, []);
    expect(closure.payload.expectation_report!.records[0].assurance).toEqual(["gateway_signed"]);
    expect(verify(closure).valid).toBe(true);

    for (const change of [
      (e: any) => (e.amount_minor += 1),
      (e: any) => (e.source = "someone-else"),
      (e: any) => (e.event_date = "2026-10-01T08:00:00.000Z"),
      (e: any) => delete e.expectation.signer,
    ]) {
      const tampered = structuredClone(closure);
      change(tampered.payload.financial_events.find((e) => e.record.type === "hold")!.record);
      expect(verify(tampered).valid).toBe(false);
      // Even re-signed by the issuer, a changed record no longer matches its signature or the report.
      const resigned = signPayload(tampered.payload, serviceKey) as SignedClosure;
      expect(verify(resigned).valid).toBe(false);
    }
  });

  it("refuses a signature that does not verify, and an agent estimate signed by another provider", () => {
    const { subledger } = setup();
    const task = subledger.createTask({ external_ref: "bad-signature", currency: "USD" });
    const { event } = signedAgentEstimate(subledger, "beta-job", 9_500);
    const other = subledger.addProvider("Other Agent", "other");
    subledger.createDelegation(task.task_id, { external_ref: "code-fix", provider_id: other.provider_id, provider_job_ref: "beta-job", currency: "USD" });
    expect(() => subledger.recordFinancialEvent(event)).toThrow(/signed by a provider other than the delegation's/);
    const forged = structuredClone(event);
    forged.amount_minor = 1;
    forged.match = { provider_job_ref: "unmatched-job" };
    expect(() => subledger.recordFinancialEvent(forged)).toThrow(/signature does not verify/);
  });

  it("keeps a late estimate visible but does not use it, and keeps superseded estimates in the history", () => {
    const { subledger, verify } = setup();
    const task = subledger.createTask({ external_ref: "late", currency: "USD", estimate_tolerance_bps: 1_000 });
    const d = subledger.createDelegation(task.task_id, { external_ref: "work", provider_job_ref: "job-1", currency: "USD" });
    subledger.recordFinancialEvent(expectationEvent("estimate", "est-1", 800, "job-1", operatorEstimate, "2026-10-01T08:00:00.000Z"));
    subledger.recordFinancialEvent(expectationEvent("estimate", "est-2", 950, "job-1", { ...operatorEstimate, supersedes: "est-1" }, "2026-10-01T09:00:00.000Z"));
    subledger.recordFinancialEvent(charge("ch-1", 1_000, "job-1", "2026-10-01T12:00:00.000Z"));
    subledger.recordFinancialEvent(expectationEvent("estimate", "est-3", 2_000, "job-1", operatorEstimate, "2026-10-01T13:00:00.000Z"));

    const { closure } = subledger.closeTask(task.task_id, []);
    const report = closure.payload.expectation_report!;
    expect(report.records.map((r) => [r.status, r.assurance])).toEqual([
      ["superseded", ["buyer_recorded", "superseded"]],
      ["current", ["buyer_recorded"]],
      ["after_charge", ["buyer_recorded"]],
    ]);
    expect(report.nodes[0]).toMatchObject({ node_id: d.delegation_id, estimated_minor: 950, actual_minor: 1_000, variance_vs_estimate_minor: 50, variance_vs_estimate_bps: 526 });
    const kinds = closure.payload.open_exceptions.map((x) => x.kind);
    expect(kinds).toContain("estimate_after_charge");
    // 1,000 is within 10% of 950, the task's tolerance.
    expect(kinds).not.toContain("actual_exceeds_estimate");
    expect(verify(closure).valid).toBe(true);
    expect(() => subledger.recordFinancialEvent(expectationEvent("estimate", "est-4", 1, "job-1", { ...operatorEstimate, supersedes: "missing" }))).toThrow(/not found/);
  });

  it("flags an open hold with nothing charged at close, but not a released one or one on cancelled work", () => {
    const { subledger, verify } = setup();
    const task = subledger.createTask({ external_ref: "holds-at-close", currency: "USD" });
    const open = subledger.createDelegation(task.task_id, { external_ref: "open", provider_job_ref: "job-open", currency: "USD" });
    subledger.createDelegation(task.task_id, { external_ref: "released", provider_job_ref: "job-released", currency: "USD" });
    const cancelled = subledger.createDelegation(task.task_id, { external_ref: "cancelled", provider_job_ref: "job-cancelled", currency: "USD" });
    const hold: Expectation = { issued_by: "gateway", source_ref: null, basis: null, expires_at: null, supersedes: null, hold_status: "open" };
    subledger.recordFinancialEvent(expectationEvent("hold", "h-open", 100, "job-open", hold, undefined, "cost-gateway"));
    subledger.recordFinancialEvent(expectationEvent("hold", "h-released", 100, "job-released", hold, undefined, "cost-gateway"));
    subledger.recordFinancialEvent(expectationEvent("hold", "h-released-2", 100, "job-released", { ...hold, hold_status: "released", supersedes: "h-released" }, "2026-10-01T10:00:00.000Z", "cost-gateway"));
    subledger.recordFinancialEvent(expectationEvent("hold", "h-cancelled", 100, "job-cancelled", hold, undefined, "cost-gateway"));
    subledger.appendDelegationEvent(cancelled.delegation_id, { type: "cancellation", asserted_by: "buyer", note: "not needed" });
    expect(subledger.exceptions.filter((x) => x.kind === "hold_not_released")).toEqual([]);

    const { closure } = subledger.closeTask(task.task_id, []);
    const notReleased = closure.payload.open_exceptions.filter((x) => x.kind === "hold_not_released");
    expect(notReleased.map((x) => x.delegation_id)).toEqual([open.delegation_id]);
    const cancelledHold = closure.payload.expectation_report!.records.find((r) => r.node_id === cancelled.delegation_id)!;
    expect(cancelledHold.hold_status).toBe("released");
    expect(closure.payload.expectation_report!.task.held_minor).toBe(100);
    expect(verify(closure).valid).toBe(true);
  });

  it("opens unmatched_estimate for an estimate with no matching node, and refuses to reverse an estimate", () => {
    const { subledger } = setup();
    const task = subledger.createTask({ external_ref: "unmatched", currency: "USD" });
    const result = subledger.recordFinancialEvent(expectationEvent("estimate", "est-x", 500, "nobody", operatorEstimate));
    expect(result.attribution).toBeNull();
    expect(subledger.exceptions.find((x) => x.financial_event_id === result.financial_event.financial_event_id)!.kind).toBe("unmatched_estimate");
    subledger.createDelegation(task.task_id, { external_ref: "work", provider_job_ref: "job-1", currency: "USD" });
    const estimate = subledger.recordFinancialEvent(expectationEvent("estimate", "est-1", 500, "job-1", operatorEstimate));
    expect(() =>
      subledger.recordFinancialEvent({ type: "reversal", source: "orchestrator", source_event_id: "rev-1", amount_minor: 500, currency: "USD", event_date: "2026-10-01T10:00:00.000Z", reverses_event_id: estimate.financial_event.financial_event_id, reason: "wrong" }),
    ).toThrow(/not reversed/);
    expect(() => subledger.recordFinancialEvent({ ...charge("ch-1", 100, "job-1"), expectation: operatorEstimate })).toThrow(/expectation is allowed only on estimate and hold events/);
  });

  it("refuses estimates in a document that declares schema 1.4", () => {
    const { serviceKey, subledger, verify } = setup();
    const task = subledger.createTask({ external_ref: "old-schema", currency: "USD" });
    subledger.createDelegation(task.task_id, { external_ref: "work", provider_job_ref: "job-1", currency: "USD" });
    subledger.recordFinancialEvent(expectationEvent("estimate", "est-1", 500, "job-1", operatorEstimate));
    const { closure } = subledger.closeTask(task.task_id, []);
    const downgraded = signPayload({ ...closure.payload, schema_version: "1.4" }, serviceKey) as SignedClosure;
    const schema = verify(downgraded).checks.find((c) => c.name === "schema")!;
    expect(schema.ok).toBe(false);
    expect(schema.details.join("; ")).toMatch(/does not allow estimate events.*does not allow expectation.*does not allow expectation_report/);
  });
});
