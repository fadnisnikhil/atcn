import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESULTS_PATH, buildResults, loadVectors, mismatches, runVector, type Vector } from "../scripts/reconciliation.js";

const { vectors } = loadVectors();

describe("adversarial reconciliation vectors", () => {
  it.each(vectors.map((v) => [v.vector_id, v] as const))("%s", async (_id, vector) => {
    expect(mismatches(vector.expected, await runVector(vector))).toEqual([]);
  });

  it("keeps the published results file current (npm run gen:reconciliation)", async () => {
    expect(JSON.parse(readFileSync(RESULTS_PATH, "utf8"))).toEqual(await buildResults());
  });

  it("uses a late estimate when its import is declared retrospective", async () => {
    const backdated = vectors.find((v) => v.attack_class === "backdated_estimate")!;
    const retrospective: Vector = structuredClone(backdated);
    const estimateStep = retrospective.steps.find((s) => s.op === "financial_event" && s.body.type === "estimate")!;
    if (estimateStep.op === "financial_event") estimateStep.body.retrospective = true;
    expect((await runVector(retrospective)).exception_kinds).toEqual([]);
  });
});
