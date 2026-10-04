import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "@atcn/local-runner";
import { generateKeyPair } from "@atcn/schema";
import { verifySubledgerDocument } from "@atcn/subledger";
import { describe, expect, it } from "vitest";
import { outcomeClaimFromA2A, outcomeFromMetadata, signedOutcomeMetadata, terminalClaimType } from "../src/index.js";

const keys = generateKeyPair();

/** A buyer with one delegation to an A2A agent (task "a2a-task-7"), the agent's key bound, and a charge of 500. */
function failedTask(state: "TASK_STATE_FAILED" | "TASK_STATE_CANCELED" | "TASK_STATE_REJECTED" = "TASK_STATE_FAILED") {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-outcome-")), "service-key.json"));
  const s = new LocalSubledger(serviceKey, "Acme");
  const task = s.createTask({ external_ref: "job", currency: "USD" });
  const provider = s.addProvider("Gamma Search", "gamma");
  const delegation = s.createDelegation(task.task_id, { external_ref: "search", provider_id: provider.provider_id, provider_job_ref: "a2a-task-7", currency: "USD" });
  const binding = s.bindProviderKey(provider.provider_id, keys.publicKey, "gamma-key");
  s.recordFinancialEvent({ type: "charge", source: "gamma", source_event_id: "ch-1", amount_minor: 500, currency: "USD", event_date: "2026-10-01T12:00:00Z", match: { provider_job_ref: "a2a-task-7" } });
  const metadata = signedOutcomeMetadata(
    { type: terminalClaimType(state), task_id: "a2a-task-7", occurred_at: "2026-10-01T12:05:00Z", note: "upstream index unavailable", evidence: [] },
    { keyId: "gamma-key", privateKey: keys.privateKey },
  );
  const terminal = outcomeFromMetadata(metadata)!;
  const close = () => {
    const { closure } = s.closeTask(task.task_id, []);
    return { closure, report: verifySubledgerDocument(closure, { trustedKeys: [servicePublicKey(serviceKey)] }) };
  };
  return { s, task, delegation, binding, terminal, close };
}

describe("A2A signed outcomes for terminal states", () => {
  it("records a signed failure as provider_key_signed; an unrefunded charge on it shows in the closure, which verifies offline", () => {
    const { s, delegation, binding, terminal, close } = failedTask();
    const claim = s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A(terminal, { binding }));
    expect(claim).toMatchObject({ type: "provider_failure", asserted_by: "provider", assurance: ["provider_key_signed"], occurred_at: "2026-10-01T12:05:00.000Z" });
    expect(s.delegation(delegation.delegation_id).delivery_status).toBe("provider_failed");

    const { closure, report } = close();
    expect(report.valid).toBe(true);
    expect(report.checks.find((c) => c.name === "signed_claims")!.details).toEqual(["1 provider-signed outcome claim(s) verify"]);
    expect(closure.payload.open_exceptions.map((x) => x.kind)).toContain("charge_after_cancellation");
  });

  it("nets a refunded charge to zero with no open exception", () => {
    const { s, task, delegation, binding, terminal, close } = failedTask();
    s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A(terminal, { binding }));
    expect(s.summary(task.task_id).open_exceptions.map((x) => x.kind)).toContain("charge_after_cancellation");
    s.recordFinancialEvent({ type: "refund", source: "gamma", source_event_id: "rf-1", amount_minor: 500, currency: "USD", event_date: "2026-10-01T12:10:00Z", match: { provider_job_ref: "a2a-task-7" } });

    const { closure, report } = close();
    expect(report.valid).toBe(true);
    expect(closure.payload.rollup.nodes.find((n) => n.node_id === delegation.delegation_id)!.direct.USD.net_cost).toBe(0);
    expect(closure.payload.open_exceptions).toEqual([]);
  });

  it("maps canceled and rejected tasks to cancellation claims", () => {
    for (const state of ["TASK_STATE_CANCELED", "TASK_STATE_REJECTED"] as const) {
      const { s, delegation, binding, terminal } = failedTask(state);
      expect(s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A(terminal, { binding })).type).toBe("cancellation");
      expect(s.delegation(delegation.delegation_id).delivery_status).toBe("cancelled");
    }
    expect(() => terminalClaimType("TASK_STATE_COMPLETED")).toThrow(/not a terminal non-success/);
  });

  it("refuses a signature that does not cover the recorded claim, and relays an unbound key unsigned", () => {
    const { s, delegation, binding, terminal } = failedTask();
    expect(() => s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A({ ...terminal, note: "edited" }, { binding }))).toThrow(/signature does not verify/);
    expect(() => s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A({ ...terminal, type: "cancellation" }, { binding }))).toThrow(/signature does not verify/);
    expect(() => s.appendDelegationEvent(delegation.delegation_id, { ...outcomeClaimFromA2A(terminal, { binding }), asserted_by: "buyer" })).toThrow(/asserted_by provider/);

    const unbound = s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A(terminal));
    expect(unbound.assurance).toEqual(["buyer_recorded"]);
    expect(unbound.signer).toBeUndefined();
  });

  it("fails offline verification when a signed claim is altered after closing", () => {
    const { s, delegation, binding, terminal, close } = failedTask();
    s.appendDelegationEvent(delegation.delegation_id, outcomeClaimFromA2A(terminal, { binding }));
    const { closure } = close();
    const tampered = structuredClone(closure);
    tampered.payload.delivery_claims[0].note = "edited";
    const report = verifySubledgerDocument(tampered, { trustedKeys: [] });
    expect(report.checks.find((c) => c.name === "signed_claims")).toMatchObject({ ok: false, details: [expect.stringContaining("signature does not verify")] });
  });
});
