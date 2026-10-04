import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usdCents } from "../src/record.js";
import { runX402Job } from "../src/run.js";
import { NETWORK, USDC } from "../src/sellers.js";

describe("x402 example", () => {
  it("links each x402 payment to the work it bought; a pending settlement stays unresolved and is flagged", async () => {
    const result = await runX402Job({ dataDir: mkdtempSync(join(tmpdir(), "atcn-x402-example-")) });
    expect(result.valid).toBe(true);
    expect(result.totals.USD).toMatchObject({ charged: 300, net_cost: 300, reported_paid: 290, unresolved: 10 });
    expect(result.open_exceptions.map((x) => x.kind)).toEqual(["missing_receipt", "charge_after_cancellation"]);
    const delegationIds = result.closure.payload.delegations.map((d) => d.delegation_id);
    expect(delegationIds).toHaveLength(3);
    const events = result.closure.payload.financial_events;
    expect(events.map((e) => e.record.type)).toEqual(["charge", "payment_reported", "charge", "payment_reported", "charge"]);
    for (const event of events) expect(delegationIds).toContain(event.attributed_to);
  });

  it("converts USDC atomic units to USD cents and refuses fractions of a cent", () => {
    const requirements = { scheme: "exact", network: NETWORK, asset: USDC, payTo: "0x0", maxTimeoutSeconds: 60 };
    expect(usdCents({ ...requirements, amount: "2500000" })).toBe(250);
    expect(() => usdCents({ ...requirements, amount: "1000" })).toThrow(/whole number of cents/);
    expect(() => usdCents({ ...requirements, asset: "0xunknown", amount: "10000" })).toThrow(/no USD conversion/);
  });
});
