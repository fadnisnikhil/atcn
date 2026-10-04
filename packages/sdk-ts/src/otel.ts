import { AgentTraceSchema, TRACE_VERSION, type AgentTrace, type ExecutionBinding, type TraceStep } from "@atcn/schema";

/**
 * The OpenTelemetry GenAI conventions this mapping was written against. They are at "Development" status, so names may
 * change; every attribute name used below is in this file only.
 */
export const OTEL_GENAI_CONVENTIONS = "OpenTelemetry semantic conventions 1.41.0, GenAI spans";

const MODEL_OPERATIONS = ["chat", "generate_content", "text_completion", "embeddings"];
/** Not an OpenTelemetry attribute: set it on invoke_agent spans that call another agent over A2A, with the A2A task id. */
export const A2A_TASK_ID_ATTRIBUTE = "atcn.a2a.task_id";

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpSpan {
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: { key: string; value?: OtlpAnyValue }[];
}
/** An OTLP JSON trace export: resourceSpans[].scopeSpans[].spans[]. */
export interface OtlpTraceExport {
  resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}

export interface SkippedSpan {
  span_id: string;
  name: string;
  reason: string;
}

export interface OtelImportResult {
  trace: AgentTrace;
  /** Spans that did not become steps, with the reason, so nothing is dropped silently. */
  skipped: SkippedSpan[];
}

function attributes(span: OtlpSpan): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  for (const a of span.attributes ?? []) {
    const v = a.value ?? {};
    if (v.stringValue !== undefined) map.set(a.key, v.stringValue);
    else if (v.intValue !== undefined) map.set(a.key, Number(v.intValue));
    else if (v.doubleValue !== undefined) map.set(a.key, v.doubleValue);
    else if (v.boolValue !== undefined) map.set(a.key, v.boolValue);
  }
  return map;
}

function text(attrs: Map<string, string | number | boolean>, key: string): string | undefined {
  const value = attrs.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(attrs: Map<string, string | number | boolean>, key: string): number | undefined {
  const value = attrs.get(key);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isoFromNanos(nanos: string | number | undefined): string | undefined {
  if (nanos === undefined) return undefined;
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
}

function nanosOf(span: OtlpSpan): bigint {
  return span.startTimeUnixNano === undefined ? 0n : BigInt(span.startTimeUnixNano);
}

type Draft = Omit<TraceStep, "seq">;

function stepFromSpan(span: OtlpSpan): Draft | string {
  const attrs = attributes(span);
  const operation = text(attrs, "gen_ai.operation.name");
  if (operation === undefined) return "no gen_ai.operation.name";
  const started_at = isoFromNanos(span.startTimeUnixNano);
  const ended_at = isoFromNanos(span.endTimeUnixNano);
  if (started_at === undefined || ended_at === undefined) return "missing start or end time";

  if (MODEL_OPERATIONS.includes(operation)) {
    const provider = text(attrs, "gen_ai.provider.name");
    const name = text(attrs, "gen_ai.response.model") ?? text(attrs, "gen_ai.request.model");
    if (provider === undefined) return "model call without gen_ai.provider.name";
    if (name === undefined) return "model call without gen_ai.response.model or gen_ai.request.model";
    const input = count(attrs, "gen_ai.usage.input_tokens");
    const output = count(attrs, "gen_ai.usage.output_tokens");
    const cached = count(attrs, "gen_ai.usage.cache_read.input_tokens");
    const upstream = text(attrs, "gen_ai.response.id");
    return {
      kind: "model_call",
      started_at,
      ended_at,
      model: { provider, name },
      ...(input !== undefined || output !== undefined
        ? { usage: { input_tokens: input ?? 0, output_tokens: output ?? 0, ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}) } }
        : {}),
      ...(upstream !== undefined ? { upstream_ref: upstream } : {}),
    };
  }
  if (operation === "execute_tool") {
    const name = text(attrs, "gen_ai.tool.name");
    if (name === undefined) return "tool call without gen_ai.tool.name";
    const upstream = text(attrs, "gen_ai.tool.call.id");
    return { kind: "tool_call", started_at, ended_at, tool: { name }, ...(upstream !== undefined ? { upstream_ref: upstream } : {}) };
  }
  if (operation === "invoke_agent") {
    const taskId = text(attrs, A2A_TASK_ID_ATTRIBUTE);
    if (taskId === undefined) return `invoke_agent without ${A2A_TASK_ID_ATTRIBUTE}`;
    const agentId = text(attrs, "gen_ai.agent.id");
    return { kind: "a2a_call", started_at, ended_at, remote: { ...(agentId !== undefined ? { agent_id: agentId } : {}), task_id: taskId } };
  }
  return `operation ${operation} is not mapped`;
}

/**
 * Builds an AgentTrace for one run from an OTLP JSON export of GenAI spans. Steps are ordered by start time, then span
 * id. Spans that are not model calls, tool calls or A2A calls are returned in `skipped` with the reason.
 */
export function traceFromOtelSpans(otlp: OtlpTraceExport, execution: ExecutionBinding): OtelImportResult {
  const spans = (otlp.resourceSpans ?? []).flatMap((r) => (r.scopeSpans ?? []).flatMap((s) => s.spans ?? []));
  const ordered = [...spans].sort((a, b) => {
    const at = nanosOf(a);
    const bt = nanosOf(b);
    if (at !== bt) return at < bt ? -1 : 1;
    const aid = a.spanId ?? "";
    const bid = b.spanId ?? "";
    return aid < bid ? -1 : aid > bid ? 1 : 0;
  });
  const steps: TraceStep[] = [];
  const skipped: SkippedSpan[] = [];
  for (const span of ordered) {
    const step = stepFromSpan(span);
    if (typeof step === "string") skipped.push({ span_id: span.spanId ?? "", name: span.name ?? "", reason: step });
    else steps.push({ seq: steps.length, ...step });
  }
  if (steps.length === 0) throw new Error("the export has no GenAI model, tool or A2A spans");
  const trace = AgentTraceSchema.parse({ trace_version: TRACE_VERSION, execution, steps });
  return { trace, skipped };
}
