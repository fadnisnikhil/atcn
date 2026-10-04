import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey } from "@atcn/local-runner";
import { generateKeyPair } from "@atcn/schema";
import { describe, expect, it } from "vitest";
import {
  BILLING_REF_EXTENSION_URI,
  billingRefExtension,
  billingRefFromAgentCard,
  delegationFromA2A,
  estimateEventFromA2A,
  estimateFromMetadata,
  providerJobRefFor,
  signedEstimateMetadata,
  statedSkillPrice,
  type A2AAgentCard,
} from "../src/index.js";

const cardWith = (params: unknown): A2AAgentCard => ({ name: "Gamma Billing", version: "2.0.0", capabilities: { extensions: [{ uri: BILLING_REF_EXTENSION_URI, required: false, params }] } });

function subledger() {
  return new LocalSubledger(loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-billing-")), "service-key.json")), "Acme");
}

const charge = (id: string, ref: string) => ({ type: "charge", source: "gamma", source_event_id: id, amount_minor: 500, currency: "USD", event_date: "2026-10-01T12:00:00.000Z", match: { provider_job_ref: ref } });

describe("A2A billing-reference extension", () => {
  it("matches a charge by a declared metadata key, and a missing value opens unmatched_charge rather than dropping it", () => {
    const card = cardWith({ billing_ref: { metadata_key: "invoice_ref" } });
    const s = subledger();
    const task = s.createTask({ external_ref: "job", currency: "USD" });
    const withRef = s.createDelegation(task.task_id, delegationFromA2A({ card, task: { id: "t-1", contextId: "c-1", metadata: { invoice_ref: "inv-77" } }, currency: "USD", externalRef: "first" }));
    const withoutRef = s.createDelegation(task.task_id, delegationFromA2A({ card, task: { id: "t-2", contextId: "c-1", metadata: {} }, currency: "USD", externalRef: "second" }));
    expect(withRef.provider_job_ref).toBe("inv-77");
    expect(withoutRef.provider_job_ref).toBeNull();
    expect(withRef.execution).toMatchObject({ execution_id: "a2a:t-1", protocol: { name: "a2a", task_id: "t-1", context_id: "c-1" }, agent: { agent_id: "Gamma Billing", agent_version: "2.0.0" } });

    expect(s.recordFinancialEvent(charge("ch-1", "inv-77")).attribution).toEqual({ task_id: task.task_id, delegation_id: withRef.delegation_id });
    const unmatched = s.recordFinancialEvent(charge("ch-2", "inv-78"));
    expect(unmatched.attribution).toBeNull();
    expect(s.exceptions.find((x) => x.financial_event_id === unmatched.financial_event.financial_event_id)!.kind).toBe("unmatched_charge");
  });

  it("reads task_id and context_id references, falls back without the extension, and refuses malformed params", () => {
    const task = { id: "t-9", contextId: "c-9" };
    expect(providerJobRefFor(cardWith({ billing_ref: "task_id" }), task)).toBe("t-9");
    expect(providerJobRefFor(cardWith({ billing_ref: "context_id" }), task)).toBe("c-9");
    const plain: A2AAgentCard = { name: "Plain", version: "1.0.0" };
    expect(billingRefFromAgentCard(plain)).toBeNull();
    expect(delegationFromA2A({ card: plain, task, currency: "USD", fallbackProviderJobRef: "own-ref" }).provider_job_ref).toBe("own-ref");
    expect(() => billingRefFromAgentCard(cardWith({ billing_ref: "invoice_id" }))).toThrow(/invalid/);
  });

  it("builds the card entry and reads a stated skill price", () => {
    const entry = billingRefExtension({ billing_ref: "task_id", currency: "USD", pricing: [{ skill_id: "search", unit: "task", amount_minor: 1_200 }] });
    const card: A2AAgentCard = { name: "Gamma", version: "1.0.0", capabilities: { extensions: [entry] } };
    expect(statedSkillPrice(card, "search")).toEqual({ amount_minor: 1_200, currency: "USD", unit: "task" });
    expect(statedSkillPrice(card, "other")).toBeNull();
  });

  it("records an agent's signed estimate as provider_key_signed only when the buyer has bound the agent's key", () => {
    const keys = generateKeyPair();
    const metadata = signedEstimateMetadata(
      { source: "beta-agent", source_event_id: "est-1", amount_minor: 9_500, currency: "USD", issued_at: "2026-10-01T09:00:00Z", basis: "fixed fee", expires_at: null, supersedes: null, source_ref: null },
      { keyId: "beta-key", privateKey: keys.privateKey },
    );
    const estimate = estimateFromMetadata(metadata)!;
    expect(estimate.issued_at).toBe("2026-10-01T09:00:00.000Z");

    const s = subledger();
    const task = s.createTask({ external_ref: "job", currency: "USD" });
    const provider = s.addProvider("Beta", "beta");
    s.createDelegation(task.task_id, { external_ref: "fix", provider_id: provider.provider_id, provider_job_ref: "beta-job", currency: "USD" });
    const binding = s.bindProviderKey(provider.provider_id, keys.publicKey, "beta-key");
    const signed = s.recordFinancialEvent(estimateEventFromA2A(estimate, { match: { provider_job_ref: "beta-job" }, binding }));
    expect(signed.financial_event.expectation?.signer?.binding_id).toBe(binding.binding_id);

    const unbound = estimateEventFromA2A({ ...estimate, source_event_id: "est-2" }, { match: { provider_job_ref: "beta-job" } }) as { expectation: Record<string, unknown> };
    expect(unbound.expectation.signer).toBeUndefined();
    expect(unbound.expectation.issued_by).toBe("agent");
  });
});
