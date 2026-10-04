"""Agent traces, the OpenTelemetry GenAI import, and usage pricing - identical results to the TypeScript SDK.

A trace records one run's model calls, tool calls and A2A calls, with token usage per model call. Prompts and outputs
never appear. These helpers do not validate a trace's JSON schema; the API and the offline verifier do.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from .canonical import MAX_SAFE_INTEGER, _utf16_sort_key
from .crypto import digest_of

Json = dict[str, Any]

TRACE_VERSION = "1.0"
OTEL_GENAI_CONVENTIONS = "OpenTelemetry semantic conventions 1.41.0, GenAI spans"
# Not an OpenTelemetry attribute: set it on invoke_agent spans that call another agent over A2A, with the A2A task id.
A2A_TASK_ID_ATTRIBUTE = "atcn.a2a.task_id"
_MODEL_OPERATIONS = ["chat", "generate_content", "text_completion", "embeddings"]


# ---------- Traces ----------


def trace_digest(trace: Json) -> str:
    """Digest of a trace over its canonical JSON, so whitespace and key order in the file do not matter."""
    return digest_of(trace)


def trace_problems(trace: Json) -> list[str]:
    """Rules a schema cannot express. An empty list means the trace is well formed."""
    from .projection import date_parse  # projection imports this module

    problems: list[str] = []
    previous_seq = -1
    for step in trace["steps"]:
        at = f"step {step['seq']}"
        kind = step["kind"]
        usage = step.get("usage")
        if step["seq"] <= previous_seq:
            problems.append(f"{at}: seq must increase")
        previous_seq = max(previous_seq, step["seq"])
        if date_parse(step["ended_at"]) < date_parse(step["started_at"]):
            problems.append(f"{at}: ended_at is before started_at")
        if kind == "model_call" and "model" not in step:
            problems.append(f"{at}: a model_call needs model")
        if kind != "model_call" and "model" in step:
            problems.append(f"{at}: only a model_call has model")
        if kind != "model_call" and usage is not None:
            problems.append(f"{at}: only a model_call has usage")
        if kind == "tool_call" and "tool" not in step:
            problems.append(f"{at}: a tool_call needs tool")
        if kind != "tool_call" and "tool" in step:
            problems.append(f"{at}: only a tool_call has tool")
        if kind == "a2a_call" and "remote" not in step:
            problems.append(f"{at}: an a2a_call needs remote")
        if kind != "a2a_call" and "remote" in step:
            problems.append(f"{at}: only an a2a_call has remote")
        if usage is not None and usage.get("cache_read_input_tokens", 0) > usage["input_tokens"]:
            problems.append(f"{at}: cache_read_input_tokens exceeds input_tokens")
    return problems


def summarize_trace(trace: Json) -> Json:
    """Totals per model and per tool, with every list sorted, so equal traces always give equal summaries."""
    models: dict[tuple[str, str], Json] = {}
    tools: dict[str, int] = {}
    a2a_calls = 0
    for step in trace["steps"]:
        if step["kind"] == "model_call" and "model" in step:
            key = (step["model"]["provider"], step["model"]["name"])
            entry = models.setdefault(key, {"provider": key[0], "name": key[1], "calls": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0})
            usage = step.get("usage", {})
            entry["calls"] += 1
            entry["input_tokens"] = _js_add(entry["input_tokens"], usage.get("input_tokens", 0))
            entry["output_tokens"] = _js_add(entry["output_tokens"], usage.get("output_tokens", 0))
            entry["cache_read_input_tokens"] = _js_add(entry["cache_read_input_tokens"], usage.get("cache_read_input_tokens", 0))
        if step["kind"] == "tool_call" and "tool" in step:
            tools[step["tool"]["name"]] = tools.get(step["tool"]["name"], 0) + 1
        if step["kind"] == "a2a_call":
            a2a_calls += 1
    return {
        "models": sorted(models.values(), key=lambda m: (_utf16_sort_key(m["provider"]), _utf16_sort_key(m["name"]))),
        "tools": sorted(({"name": name, "calls": calls} for name, calls in tools.items()), key=lambda t: _utf16_sort_key(t["name"])),
        "a2a_calls": a2a_calls,
    }


# ---------- OpenTelemetry GenAI import ----------


def _attributes(span: Json) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for attribute in span.get("attributes", []):
        value = attribute.get("value", {})
        if "stringValue" in value:
            values[attribute["key"]] = value["stringValue"]
        elif "intValue" in value:
            try:
                values[attribute["key"]] = int(value["intValue"])
            except (TypeError, ValueError):
                values[attribute["key"]] = None
        elif "doubleValue" in value:
            values[attribute["key"]] = value["doubleValue"]
        elif "boolValue" in value:
            values[attribute["key"]] = value["boolValue"]
    return values


def _text(attrs: dict[str, Any], key: str) -> str | None:
    value = attrs.get(key)
    return value if isinstance(value, str) and value else None


def _count(attrs: dict[str, Any], key: str) -> int | None:
    value = attrs.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != int(value) or not 0 <= value <= MAX_SAFE_INTEGER:
        return None
    return int(value)


def _iso_from_nanos(nanos: Any) -> str | None:
    if nanos is None:
        return None
    millis = int(nanos) // 1_000_000
    moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=millis)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{millis % 1000:03d}Z"


def _step_from_span(span: Json) -> Json | str:
    attrs = _attributes(span)
    operation = _text(attrs, "gen_ai.operation.name")
    if operation is None:
        return "no gen_ai.operation.name"
    started_at = _iso_from_nanos(span.get("startTimeUnixNano"))
    ended_at = _iso_from_nanos(span.get("endTimeUnixNano"))
    if started_at is None or ended_at is None:
        return "missing start or end time"

    if operation in _MODEL_OPERATIONS:
        provider = _text(attrs, "gen_ai.provider.name")
        name = _text(attrs, "gen_ai.response.model") or _text(attrs, "gen_ai.request.model")
        if provider is None:
            return "model call without gen_ai.provider.name"
        if name is None:
            return "model call without gen_ai.response.model or gen_ai.request.model"
        step: Json = {"kind": "model_call", "started_at": started_at, "ended_at": ended_at, "model": {"provider": provider, "name": name}}
        input_tokens = _count(attrs, "gen_ai.usage.input_tokens")
        output_tokens = _count(attrs, "gen_ai.usage.output_tokens")
        cached = _count(attrs, "gen_ai.usage.cache_read.input_tokens")
        if input_tokens is not None or output_tokens is not None:
            step["usage"] = {"input_tokens": input_tokens or 0, "output_tokens": output_tokens or 0}
            if cached is not None:
                step["usage"]["cache_read_input_tokens"] = cached
        upstream = _text(attrs, "gen_ai.response.id")
        if upstream is not None:
            step["upstream_ref"] = upstream
        return step
    if operation == "execute_tool":
        tool_name = _text(attrs, "gen_ai.tool.name")
        if tool_name is None:
            return "tool call without gen_ai.tool.name"
        step = {"kind": "tool_call", "started_at": started_at, "ended_at": ended_at, "tool": {"name": tool_name}}
        upstream = _text(attrs, "gen_ai.tool.call.id")
        if upstream is not None:
            step["upstream_ref"] = upstream
        return step
    if operation == "invoke_agent":
        task_id = _text(attrs, A2A_TASK_ID_ATTRIBUTE)
        if task_id is None:
            return f"invoke_agent without {A2A_TASK_ID_ATTRIBUTE}"
        agent_id = _text(attrs, "gen_ai.agent.id")
        remote: Json = {"agent_id": agent_id, "task_id": task_id} if agent_id is not None else {"task_id": task_id}
        return {"kind": "a2a_call", "started_at": started_at, "ended_at": ended_at, "remote": remote}
    return f"operation {operation} is not mapped"


def trace_from_otel_spans(otlp: Json, execution: Json) -> tuple[Json, list[Json]]:
    """
    Builds an AgentTrace for one run from an OTLP JSON export of GenAI spans. Steps are ordered by start time, then span
    id. Returns (trace, skipped): spans that are not model, tool or A2A calls are listed in skipped with the reason.
    """
    spans = [span for resource in otlp.get("resourceSpans", []) for scope in resource.get("scopeSpans", []) for span in scope.get("spans", [])]
    ordered = sorted(spans, key=lambda s: (int(s.get("startTimeUnixNano", 0)), s.get("spanId", "")))
    steps: list[Json] = []
    skipped: list[Json] = []
    for span in ordered:
        step = _step_from_span(span)
        if isinstance(step, str):
            skipped.append({"span_id": span.get("spanId", ""), "name": span.get("name", ""), "reason": step})
        else:
            steps.append({"seq": len(steps), **step})
    if not steps:
        raise ValueError("the export has no GenAI model, tool or A2A spans")
    return {"trace_version": TRACE_VERSION, "execution": execution, "steps": steps}, skipped


# ---------- Pricing ----------
# Sums follow JavaScript numbers (exact while safe, then floating point) so results past 2**53 match the TypeScript SDK.


def _js_add(a: int | float, b: int | float) -> int | float:
    """a + b as JavaScript adds numbers. An integral float in the safe range is returned as an int."""
    if isinstance(a, int) and isinstance(b, int) and abs(a + b) <= MAX_SAFE_INTEGER:
        return a + b
    total = float(a) + float(b)
    return int(total) if total.is_integer() and abs(total) <= MAX_SAFE_INTEGER else total


def _js_number_of(value: int) -> int | float:
    """Number(bigint): exact in the safe range, otherwise the nearest float."""
    return value if abs(value) <= MAX_SAFE_INTEGER else float(value)


def _usage_items(summaries: list[Json]) -> list[Json]:
    """Usage from several summaries as metered items. Cached input tokens are split out of input_tokens."""
    models: dict[tuple[str, str], Json] = {}
    tools: dict[str, int] = {}
    a2a_calls = 0
    for summary in summaries:
        for m in summary["models"]:
            key = (m["provider"], m["name"])
            entry = models.setdefault(key, {"calls": 0, "uncached": 0, "cached": 0, "output": 0})
            entry["calls"] = _js_add(entry["calls"], m["calls"])
            entry["uncached"] = _js_add(entry["uncached"], _js_add(m["input_tokens"], -m["cache_read_input_tokens"]))
            entry["cached"] = _js_add(entry["cached"], m["cache_read_input_tokens"])
            entry["output"] = _js_add(entry["output"], m["output_tokens"])
        for t in summary["tools"]:
            tools[t["name"]] = tools.get(t["name"], 0) + t["calls"]
        a2a_calls += summary["a2a_calls"]
    items: list[Json] = []
    for (provider, name), m in models.items():
        model = {"provider": provider, "name": name}
        for meter, units in [("input_tokens", m["uncached"]), ("cache_read_input_tokens", m["cached"]), ("output_tokens", m["output"]), ("model_call", m["calls"])]:
            items.append({"meter": meter, "model": model, "units": units, "label": f"model:{provider}/{name}:{meter}"})
    for tool_name, calls in tools.items():
        items.append({"meter": "tool_call", "tool_name": tool_name, "units": calls, "label": f"tool:{tool_name}:tool_call"})
    items.append({"meter": "a2a_call", "units": a2a_calls, "label": "a2a_call"})
    return [item for item in items if item["units"] > 0]


def _find_rate(rates: list[Json], meter: str, item: Json) -> int:
    for index, rate in enumerate(rates):
        if rate["meter"] != meter:
            continue
        same_model = "model" in item and rate.get("model") == item["model"]
        same_tool = "tool_name" in item and rate.get("tool_name") == item["tool_name"]
        if same_model or same_tool:
            return index
    for index, rate in enumerate(rates):
        if rate["meter"] == meter and "model" not in rate and "tool_name" not in rate:
            return index
    return -1


def _line_cost(units: int | float, rate: Json) -> int | float:
    """units x numerator / denominator, rounded half up to a whole minor unit, computed exactly."""
    numerator = int(units) * rate["price_numerator"]
    denominator = rate["price_denominator"]
    return _js_number_of((2 * numerator + denominator) // (2 * denominator))


def expected_cost_from_usage(pricing: Json, summaries: list[Json]) -> Json:
    """
    Prices usage with agreed rates. A specific rate (naming the model or tool) wins over a general one. Cached input
    tokens without a cache rate are priced at the input_tokens rate. A meter that no rate names is not charged; usage on
    a meter that some rate names, but that no rate matches, is unpriced. Each rate line rounds half up once, then the
    lines are summed with fixed_minor. expected_minor is None when anything is unpriced.
    """
    rates = pricing["rates"]
    units: dict[int, int] = {}
    unpriced: list[str] = []

    def charged(meter: str) -> bool:
        return any(rate["meter"] == meter for rate in rates)

    for item in _usage_items(summaries):
        cached = item["meter"] == "cache_read_input_tokens"
        index = _find_rate(rates, item["meter"], item)
        if index < 0 and cached:
            index = _find_rate(rates, "input_tokens", item)
        if index >= 0:
            units[index] = _js_add(units.get(index, 0), item["units"])
        elif charged(item["meter"]) or (cached and charged("input_tokens")):
            unpriced.append(item["label"])
    lines: list[Json] = []
    for index, rate in enumerate(rates):
        if index not in units:
            continue
        line: Json = {"meter": rate["meter"]}
        if "model" in rate:
            line["model"] = rate["model"]
        if "tool_name" in rate:
            line["tool_name"] = rate["tool_name"]
        line["units"] = units[index]
        line["cost_minor"] = _line_cost(units[index], rate)
        lines.append(line)
    total = pricing.get("fixed_minor", 0)
    for line in lines:
        total = _js_add(total, line["cost_minor"])
    return {"expected_minor": None if unpriced else total, "lines": lines, "unpriced": sorted(unpriced, key=_utf16_sort_key)}


def allowed_difference(expected_minor: int | float, tolerance_bps: int) -> int | float:
    """The difference billed allows before it counts as a mismatch: expected x tolerance_bps / 10000, rounded down."""
    return _js_number_of(int(expected_minor) * tolerance_bps // 10000)


def usage_cost_details(pricing: Json, amount_minor: int, traces: list[Json]) -> Json:
    """
    What the usage_cost verifier records about one deliverable. The amount may be below usage cost; it may exceed it
    only within the tolerance. Traces with the same digest are priced once.
    """
    by_digest = {trace_digest(trace): trace for trace in traces}
    digests = sorted(by_digest, key=_utf16_sort_key)
    cost = expected_cost_from_usage(pricing, [summarize_trace(by_digest[d]) for d in digests])
    expected = cost["expected_minor"]
    allowed = None if expected is None else allowed_difference(expected, pricing["tolerance_bps"])
    difference = None if expected is None else _js_add(amount_minor, -expected)
    return {
        "expected_minor": expected,
        "amount_minor": amount_minor,
        "difference_minor": difference,
        "allowed_difference_minor": allowed,
        "within_tolerance": None if difference is None or allowed is None else difference <= allowed,
        "trace_digests": ",".join(digests),
        "lines_digest": digest_of(cost["lines"]),
        "unpriced": ",".join(cost["unpriced"]),
    }
