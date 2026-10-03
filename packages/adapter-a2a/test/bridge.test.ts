import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_POLICIES } from "@atcn/core";
import { LocalNetwork, LocalSubledger, loadOrCreateServiceKey } from "@atcn/local-runner";
import { acceptanceData, buildTerms, termsData } from "@atcn/sdk";
import { describe, expect, it } from "vitest";
import { A2AObligationBridge, localObligationClient, obligationIdFromMetadata, obligationTaskMetadata } from "../src/index.js";

const PASSING_JUNIT = `<?xml version="1.0"?><testsuites><testsuite name="unit"><testcase name="adds"/><testcase name="handles negatives"/></testsuite></testsuites>`;
const CLEAN_LINT = JSON.stringify([{ filePath: "src/math.ts", errorCount: 0, warningCount: 0, messages: [] }]);
const PATCH = "diff --git a/src/math.ts b/src/math.ts\n--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;\n";

function acceptedObligation() {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-a2a-")), "service-key.json"));
  const network = new LocalNetwork(new LocalSubledger(serviceKey, "Acme"), serviceKey);
  const buyer = network.registerAgent("Acme");
  const worker = network.registerAgent("Beta");
  const policy = REFERENCE_POLICIES.find((p) => p.policy_id === "code-change-checks" && p.policy_version === "1.0.0")!;
  const terms = buildTerms({
    principalId: network.registerPrincipal(),
    issuerAgentId: buyer.actorId,
    counterpartyAgentId: worker.actorId,
    description: "Delegated over A2A",
    currency: "USD",
    maxAmountMinor: 100,
    deliverables: [{ deliverable_id: "part-1", description: "fix", amount_minor: 100, required_checks: ["unit_tests", "lint", "patch"] }],
    policy,
  });
  network.offerObligation(buyer.sign("obligation.offered", terms.obligation_id, termsData(terms)));
  network.acceptObligation(worker.sign("obligation.accepted", terms.obligation_id, acceptanceData(terms, worker.actorId)));
  return { network, worker, obligationId: terms.obligation_id };
}

describe("A2A bridge", () => {
  it("round-trips the obligation id through A2A metadata", () => {
    expect(obligationIdFromMetadata(obligationTaskMetadata("obl_1"))).toBe("obl_1");
    expect(obligationIdFromMetadata({})).toBeNull();
    expect(obligationIdFromMetadata(undefined)).toBeNull();
  });

  it("turns an A2A v1.0 task stream into signed ATCN lifecycle and evidence events", async () => {
    const { network, worker, obligationId } = acceptedObligation();
    const bridge = new A2AObligationBridge({ client: localObligationClient(network), worker, obligationId });
    const evidenceMeta = (evidence_type: string, verifier: string) => ({ atcn: { evidence_type, verifier, deliverable_ids: ["part-1"] } });
    const task = { id: "task-1", contextId: "ctx-1", status: { state: "TASK_STATE_SUBMITTED" as const }, metadata: obligationTaskMetadata(obligationId) };

    expect(await bridge.handle({ task })).toEqual([]);
    const started = await bridge.handle({ statusUpdate: { taskId: "task-1", contextId: "ctx-1", status: { state: "TASK_STATE_WORKING" } } });
    expect(started).toMatchObject([{ kind: "event", eventType: "obligation.started" }]);

    // Chunked artifact: parts are joined only after lastChunk.
    const half = Math.floor(PASSING_JUNIT.length / 2);
    expect(
      await bridge.handle({ artifactUpdate: { taskId: "task-1", contextId: "ctx-1", lastChunk: false, artifact: { artifactId: "junit", parts: [{ text: PASSING_JUNIT.slice(0, half) }], metadata: evidenceMeta("test_report", "junit_tests") } } }),
    ).toEqual([]);
    const junitAction = await bridge.handle({
      artifactUpdate: { taskId: "task-1", contextId: "ctx-1", append: true, lastChunk: true, artifact: { artifactId: "junit", parts: [{ text: PASSING_JUNIT.slice(half) }], metadata: evidenceMeta("test_report", "junit_tests") } },
    });
    expect(junitAction).toMatchObject([{ kind: "evidence" }]);
    await bridge.handle({ artifactUpdate: { taskId: "task-1", contextId: "ctx-1", artifact: { artifactId: "lint", parts: [{ raw: Buffer.from(CLEAN_LINT).toString("base64"), mediaType: "application/json" }], metadata: evidenceMeta("lint_report", "eslint_lint") } } });
    await bridge.handle({ artifactUpdate: { taskId: "task-1", contextId: "ctx-1", artifact: { artifactId: "patch", parts: [{ text: PATCH, mediaType: "text/x-diff" }], metadata: evidenceMeta("patch_ref", "patch_digest") } } });
    expect(await bridge.handle({ artifactUpdate: { taskId: "task-1", contextId: "ctx-1", artifact: { artifactId: "notes", parts: [{ text: "summary" }] } } })).toMatchObject([{ kind: "skipped" }]);

    expect(await bridge.handle({ statusUpdate: { taskId: "task-1", contextId: "ctx-1", status: { state: "TASK_STATE_COMPLETED" } } })).toMatchObject([
      { kind: "event", eventType: "completion.proposed" },
    ]);
    expect(network.evaluate(obligationId).decision.outcome).toBe("accepted");
  });

  it("does not record failed or canceled tasks as payment facts", async () => {
    const { network, worker, obligationId } = acceptedObligation();
    const bridge = new A2AObligationBridge({ client: localObligationClient(network), worker, obligationId });
    expect(await bridge.handle({ statusUpdate: { taskId: "t", contextId: "c", status: { state: "TASK_STATE_FAILED" } } })).toMatchObject([{ kind: "skipped" }]);
    expect(network.obligation(obligationId).state).toBe("accepted");
  });
});
