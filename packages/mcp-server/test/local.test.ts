import { existsSync, readFileSync } from "node:fs";
import { generateKeyPair } from "@atcn/schema";
import { buildExpectationStatement, signExpectation, type Expectation } from "@atcn/subledger";
import { describe, expect, it } from "vitest";
import { LocalBackend } from "../src/local-backend.js";
import { connect, ok, temporaryDir } from "./helpers.js";

const EVENT_DATE = "2026-10-01T09:00:00.000Z";

/** Records a task with one provider-backed delegation, a signed estimate, a charge and a completion claim. */
async function recordJob(call: Awaited<ReturnType<typeof connect>>["call"]) {
  const task = ok(await call("create_task", { external_ref: "job-1", currency: "USD", budget_minor: 5000 }));
  const provider = ok(await call("add_provider", { name: "Beta Agent", provider_own_id: "beta" }));
  const keys = generateKeyPair();
  const binding = ok(await call("bind_provider_key", { provider_id: provider.provider_id, key_id: "beta-key-1", public_key: keys.publicKey }));
  const delegation = ok(
    await call("create_delegation", { task_id: "ext:job-1", currency: "USD", external_ref: "del-1", provider_job_ref: "beta-job-1", provider_id: provider.provider_id }),
  );

  const expectation: Expectation = { issued_by: "agent", source_ref: null, basis: "max tokens x rate", expires_at: null, supersedes: null };
  const statement = buildExpectationStatement({ type: "estimate", source: "beta-agent", source_event_id: "est-1", amount_minor: 1500, currency: "USD", issued_at: EVENT_DATE, expectation });
  const signer = { provider_id: provider.provider_id, binding_id: binding.binding_id, key_id: "beta-key-1", value: signExpectation(statement, keys.privateKey) };
  const estimate = ok(
    await call("record_estimate", {
      type: "estimate",
      source: "beta-agent",
      source_event_id: "est-1",
      amount_minor: 1500,
      currency: "USD",
      event_date: EVENT_DATE,
      expectation: { ...expectation, signer },
      match: { delegation_external_ref: "del-1" },
    }),
  );
  const charge = ok(
    await call("record_cost", { type: "charge", source: "beta-agent", source_event_id: "ch-1", amount_minor: 1200, currency: "USD", event_date: EVENT_DATE, match: { provider_job_ref: "beta-job-1" } }),
  );
  const claim = ok(await call("record_claim", { delegation_id: "ext:del-1", type: "completion", note: "report delivered" }));
  return { task, delegation, estimate, charge, claim };
}

