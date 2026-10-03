import type { PostingLine } from "@atcn/schema";
import { allocateLargestRemainder } from "./allocation.js";

export interface BuiltLines {
  lines: PostingLine[];
  rounding: { method: string; detail: string } | null;
}

function line(
  account_type: PostingLine["account_type"],
  party_id: string,
  allocation_role: PostingLine["allocation_role"],
  currency: string,
  debit: number,
  credit: number,
): PostingLine {
  return { account_type, party_id, allocation_role, currency, debit_minor: debit, credit_minor: credit };
}

/** On acceptance: the agreed price becomes a contingent amount (LJ-4). */
export function buildContingentLines(input: { payerId: string; payeeId: string; currency: string; amountMinor: number }): BuiltLines {
  return {
    lines: [
      line("contingent_expense", input.payerId, "contingent", input.currency, input.amountMinor, 0),
      line("contingent_payable", input.payeeId, "contingent", input.currency, 0, input.amountMinor),
    ],
    rounding: null,
  };
}

export interface ClearingPostingInput {
  payerId: string;
  payeeAgentId: string;
  payeePlatformId: string;
  currency: string;
  /** Accepted amount that is not contested. */
  clearableMinor: number;
  /** Amount held in dispute (contested accepted amount + decision-level disputed portion). */
  frozenMinor: number;
  /** Sum of finalized child obligations' cleared amounts (parent pays its children out of its share). */
  childCostMinor: number;
  platformFeeBps: number;
}

/**
 * Clearing batch (LJ-2, LJ-6, LJ-7): payer expense is split into platform fee and payee share;
 * when the payee delegated work, its share is split further into child cost and parent margin.
 * Contested amounts are credited to dispute_frozen rather than payable (CL-9).
 */
export function buildClearingLines(input: ClearingPostingInput): BuiltLines {
  const total = input.clearableMinor + input.frozenMinor;
  if (total === 0) return { lines: [], rounding: null };
  const lines: PostingLine[] = [line("obligation_expense", input.payerId, "payer_expense", input.currency, total, 0)];
  let rounding: BuiltLines["rounding"] = null;

  if (input.clearableMinor > 0) {
    const split = allocateLargestRemainder(input.clearableMinor, [
      { key: "platform_fee", weight: input.platformFeeBps },
      { key: "payee_share", weight: 10000 - input.platformFeeBps },
    ]);
    rounding = { method: split.method, detail: split.detail };
    const fee = split.amounts.platform_fee;
    const share = split.amounts.payee_share;
    if (fee > 0) lines.push(line("platform_fee", input.payeePlatformId, "platform_fee", input.currency, 0, fee));
    if (input.childCostMinor > 0) {
      const childCost = Math.min(input.childCostMinor, share);
      const margin = share - childCost;
      if (childCost > 0) lines.push(line("payable", input.payeeAgentId, "child_cost", input.currency, 0, childCost));
      if (margin > 0) lines.push(line("payable", input.payeeAgentId, "parent_margin", input.currency, 0, margin));
    } else if (share > 0) {
      lines.push(line("payable", input.payeeAgentId, "payee_share", input.currency, 0, share));
    }
  }
  if (input.frozenMinor > 0) {
    lines.push(line("dispute_frozen", input.payeeAgentId, "dispute_freeze", input.currency, 0, input.frozenMinor));
  }
  return { lines, rounding };
}

/** Reversal mirrors every line with debit and credit swapped (LJ-1). */
export function buildReversalLines(original: PostingLine[]): BuiltLines {
  return {
    lines: original.map((l) => ({ ...l, debit_minor: l.credit_minor, credit_minor: l.debit_minor })),
    rounding: null,
  };
}

export function buildReserveLines(input: { payeeId: string; currency: string; amountMinor: number }): BuiltLines {
  return {
    lines: [
      line("payable", input.payeeId, "reserve", input.currency, input.amountMinor, 0),
      line("reserve_reported", input.payeeId, "reserve", input.currency, 0, input.amountMinor),
    ],
    rounding: null,
  };
}

/** Provider reported settlement: payable (and any reported reserve) moves to settlement_reported. */
export function buildSettlementLines(input: { payeeId: string; currency: string; amountMinor: number; reservedMinor: number }): BuiltLines {
  const fromReserve = Math.min(input.reservedMinor, input.amountMinor);
  const fromPayable = input.amountMinor - fromReserve;
  const lines: PostingLine[] = [];
  if (fromReserve > 0) lines.push(line("reserve_reported", input.payeeId, "settlement", input.currency, fromReserve, 0));
  if (fromPayable > 0) lines.push(line("payable", input.payeeId, "settlement", input.currency, fromPayable, 0));
  lines.push(line("settlement_reported", input.payeeId, "settlement", input.currency, 0, input.amountMinor));
  return { lines, rounding: null };
}

/** Refund after settlement: value returns to the payer; the original settlement stays visible. */
export function buildRefundLines(input: { payeeId: string; payerId: string; currency: string; amountMinor: number }): BuiltLines {
  return {
    lines: [
      line("settlement_reported", input.payeeId, "refund", input.currency, input.amountMinor, 0),
      line("refund", input.payerId, "refund", input.currency, 0, input.amountMinor),
    ],
    rounding: null,
  };
}

/** Provider returned the transfer: the amount is payable again. */
export function buildReturnLines(input: { payeeId: string; currency: string; amountMinor: number }): BuiltLines {
  return {
    lines: [
      line("settlement_reported", input.payeeId, "settlement", input.currency, input.amountMinor, 0),
      line("payable", input.payeeId, "settlement", input.currency, 0, input.amountMinor),
    ],
    rounding: null,
  };
}

export interface BalanceCheck {
  balanced: boolean;
  byCurrency: Record<string, { debit: number; credit: number }>;
  problems: string[];
}

/** Each batch must balance per currency using double-entry semantics (LJ-3). */
export function checkBalanced(lines: PostingLine[]): BalanceCheck {
  const byCurrency: BalanceCheck["byCurrency"] = {};
  const problems: string[] = [];
  if (lines.length < 2) problems.push("a posting batch needs at least two lines");
  for (const l of lines) {
    if (l.debit_minor < 0 || l.credit_minor < 0) problems.push("negative amount");
    if ((l.debit_minor > 0) === (l.credit_minor > 0)) problems.push("each line must be exactly one of debit or credit");
    const totals = (byCurrency[l.currency] ??= { debit: 0, credit: 0 });
    totals.debit += l.debit_minor;
    totals.credit += l.credit_minor;
  }
  for (const [currency, totals] of Object.entries(byCurrency)) {
    if (totals.debit !== totals.credit) problems.push(`${currency} debits ${totals.debit} != credits ${totals.credit}`);
  }
  return { balanced: problems.length === 0, byCurrency, problems };
}

/** Net balance per (account_type, party, currency): credit minus debit. */
export function accountBalances(lines: PostingLine[]): Map<string, number> {
  const balances = new Map<string, number>();
  for (const l of lines) {
    const key = `${l.account_type}|${l.party_id}|${l.currency}`;
    balances.set(key, (balances.get(key) ?? 0) + l.credit_minor - l.debit_minor);
  }
  return balances;
}
