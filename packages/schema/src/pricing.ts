import { digestOf } from "./crypto.js";
import { summarizeTrace, traceDigest, type AgentTrace, type UsageSummary } from "./trace.js";
import type { Pricing, PricingRate, UsageMeter } from "./types.js";

export interface CostLine {
  meter: UsageMeter;
  model?: { provider: string; name: string };
  tool_name?: string;
  units: number;
  cost_minor: number;
}

export interface ExpectedCost {
  /** Null when some usage has no rate, because a partial expected cost would mislead. */
  expected_minor: number | null;
  /** One line per rate that priced any usage, in the order of pricing.rates. */
  lines: CostLine[];
  /** Usage with no matching rate, for example "model:openai/gpt-x:output_tokens". */
  unpriced: string[];
}

interface UsageItem {
  meter: UsageMeter;
  model?: { provider: string; name: string };
  tool_name?: string;
  units: number;
  label: string;
}

/** Usage from several summaries as metered items. Cached input tokens are split out of input_tokens, so nothing is priced twice. */
function usageItems(summaries: UsageSummary[]): UsageItem[] {
  const models = new Map<string, { provider: string; name: string; calls: number; uncached: number; cached: number; output: number }>();
  const tools = new Map<string, number>();
  let a2aCalls = 0;
  for (const summary of summaries) {
    for (const m of summary.models) {
      const key = JSON.stringify([m.provider, m.name]);
      const entry = models.get(key) ?? { provider: m.provider, name: m.name, calls: 0, uncached: 0, cached: 0, output: 0 };
      entry.calls += m.calls;
      entry.uncached += m.input_tokens - m.cache_read_input_tokens;
      entry.cached += m.cache_read_input_tokens;
      entry.output += m.output_tokens;
      models.set(key, entry);
    }
    for (const t of summary.tools) tools.set(t.name, (tools.get(t.name) ?? 0) + t.calls);
    a2aCalls += summary.a2a_calls;
  }
  const items: UsageItem[] = [];
  for (const m of models.values()) {
    const model = { provider: m.provider, name: m.name };
    const label = (meter: UsageMeter) => `model:${m.provider}/${m.name}:${meter}`;
    items.push({ meter: "input_tokens", model, units: m.uncached, label: label("input_tokens") });
    items.push({ meter: "cache_read_input_tokens", model, units: m.cached, label: label("cache_read_input_tokens") });
    items.push({ meter: "output_tokens", model, units: m.output, label: label("output_tokens") });
    items.push({ meter: "model_call", model, units: m.calls, label: label("model_call") });
  }
  for (const [name, calls] of tools) items.push({ meter: "tool_call", tool_name: name, units: calls, label: `tool:${name}:tool_call` });
  items.push({ meter: "a2a_call", units: a2aCalls, label: "a2a_call" });
  return items.filter((i) => i.units > 0);
}

function findRate(rates: PricingRate[], meter: UsageMeter, item: UsageItem): number {
  const specific = rates.findIndex(
    (r) =>
      r.meter === meter &&
      ((item.model && r.model?.provider === item.model.provider && r.model?.name === item.model.name) || (item.tool_name !== undefined && r.tool_name === item.tool_name)),
  );
  if (specific >= 0) return specific;
  return rates.findIndex((r) => r.meter === meter && r.model === undefined && r.tool_name === undefined);
}

/** units × numerator / denominator, rounded half up to a whole minor unit, computed exactly. */
function lineCost(units: number, rate: PricingRate): number {
  const numerator = BigInt(units) * BigInt(rate.price_numerator);
  const denominator = BigInt(rate.price_denominator);
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/**
 * Prices usage with agreed rates. A specific rate (naming the model or tool) wins over a general one. Cached input
 * tokens without a cache rate are priced at the input_tokens rate. A meter that no rate names is not charged; usage on
 * a meter that some rate names, but that no rate matches, is unpriced. Each rate line rounds half up once, then the
 * lines are summed with fixed_minor.
 */
export function expectedCostFromUsage(pricing: Pricing, summaries: UsageSummary[]): ExpectedCost {
  const units = new Map<number, number>();
  const unpriced: string[] = [];
  const charged = (meter: UsageMeter) => pricing.rates.some((r) => r.meter === meter);
  for (const item of usageItems(summaries)) {
    const cached = item.meter === "cache_read_input_tokens";
    let index = findRate(pricing.rates, item.meter, item);
    if (index < 0 && cached) index = findRate(pricing.rates, "input_tokens", item);
    if (index >= 0) units.set(index, (units.get(index) ?? 0) + item.units);
    else if (charged(item.meter) || (cached && charged("input_tokens"))) unpriced.push(item.label);
  }
  const lines: CostLine[] = [];
  pricing.rates.forEach((rate, index) => {
    const lineUnits = units.get(index);
    if (lineUnits === undefined) return;
    lines.push({
      meter: rate.meter,
      ...(rate.model ? { model: rate.model } : {}),
      ...(rate.tool_name !== undefined ? { tool_name: rate.tool_name } : {}),
      units: lineUnits,
      cost_minor: lineCost(lineUnits, rate),
    });
  });
  const total = lines.reduce((sum, line) => sum + line.cost_minor, pricing.fixed_minor ?? 0);
  return { expected_minor: unpriced.length > 0 ? null : total, lines, unpriced: unpriced.sort() };
}

/** The difference billed allows before it counts as a mismatch: expected × tolerance_bps / 10000, rounded down. */
export function allowedDifference(expectedMinor: number, toleranceBps: number): number {
  return Number((BigInt(expectedMinor) * BigInt(toleranceBps)) / 10000n);
}

/** What usage_cost records about one deliverable. Scalars only, so it fits a verifier result's details. */
export interface UsageCostDetails {
  expected_minor: number | null;
  amount_minor: number;
  /** amount − expected; positive when the agreed amount exceeds usage cost. Null when expected is unknown. */
  difference_minor: number | null;
  allowed_difference_minor: number | null;
  within_tolerance: boolean | null;
  /** Comma-separated, sorted trace digests (traceDigest) of the priced traces. */
  trace_digests: string;
  /** digestOf the cost lines, so an offline check can compare them exactly. */
  lines_digest: string;
  unpriced: string;
}

/**
 * Whether usage supports a deliverable's agreed amount. The amount may be below usage cost (the provider agreed to it);
 * it may exceed it only within the tolerance. Traces with the same digest are priced once.
 */
export function usageCostDetails(pricing: Pricing, amountMinor: number, traces: AgentTrace[]): UsageCostDetails {
  const byDigest = new Map(traces.map((t) => [traceDigest(t), t]));
  const digests = [...byDigest.keys()].sort();
  const cost = expectedCostFromUsage(
    pricing,
    digests.map((d) => summarizeTrace(byDigest.get(d)!)),
  );
  const expected = cost.expected_minor;
  const allowed = expected === null ? null : allowedDifference(expected, pricing.tolerance_bps);
  const difference = expected === null ? null : amountMinor - expected;
  return {
    expected_minor: expected,
    amount_minor: amountMinor,
    difference_minor: difference,
    allowed_difference_minor: allowed,
    within_tolerance: difference === null || allowed === null ? null : difference <= allowed,
    trace_digests: digests.join(","),
    lines_digest: digestOf(cost.lines),
    unpriced: cost.unpriced.join(","),
  };
}