describe("ATCN MCP server, local backend", () => {
  it("lists every tool", async () => {
    const { client, close } = await connect(new LocalBackend(temporaryDir()), temporaryDir());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_provider",
      "bind_provider_key",
      "close_task",
      "create_delegation",
      "create_task",
      "record_claim",
      "record_cost",
      "record_estimate",
      "record_hold",
      "report_capture_gap",
      "task_summary",
      "verify_document",
    ]);
    expect(tools.find((t) => t.name === "record_hold")?.description).toContain("never blocks");
    await close();
  });

  it("records a job, closes it, and verifies the closure offline", async () => {
    const dataDir = temporaryDir();
    const { call, close } = await connect(new LocalBackend(dataDir), dataDir);
    const { task, delegation, estimate, charge, claim } = await recordJob(call);
    expect(estimate.attribution).toEqual({ task_id: task.task_id, delegation_id: delegation.delegation_id });
    expect(charge.attribution).toEqual({ task_id: task.task_id, delegation_id: delegation.delegation_id });
    expect(claim.type).toBe("completion");

    const summary = ok(await call("task_summary", { task_id: task.task_id }));
    expect(summary.totals_by_currency.USD.net_cost).toBe(1200);

    const closed = await call("close_task", { task_id: "ext:job-1" });
    const closure = ok(closed);
    expect(closure.version).toBe(1);
    expect(closure.digest).toMatch(/^sha256:/);
    expect(closure.totals_by_currency.USD.net_cost).toBe(1200);
    expect(closure.expectation_report.task.estimated_minor).toBe(1500);
    expect(existsSync(closure.closure_path)).toBe(true);
    expect(existsSync(closure.keys_path)).toBe(true);
    expect(closed.content[0].text).toContain("nothing was reserved");

    const verified = await call("verify_document", { path: closure.closure_path });
    expect(ok(verified).valid).toBe(true);
    expect(verified.content[0].text).toContain("task closure is VALID");

    const inline = ok(await call("verify_document", { document: JSON.parse(readFileSync(closure.closure_path, "utf8")) }));
    expect(inline.valid).toBe(true);
    await close();
  });

  it("detects a tampered closure", async () => {
    const dataDir = temporaryDir();
    const { call, close } = await connect(new LocalBackend(dataDir), dataDir);
    await recordJob(call);
    const closure = ok(await call("close_task", { task_id: "ext:job-1" }));
    const document = JSON.parse(readFileSync(closure.closure_path, "utf8"));
    document.payload.rollup.root_total.USD.net_cost = 1;
    const verified = await call("verify_document", { document });
    expect(ok(verified).valid).toBe(false);
    expect(verified.content[0].text).toContain("task closure is INVALID");
    await close();
  });

  it("keeps its records across a restart on the same data directory", async () => {
    const dataDir = temporaryDir();
    const first = await connect(new LocalBackend(dataDir), dataDir);
    const { task } = await recordJob(first.call);
    const v1 = ok(await first.call("close_task", { task_id: task.task_id }));
    await first.close();

    const second = await connect(new LocalBackend(dataDir), dataDir);
    const summary = ok(await second.call("task_summary", { task_id: "ext:job-1" }));
    expect(summary.task.task_id).toBe(task.task_id);
    expect(summary.totals_by_currency.USD.net_cost).toBe(1200);

    const refund = ok(
      await second.call("record_cost", { type: "refund", source: "beta-agent", source_event_id: "rf-1", amount_minor: 200, currency: "USD", event_date: EVENT_DATE, match: { delegation_external_ref: "del-1" } }),
    );
    expect(refund.attribution.task_id).toBe(task.task_id);
    const v2 = ok(await second.call("close_task", { task_id: task.task_id }));
    expect(v2.version).toBe(2);
    expect(v2.totals_by_currency.USD.net_cost).toBe(1000);
    const closureV2 = JSON.parse(readFileSync(v2.closure_path, "utf8"));
    expect(closureV2.payload.previous_closure_digest).toBe(v1.digest);
    expect(ok(await second.call("verify_document", { path: v2.closure_path })).valid).toBe(true);
    await second.close();
  });

  it("returns validation and ledger errors as tool errors", async () => {
    const dataDir = temporaryDir();
    const { call, close } = await connect(new LocalBackend(dataDir), dataDir);

    const badCurrency = await call("create_task", { external_ref: "job-1", currency: "usd" });
    expect(badCurrency.isError).toBe(true);
    expect(badCurrency.content[0].text).toContain("ISO 4217");

    const negativeEstimate = await call("record_estimate", {
      type: "estimate",
      source: "agent",
      source_event_id: "est-1",
      amount_minor: -5,
      currency: "USD",
      event_date: EVENT_DATE,
      expectation: { issued_by: "agent", source_ref: null, basis: null, expires_at: null, supersedes: null },
    });
    expect(negativeEstimate.isError).toBe(true);
    expect(negativeEstimate.content[0].text).toContain("estimate amount must not be negative");

    const missingTask = await call("create_delegation", { task_id: "ext:nope", currency: "USD" });
    expect(missingTask.isError).toBe(true);
    expect(missingTask.content[0].text).toContain("task ext:nope not found");

    ok(await call("create_task", { external_ref: "job-1", currency: "USD" }));
    const duplicate = await call("create_task", { external_ref: "job-1", currency: "USD" });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0].text).toContain("already used");

    const noDocument = await call("verify_document", {});
    expect(noDocument.isError).toBe(true);
    expect(noDocument.content[0].text).toContain("exactly one of path or document");
    await close();
  });

  it("records a hold and a capture gap without counting the hold as cost", async () => {
    const dataDir = temporaryDir();
    const { call, close } = await connect(new LocalBackend(dataDir), dataDir);
    const task = ok(await call("create_task", { external_ref: "job-2", currency: "USD" }));
    const hold = await call("record_hold", {
      type: "hold",
      source: "cost-gateway",
      source_event_id: "hold-1",
      amount_minor: 300,
      currency: "USD",
      event_date: EVENT_DATE,
      expectation: { issued_by: "gateway", source_ref: "req-9", basis: null, expires_at: null, supersedes: null, hold_status: "open" },
      match: { task_external_ref: "job-2" },
    });
    expect(ok(hold).attribution.task_id).toBe(task.task_id);
    expect(hold.content[0].text).toContain("do not count toward net cost");

    ok(await call("report_capture_gap", { task_id: "ext:job-2", kind: "provider_undisclosed", detail: "search API did not report sub-calls" }));
    const summary = ok(await call("task_summary", { task_id: task.task_id }));
    expect(summary.totals_by_currency.USD.net_cost).toBe(0);
    expect(summary.open_exceptions.map((x: { kind: string }) => x.kind)).toContain("incomplete_lineage");

    const closure = ok(await call("close_task", { task_id: task.task_id }));
    expect(closure.lineage_complete).toBe(false);
    expect(ok(await call("verify_document", { path: closure.closure_path })).valid).toBe(true);
    await close();
  });
});
