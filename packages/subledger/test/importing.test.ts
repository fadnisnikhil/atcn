import { describe, expect, it } from "vitest";
import { FinancialEventInputSchema, derivedSourceEventId, financialEventFromRow, importRows, majorToMinor, parseCsvRows, parseJsonlRows } from "../src/index.js";

describe("importing external exports", () => {
  it("parses quoted CSV and JSONL rows", () => {
    expect(parseCsvRows('id,note\r\n1,"a, ""quoted"" note"\n\n2,plain\n')).toEqual([
      { id: "1", note: 'a, "quoted" note' },
      { id: "2", note: "plain" },
    ]);
    expect(parseJsonlRows('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonlRows("[1]")).toThrow(/line 1 is not a JSON object/);
  });

  it("converts decimal amounts exactly and refuses extra precision", () => {
    expect(majorToMinor("12.5")).toBe(1250);
    expect(majorToMinor("0.07")).toBe(7);
    expect(majorToMinor("-3")).toBe(-300);
    expect(majorToMinor("1.234", 3)).toBe(1234);
    expect(() => majorToMinor("1.234")).toThrow(/more than 2 decimal places/);
    expect(() => majorToMinor("1e3")).toThrow(/not a decimal number/);
  });

  it("maps a gateway hold row to a valid hold event with a key derived from its identifying columns", () => {
    const row = { request_id: "req-1", task_id: "a2a-1", reserved_usd: "1.00", ts: "2026-10-01T11:51:00Z" };
    const event = financialEventFromRow(row, {
      kind: "hold",
      source: "cost-gateway",
      currency: "USD",
      keyColumns: ["request_id"],
      map: { source_ref: "request_id", provider_job_ref: "task_id", amount_major: "reserved_usd", event_date: "ts" },
    });
    expect(event).toMatchObject({
      type: "hold",
      source_event_id: derivedSourceEventId({ request_id: "req-1" }),
      amount_minor: 100,
      event_date: "2026-10-01T11:51:00.000Z",
      match: { provider_job_ref: "a2a-1" },
      expectation: { issued_by: "gateway", source_ref: "req-1", hold_status: "open", supersedes: null },
    });
    expect(FinancialEventInputSchema.safeParse(event).success).toBe(true);
    // Only the key columns form the key: a changed amount keeps the key, so the replay is caught as duplicate_event.
    expect(financialEventFromRow({ ...row, reserved_usd: "2.00" }, { kind: "hold", source: "cost-gateway", currency: "USD", keyColumns: ["request_id"], map: { amount_major: "reserved_usd", event_date: "ts" } }).source_event_id).toBe(event.source_event_id);
  });

  it("reports bad rows by number and keeps the good ones", () => {
    const result = importRows(
      [
        { id: "1", amount_minor: "100", currency: "USD", event_date: "2026-10-01T00:00:00Z" },
        { amount_minor: "100", currency: "USD", event_date: "2026-10-01T00:00:00Z" },
        { id: "3", amount_minor: "1.5", currency: "USD", event_date: "2026-10-01T00:00:00Z" },
        { id: "4", amount_minor: "100", currency: "USD", event_date: "yesterday" },
      ],
      { kind: "charge", source: "bill", map: { source_event_id: "id" } },
    );
    expect(result.events.map((e) => e.row)).toEqual([1]);
    expect(result.errors).toEqual([
      { row: 2, error: "missing source_event_id (column id); name the identifying columns with keyColumns" },
      { row: 3, error: "amount_minor 1.5 is not a whole number" },
      { row: 4, error: 'event_date "yesterday" is not a date' },
    ]);
  });
});
