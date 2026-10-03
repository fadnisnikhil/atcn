export interface Share {
  key: string;
  weight: number;
}

export interface AllocationResult {
  amounts: Record<string, number>;
  method: "largest_remainder";
  /** Human-readable record of how remainders were distributed (LJ-7). */
  detail: string;
}

/**
 * Splits an integer amount by integer weights using the largest-remainder method.
 * Ties on the remainder are broken by key in ascending order, so the result is
 * deterministic and always sums exactly to `total`.
 */
export function allocateLargestRemainder(total: number, shares: Share[]): AllocationResult {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("total must be a non-negative safe integer");
  const weightSum = shares.reduce((sum, s) => sum + s.weight, 0);
  if (weightSum <= 0) throw new Error("weights must sum to a positive number");

  const rows = shares.map((share) => {
    const exactNumerator = total * share.weight;
    const floor = Math.floor(exactNumerator / weightSum);
    const remainder = exactNumerator - floor * weightSum;
    return { key: share.key, floor, remainder };
  });

  let leftover = total - rows.reduce((sum, r) => sum + r.floor, 0);
  const order = [...rows].sort((a, b) => b.remainder - a.remainder || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const bonus: Record<string, number> = {};
  for (const row of order) {
    if (leftover === 0) break;
    bonus[row.key] = 1;
    leftover -= 1;
  }

  const amounts: Record<string, number> = {};
  for (const row of rows) amounts[row.key] = row.floor + (bonus[row.key] ?? 0);

  const remainderNotes = rows.map((r) => `${r.key}=${r.floor}+${bonus[r.key] ?? 0}(rem ${r.remainder}/${weightSum})`);
  return { amounts, method: "largest_remainder", detail: `total=${total}; ${remainderNotes.join("; ")}` };
}
