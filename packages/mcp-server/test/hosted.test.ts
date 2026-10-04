import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "@atcn/local-runner";
import { AtcnApiError } from "@atcn/sdk";
import { describe, expect, it, vi } from "vitest";
import { HostedBackend, type HostedClient } from "../src/hosted-backend.js";
import { connect, ok, temporaryDir } from "./helpers.js";

/** A signed closure as the hosted API would return it, and the service key that signed it. */
function hostedClosure() {
  const serviceKey = loadOrCreateServiceKey(join(temporaryDir(), "service-key.json"));
  const ledger = new LocalSubledger(serviceKey, "Hosted Operator");
  const task = ledger.createTask({ external_ref: "job-h", currency: "USD" });
  return { ...ledger.closeTask(task.task_id, []), publicKey: servicePublicKey(serviceKey) };
}

function fakeClient() {
  const closed = hostedClosure();
  const totals = { quoted: 0, accepted: 0, invoiced: 0, charged: 700, fees: 0, adjustments: 0, refunded: 0, credits: 0, reported_paid: 0, net_cost: 700, unresolved: 700, downstream_reported: 0, allocated: 0, unallocated: 700 };
  const client = {
    createTask: vi.fn(async (input: { external_ref: string }) => ({ task_id: "task_hosted", ...input })),
    createDelegation: vi.fn(async () => ({ delegation_id: "delegation_hosted" })),
    appendDelegationEvent: vi.fn(async () => ({ event_id: "event_hosted" })),
    recordFinancialEvent: vi.fn(async (input: { type: string }) => ({
      financial_event: { financial_event_id: "fe_hosted", type: input.type },
      deduplicated: false,
      attribution: { task_id: "task_hosted", delegation_id: null },
      match_id: null,
      exception_ids: [],
    })),
    createProvider: vi.fn(async () => ({ provider_id: "provider_hosted" })),
    bindProviderKey: vi.fn(async () => ({ binding_id: "binding_hosted" })),
    reportCaptureGap: vi.fn(async () => ({ gap_id: "gap_hosted" })),
    financialSummary: vi.fn(async () => ({ totals_by_currency: { USD: totals }, open_exceptions: [] })),
    closeTask: vi.fn(async () => ({ closure: closed.closure, digest: closed.digest })),
    serviceKeys: vi.fn(async () => ({ items: [closed.publicKey] })),
  };
  return client;
}

describe("ATCN MCP server, hosted backend", () => {
  it("sends each tool call to the matching SDK operation", async () => {
    const client = fakeClient();
    const dataDir = temporaryDir();
    const { call, close } = await connect(new HostedBackend(client as unknown as HostedClient), dataDir);

    const task = ok(await call("create_task", { external_ref: "job-h", currency: "USD" }));
    expect(task.task_id).toBe("task_hosted");
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ external_ref: "job-h", currency: "USD", budget_minor: null }));

    ok(await call("create_delegation", { task_id: "ext:job-h", currency: "USD", external_ref: "del-h" }));
    expect(client.createDelegation).toHaveBeenCalledWith("ext:job-h", expect.objectContaining({ external_ref: "del-h", currency: "USD" }));

    ok(await call("record_claim", { delegation_id: "ext:del-h", type: "completion" }));
    expect(client.appendDelegationEvent).toHaveBeenCalledWith("ext:del-h", expect.objectContaining({ type: "completion", asserted_by: "buyer" }));

    const estimate = await call("record_estimate", {
      type: "estimate",
      source: "agent",
      source_event_id: "est-h",
      amount_minor: 900,
      currency: "USD",
      event_date: "2026-10-01T09:00:00.000Z",
      expectation: { issued_by: "agent", source_ref: null, basis: null, expires_at: null, supersedes: null },
      match: { task_external_ref: "job-h" },
    });
    expect(ok(estimate).financial_event.financial_event_id).toBe("fe_hosted");
    expect(estimate.content[0].text).toContain("nothing was reserved");
    expect(client.recordFinancialEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "estimate", source_event_id: "est-h" }));

    ok(await call("add_provider", { name: "Beta Agent", provider_own_id: "beta" }));
    expect(client.createProvider).toHaveBeenCalledWith({ name: "Beta Agent", provider_own_id: "beta" });

    ok(await call("bind_provider_key", { provider_id: "provider_hosted", key_id: "k1", public_key: "pub" }));
    expect(client.bindProviderKey).toHaveBeenCalledWith("provider_hosted", "k1", "pub");

    ok(await call("report_capture_gap", { task_id: "task_hosted", kind: "broken_edge", detail: "sub-task without outcome" }));
    expect(client.reportCaptureGap).toHaveBeenCalledWith("task_hosted", { delegation_id: null, kind: "broken_edge", detail: "sub-task without outcome" });

    const summary = await call("task_summary", { task_id: "task_hosted" });
    expect(ok(summary).totals_by_currency.USD.net_cost).toBe(700);
    expect(summary.content[0].text).toContain("USD: net cost 700");
    await close();
  });

  it("writes the hosted closure locally and verifies it with the hosted service keys", async () => {
    const client = fakeClient();
    const dataDir = temporaryDir();
    const { call, close } = await connect(new HostedBackend(client as unknown as HostedClient), dataDir);
    const closure = ok(await call("close_task", { task_id: "task_hosted" }));
    expect(closure.closure_path.startsWith(dataDir)).toBe(true);
    expect(client.closeTask).toHaveBeenCalledWith("task_hosted");

    const verified = ok(await call("verify_document", { path: closure.closure_path }));
    expect(verified.valid).toBe(true);
    expect(client.serviceKeys).toHaveBeenCalled();
    await close();
  });

  it("returns API errors as tool errors", async () => {
    const client = fakeClient();
    client.createTask.mockRejectedValueOnce(new AtcnApiError(409, "conflict", "task external_ref job-h is already used", undefined, false, undefined, null));
    const { call, close } = await connect(new HostedBackend(client as unknown as HostedClient), temporaryDir());
    const result = await call("create_task", { external_ref: "job-h", currency: "USD" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already used");
    await close();
  });
});
