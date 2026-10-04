import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runA2ADelegation } from "../src/run.js";

describe("A2A delegation example", () => {
  it("records both A2A delegations and the provider's bill, and the closure verifies offline", async () => {
    const result = await runA2ADelegation({ dataDir: mkdtempSync(join(tmpdir(), "atcn-a2a-example-")) });
    expect(result.valid).toBe(true);
    expect(result.totals.USD).toMatchObject({ charged: 10_200, fees: 1_000, net_cost: 11_200, reported_paid: 9_000, unresolved: 2_200 });
    expect(result.open_exceptions.map((x) => x.kind)).toEqual(["unmatched_charge"]);
    expect(result.closure.payload.delegations).toHaveLength(2);
    expect(result.execution).toMatchObject({ protocol: { name: "a2a" }, agent: { agent_version: "1.0.0" }, skill: { namespace: "a2a", skill_id: "code-fix" } });
    expect(result.execution?.execution_id).toBe(`a2a:${result.execution?.protocol?.task_id}`);
  });
});
