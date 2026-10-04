import { AGENT_TRACE_EVIDENCE_TYPE, usageCostDetails, type AgentTrace } from "@atcn/schema";
import { checkTraceBytes } from "./agentTrace.js";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

/**
 * Prices the usage in every trace covering a deliverable with the terms' agreed rates (terms schema 1.2) and checks
 * that the usage supports the deliverable's amount. Each trace must first pass every agent_trace rule. An amount below
 * usage cost passes, because the provider agreed to it; an amount above it fails beyond the agreed tolerance.
 * This checks the amount. It never computes a payout from usage.
 */
export const usageCostVerifier: VerifierPlugin = {
  name: "usage_cost",
  version: "1.0.0",
  evidenceTypes: [AGENT_TRACE_EVIDENCE_TYPE],
  run(context: VerifierContext): VerifierOutcome {
    const pricing = context.termsPricing ?? null;
    if (pricing === null) return invalid("the accepted terms carry no pricing", "pricing_missing");
    if (context.deliverableAmountMinor === undefined) return invalid("the deliverable amount was not supplied", "pricing_missing");

    const traces: AgentTrace[] = [];
    for (const [index, content] of (context.deliverableTraces ?? [context.content]).entries()) {
      const checked = checkTraceBytes(content, context);
      if (!checked.ok) return invalid(`trace ${index + 1}: ${checked.error}`, checked.code);
      traces.push(checked.trace);
    }

    const details = usageCostDetails(pricing, context.deliverableAmountMinor, traces);
    if (details.expected_minor === null) return invalid(`usage has no agreed rate: ${details.unpriced}`, "usage_unpriced", { ...details });
    if (details.within_tolerance === false) {
      return {
        status: "fail",
        kind: "deterministic",
        details: { ...details, code: "usage_cost_mismatch", error: `amount ${details.amount_minor} exceeds usage cost ${details.expected_minor} by more than ${details.allowed_difference_minor}` },
        model: null,
      };
    }
    return { status: "pass", kind: "deterministic", details: { ...details }, model: null };
  },
};

function invalid(error: string, code: string, extra: VerifierOutcome["details"] = {}): VerifierOutcome {
  return { status: "invalid_evidence", kind: "deterministic", details: { ...extra, error, code }, model: null };
}
