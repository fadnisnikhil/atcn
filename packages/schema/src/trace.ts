import { z } from "zod";
import { digestOf } from "./crypto.js";
import { Digest, ExecutionBindingSchema, Timestamp, type ExecutionDescriptor } from "./types.js";

/**
 * The trace of one run: its model calls, tool calls and A2A calls, with token usage per model call.
 * Prompts and outputs never appear; io_digest can commit to them without disclosing them.
 * The schemas are strict, so a trace with fields this version does not know is refused rather than silently reduced.
 */

export const TRACE_VERSION = "1.0" as const;
export const TRACE_STEP_KINDS = ["model_call", "tool_call", "a2a_call"] as const;
export const AGENT_TRACE_EVIDENCE_TYPE = "agent_trace" as const;

const Count = z.number().int().nonnegative().refine(Number.isSafeInteger, "count must be a safe integer");

export const ModelRefSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const TraceStepSchema = z.strictObject({
  seq: Count,
  kind: z.enum(TRACE_STEP_KINDS),
  started_at: Timestamp,
  ended_at: Timestamp,
  model: ModelRefSchema.optional(),
  tool: z.strictObject({ name: z.string().min(1).max(200) }).optional(),
  remote: z.strictObject({ agent_id: z.string().min(1).max(200).optional(), task_id: z.string().min(1).max(200) }).optional(),
  usage: z
    .strictObject({
      /** All input tokens, including cached ones, as OpenTelemetry's gen_ai.usage.input_tokens defines them. */
      input_tokens: Count,
      output_tokens: Count,
      cache_read_input_tokens: Count.optional(),
    })
    .optional(),
  /** The model provider's response id, or the tool call id, so an independent witness can match the call. */
  upstream_ref: z.string().min(1).max(200).optional(),
  io_digest: Digest.optional(),
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const AgentTraceSchema = z.strictObject({
  trace_version: z.literal(TRACE_VERSION),
  execution: ExecutionBindingSchema,
  steps: z.array(TraceStepSchema).min(1).max(10000),
});
export type AgentTrace = z.infer<typeof AgentTraceSchema>;

export const UsageSummarySchema = z.strictObject({
  models: z.array(
    z.strictObject({
      provider: z.string().min(1).max(100),
      name: z.string().min(1).max(200),
      calls: Count,
      input_tokens: Count,
      output_tokens: Count,
      cache_read_input_tokens: Count,
    }),
  ),
  tools: z.array(z.strictObject({ name: z.string().min(1).max(200), calls: Count })),
  a2a_calls: Count,
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/** Digest of a trace over its canonical JSON, so whitespace and key order in the file do not matter. */
export function traceDigest(trace: AgentTrace): string {
  return digestOf(trace);
}

/** Rules a schema cannot express. An empty list means the trace is well formed. */
export function traceProblems(trace: AgentTrace): string[] {
  const problems: string[] = [];
  let previousSeq = -1;
  for (const step of trace.steps) {
    const at = `step ${step.seq}`;
    if (step.seq <= previousSeq) problems.push(`${at}: seq must increase`);
    previousSeq = Math.max(previousSeq, step.seq);
    if (Date.parse(step.ended_at) < Date.parse(step.started_at)) problems.push(`${at}: ended_at is before started_at`);
    if (step.kind === "model_call" && !step.model) problems.push(`${at}: a model_call needs model`);
    if (step.kind !== "model_call" && step.model) problems.push(`${at}: only a model_call has model`);
    if (step.kind !== "model_call" && step.usage) problems.push(`${at}: only a model_call has usage`);
    if (step.kind === "tool_call" && !step.tool) problems.push(`${at}: a tool_call needs tool`);
    if (step.kind !== "tool_call" && step.tool) problems.push(`${at}: only a tool_call has tool`);
    if (step.kind === "a2a_call" && !step.remote) problems.push(`${at}: an a2a_call needs remote`);
    if (step.kind !== "a2a_call" && step.remote) problems.push(`${at}: only an a2a_call has remote`);
    if (step.usage && (step.usage.cache_read_input_tokens ?? 0) > step.usage.input_tokens) problems.push(`${at}: cache_read_input_tokens exceeds input_tokens`);
  }
  return problems;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Totals per model and per tool, with every list sorted, so equal traces always give equal summaries. */
export function summarizeTrace(trace: AgentTrace): UsageSummary {
  const models = new Map<string, UsageSummary["models"][number]>();
  const tools = new Map<string, number>();
  let a2aCalls = 0;
  for (const step of trace.steps) {
    if (step.kind === "model_call" && step.model) {
      const key = JSON.stringify([step.model.provider, step.model.name]);
      const entry = models.get(key) ?? { provider: step.model.provider, name: step.model.name, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
      entry.calls += 1;
      entry.input_tokens += step.usage?.input_tokens ?? 0;
      entry.output_tokens += step.usage?.output_tokens ?? 0;
      entry.cache_read_input_tokens += step.usage?.cache_read_input_tokens ?? 0;
      models.set(key, entry);
    }
    if (step.kind === "tool_call" && step.tool) tools.set(step.tool.name, (tools.get(step.tool.name) ?? 0) + 1);
    if (step.kind === "a2a_call") a2aCalls += 1;
  }
  return {
    models: [...models.values()].sort((a, b) => byText(a.provider, b.provider) || byText(a.name, b.name)),
    tools: [...tools.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => byText(a.name, b.name)),
    a2a_calls: a2aCalls,
  };
}

/** Whether a model is the run's declared model or one of its additional models. A run that declares none allows any. */
export function modelAllowed(run: ExecutionDescriptor, model: ModelRef): boolean {
  const declared = [run.agent.model, ...(run.agent.additional_models ?? [])].filter((m) => m !== undefined);
  if (declared.length === 0) return true;
  return declared.some((m) => m.provider === model.provider && m.name === model.name);
}

export type TraceRuleCode = "malformed" | "execution_not_declared" | "model_mismatch" | "trace_outside_run";

export interface TraceRun {
  execution_id: string;
  execution_digest: string;
  descriptor: ExecutionDescriptor;
  /** Service-recorded time the run was declared. Without it, the start bound is not checked. */
  started_at?: string;
}

export type TraceCheck = { ok: true; trace: AgentTrace } | { ok: false; code: TraceRuleCode; error: string };

/**
 * Parses a trace and checks it against the declared runs: well formed, bound to a declared run, using only that run's
 * declared models, and inside the run's time window (from the declaration to `endAt`).
 */
export function checkTrace(raw: unknown, runs: TraceRun[], endAt: string | null): TraceCheck {
  const parsed = AgentTraceSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: "malformed", error: `trace does not match the schema: ${issue.path.join(".")}: ${issue.message}` };
  }
  const trace = parsed.data;
  const problems = traceProblems(trace);
  if (problems.length > 0) return { ok: false, code: "malformed", error: problems.join("; ") };
  const run = runs.find((r) => r.execution_id === trace.execution.execution_id && r.execution_digest === trace.execution.execution_digest);
  if (!run) return { ok: false, code: "execution_not_declared", error: `run ${trace.execution.execution_id} with digest ${trace.execution.execution_digest} was not declared` };
  for (const step of trace.steps) {
    if (step.model && !modelAllowed(run.descriptor, step.model)) {
      return { ok: false, code: "model_mismatch", error: `step ${step.seq} uses ${step.model.provider}/${step.model.name}, which run ${run.execution_id} did not declare` };
    }
    if (run.started_at !== undefined && Date.parse(step.started_at) < Date.parse(run.started_at)) {
      return { ok: false, code: "trace_outside_run", error: `step ${step.seq} starts at ${step.started_at}, before run ${run.execution_id} was declared at ${run.started_at}` };
    }
    if (endAt !== null && Date.parse(step.ended_at) > Date.parse(endAt)) {
      return { ok: false, code: "trace_outside_run", error: `step ${step.seq} ends at ${step.ended_at}, after ${endAt}` };
    }
  }
  return { ok: true, trace };
}
