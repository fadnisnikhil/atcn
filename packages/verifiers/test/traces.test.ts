import { describe, expect, it } from "vitest";
import {
  canonicalize,
  digestOf,
  newId,
  sha256Digest,
  summarizeTrace,
  traceDigest,
  utf8Encode,
  type AgentTrace,
  type DeclaredExecution,
  type EvidenceEnvelope,
  type ExecutionDescriptor,
  type Pricing,
} from "@atcn/schema";
import { runCheck, type RunCheckInput } from "../src/index.js";
import fixtures from "../../sdk-ts/test-vectors/traces.json";

const descriptor = fixtures.descriptor as ExecutionDescriptor;
const importedTrace = fixtures.otel.trace as AgentTrace;
const retryTrace = fixtures.traces.find((t) => t.name === "retry")!.trace as AgentTrace;
const pricing = fixtures.pricings.full as Pricing;
const declaredAt = "2026-10-05T12:00:00.000Z";
const after = new Date("2026-10-05T13:00:00.000Z");

const declared: DeclaredExecution = {
  execution_id: descriptor.execution_id,
  execution_digest: digestOf(descriptor),
  started_event_id: newId("event"),
  descriptor,
  started_at: declaredAt,
};

function envelope(content: string): EvidenceEnvelope {
  return {
    evidence_id: newId("evidence"),
    evidence_type: "agent_trace",
    producer_id: newId("agent"),
    created_at: declaredAt,
    content_digest: sha256Digest(content),
    uri: "atcn-blob://x",
    retrieval_method: "atcn-blob",
    media_type: "application/json",
    access_policy: { visible_to: ["verifier"] },
    verifiers: ["agent_trace", "usage_cost"],
    deliverable_ids: ["main"],
  };
}

function traceCheck(trace: unknown, extra: Partial<RunCheckInput> = {}) {
  const content = JSON.stringify(trace);
  return runCheck({
    obligationId: newId("obligation"),
    deliverableId: "main",
    check: { check_id: "trace", verifier: "agent_trace", verifier_version: "1.0.0", evidence_type: "agent_trace", config: {} },
    envelope: envelope(content),
    fetchResult: { ok: true, content: utf8Encode(content) },
    requireDigestMatch: true,
    allowedVerifierIds: [],
    resolveKey: () => null,
    executions: [declared],
    now: after,
    ...extra,
  });
}

function usageCheck(traces: AgentTrace[], amountMinor: number, termsPricing: Pricing | null = pricing) {
  const items = traces.map((t) => {
    const content = JSON.stringify(t);
    return { envelope: envelope(content), fetchResult: { ok: true as const, content: utf8Encode(content) } };
  });
  return runCheck({
    obligationId: newId("obligation"),
    deliverableId: "main",
    check: { check_id: "usage", verifier: "usage_cost", verifier_version: "1.0.0", evidence_type: "agent_trace", config: {} },
    envelope: items[0].envelope,
    fetchResult: items[0].fetchResult,
    requireDigestMatch: true,
    allowedVerifierIds: [],
    resolveKey: () => null,
    executions: [declared],
    termsPricing,
    deliverableAmountMinor: amountMinor,
    deliverableTraces: items,
    now: after,
  });
}

