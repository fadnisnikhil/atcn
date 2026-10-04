import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "@atcn/local-runner";
import { generateKeyPair } from "@atcn/schema";
import { describe, expect, it } from "vitest";
import {
  expectationSignatureProblem,
  outcomeSignatureProblem,
  verifySubledgerDocument,
  type DeliveryClaim,
  type FinancialEventRecord,
  type KeyBindingRecord,
} from "../src/index.js";

function closedTask() {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-hostile-")), "service-key.json"));
  const s = new LocalSubledger(serviceKey, "Acme");
  const task = s.createTask({ external_ref: "job", currency: "USD" });
  s.createDelegation(task.task_id, { external_ref: "search", currency: "USD" });
  s.createDelegation(task.task_id, { external_ref: "rank", currency: "USD" });
  s.recordFinancialEvent({ type: "charge", source: "gamma", source_event_id: "ch-1", amount_minor: 100, currency: "USD", event_date: "2026-10-01T11:00:00Z", match: { task_id: task.task_id } });
  const { closure } = s.closeTask(task.task_id, []);
  return { closure, trustedKeys: [servicePublicKey(serviceKey)] };
}

const binding: KeyBindingRecord = {
  binding_id: "kb_1",
  provider_id: "prov_1",
  key_id: "k1",
  public_key: generateKeyPair().publicKey,
  method: "operator_configured",
  created_by: "user:test",
  created_at: "2026-10-01T00:00:00Z",
  revoked_at: null,
};
const signer = { provider_id: "prov_1", binding_id: "kb_1", key_id: "k1", value: "AAAA" };

describe("the verifier reports on hostile documents instead of throwing", () => {
  it("reports a parent outside the task and a parent cycle as lineage failures", () => {
    const { closure, trustedKeys } = closedTask();
    const outside = structuredClone(closure);
    outside.payload.delegations[0].parent_delegation_id = "dlg_missing";
    outside.payload.delegations[0].depth = 2;
    expect(verifySubledgerDocument(outside, { trustedKeys }).checks.find((c) => c.name === "lineage")).toMatchObject({
      ok: false,
      details: expect.arrayContaining([expect.stringContaining("references a parent outside the task")]),
    });

    const cycle = structuredClone(closure);
    const [a, b] = cycle.payload.delegations;
    a.parent_delegation_id = b.delegation_id;
    b.parent_delegation_id = a.delegation_id;
    a.depth = 2;
    b.depth = 2;
    expect(verifySubledgerDocument(cycle, { trustedKeys }).checks.find((c) => c.name === "lineage")).toMatchObject({
      ok: false,
      details: expect.arrayContaining([expect.stringContaining("cycle through")]),
    });
  });

  it("reports a rail record with a number no signature could cover as a schema failure", () => {
    const { closure, trustedKeys } = closedTask();
    const doc = structuredClone(closure);
    doc.payload.financial_events[0].record.rail_attestation = { scheme: "urn:example", record: { amount: 1.5 } };
    expect(verifySubledgerDocument(doc, { trustedKeys })).toEqual({
      valid: false,
      document_type: closure.payload.document_type,
      checks: [{ name: "schema", ok: false, details: ["payload is not canonical JSON: numbers must be safe integers"] }],
    });
  });

  it("treats a signed claim or estimate with an unreadable date as a signature that does not verify", () => {
    const claim = { event_id: "ev_1", delegation_id: "dlg_1", type: "completion", note: null, evidence: [], occurred_at: "yesterday", signer } as unknown as DeliveryClaim;
    expect(outcomeSignatureProblem(claim, { provider_id: "prov_1", provider_job_ref: "job-1" }, [binding])).toBe("completion claim ev_1 signature does not verify");

    const estimate = {
      financial_event_id: "fe_1",
      type: "estimate",
      source: "gateway",
      source_event_id: "est-1",
      provider_reference: null,
      amount_minor: 100,
      currency: "USD",
      event_date: "yesterday",
      expectation: { issued_by: "gateway", source_ref: null, basis: null, expires_at: null, supersedes: null, signer },
    } as unknown as FinancialEventRecord;
    expect(expectationSignatureProblem(estimate, null, [binding])).toBe("estimate fe_1 signature does not verify");
  });
});
