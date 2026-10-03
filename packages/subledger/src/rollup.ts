import type { AllocationLine, DelegationNode, FinancialEventRecord, FinancialEventType, RootNode } from "./types.js";

/** Per-currency figures for one node. Amounts are never combined across currencies. */
export interface Totals {
  quoted: number;
  accepted: number;
  invoiced: number;
  charged: number;
  fees: number;
  adjustments: number;
  refunded: number;
  credits: number;
  reported_paid: number;
  /** Buyer expense: invoiced + charged + fees + adjustments - refunded - credits. */
  net_cost: number;
  /** Billed but not reported paid: invoiced + charged + fees + adjustments - credits - reported_paid. Refunds cancel out of both sides. */
  unresolved: number;
  /** Cost reported for downstream work that the buyer does not pay directly (included in a parent fee, or paid by another party). */
  downstream_reported: number;
  allocated: number;
  unallocated: number;
}

export type CurrencyTotals = Record<string, Totals>;

export interface NodeRollup {
  node_id: string;
  parent_id: string | null;
  direct: CurrencyTotals;
  descendant: CurrencyTotals;
  total: CurrencyTotals;
  event_ids: string[];
}

export interface RollupInput {
  root: RootNode;
  delegations: DelegationNode[];
  events: FinancialEventRecord[];
  /** Current attribution: financial_event_id -> node id (task id or delegation id). */
  attribution: Record<string, string>;
  /** Current allocation lines per financial_event_id. */
  allocations: Record<string, AllocationLine[]>;
}

export interface Rollup {
  root_task_id: string;
  nodes: NodeRollup[];
  root_total: CurrencyTotals;
  excluded_event_ids: { reversed: string[]; reversals: string[]; fx_rates: string[] };
}

/** +1 adds to buyer cost, -1 reduces it, 0 carries no cost (quotes, payment reports, reversals, rates). */
export function costSign(type: FinancialEventType): 1 | -1 | 0 {
  if (type === "invoice" || type === "charge" || type === "fee" || type === "adjustment") return 1;
  if (type === "refund" || type === "credit") return -1;
  return 0;
}

export function emptyTotals(): Totals {
  return {
    quoted: 0,
    accepted: 0,
    invoiced: 0,
    charged: 0,
    fees: 0,
    adjustments: 0,
    refunded: 0,
    credits: 0,
    reported_paid: 0,
    net_cost: 0,
    unresolved: 0,
    downstream_reported: 0,
    allocated: 0,
    unallocated: 0,
  };
}

function bucket(totals: CurrencyTotals, currency: string): Totals {
  totals[currency] ??= emptyTotals();
  return totals[currency];
}

function addInto(target: CurrencyTotals, source: CurrencyTotals): void {
  for (const [currency, values] of Object.entries(source)) {
    const into = bucket(target, currency);
    for (const key of Object.keys(values) as (keyof Totals)[]) into[key] += values[key];
  }
}

/** True when an event counts as the buyer's own expense rather than reported downstream cost (acceptance 25). */
export function isBuyerExpense(event: FinancialEventRecord): boolean {
  return event.payer === "buyer" && event.included_in_event_id === null;
}

/**
 * Deterministic roll-up of one root task (acceptance 1, 6, 25). Each event is attributed to exactly one node
 * and counted once; parents show direct and descendant cost separately. Reversed events and the reversals
 * themselves are excluded from all totals but stay in the record.
 */
