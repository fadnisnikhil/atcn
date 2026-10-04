import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  allowedDifference,
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

/**
 * Language-neutral trace and pricing vectors. The TypeScript and Python SDKs must reproduce every value here:
 * the OpenTelemetry import, trace digests, usage summaries, trace problems, expected costs and usage_cost details.
 */

const WORKER = "agt_01J00000000000000000000003";
const run: ExecutionDescriptor = {
  execution_id: "run_tr_1",
  protocol: { name: "a2a", task_id: "task-tr-1", context_id: "ctx-tr-1" },
  agent: {
    agent_id: WORKER,
    agent_version: "1.0.0",
    model: { provider: "openai", name: "gpt-5", version: "2026-08" },
    additional_models: [{ provider: "anthropic", name: "claude-haiku", version: "2026-07" }],
  },
};
const binding = executionBinding(run);
const T = (seconds: number) => String(BigInt(Date.parse("2026-10-05T12:00:00.000Z")) * 1_000_000n + BigInt(seconds) * 1_000_000_000n + 123_456n);

function attr(key: string, value: string | number): { key: string; value: { stringValue: string } | { intValue: string } } {
  return { key, value: typeof value === "string" ? { stringValue: value } : { intValue: String(value) } };
}

const otlp: OtlpTraceExport = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              spanId: "00000000000000b2",
              name: "execute_tool run_tests",
              startTimeUnixNano: T(5),
              endTimeUnixNano: T(9),
              attributes: [attr("gen_ai.operation.name", "execute_tool"), attr("gen_ai.tool.name", "run_tests"), attr("gen_ai.tool.call.id", "call_7")],
            },
            {
              spanId: "00000000000000a1",
              name: "chat gpt-5",
              startTimeUnixNano: T(1),
              endTimeUnixNano: T(4),
              attributes: [
                attr("gen_ai.operation.name", "chat"),
                attr("gen_ai.provider.name", "openai"),
                attr("gen_ai.request.model", "gpt-5"),
                attr("gen_ai.response.model", "gpt-5"),
                attr("gen_ai.response.id", "resp_1"),
                attr("gen_ai.usage.input_tokens", 1200),
                attr("gen_ai.usage.output_tokens", 300),
                attr("gen_ai.usage.cache_read.input_tokens", 200),
              ],
            },
            { spanId: "00000000000000c3", name: "HTTP GET", startTimeUnixNano: T(6), endTimeUnixNano: T(7), attributes: [attr("http.request.method", "GET")] },
            {
              spanId: "00000000000000d4",
              name: "chat claude-haiku",
              startTimeUnixNano: T(10),
              endTimeUnixNano: T(12),
              attributes: [
                attr("gen_ai.operation.name", "chat"),
                attr("gen_ai.provider.name", "anthropic"),
                attr("gen_ai.request.model", "claude-haiku"),
                attr("gen_ai.usage.input_tokens", 400),
                attr("gen_ai.usage.output_tokens", 50),
              ],
            },
            {
              spanId: "00000000000000e5",
              name: "invoke_agent reviewer",
              startTimeUnixNano: T(13),
              endTimeUnixNano: T(20),
              attributes: [attr("gen_ai.operation.name", "invoke_agent"), attr("gen_ai.agent.id", "agt_reviewer"), attr("atcn.a2a.task_id", "task-review-1")],
            },
            {
              spanId: "00000000000000f6",
              name: "invoke_agent local planner",
              startTimeUnixNano: T(14),
              endTimeUnixNano: T(15),
              attributes: [attr("gen_ai.operation.name", "invoke_agent"), attr("gen_ai.agent.id", "planner")],
            },
          ],
        },
      ],
    },
  ],
};

const imported = traceFromOtelSpans(otlp, binding);
const trace = imported.trace;

function step(seq: number, extra: Partial<AgentTrace["steps"][number]>): AgentTrace["steps"][number] {
  return { seq, kind: "model_call", started_at: "2026-10-05T12:00:01.000Z", ended_at: "2026-10-05T12:00:02.000Z", model: { provider: "openai", name: "gpt-5" }, ...extra };
}
const retryTrace: AgentTrace = {
  trace_version: "1.0",
  execution: binding,
  steps: [step(0, { usage: { input_tokens: 1000, output_tokens: 100 } })],
};
const malformedTraces: { name: string; trace: AgentTrace }[] = [
  { name: "duplicate_seq", trace: { ...retryTrace, steps: [step(0, {}), step(0, {})] } },
  { name: "usage_on_tool_call", trace: { ...retryTrace, steps: [{ seq: 0, kind: "tool_call", started_at: "2026-10-05T12:00:01.000Z", ended_at: "2026-10-05T12:00:02.000Z", tool: { name: "x" }, usage: { input_tokens: 1, output_tokens: 1 } }] } },
  { name: "ends_before_start", trace: { ...retryTrace, steps: [step(0, { started_at: "2026-10-05T12:00:03.000Z" })] } },
  { name: "cache_exceeds_input", trace: { ...retryTrace, steps: [step(0, { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 11 } })] } },
  { name: "a2a_without_remote", trace: { ...retryTrace, steps: [{ seq: 0, kind: "a2a_call", started_at: "2026-10-05T12:00:01.000Z", ended_at: "2026-10-05T12:00:02.000Z" }] } },
];

