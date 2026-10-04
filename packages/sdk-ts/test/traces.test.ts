import { describe, expect, it } from "vitest";
import { ObligationTermsSchema, newId } from "@atcn/schema";
import {
  AGENT_USAGE_POLICY_V1,
  buildTerms,
  executionBinding,
  expectedCostFromUsage,
  summarizeTrace,
  traceDigest,
  traceFromOtelSpans,
  traceProblems,
  usageCostDetails,
  type AgentTrace,
  type ExecutionDescriptor,
  type OtlpTraceExport,
  type Pricing,
} from "../src/index.js";
import fixtures from "../test-vectors/traces.json";

const traces = Object.fromEntries(fixtures.traces.map((t) => [t.name, t.trace as AgentTrace]));
const pricings = fixtures.pricings as Record<string, Pricing>;

describe("trace vectors (the Python SDK checks the same file)", () => {
  it("binds the fixture run", () => {
    expect(executionBinding(fixtures.descriptor as ExecutionDescriptor)).toEqual(fixtures.binding);
  });

  it("imports the OTLP export with every skipped span and its reason (fixture 1)", () => {
    const result = traceFromOtelSpans(fixtures.otel.export as OtlpTraceExport, fixtures.binding);
    expect(result.trace).toEqual(fixtures.otel.trace);
    expect(result.skipped).toEqual(fixtures.otel.skipped);
    expect(result.skipped).toHaveLength(2);
  });

  it("refuses an export with no GenAI spans", () => {
    expect(() => traceFromOtelSpans({ resourceSpans: [] }, fixtures.binding)).toThrow(/no GenAI model, tool or A2A spans/);
  });

  it("reproduces digests, summaries and problems (fixtures 2 and 6)", () => {
    for (const t of fixtures.traces) {
      expect(traceDigest(t.trace as AgentTrace)).toBe(t.digest);
      expect(summarizeTrace(t.trace as AgentTrace)).toEqual(t.summary);
      expect(traceProblems(t.trace as AgentTrace)).toEqual([]);
    }
    for (const m of fixtures.malformed) expect(traceProblems(m.trace as AgentTrace), m.name).toEqual(m.problems);
  });

  it("reproduces expected costs and usage_cost details (fixtures 7 to 10)", () => {
    for (const c of fixtures.cost_cases) {
      expect(expectedCostFromUsage(pricings[c.pricing], c.traces.map((name) => summarizeTrace(traces[name]))), c.name).toEqual(c.expected);
    }
    for (const c of fixtures.detail_cases) {
      expect(usageCostDetails(pricings[c.pricing], c.amount_minor, c.traces.map((name) => traces[name])), c.name).toEqual(c.expected);
    }
  });
});

describe("terms with pricing", () => {
  const base = {
    principalId: newId("principal"),
    issuerAgentId: newId("agent"),
    counterpartyAgentId: newId("agent"),
    description: "Fix the failing tests",
    maxAmountMinor: 500,
    deliverables: [{ deliverable_id: "main", description: "work", amount_minor: 500, required_checks: ["trace", "usage_cost"] }],
    policy: AGENT_USAGE_POLICY_V1,
  };

  it("emits schema 1.2 only when pricing is set, and the schema refuses pricing on older versions (fixture 17)", () => {
    expect(buildTerms(base).schema_version).toBe("1.0");
    const priced = buildTerms({ ...base, pricing: pricings.full });
    expect(priced.schema_version).toBe("1.2");
    expect(ObligationTermsSchema.safeParse(priced).success).toBe(true);
    const mislabeled = ObligationTermsSchema.safeParse({ ...priced, schema_version: "1.1" });
    expect(mislabeled.success).toBe(false);
    expect(mislabeled.error?.issues.map((i) => i.message)).toContain("pricing requires schema_version 1.2");
  });

  it("refuses duplicate rates and a model on a tool meter", () => {
    expect(ObligationTermsSchema.safeParse(buildTerms({ ...base, pricing: pricings.full })).success).toBe(true);
    const duplicate = { ...pricings.full, rates: [...pricings.full.rates, pricings.full.rates[0]] };
    expect(ObligationTermsSchema.safeParse(buildTerms({ ...base, pricing: duplicate })).success).toBe(false);
    const misplaced = { ...pricings.full, rates: [{ meter: "tool_call" as const, model: { provider: "openai", name: "gpt-5" }, price_numerator: 1, price_denominator: 1 }] };
    expect(ObligationTermsSchema.safeParse(buildTerms({ ...base, pricing: misplaced })).success).toBe(false);
  });
});
