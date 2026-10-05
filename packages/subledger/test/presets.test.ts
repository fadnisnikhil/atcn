import { describe, expect, it } from "vitest";
import { FinancialEventInputSchema, derivedSourceEventId, exportRowsFromJson, importPresetRows, parseExportText } from "../src/index.js";

describe("import presets", () => {
  it("reads JSON, wrapped JSON, JSONL and CSV exports", () => {
    expect(parseExportText('{"data":[{"a":1}],"total":1}')).toEqual([{ a: 1 }]);
    expect(parseExportText('{"data":{"data":[{"a":1}]}}')).toEqual([{ a: 1 }]);
    expect(parseExportText('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseExportText('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseExportText("a,b\n1,2\n")).toEqual([{ a: "1", b: "2" }]);
    expect(() => exportRowsFromJson([1])).toThrow(/row 1 is not a JSON object/);
    expect(() => exportRowsFromJson({ data: "x" })).toThrow(/array of rows/);
  });

  it("sums LiteLLM sub-cent spend exactly per job reference per UTC day and rounds half up once", () => {
    const log = (request_id: string, end_user: string | null, spend: number | string, startTime: string) => ({ request_id, end_user, spend, startTime, model: "gpt-4o" });
    const result = importPresetRows("litellm", [
      log("r1", "job-a", 0.004, "2026-10-01T09:00:00Z"),
      log("r2", "job-a", 0.0011, "2026-10-01T23:59:59.999Z"),
      log("r3", "job-a", 1.82e-5, "2026-10-02T00:00:00"),
      log("r4", "job-b", 0.125, "2026-10-01 10:00:00"),
      log("r5", null, 2, "2026-10-01T10:00:00Z"),
      log("r6", "job-a", "abc", "2026-10-01T10:00:00Z"),
    ]);
    expect(result.events).toEqual([
      {
        row: 1,
        event: {
          type: "charge",
          source: "litellm",
          source_event_id: derivedSourceEventId({ provider_job_ref: "job-a", day: "2026-10-01" }),
          provider_reference: null,
          provider_status: null,
          amount_minor: 1,
          currency: "USD",
          event_date: "2026-10-01T00:00:00.000Z",
          match: { provider_job_ref: "job-a", task_external_ref: null, delegation_external_ref: null },
        },
      },
      expect.objectContaining({ row: 4, event: expect.objectContaining({ amount_minor: 13, match: expect.objectContaining({ provider_job_ref: "job-b" }) }) }),
    ]);
    for (const { event } of result.events) expect(FinancialEventInputSchema.safeParse(event).success).toBe(true);
    expect(result.skipped).toEqual([
      { row: 3, reason: "spend for job-a on 2026-10-02 rounds to 0 cents" },
      { row: 5, reason: "no end_user: send the ATCN job reference as the request's user field" },
    ]);
    expect(result.errors).toEqual([{ row: 6, error: "spend \"abc\" is not a non-negative decimal number" }]);
  });

  it("maps OpenRouter daily analytics rows by external_user", () => {
    const rows = exportRowsFromJson({
      data: {
        data: [
          { date__day: "2026-10-01", external_user: "job-a", request_count: "12", total_usage: 4.27 },
          { date__day: "2026-10-01", external_user: "", request_count: "3", total_usage: 1 },
        ],
      },
    });
    const result = importPresetRows("openrouter", rows, { source: "openrouter-prod" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].event).toMatchObject({ source: "openrouter-prod", amount_minor: 427, currency: "USD", event_date: "2026-10-01T00:00:00.000Z", match: { provider_job_ref: "job-a" } });
    expect(result.skipped).toEqual([{ row: 2, reason: "no external_user: send the ATCN job reference as the request's user field" }]);
  });

  it("maps Stripe balance rows by reporting category and skips rows that are not job cost", () => {
    const csv = [
      "balance_transaction_id,created_utc,currency,gross,fee,net,reporting_category,source_id,payment_metadata[atcn_job_ref],transfer_metadata[atcn_job_ref]",
      "txn_1,2026-10-01 10:00:00,usd,12.50,0.66,11.84,charge,ch_1,job-a,",
      "txn_2,2026-10-02 10:00:00,usd,-2.50,0.00,-2.50,refund,re_1,job-a,",
      "txn_3,2026-10-02 11:00:00,jpy,-500.00,0,-500.00,transfer,tr_1,,job-b",
      "txn_4,2026-10-03 11:00:00,jpy,200.00,0,200.00,transfer_reversal,trr_1,,job-b",
      "txn_5,2026-10-03 12:00:00,usd,-100.00,0,-100.00,payout,po_1,,",
      "txn_6,2026-10-03 12:00:00,usd,9.00,0.56,8.44,charge,ch_2,,",
      "txn_7,2026-10-03 12:00:00,usd,1.005,0,1.005,charge,ch_3,job-a,",
    ].join("\n");
    const result = importPresetRows("stripe", parseExportText(csv));
    expect(result.events.map(({ row, event }) => [row, event.type, event.amount_minor, event.currency, event.provider_reference, (event.match as { provider_job_ref: string }).provider_job_ref])).toEqual([
      [1, "charge", 1250, "USD", "ch_1", "job-a"],
      [2, "refund", 250, "USD", "re_1", "job-a"],
      [3, "payment_reported", 500, "JPY", "tr_1", "job-b"],
      [4, "refund", 200, "JPY", "trr_1", "job-b"],
    ]);
    expect(result.events[0].event).toMatchObject({ source: "stripe", source_event_id: "txn_1", event_date: "2026-10-01T10:00:00.000Z" });
    for (const { event } of result.events) expect(FinancialEventInputSchema.safeParse(event).success).toBe(true);
    expect(result.skipped).toEqual([
      { row: 5, reason: "reporting_category payout is not job cost" },
      { row: 6, reason: "no payment_metadata[atcn_job_ref]" },
    ]);
    expect(result.errors).toEqual([{ row: 7, error: "amount 1.005 has more than 2 decimal places" }]);
  });
});