describe("agent_trace@1.0.0", () => {
  it("passes a trace of a declared run and reports its token totals (fixtures 1 and 2)", () => {
    const result = traceCheck(importedTrace);
    expect(result.status).toBe("pass");
    expect(result.details).toMatchObject({ execution_id: "run_tr_1", trace_digest: traceDigest(importedTrace), steps: 4, model_calls: 2, input_tokens: 1600, output_tokens: 350, tool_calls: 1, a2a_calls: 1 });
  });

  it("gives the same digest whatever the file's whitespace and key order", () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(importedTrace).reverse()), null, 4)) as AgentTrace;
    expect(traceDigest(reordered)).toBe(traceDigest(importedTrace));
    expect(summarizeTrace(reordered)).toEqual(summarizeTrace(importedTrace));
    expect(canonicalize(reordered)).toBe(canonicalize(importedTrace));
  });

  it("refuses a trace citing an undeclared run (fixture 3)", () => {
    const other = { ...importedTrace, execution: { execution_id: "run_other", execution_digest: importedTrace.execution.execution_digest } };
    expect(traceCheck(other).details.code).toBe("execution_not_declared");
    expect(traceCheck(importedTrace, { executions: [] }).details.code).toBe("execution_not_declared");
  });

  it("refuses an undeclared model and allows one listed in additional_models (fixture 4)", () => {
    const steps = importedTrace.steps.map((s) => (s.kind === "model_call" && s.model?.name === "claude-haiku" ? { ...s, model: { provider: "anthropic", name: "claude-opus" } } : s));
    const result = traceCheck({ ...importedTrace, steps });
    expect(result.status).toBe("invalid_evidence");
    expect(result.details.code).toBe("model_mismatch");
    expect(traceCheck(importedTrace).status).toBe("pass");
  });

  it("refuses a step before the run was declared or after evaluation (fixture 5)", () => {
    const early = { ...importedTrace, steps: [{ ...importedTrace.steps[0], started_at: "2026-10-05T11:59:59.000Z" }] };
    expect(traceCheck(early).details.code).toBe("trace_outside_run");
    expect(traceCheck(importedTrace, { now: new Date("2026-10-05T12:00:10.000Z") }).details.code).toBe("trace_outside_run");
  });

  it("refuses malformed traces (fixture 6)", () => {
    for (const m of fixtures.malformed) {
      const bound = { ...m.trace, execution: importedTrace.execution };
      const result = traceCheck(bound);
      expect(result.status, m.name).toBe("invalid_evidence");
      expect(result.details.code, m.name).toBe("malformed");
      expect(result.details.error, m.name).toBe(m.problems.join("; "));
    }
    expect(traceCheck({ ...importedTrace, extra: true }).details.code).toBe("malformed");
    expect(traceCheck("not a trace").details.code).toBe("malformed");
  });
});

describe("usage_cost@1.0.0", () => {
  const expected = fixtures.detail_cases.find((c) => c.name === "amount_within_tolerance")!.expected;

  it("passes an amount within tolerance and fails one minor unit over (fixture 15)", () => {
    const within = usageCheck([importedTrace], expected.amount_minor);
    expect(within.status).toBe("pass");
    expect(within.details).toMatchObject(expected);
    const over = usageCheck([importedTrace], expected.amount_minor + 1);
    expect(over.status).toBe("fail");
    expect(over.details.code).toBe("usage_cost_mismatch");
  });

  it("passes an amount below usage cost and reports the shortfall", () => {
    const below = usageCheck([importedTrace], expected.expected_minor! - 30);
    expect(below.status).toBe("pass");
    expect(below.details.difference_minor).toBe(-30);
  });

  it("prices every declared run's trace on the deliverable, such as a retry (fixture 16)", () => {
    const both = usageCheck([importedTrace, retryTrace], 1000);
    const summed = fixtures.cost_cases.find((c) => c.name === "two_traces_are_summed")!.expected;
    expect(both.details.expected_minor).toBe(summed.expected_minor);
    expect(both.details.trace_digests).toBe([traceDigest(importedTrace), traceDigest(retryTrace)].sort().join(","));
    expect(both.evidence_ids).toHaveLength(2);
  });

  it("refuses terms without pricing and usage with no agreed rate (fixture 17)", () => {
    const missing = usageCheck([importedTrace], 100, null);
    expect(missing.status).toBe("invalid_evidence");
    expect(missing.details.code).toBe("pricing_missing");
    const unpriced = usageCheck([importedTrace], 100, fixtures.pricings.no_tool_rate as Pricing);
    expect(unpriced.details.code).toBe("usage_unpriced");
    expect(unpriced.details.unpriced).toBe("tool:run_tests:tool_call");
  });

  it("refuses a trace that fails an agent_trace rule", () => {
    const undeclared = { ...retryTrace, execution: { ...retryTrace.execution, execution_id: "run_other" } };
    expect(usageCheck([importedTrace, undeclared], 100).details.code).toBe("execution_not_declared");
  });
});
