import type { AllocationLine, AllocationTarget } from "./types.js";

export const ROUNDING_METHOD = "largest_remainder";

export interface Rounding {
  method: typeof ROUNDING_METHOD | "none";
  /** Minor units added to lines after flooring, by line index. Empty when the split was exact. */
  remainder_units: { line_index: number; units: number }[];
}

export interface AllocationResult {
  lines: AllocationLine[];
  rounding: Rounding;
}

export const UNALLOCATED: AllocationTarget = { type: "unallocated", id: null };

/**
 * Splits an amount by basis-point weights. Each line gets floor(amount * weight / total weight);
 * leftover units go to the largest fractional remainders, ties to the earlier line. Deterministic.
 */
export function splitByWeights(amountMinor: number, splits: { target: AllocationTarget; weight_bps: number }[]): AllocationResult {
  const totalWeight = splits.reduce((sum, s) => sum + s.weight_bps, 0);
  if (totalWeight !== 10_000) throw new Error(`split weights must sum to 10000 bps, got ${totalWeight}`);
  const amount = BigInt(amountMinor);
  const shares = splits.map((s, index) => {
    const exact = amount * BigInt(s.weight_bps);
    return { index, floor: exact / 10_000n, remainder: exact % 10_000n };
  });
  let leftover = amount - shares.reduce((sum, s) => sum + s.floor, 0n);
  const byRemainder = [...shares].sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));
  const extra = new Map<number, number>();
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    extra.set(share.index, 1);
    leftover -= 1n;
  }
  const lines = splits.map((s, index) => ({ target: s.target, amount_minor: Number(shares[index].floor) + (extra.get(index) ?? 0) }));
  const remainder_units = [...extra.entries()].map(([line_index, units]) => ({ line_index, units })).sort((a, b) => a.line_index - b.line_index);
  return { lines, rounding: { method: ROUNDING_METHOD, remainder_units } };
}

/**
 * Validates manual allocation lines against the source amount (acceptance 4).
 * Over-allocation is rejected; any shortfall becomes an explicit unallocated line, so lines always sum to the source.
 */
export function completeManualAllocation(sourceAmountMinor: number, lines: AllocationLine[]): AllocationResult {
  const sum = lines.reduce((total, line) => total + line.amount_minor, 0);
  if (lines.some((line) => line.amount_minor < 0 || !Number.isSafeInteger(line.amount_minor))) throw new Error("allocation amounts must be non-negative integers");
  if (sum > sourceAmountMinor) throw new Error(`allocation lines sum to ${sum}, more than the source amount ${sourceAmountMinor}`);
  const merged = mergeUnallocated(lines);
  const unallocatedIndex = merged.findIndex((line) => line.target.type === "unallocated");
  const shortfall = sourceAmountMinor - sum;
  if (shortfall > 0) {
    if (unallocatedIndex >= 0) merged[unallocatedIndex] = { ...merged[unallocatedIndex], amount_minor: merged[unallocatedIndex].amount_minor + shortfall };
    else merged.push({ target: UNALLOCATED, amount_minor: shortfall });
  }
  return { lines: merged, rounding: { method: "none", remainder_units: [] } };
}

function mergeUnallocated(lines: AllocationLine[]): AllocationLine[] {
  const result: AllocationLine[] = [];
  let unallocated = 0;
  let sawUnallocated = false;
  for (const line of lines) {
    if (line.target.type === "unallocated") {
      unallocated += line.amount_minor;
      sawUnallocated = true;
    } else {
      result.push({ target: { type: line.target.type, id: line.target.id }, amount_minor: line.amount_minor });
    }
  }
  if (sawUnallocated) result.push({ target: UNALLOCATED, amount_minor: unallocated });
  return result;
}

export function allocationSum(lines: AllocationLine[]): number {
  return lines.reduce((total, line) => total + line.amount_minor, 0);
}
