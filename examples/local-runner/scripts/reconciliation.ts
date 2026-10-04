import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySubledgerDocument } from "@atcn/subledger";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "../src/index.js";

/**
 * Runs the adversarial reconciliation vectors (packages/subledger/test-vectors/reconciliation.json) against the local
 * runner's subledger, which applies the same rules as the hosted API, and writes the results in the shape of
 * a2a-settlement/settlement-conformance results: `tsx --conditions=atcn-source examples/local-runner/scripts/reconciliation.ts`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const VECTORS_PATH = join(repoRoot, "packages/subledger/test-vectors/reconciliation.json");
export const RESULTS_PATH = join(repoRoot, "packages/subledger/test-vectors/reconciliation-results.json");

type Step =
  | { op: "task"; body: { external_ref: string } & Record<string, unknown> }
  | { op: "delegation"; task: string; body: Record<string, unknown> }
  | { op: "claim"; delegation: string; body: Record<string, unknown> }
  | { op: "financial_event"; body: Record<string, unknown> }
  | { op: "close"; task: string };

export interface Outcome {
  refused_steps: { step: number; detail: string }[];
  deduplicated_steps: number[];
  exception_kinds: string[];
  net_cost_minor: Record<string, number>;
  closed_net_cost_minor: Record<string, number>;
  closures_valid: boolean;
}

interface Expected {
  verdict: "BLOCK" | "REVIEW";
  refused_steps: { step: number; detail_substring: string }[];
  deduplicated_steps: number[];
  exception_kinds: string[];
  net_cost_minor: Record<string, number>;
  closed_net_cost_minor: Record<string, number>;
}

export interface Vector {
  vector_id: string;
  attack_class: string;
  description: string;
  steps: Step[];
  expected: Expected;
}

export function loadVectors(): { artefact_id: string; vectors: Vector[] } {
  return JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
}

/** Recorded times have millisecond resolution; a short pause keeps each step's recorded time after the previous one. */
const pause = () => new Promise((done) => setTimeout(done, 3));

export async function runVector(vector: Vector): Promise<Outcome> {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-recon-")), "service-key.json"));
  const subledger = new LocalSubledger(serviceKey, "Conformance");
  const taskIds = new Map<string, string>();
  const outcome: Outcome = { refused_steps: [], deduplicated_steps: [], exception_kinds: [], net_cost_minor: {}, closed_net_cost_minor: {}, closures_valid: true };

  for (const [index, step] of vector.steps.entries()) {
    try {
      if (step.op === "task") taskIds.set(step.body.external_ref, subledger.createTask(step.body).task_id);
      if (step.op === "delegation") subledger.createDelegation(taskIds.get(step.task)!, step.body);
      if (step.op === "claim") subledger.appendDelegationEvent(subledger.resolveDelegationId(`ext:${step.delegation}`), step.body);
      if (step.op === "financial_event" && subledger.recordFinancialEvent(step.body).deduplicated) outcome.deduplicated_steps.push(index);
      if (step.op === "close") {
        const { closure } = subledger.closeTask(taskIds.get(step.task)!, []);
        if (!verifySubledgerDocument(closure, { trustedKeys: [servicePublicKey(serviceKey)] }).valid) outcome.closures_valid = false;
      }
    } catch (error) {
      outcome.refused_steps.push({ step: index, detail: (error as Error).message });
    }
    await pause();
  }

  for (const [ref, taskId] of taskIds) {
    subledger.refreshExceptions(taskId);
    outcome.net_cost_minor[ref] = subledger.summary(taskId).rollup.root_total.USD?.net_cost ?? 0;
    const closure = subledger.closures.filter((c) => c.task_id === taskId).at(-1);
    if (closure) outcome.closed_net_cost_minor[ref] = closure.closure.payload.rollup.root_total.USD?.net_cost ?? 0;
  }
  outcome.exception_kinds = [...new Set(subledger.exceptions.filter((x) => x.status === "open").map((x) => x.kind))].sort();
  return outcome;
}

/** Why the outcome differs from what the vector expects; empty when it passes. */
export function mismatches(expected: Expected, outcome: Outcome): string[] {
  const problems: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const refusedOk =
    expected.refused_steps.length === outcome.refused_steps.length &&
    expected.refused_steps.every((r, i) => outcome.refused_steps[i].step === r.step && outcome.refused_steps[i].detail.includes(r.detail_substring));
  if (!refusedOk) problems.push(`refused steps ${JSON.stringify(outcome.refused_steps)}`);
  if (!same(expected.deduplicated_steps, outcome.deduplicated_steps)) problems.push(`deduplicated steps ${JSON.stringify(outcome.deduplicated_steps)}`);
  if (!same([...expected.exception_kinds].sort(), outcome.exception_kinds)) problems.push(`exception kinds ${JSON.stringify(outcome.exception_kinds)}`);
  if (!same(expected.net_cost_minor, outcome.net_cost_minor)) problems.push(`net cost ${JSON.stringify(outcome.net_cost_minor)}`);
  if (!same(expected.closed_net_cost_minor, outcome.closed_net_cost_minor)) problems.push(`closed net cost ${JSON.stringify(outcome.closed_net_cost_minor)}`);
  if (!outcome.closures_valid) problems.push("a closure failed offline verification");
  return problems;
}

/** Results in the settlement-conformance results shape. No timestamp, so the committed file is reproducible. */
export async function buildResults() {
  const { artefact_id, vectors } = loadVectors();
  const results = [];
  for (const vector of vectors) {
    const outcome = await runVector(vector);
    const problems = mismatches(vector.expected, outcome);
    results.push({
      vector_id: vector.vector_id,
      artefact_id,
      attack_class: vector.attack_class,
      expected_verdict: vector.expected.verdict,
      result: problems.length === 0 ? "PASS" : "FAIL",
      observed: {
        refused_steps: outcome.refused_steps.map((r) => r.step),
        deduplicated_steps: outcome.deduplicated_steps,
        exception_kinds: outcome.exception_kinds,
        net_cost_minor: outcome.net_cost_minor,
        closed_net_cost_minor: outcome.closed_net_cost_minor,
        closures_verify_offline: outcome.closures_valid,
      },
      adapter_notes: problems.join("; "),
    });
  }
  return {
    rail_id: "atcn",
    rail_url: "https://github.com/fadnisnikhil/atcn",
    artefact_id,
    schema_version: "1.1",
    atcn_version: "1.5.0",
    method: "in-process run against the local runner's subledger (same rules as the hosted API): examples/local-runner/scripts/reconciliation.ts",
    verdicts: { BLOCK: "the attack does not change the books: refused or absorbed at intake", REVIEW: "recorded, with an open exception flagging it for a person" },
    vectors: results,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await buildResults();
  writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.vectors.filter((v) => v.result !== "PASS");
  console.log(`${results.vectors.length - failed.length}/${results.vectors.length} reconciliation vectors pass; wrote ${RESULTS_PATH}`);
  for (const v of failed) console.log(`  FAIL ${v.vector_id}: ${v.adapter_notes}`);
  if (failed.length > 0) process.exitCode = 1;
}
