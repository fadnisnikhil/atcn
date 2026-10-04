import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "@atcn/local-runner";
import { generateKeyPair } from "@atcn/schema";
import { delegationEventProblems, verifySubledgerDocument, type UsageRecord } from "@atcn/subledger";
import { describe, expect, it } from "vitest";
import {
  brokenEdgeGap,
  childDelegationFromA2A,
  downstreamFromMetadata,
  downstreamMetadata,
  lineageFromMetadata,
  lineageMetadata,
  outcomeClaimFromA2A,
  signOutcome,
} from "../src/index.js";

const gammaKeys = generateKeyPair();
const report = { uri: "https://gamma.example/runs/2/report.json", digest: `sha256:${"a".repeat(64)}`, evidence_type: "test_report" };

/**
 * The buyer delegates to Beta (task beta-task-1). Beta sends part of the work to Gamma and part to Delta, then reports
 * both sub-tasks upstream: Gamma's signed completion relayed unchanged, Delta with no outcome at all.
 */
function chain() {
  const betaTask = { id: "beta-task-1", contextId: "ctx-1", metadata: undefined };
  const toGamma = lineageMetadata(betaTask, "Beta");
  const gammaOutcome = signOutcome(
    { type: "completion", task_id: "gamma-task-2", occurred_at: "2026-10-01T12:06:00Z", note: "ranked 40 results", evidence: [report] },
    { keyId: "gamma-key", privateKey: gammaKeys.privateKey },
  );
  const betaReport = downstreamMetadata([
    { agent: "Gamma", task_id: "gamma-task-2", context_id: "ctx-1", outcome: gammaOutcome },
    { agent: "Delta", task_id: "delta-task-3", context_id: "ctx-1", outcome: null },
  ]);

  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-lineage-")), "service-key.json"));
  const s = new LocalSubledger(serviceKey, "Acme");
  const task = s.createTask({ external_ref: "job", currency: "USD" });
  const beta = s.createDelegation(task.task_id, { external_ref: "beta", provider_name_stated: "Beta", provider_job_ref: "beta-task-1", currency: "USD", downstream_visibility: "disclosed" });
  const gammaProvider = s.addProvider("Gamma", "gamma");
  const binding = s.bindProviderKey(gammaProvider.provider_id, gammaKeys.publicKey, "gamma-key");

  const children = downstreamFromMetadata(betaReport).map((edge) => {
    const known = edge.agent === "Gamma" ? gammaProvider.provider_id : undefined;
    const child = s.createDelegation(task.task_id, childDelegationFromA2A(edge, { parentDelegationId: beta.delegation_id, currency: "USD", providerId: known }));
    if (edge.outcome) s.appendDelegationEvent(child.delegation_id, outcomeClaimFromA2A(edge.outcome, { binding: known ? binding : undefined }));
    else s.reportCaptureGap(task.task_id, brokenEdgeGap(edge, child.delegation_id));
    return child;
  });
  const close = () => {
    const { closure } = s.closeTask(task.task_id, []);
    return { closure, report: verifySubledgerDocument(closure, { trustedKeys: [servicePublicKey(serviceKey)] }) };
  };
  return { s, task, beta, children, toGamma, close };
}

describe("A2A multi-hop lineage", () => {
  it("carries the chain of parent tasks down each hop", () => {
    const { toGamma } = chain();
    expect(lineageFromMetadata(toGamma)).toEqual([{ task_id: "beta-task-1", context_id: "ctx-1", agent: "Beta" }]);
    const toEpsilon = lineageMetadata({ id: "gamma-task-2", contextId: "ctx-9", metadata: toGamma }, "Gamma");
    expect(lineageFromMetadata(toEpsilon).map((hop) => hop.task_id)).toEqual(["beta-task-1", "gamma-task-2"]);
    expect(lineageFromMetadata(undefined)).toEqual([]);
  });

  it("records reported sub-tasks as child delegations: a sub-agent's signed outcome verifies offline, a missing one is a broken edge", () => {
    const { s, beta, children, close } = chain();
    const [gamma, delta] = children;
    expect(gamma).toMatchObject({ parent_delegation_id: beta.delegation_id, depth: 2, provider_job_ref: "gamma-task-2" });
    expect(s.delegation(gamma.delegation_id).delivery_status).toBe("completed");
    expect(s.claims.find((c) => c.delegation_id === gamma.delegation_id)).toMatchObject({ assurance: ["provider_key_signed"], evidence: [report] });

    const { closure, report: verification } = close();
    expect(verification.valid).toBe(true);
    expect(verification.checks.find((c) => c.name === "signed_claims")!.details).toEqual(["1 provider-signed outcome claim(s) verify"]);
    expect(closure.payload.lineage.complete).toBe(false);
    expect(closure.payload.lineage.capture_gaps).toEqual([expect.objectContaining({ delegation_id: delta.delegation_id, kind: "broken_edge", detail: "Delta task delta-task-3 reported no outcome" })]);
    expect(closure.payload.open_exceptions.map((x) => x.kind)).toContain("incomplete_lineage");
  });

  it("fails offline verification when the evidence pointer of a signed outcome is swapped after closing", () => {
    const { close } = chain();
    const { closure } = close();
    const tampered = structuredClone(closure);
    tampered.payload.delivery_claims.find((c) => c.signer)!.evidence[0].uri = "https://gamma.example/runs/2/other.json";
    const verification = verifySubledgerDocument(tampered, { trustedKeys: [] });
    expect(verification.checks.find((c) => c.name === "signed_claims")).toMatchObject({ ok: false, details: [expect.stringContaining("signature does not verify")] });
  });

  it("refuses a signed outcome that carries usage the signature does not cover", () => {
    const { s, children } = chain();
    const signer = s.claims.find((c) => c.delegation_id === children[0].delegation_id)!.signer;
    expect(delegationEventProblems({ type: "completion", asserted_by: "provider", signer, usage: {} as UsageRecord })).toEqual(["a signed claim cannot carry usage, which the outcome statement does not cover"]);
  });
});
