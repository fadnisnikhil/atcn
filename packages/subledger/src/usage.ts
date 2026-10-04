import { allowedDifference, expectedCostFromUsage, type Pricing } from "@atcn/schema";
import type { DeliveryClaim, ResponseRecord, UsageCheck } from "./documents.js";
import type { Rollup, Totals } from "./rollup.js";
import { ASSURANCE_LABELS, USAGE_CLAIM_TYPES, type AssuranceLabel } from "./types.js";

/** What a delegation was billed: invoices, charges, fees and adjustments, less credits and refunds. */
export function billedMinor(totals: Totals | undefined): number {
  return totals ? totals.invoiced + totals.charged + totals.fees + totals.adjustments - totals.credits - totals.refunded : 0;
}

/**
 * The usage claims that count for one delegation: completion and partial_completion claims with usage that no later
 * correction superseded. Each claim reports the usage of the work it covers, so claims are summed, but a trace
 * recorded more than once (for example by both buyer and provider) counts once, from its latest claim.
 */
export function countedUsageClaims(claims: DeliveryClaim[]): DeliveryClaim[] {
  const superseded = new Set(claims.map((c) => c.supersedes_event_id).filter((id): id is string => id !== null));
  const byTrace = new Map<string, DeliveryClaim>();
  for (const c of claims) {
    if (!c.usage || superseded.has(c.event_id) || !USAGE_CLAIM_TYPES.includes(c.type)) continue;
    byTrace.set(c.usage.trace_digest, c);
  }
  return [...byTrace.values()];
}

export interface UsageCheckInput {
  delegation_id: string;
  currency: string;
  pricing: Pricing | null | undefined;
  /** This delegation's claims, in recorded order. */
  claims: DeliveryClaim[];
  billed_minor: number;
  /** Whether a provider key-signed, unexpired, unrevoked statement attests delivery.usage on this delegation's receipt. */
  provider_attested: boolean;
}

function sortedLabels(labels: Set<string>): AssuranceLabel[] {
  return ASSURANCE_LABELS.filter((l) => labels.has(l));
}

/**
 * Prices a delegation's usage at its agreed rates and compares it with what was billed, in both directions:
 * overbilling is the obvious risk, and underbilling often means a charge is missing or attributed elsewhere.
 * Null when the delegation has no pricing or no counted usage.
 */
export function usageCheckFor(input: UsageCheckInput): UsageCheck | null {
  if (!input.pricing) return null;
  const counted = countedUsageClaims(input.claims);
  if (counted.length === 0) return null;
  const cost = expectedCostFromUsage(
    input.pricing,
    counted.map((c) => c.usage!.summary),
  );
  const expected = cost.expected_minor;
  const allowed = expected === null ? null : allowedDifference(expected, input.pricing.tolerance_bps);
  const difference = expected === null ? null : input.billed_minor - expected;
  const labels = new Set<string>(counted.flatMap((c) => c.assurance).filter((l) => l !== "superseded"));
  if (input.provider_attested) labels.add("provider_key_signed");
  return {
    delegation_id: input.delegation_id,
    currency: input.currency,
    expected_minor: expected,
    lines: cost.lines,
    billed_minor: input.billed_minor,
    difference_minor: difference,
    allowed_difference_minor: allowed,
    within_tolerance: difference === null || allowed === null ? null : Math.abs(difference) <= allowed,
    unpriced: cost.unpriced,
    trace_digests: counted.map((c) => c.usage!.trace_digest).sort(),
    assurance: sortedLabels(labels),
  };
}

/** Delegations whose receipts carry an in-force provider key-signed attestation of delivery.usage. */
export function usageAttestedDelegations(responses: ResponseRecord[], receipts: { receipt_id: string; delegation_id: string }[]): Set<string> {
  const delegationOf = new Map(receipts.map((r) => [r.receipt_id, r.delegation_id]));
  const attested = new Set<string>();
  for (const r of responses) {
    const inForce = r.assurance.includes("provider_key_signed") && !r.assurance.includes("expired") && !r.assurance.includes("revoked");
    if (inForce && r.statement.response_type === "signed_attestation" && r.statement.fields.includes("delivery.usage")) {
      const delegationId = delegationOf.get(r.receipt_id);
      if (delegationId) attested.add(delegationId);
    }
  }
  return attested;
}

/** Usage checks for every delegation of a closure with pricing and counted usage, in delegation order. */
export function usageChecksFor(
  delegations: { delegation_id: string; currency: string; pricing?: Pricing }[],
  claims: DeliveryClaim[],
  rollup: Rollup,
  responses: ResponseRecord[],
  receipts: { receipt_id: string; delegation_id: string }[],
): UsageCheck[] {
  const attested = usageAttestedDelegations(responses, receipts);
  return delegations.flatMap((d) => {
    const node = rollup.nodes.find((n) => n.node_id === d.delegation_id);
    const result = usageCheckFor({
      delegation_id: d.delegation_id,
      currency: d.currency,
      pricing: d.pricing,
      claims: claims.filter((c) => c.delegation_id === d.delegation_id),
      billed_minor: billedMinor(node?.direct[d.currency]),
      provider_attested: attested.has(d.delegation_id),
    });
    return result ? [result] : [];
  });
}
