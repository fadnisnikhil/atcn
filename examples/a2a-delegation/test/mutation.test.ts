import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyClosurePackage } from "@atcn/core";
import { loadOrCreateServiceKey, servicePublicKey } from "@atcn/local-runner";
import { signPayload } from "@atcn/schema";
import { verifySubledgerDocument } from "@atcn/subledger";
import { beforeAll, describe, expect, it } from "vitest";
import { runA2ADelegation, type A2ADelegationResult } from "../src/run.js";

/**
 * Field-by-field tamper test (A2A discussion #1920). Every leaf of a signed document's payload is changed one at a
 * time and the document is re-signed with the service key, so the outer signature can never be what catches it. The
 * offline verifier must then reject the document. Fields nothing checks are pinned below with the reason; the test
 * fails if a new field escapes or a pinned one starts being caught, so the list never drifts silently.
 */

type Path = (string | number)[];

const ID = /^([a-z]{3})_([0-9A-HJKMNP-TV-Z]{26})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** A changed value of the same shape, so schema checks alone don't catch it. Null leaves have no same-shape change. */
function mutate(value: unknown): unknown {
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (typeof value !== "string") return undefined;
  if (DIGEST.test(value)) return value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
  if (ID.test(value)) return value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
  if (TIMESTAMP.test(value)) return new Date(Date.parse(value) + 1000).toISOString();
  return `${value}x`;
}

function leaves(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [path];
}

function setAt(root: unknown, path: Path, value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}

function getAt(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], root);
}

/** The path with array indexes replaced by [], so one pinned entry covers every element of a list. */
function pattern(path: Path): string {
  return path.map((k) => (typeof k === "number" ? "[]" : `.${k}`)).join("").replace(/^\./, "");
}

interface Battery {
  total: number;
  caught: number;
  escapes: string[];
}

function runBattery(payload: unknown, verify: (mutatedPayload: unknown) => boolean): Battery {
  let total = 0;
  let caught = 0;
  const escapes = new Set<string>();
  for (const path of leaves(payload)) {
    const changed = mutate(getAt(payload, path));
    if (changed === undefined) continue;
    const copy = structuredClone(payload);
    setAt(copy, path, changed);
    total += 1;
    if (verify(copy)) escapes.add(pattern(path));
    else caught += 1;
  }
  return { total, caught, escapes: [...escapes].sort() };
}

const SERVICE_TIME = "set by the service when it records or builds the item, outside any party's signature";
const RAIL_REPORT = "the payment rail's own report as received; the signed settlement.reported event does not carry it";
const RAIL_ROUTING = "routing data for the payment rail; no signed event carries it, so confirm it with the payee";
const BUYER_RECORD = "recorded by the buyer and covered only by the closure signature; no other record repeats it";

/** Closure package fields no check covers, and why. Each is also listed in the threat model. */
const PACKAGE_RESIDUAL_ESCAPES: Record<string, string> = {
  "events[].received_at": SERVICE_TIME,
  "events[].sequence": SERVICE_TIME,
  generated_at: SERVICE_TIME,
  "obligations[].state": "a lifecycle label the service derives from events; nothing is computed from it",
  "posting_batches[].posted_at": SERVICE_TIME,
  "posting_batches[].rounding.detail": "describes the rounding applied; the lines themselves must balance and match their journal event's totals",
  "posting_batches[].rounding.method": "describes the rounding applied; the lines themselves must balance and match their journal event's totals",
  "settlement_events[].provider_event_id": RAIL_REPORT,
  "settlement_events[].raw_json": RAIL_REPORT,
  "settlement_events[].reported_at": RAIL_REPORT,
  "settlement_instructions[].beneficiary_ref": RAIL_ROUTING,
  "settlement_instructions[].created_at": SERVICE_TIME,
  "settlement_instructions[].expires_at": RAIL_ROUTING,
  "settlement_instructions[].idempotency_key": RAIL_ROUTING,
  "verifier_results[].result_id": "an identifier only; decisions cite results by the digest of their output, which excludes it",
};

