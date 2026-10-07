import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySubledgerDocument } from "@atcn/subledger";
import { describe, expect, it } from "vitest";
import { costEstimates, delegatedTasks, estimateEvent, formatUsd, readGatewayLogs } from "../src/gateway-logs.js";
import { runCostGatewayReconciliation } from "../src/run.js";

const exampleDir = fileURLToPath(new URL("..", import.meta.url));
const run = () =>
  runCostGatewayReconciliation({
    dataDir: mkdtempSync(join(tmpdir(), "atcn-cost-gateway-")),
    logsDir: join(exampleDir, "gateway-logs"),
    billPath: join(exampleDir, "litellm-spend.json"),
  });

const FIRST = "62c22827-2f08-458a-b62b-ad757fa10a52";
const SECOND = "cb08c12b-a44c-425f-930a-9c992f1d36c0";

describe("a2a-cost-gateway example", () => {
  it("matches the bill to the gateway's delegated A2A tasks and the closure verifies offline", () => {
    const result = run();
    expect(result.verification.valid).toBe(true);
    expect(result.closure.payload.delegations.map((d) => d.provider_job_ref)).toEqual([FIRST, SECOND]);
    expect(result.comparisons.map((c) => [c.a2a_task_id, c.billed_minor])).toEqual([
      [FIRST, 3],
      [SECOND, 1],
    ]);
    expect(result.totals.USD).toMatchObject({ charged: 4, net_cost: 4 });
    expect(result.skipped_bill_rows).toEqual([{ row: 5, reason: "no end_user: send the ATCN job reference as the request's user field" }]);
  });

  it("keeps the gateway's estimates with their exact amounts, flagged as issued after the first charge", () => {
    const result = run();
    const estimates = result.closure.payload.financial_events.map((e) => e.record).filter((r) => r.type === "estimate");
    expect(estimates).toHaveLength(2);
    expect(estimates[0]).toMatchObject({ source: "a2a-cost-gateway", amount_minor: 0, expectation: { issued_by: "gateway" } });
    expect(estimates[0].expectation!.basis).toContain("provider_tokenizer:openai:gpt-4o-mini: 3 input + 7 output tokens = USD 0.00000465 (0 cents)");
    expect(result.comparisons.map((c) => c.estimate_status)).toEqual(["after_charge", "after_charge"]);
    expect(result.open_exceptions.map((x) => x.kind).sort()).toEqual(["estimate_after_charge", "estimate_after_charge", "unmatched_charge"]);
  });

  it("detects a changed charge amount offline", () => {
    const result = run();
    const tampered = structuredClone(result.closure);
    tampered.payload.financial_events.find((e) => e.record.type === "charge" && e.record.amount_minor === 3)!.record.amount_minor = 1;
    expect(verifySubledgerDocument(tampered, { trustedKeys: result.trusted_keys }).valid).toBe(false);
  });
});

describe("reading gateway logs", () => {
  it("records no estimate when the gateway logged token counts but no dollar figure", () => {
    const dir = mkdtempSync(join(tmpdir(), "atcn-gateway-logs-"));
    const line = (record: object) => `${JSON.stringify(record)}\n`;
    writeFileSync(
      join(dir, "run_1.jsonl"),
      line({ timestamp: "2026-10-07T10:00:00.000001+00:00", task_id: "", event_type: "agent_card_fetch", actor: "coordinator", payload: { name: "Specialist" } }) +
        line({ timestamp: "2026-10-07T10:00:01+00:00", task_id: "t-1", event_type: "task_response", actor: "coordinator", payload: { task: { id: "t-1", status: { state: "TASK_STATE_FAILED" } } } }),
    );
    writeFileSync(
      join(dir, "run_2.jsonl"),
      line({
        timestamp: "2026-10-07T10:00:01+00:00",
        task_id: "t-1",
        event_type: "cost_estimate",
        actor: "gateway",
        payload: { task_id: "t-1", estimation_method: "generic_fallback", input_tokens: 4, output_tokens: 5, estimated_cost_usd: null, rate_source: "not_configured", scope_note: "" },
      }),
    );
    const events = readGatewayLogs(dir);
    expect(events[0].timestamp).toBe("2026-10-07T10:00:00.000Z");
    expect(delegatedTasks(events)).toEqual([{ a2a_task_id: "t-1", agent_name: "Specialist", final_state: "TASK_STATE_FAILED", logged_at: "2026-10-07T10:00:01.000Z" }]);
    const [estimate] = costEstimates(events);
    expect(estimate).toMatchObject({ a2a_task_id: "t-1", estimation_method: "generic_fallback", estimated_cost_usd: null });
    expect(estimateEvent(estimate)).toBeNull();
  });

  it("formats float USD amounts without exponent notation", () => {
    expect(formatUsd(4.6499999999999995e-6)).toBe("0.00000465");
    expect(formatUsd(0.0117)).toBe("0.0117");
    expect(formatUsd(2)).toBe("2");
  });
});
