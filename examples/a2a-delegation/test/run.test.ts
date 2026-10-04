import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyClosurePackage } from "@atcn/core";
import { describe, expect, it } from "vitest";
import { runA2ADelegation } from "../src/run.js";

describe("A2A delegation example", () => {
  it("records both A2A delegations and the provider's bill, and the closure verifies offline", async () => {
    const result = await runA2ADelegation({ dataDir: mkdtempSync(join(tmpdir(), "atcn-a2a-example-")) });
    expect(result.valid).toBe(true);
    expect(result.totals.USD).toMatchObject({ charged: 10_200, fees: 1_000, net_cost: 11_200, reported_paid: 9_000, unresolved: 2_200 });
    expect(result.open_exceptions.map((x) => x.kind)).toEqual(["unmatched_charge"]);
    expect(result.closure.payload.delegations).toHaveLength(2);
    expect(result.execution).toMatchObject({ protocol: { name: "a2a" }, agent: { agent_version: "1.0.0" }, skill: { namespace: "a2a", skill_id: "code-fix" } });
    expect(result.execution?.execution_id).toBe(`a2a:${result.execution?.protocol?.task_id}`);
    expect(result.execution?.agent.model).toEqual({ provider: "openai", name: "gpt-5", version: "2026-08" });
  });

  it("takes the search's provider_job_ref from the agent card's billing reference", async () => {
    const result = await runA2ADelegation({ dataDir: mkdtempSync(join(tmpdir(), "atcn-a2a-example-")) });
    const search = result.closure.payload.delegations.find((d) => d.external_ref === "search")!;
    expect(search.provider_job_ref).toBe(search.execution?.protocol?.task_id);
    expect(search.execution?.agent.card_digest).toMatch(/^sha256:/);
    expect(result.closure.payload.expectation_report).toBeUndefined();
  });

  it("with estimates: reports USD 105.00 estimated against USD 112.00 actual, net cost unchanged, and verifies", async () => {
    const result = await runA2ADelegation({ dataDir: mkdtempSync(join(tmpdir(), "atcn-a2a-example-")), estimates: true });
    expect(result.valid).toBe(true);
    expect(result.totals.USD.net_cost).toBe(11_200);
    const report = result.closure.payload.expectation_report!;
    expect(report.task).toMatchObject({ estimated_minor: 10_500, actual_minor: 11_200, variance_vs_estimate_minor: 700, variance_vs_estimate_bps: 667 });
    expect(report.records.map((r) => [r.issued_by, r.assurance[0]])).toEqual([
      ["agent", "provider_key_signed"],
      ["operator", "buyer_recorded"],
    ]);
    expect(result.open_exceptions.map((x) => x.kind).sort()).toEqual(["actual_exceeds_estimate", "actual_exceeds_estimate", "unmatched_charge"]);
  });

  it("when the search fails and is refunded: a provider-signed failure, a net of zero for the search, no exception on it", async () => {
    const result = await runA2ADelegation({ dataDir: mkdtempSync(join(tmpdir(), "atcn-a2a-example-")), searchFails: true });
    expect(result.valid).toBe(true);
    const search = result.closure.payload.delegations.find((d) => d.external_ref === "search")!;
    expect(search.delivery_status).toBe("provider_failed");
    const claim = result.closure.payload.delivery_claims.find((c) => c.delegation_id === search.delegation_id)!;
    expect(claim).toMatchObject({ type: "provider_failure", asserted_by: "provider", assurance: ["provider_key_signed"], note: "search index unavailable; charge refunded" });
    expect(result.closure.payload.rollup.nodes.find((n) => n.node_id === search.delegation_id)!.direct.USD).toMatchObject({ charged: 1_200, refunded: 1_200, net_cost: 0 });
    expect(result.totals.USD.net_cost).toBe(10_000);
    expect(result.open_exceptions.map((x) => x.kind)).toEqual(["unmatched_charge"]);
    expect(result.verification.closure.checks.find((c) => c.name === "signed_claims")!.details).toEqual(["1 provider-signed outcome claim(s) verify"]);
  });

  it("checks Beta's trace against its declared run and prices its usage, and rechecks both offline", async () => {
    const result = await runA2ADelegation({ dataDir: mkdtempSync(join(tmpdir(), "atcn-a2a-example-")) });
    expect(result.trace_check).toMatchObject({ status: "pass", details: { model_calls: 2, input_tokens: 160_000, output_tokens: 15_000, tool_calls: 1, a2a_calls: 0 } });
    expect(result.usage_check).toMatchObject({ status: "pass", details: { expected_minor: 9_983, amount_minor: 10_000, difference_minor: 17, allowed_difference_minor: 99, within_tolerance: true } });
    const traceEvidence = result.verification.packages[0].checks.find((c) => c.name === "trace_evidence")!;
    expect(traceEvidence).toEqual({ name: "trace_evidence", ok: true, details: ["2 trace item(s) and usage result(s) rechecked"] });
    expect(result.files.traces).toHaveLength(1);

    const pkg = result.packages[0];
    const withoutTraces = verifyClosurePackage(pkg, { trustedKeys: result.trusted_keys }).checks.find((c) => c.name === "trace_evidence")!;
    expect(withoutTraces.state).toBe("not_inspected");
    expect(withoutTraces.ok).toBe(true);

    const traces = [readFileSync(result.files.traces[0])];
    const tampered = structuredClone(pkg);
    const usage = tampered.payload.verifier_results.find((r) => r.verifier_name === "usage_cost")!;
    usage.details.expected_minor = 10_000;
    const report = verifyClosurePackage(tampered, { trustedKeys: result.trusted_keys, traces });
    expect(report.checks.find((c) => c.name === "trace_evidence")!.details).toEqual([
      `usage_cost result for ${usage.obligation_id}/work: recorded expected_minor do not match the traces and pricing`,
    ]);
  });
});