export function computeRollup(input: RollupInput): Rollup {
  const reversed = new Set(input.events.filter((e) => e.type === "reversal" && e.reverses_event_id).map((e) => e.reverses_event_id!));
  const nodeIds = [input.root.task_id, ...input.delegations.map((d) => d.delegation_id)];
  const nodes = new Map<string, NodeRollup>();
  nodes.set(input.root.task_id, { node_id: input.root.task_id, parent_id: null, direct: {}, descendant: {}, total: {}, event_ids: [] });
  for (const d of input.delegations) {
    nodes.set(d.delegation_id, { node_id: d.delegation_id, parent_id: d.parent_delegation_id ?? input.root.task_id, direct: {}, descendant: {}, total: {}, event_ids: [] });
  }

  const latestQuote = new Map<string, FinancialEventRecord>();
  for (const event of input.events) {
    const nodeId = input.attribution[event.financial_event_id];
    if (!nodeId || !nodes.has(nodeId)) continue;
    if (event.type === "fx_rate" || event.type === "reversal") continue;
    if (reversed.has(event.financial_event_id)) continue;
    const node = nodes.get(nodeId)!;
    node.event_ids.push(event.financial_event_id);
    const t = bucket(node.direct, event.currency);
    if (event.type === "quote") {
      const previous = latestQuote.get(nodeId);
      if (!previous || previous.event_date < event.event_date || (previous.event_date === event.event_date && previous.financial_event_id < event.financial_event_id)) {
        latestQuote.set(nodeId, event);
      }
      continue;
    }
    if (event.type === "payment_reported") {
      t.reported_paid += event.amount_minor;
      continue;
    }
    const sign = costSign(event.type);
    if (!isBuyerExpense(event)) {
      t.downstream_reported += sign * event.amount_minor;
      continue;
    }
    if (event.type === "invoice") t.invoiced += event.amount_minor;
    if (event.type === "charge") t.charged += event.amount_minor;
    if (event.type === "fee") t.fees += event.amount_minor;
    if (event.type === "adjustment") t.adjustments += event.amount_minor;
    if (event.type === "refund") t.refunded += event.amount_minor;
    if (event.type === "credit") t.credits += event.amount_minor;
    const lines = input.allocations[event.financial_event_id] ?? [];
    const allocated = lines.filter((l) => l.target.type !== "unallocated").reduce((sum, l) => sum + l.amount_minor, 0);
    t.allocated += sign * Math.sign(event.amount_minor || 1) * allocated;
  }

  for (const d of input.delegations) {
    const node = nodes.get(d.delegation_id)!;
    const quote = latestQuote.get(d.delegation_id);
    if (quote) bucket(node.direct, quote.currency).quoted += quote.amount_minor;
    else if (d.quoted_max_minor !== null) bucket(node.direct, d.currency).quoted += d.quoted_max_minor;
    if (d.accepted_amount_minor !== null) bucket(node.direct, d.currency).accepted += d.accepted_amount_minor;
  }
  const rootQuote = latestQuote.get(input.root.task_id);
  if (rootQuote) bucket(nodes.get(input.root.task_id)!.direct, rootQuote.currency).quoted += rootQuote.amount_minor;

  for (const node of nodes.values()) {
    for (const t of Object.values(node.direct)) {
      t.net_cost = t.invoiced + t.charged + t.fees + t.adjustments - t.refunded - t.credits;
      t.unresolved = t.invoiced + t.charged + t.fees + t.adjustments - t.credits - t.reported_paid;
      t.unallocated = t.net_cost - t.allocated;
    }
  }

  // Children before parents: deepest first, so each subtree total is final when added to its parent.
  const depth = (id: string): number => {
    let d = 0;
    let current = nodes.get(id)!;
    while (current.parent_id) {
      d += 1;
      current = nodes.get(current.parent_id)!;
    }
    return d;
  };
  const order = [...nodeIds].sort((a, b) => depth(b) - depth(a));
  for (const id of order) {
    const node = nodes.get(id)!;
    addInto(node.total, node.direct);
    addInto(node.total, node.descendant);
    if (node.parent_id) addInto(nodes.get(node.parent_id)!.descendant, node.total);
  }

  return {
    root_task_id: input.root.task_id,
    nodes: nodeIds.map((id) => nodes.get(id)!),
    root_total: nodes.get(input.root.task_id)!.total,
    excluded_event_ids: {
      reversed: [...reversed].sort(),
      reversals: input.events.filter((e) => e.type === "reversal").map((e) => e.financial_event_id).sort(),
      fx_rates: input.events.filter((e) => e.type === "fx_rate").map((e) => e.financial_event_id).sort(),
    },
  };
}

export interface Conversion {
  report_currency: string;
  converted_net_cost: number | null;
  rates_used: { currency: string; fx_event_id: string; rate_numerator: number; rate_denominator: number; as_of: string }[];
  missing_rates: string[];
  rounding: "half_up_per_currency";
}

/**
 * Converts per-currency net cost into one report currency only with explicit, dated fx_rate events (acceptance 5).
 * Uses the latest rate dated on or before asOf for each currency; any missing rate leaves the total null.
 */
export function convertNetCost(totals: CurrencyTotals, reportCurrency: string, fxEvents: FinancialEventRecord[], asOf: string): Conversion {
  const rates_used: Conversion["rates_used"] = [];
  const missing_rates: string[] = [];
  let sum = 0n;
  for (const [currency, t] of Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) {
    if (currency === reportCurrency) {
      sum += BigInt(t.net_cost);
      continue;
    }
    const candidates = fxEvents
      .filter((e) => e.type === "fx_rate" && e.fx && e.fx.base_currency === currency && e.fx.quote_currency === reportCurrency && e.event_date <= asOf)
      .sort((a, b) => (a.event_date === b.event_date ? a.financial_event_id.localeCompare(b.financial_event_id) : a.event_date.localeCompare(b.event_date)));
    const rate = candidates.at(-1);
    if (!rate) {
      missing_rates.push(currency);
      continue;
    }
    const numerator = BigInt(t.net_cost) * BigInt(rate.fx!.rate_numerator);
    const denominator = BigInt(rate.fx!.rate_denominator);
    const half = denominator / 2n;
    sum += numerator >= 0n ? (numerator + half) / denominator : -((-numerator + half) / denominator);
    rates_used.push({ currency, fx_event_id: rate.financial_event_id, rate_numerator: rate.fx!.rate_numerator, rate_denominator: rate.fx!.rate_denominator, as_of: rate.event_date });
  }
  return { report_currency: reportCurrency, converted_net_cost: missing_rates.length ? null : Number(sum), rates_used, missing_rates, rounding: "half_up_per_currency" };
}