/** Subledger closure fields no check covers, and why. Each is also listed in the threat model. */
const CLOSURE_RESIDUAL_ESCAPES: Record<string, string> = {
  closure_id: SERVICE_TIME,
  generated_at: SERVICE_TIME,
  "issuer.operator_id": "checked against provider responses when there are any; this closure has none",
  "issuer.operator_name": BUYER_RECORD,
  "task.budget_minor": BUYER_RECORD,
  "task.created_at": SERVICE_TIME,
  "task.external_ref": BUYER_RECORD,
  "delegations[].created_at": SERVICE_TIME,
  "delegations[].execution.agent.agent_id": BUYER_RECORD,
  "delegations[].execution.agent.agent_version": BUYER_RECORD,
  "delegations[].execution.agent.card_digest": BUYER_RECORD,
  "delegations[].execution.execution_id": BUYER_RECORD,
  "delegations[].execution.protocol.context_id": BUYER_RECORD,
  "delegations[].execution.protocol.task_id": BUYER_RECORD,
  "delegations[].execution.skill.namespace": BUYER_RECORD,
  "delegations[].execution.skill.skill_id": BUYER_RECORD,
  "delegations[].expected_delivery": BUYER_RECORD,
  "delegations[].external_ref": BUYER_RECORD,
  "delegations[].provider_id": BUYER_RECORD,
  "delegations[].provider_job_ref": BUYER_RECORD,
  "delegations[].provider_name_stated": BUYER_RECORD,
  "delegations[].provider_own_id": BUYER_RECORD,
  "delegations[].quote_basis": BUYER_RECORD,
  "delegations[].quote_valid_until": BUYER_RECORD,
  "delegations[].terms_digest": BUYER_RECORD,
  "delivery_claims[].event_id": BUYER_RECORD,
  "delivery_claims[].evidence[].digest": BUYER_RECORD,
  "delivery_claims[].evidence[].evidence_type": BUYER_RECORD,
  "delivery_claims[].evidence[].uri": BUYER_RECORD,
  "delivery_claims[].note": BUYER_RECORD,
  "delivery_claims[].occurred_at": BUYER_RECORD,
  "delivery_claims[].recorded_at": SERVICE_TIME,
};

const ISSUER_EXCEPTIONS = "the issuer's own bookkeeping for an exception; the verifier recomputes each derived exception's kind, delegation and detail, not its id or when it was raised";

/** Extra escapes when the closure lists a key binding and open exceptions (the base run's only exception belongs to no task). */
const ESTIMATE_RESIDUAL_ESCAPES: Record<string, string> = {
  "key_bindings[].created_at": SERVICE_TIME,
  "key_bindings[].created_by": BUYER_RECORD,
  "open_exceptions[].created_at": ISSUER_EXCEPTIONS,
  "open_exceptions[].exception_id": ISSUER_EXCEPTIONS,
};
/** Caught once a signed estimate ties the delegation's provider to the signing key. */
const CAUGHT_WITH_ESTIMATES = ["delegations[].provider_id"];

describe("tamper test: every published field of a signed document is checked", () => {
  let result: A2ADelegationResult;
  let resign: <T>(payload: T) => { payload: T; signature: unknown };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atcn-mutation-"));
    result = await runA2ADelegation({ dataDir });
    const serviceKey = loadOrCreateServiceKey(join(dataDir, "service-key.json"));
    expect(servicePublicKey(serviceKey).public_key).toBe(result.trusted_keys[0].public_key);
    resign = (payload) => signPayload(payload, serviceKey);
  });

  it("closure package: every change is rejected except the pinned residual escapes", () => {
    const traces = result.files.traces.map((file) => readFileSync(file));
    const options = { trustedKeys: result.trusted_keys, traces };
    expect(verifyClosurePackage(resign(result.packages[0].payload), options).valid).toBe(true);
    const battery = runBattery(result.packages[0].payload, (payload) => verifyClosurePackage(resign(payload), options).valid);
    console.log(`closure package: ${battery.caught}/${battery.total} caught; escapes: ${battery.escapes.join(", ") || "none"}`);
    expect(battery.escapes).toEqual(Object.keys(PACKAGE_RESIDUAL_ESCAPES).sort());
  });

  it("subledger closure: every change is rejected except the pinned residual escapes", () => {
    const options = { trustedKeys: result.trusted_keys, obligationPackages: result.packages };
    expect(verifySubledgerDocument(resign(result.closure.payload), options).valid).toBe(true);
    const battery = runBattery(result.closure.payload, (payload) => verifySubledgerDocument(resign(payload), options).valid);
    console.log(`subledger closure: ${battery.caught}/${battery.total} caught; escapes: ${battery.escapes.join(", ") || "none"}`);
    expect(battery.escapes).toEqual(Object.keys(CLOSURE_RESIDUAL_ESCAPES).sort());
  });

  it("subledger closure with estimates: every estimate field and the expectation report are checked", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atcn-mutation-"));
    const withEstimates = await runA2ADelegation({ dataDir, estimates: true });
    const serviceKey = loadOrCreateServiceKey(join(dataDir, "service-key.json"));
    const options = { trustedKeys: withEstimates.trusted_keys, obligationPackages: withEstimates.packages };
    const battery = runBattery(withEstimates.closure.payload, (payload) => verifySubledgerDocument(signPayload(payload, serviceKey), options).valid);
    console.log(`subledger closure with estimates: ${battery.caught}/${battery.total} caught; escapes: ${battery.escapes.join(", ") || "none"}`);
    const expected = Object.keys({ ...CLOSURE_RESIDUAL_ESCAPES, ...ESTIMATE_RESIDUAL_ESCAPES }).filter((path) => !CAUGHT_WITH_ESTIMATES.includes(path));
    expect(battery.escapes).toEqual(expected.sort());
  });
});