/** Prices are per unit: price_numerator / price_denominator minor units. */
const fullPricing: Pricing = {
  rates: [
    { meter: "input_tokens", model: { provider: "openai", name: "gpt-5" }, price_numerator: 3, price_denominator: 1000 },
    { meter: "input_tokens", price_numerator: 1, price_denominator: 1000 },
    { meter: "cache_read_input_tokens", price_numerator: 1, price_denominator: 4000 },
    { meter: "output_tokens", price_numerator: 12, price_denominator: 1000 },
    { meter: "tool_call", tool_name: "run_tests", price_numerator: 5, price_denominator: 1 },
    { meter: "a2a_call", price_numerator: 20, price_denominator: 1 },
  ],
  fixed_minor: 100,
  tolerance_bps: 500,
};
const noCacheRate: Pricing = {
  rates: fullPricing.rates.filter((r) => r.meter !== "cache_read_input_tokens"),
  tolerance_bps: 0,
};
const noToolRate: Pricing = {
  rates: [...fullPricing.rates.filter((r) => r.meter !== "tool_call"), { meter: "tool_call", tool_name: "lint", price_numerator: 5, price_denominator: 1 }],
  tolerance_bps: 500,
};
const oneModelOnly: Pricing = {
  rates: [
    { meter: "input_tokens", model: { provider: "openai", name: "gpt-5" }, price_numerator: 3, price_denominator: 1000 },
    { meter: "output_tokens", model: { provider: "openai", name: "gpt-5" }, price_numerator: 12, price_denominator: 1000 },
  ],
  tolerance_bps: 0,
};
const tinyRates: Pricing = {
  rates: [
    { meter: "input_tokens", price_numerator: 4, price_denominator: 10 },
    { meter: "output_tokens", price_numerator: 4, price_denominator: 10 },
    { meter: "model_call", price_numerator: 4, price_denominator: 10 },
  ],
  tolerance_bps: 0,
};
const tinyTrace: AgentTrace = { ...retryTrace, steps: [step(0, { usage: { input_tokens: 1, output_tokens: 1 } })] };

const traces: Record<string, AgentTrace> = { imported: trace, retry: retryTrace, tiny: tinyTrace };
const pricings: Record<string, Pricing> = { full: fullPricing, no_cache_rate: noCacheRate, no_tool_rate: noToolRate, one_model_only: oneModelOnly, tiny_rates: tinyRates };

const costCases = [
  { name: "specific_rate_beats_general_and_cache_rate_applies", pricing: "full", traces: ["imported"] },
  { name: "cached_tokens_fall_back_to_input_rate", pricing: "no_cache_rate", traces: ["imported"] },
  { name: "tool_without_matching_rate_is_unpriced", pricing: "no_tool_rate", traces: ["imported"] },
  { name: "model_without_rate_is_unpriced_and_unnamed_meters_are_free", pricing: "one_model_only", traces: ["imported"] },
  { name: "each_meter_rounds_on_its_own", pricing: "tiny_rates", traces: ["tiny"] },
  { name: "two_traces_are_summed", pricing: "full", traces: ["imported", "retry"] },
].map((c) => ({ ...c, expected: expectedCostFromUsage(pricings[c.pricing], c.traces.map((t) => summarizeTrace(traces[t]))) }));

const fullExpected = expectedCostFromUsage(fullPricing, [summarizeTrace(trace)]).expected_minor!;
const fullAllowed = allowedDifference(fullExpected, fullPricing.tolerance_bps);
const detailCases = [
  { name: "amount_within_tolerance", pricing: "full", amount_minor: fullExpected + fullAllowed, traces: ["imported"] },
  { name: "one_minor_unit_over_tolerance", pricing: "full", amount_minor: fullExpected + fullAllowed + 1, traces: ["imported"] },
  { name: "amount_below_cost", pricing: "full", amount_minor: fullExpected - 30, traces: ["imported"] },
  { name: "same_trace_twice_is_priced_once", pricing: "full", amount_minor: fullExpected, traces: ["imported", "imported"] },
  { name: "unpriced_usage", pricing: "no_tool_rate", amount_minor: 5000, traces: ["imported"] },
].map((c) => ({ ...c, expected: usageCostDetails(pricings[c.pricing], c.amount_minor, c.traces.map((t) => traces[t])) }));

const fixtures = {
  description: "Trace and pricing vectors. Generated by packages/sdk-ts/scripts/generate-trace-fixtures.ts; do not edit by hand.",
  descriptor: run,
  binding,
  otel: { export: otlp, trace, skipped: imported.skipped },
  traces: Object.entries(traces).map(([name, t]) => ({ name, trace: t, digest: traceDigest(t), summary: summarizeTrace(t) })),
  malformed: malformedTraces.map((m) => ({ ...m, problems: traceProblems(m.trace) })),
  pricings,
  cost_cases: costCases,
  detail_cases: detailCases,
};

const out = fileURLToPath(new URL("../test-vectors/traces.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("../test-vectors/", import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${out}`);
