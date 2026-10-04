import { AGENT_TRACE_EVIDENCE_TYPE, checkTrace, summarizeTrace, traceDigest, utf8Decode, type TraceCheck, type TraceRun } from "@atcn/schema";
import type { VerifierContext, VerifierOutcome, VerifierPlugin } from "./types.js";

/** The runs a trace may belong to, from the counterparty's signed obligation.started events. */
export function traceRuns(context: VerifierContext): TraceRun[] {
  return (context.executions ?? []).map((e) => ({ execution_id: e.execution_id, execution_digest: e.execution_digest, descriptor: e.descriptor, started_at: e.started_at }));
}

/** Parses trace bytes and applies every agent_trace rule. */
export function checkTraceBytes(content: Uint8Array, context: VerifierContext): TraceCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(content));
  } catch {
    return { ok: false, code: "malformed", error: "trace is not JSON" };
  }
  return checkTrace(raw, traceRuns(context), context.evaluatedAt ?? null);
}

/**
 * Checks that a trace is well formed and belongs to a declared run: bound to it by digest, using only its declared
 * models, and inside its time window. A pass means the trace is consistent with the run, not that the run happened.
 */
export const agentTraceVerifier: VerifierPlugin = {
  name: "agent_trace",
  version: "1.0.0",
  evidenceTypes: [AGENT_TRACE_EVIDENCE_TYPE],
  run(context: VerifierContext): VerifierOutcome {
    const checked = checkTraceBytes(context.content, context);
    if (!checked.ok) return { status: "invalid_evidence", kind: "deterministic", details: { error: checked.error, code: checked.code }, model: null };
    const summary = summarizeTrace(checked.trace);
    return {
      status: "pass",
      kind: "deterministic",
      details: {
        execution_id: checked.trace.execution.execution_id,
        trace_digest: traceDigest(checked.trace),
        steps: checked.trace.steps.length,
        model_calls: summary.models.reduce((sum, m) => sum + m.calls, 0),
        input_tokens: summary.models.reduce((sum, m) => sum + m.input_tokens, 0),
        output_tokens: summary.models.reduce((sum, m) => sum + m.output_tokens, 0),
        tool_calls: summary.tools.reduce((sum, t) => sum + t.calls, 0),
        a2a_calls: summary.a2a_calls,
      },
      model: null,
    };
  },
};
