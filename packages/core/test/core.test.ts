import { describe, expect, it } from "vitest";
import { digestOf, newId, type EvidenceEnvelope, type ObligationTerms, type VerifierResult } from "@atcn/schema";
import {
  allocateLargestRemainder,
  buildClearingLines,
  checkBalanced,
  checkChildAgainstParent,
  CODE_CHANGE_POLICY_V1,
  decisionDigest,
  evaluateClearing,
  hasCycle,
  planChecks,
  remainingExposure,
  type EvidenceInput,
} from "../src/index.js";

const principal = newId("principal");
const orchestrator = newId("agent");
const worker = newId("agent");
const subworker = newId("agent");
const policy = CODE_CHANGE_POLICY_V1;
const policyRef = { policy_id: policy.policy_id, policy_version: policy.policy_version, policy_digest: digestOf(policy) };

function terms(overrides: Partial<ObligationTerms> = {}): ObligationTerms {
  return {
    schema_version: "1.0",
    obligation_id: newId("obligation"),
    terms_version: 1,
    parent_obligation_id: null,
    principal_id: principal,
    payer_id: principal,
    issuer_agent_id: orchestrator,
    counterparty_agent_id: worker,
    payee_selection: null,
    scope: { task_type: "code_change", description: "Implement API change" },
    currency: "USD",
    max_amount_minor: 100,
    deliverables: [{ deliverable_id: "main", description: "API change", amount_minor: 100, required_checks: ["unit_tests", "lint"] }],
    acceptance_policy: policyRef,
    deadline: "2026-10-10T12:00:00.000Z",
    offer_expires_at: "2026-10-03T12:00:00.000Z",
    allow_subdelegation: true,
    subdelegation_limits: { max_depth: 2, max_total_minor: 100, allowed_policy_ids: [] },
    dispute_reviewer_id: null,
    verifier_agent_ids: [],
    issued_at: "2026-10-02T14:00:00.000Z",
    ...overrides,
  };
}

function evidence(type: string, deliverableIds: string[] = [], createdAt = "2026-10-05T00:00:00.000Z"): EvidenceInput {
  const envelope: EvidenceEnvelope = {
    evidence_id: newId("evidence"),
    evidence_type: type,
    producer_id: worker,
    created_at: createdAt,
    content_digest: digestOf({ type, createdAt, deliverableIds }),
    uri: "atcn-blob://x",
    retrieval_method: "atcn-blob",
    media_type: "application/octet-stream",
    access_policy: { visible_to: ["issuer", "counterparty", "verifier"] },
    verifiers: ["junit_tests", "eslint_lint", "patch_digest"],
    deliverable_ids: deliverableIds,
  };
  return { envelope, event_id: newId("event"), producer_role: "counterparty", superseded: false };
}

function resultFor(t: ObligationTerms, deliverableId: string, checkId: string, e: EvidenceInput, status: VerifierResult["status"]): VerifierResult {
  const check = policy.checks.find((c) => c.check_id === checkId)!;
  return {
    result_id: newId("verifierResult"),
    obligation_id: t.obligation_id,
    check_id: checkId,
    deliverable_id: deliverableId,
    verifier_name: check.verifier,
    verifier_version: check.verifier_version,
    config_digest: digestOf(check.config),
    kind: "deterministic",
    evidence_ids: [e.envelope.evidence_id],
    evidence_digests: [e.envelope.content_digest],
    status,
    details: {},
    model: null,
    executed_at: new Date().toISOString(),
  };
}

describe("allocation", () => {
  it("sums exactly with deterministic remainders", () => {
    const result = allocateLargestRemainder(101, [
      { key: "platform_fee", weight: 1000 },
      { key: "payee_share", weight: 9000 },
    ]);
    expect(result.amounts.platform_fee + result.amounts.payee_share).toBe(101);
    expect(result.amounts).toEqual({ platform_fee: 10, payee_share: 91 });
    const thirds = allocateLargestRemainder(100, [
      { key: "a", weight: 1 },
      { key: "b", weight: 1 },
      { key: "c", weight: 1 },
    ]);
    expect(thirds.amounts).toEqual({ a: 34, b: 33, c: 33 });
  });
});

describe("delegation bounds (scenarios A and B)", () => {
  it("allows nested delegation within the root ceiling and rejects over-limit children", () => {
    const root = terms();
    const childA = terms({
      parent_obligation_id: root.obligation_id,
      payer_id: worker,
      issuer_agent_id: worker,
      counterparty_agent_id: subworker,
      max_amount_minor: 60,
      deliverables: [{ deliverable_id: "main", description: "part", amount_minor: 60, required_checks: ["unit_tests"] }],
      subdelegation_limits: { max_depth: 1, max_total_minor: 60, allowed_policy_ids: [] },
    });
    const parentCtx = { terms: root, state: "active", depth: 0, inheritedMaxDepth: null, committedChildExposureMinor: 0, ancestorIds: [] };
    expect(checkChildAgainstParent(parentCtx, childA)).toEqual([]);

    const overLimit = terms({ ...childA, obligation_id: newId("obligation"), max_amount_minor: 25, deliverables: [{ ...childA.deliverables[0], amount_minor: 25 }] });
    const ctxWith80Committed = { ...parentCtx, committedChildExposureMinor: 80 };
    expect(remainingExposure(ctxWith80Committed)).toBe(20);
    expect(checkChildAgainstParent(ctxWith80Committed, overLimit).map((v) => v.code)).toContain("exceeds_remaining_exposure");
  });

  it("rejects subdelegation when not allowed and detects cycles", () => {
    const root = terms({ allow_subdelegation: false, subdelegation_limits: null });
    const child = terms({ parent_obligation_id: root.obligation_id, issuer_agent_id: worker, payer_id: worker });
    const violations = checkChildAgainstParent(
      { terms: root, state: "active", depth: 0, inheritedMaxDepth: null, committedChildExposureMinor: 0, ancestorIds: [] },
      child,
    );
    expect(violations.map((v) => v.code)).toContain("subdelegation_not_allowed");
    expect(hasCycle(new Map([["a", "b"], ["b", "a"]]))).toBe(true);
    expect(hasCycle(new Map([["a", "b"], ["b", null]]))).toBe(false);
  });
});

describe("clearing engine", () => {
  it("is deterministic over identical inputs (scenario C)", () => {
    const t = terms();
    const tests = evidence("test_report");
    const lint = evidence("lint_report");
    const patch = evidence("patch_ref");
    const results = [resultFor(t, "main", "unit_tests", tests, "pass"), resultFor(t, "main", "lint", lint, "pass")];
    const input = {
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: newId("event"),
      evidence: [tests, lint, patch],
      verifier_results: results,
    };
    const first = evaluateClearing(input);
    const second = evaluateClearing({ ...input, verifier_results: results.map((r) => ({ ...r, result_id: newId("verifierResult") })) });
    expect(first.outcome).toBe("accepted");
    expect(first.accepted_amount_minor).toBe(100);
    expect(decisionDigest(first)).toBe(decisionDigest(second));
  });

  it("returns insufficient_evidence and names the missing requirement (scenario D)", () => {
    const t = terms();
    const lint = evidence("lint_report");
    const patch = evidence("patch_ref");
    const decision = evaluateClearing({
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [lint, patch],
      verifier_results: [resultFor(t, "main", "lint", lint, "pass")],
    });
    expect(decision.outcome).toBe("insufficient_evidence");
    expect(decision.accepted_amount_minor).toBe(0);
    expect(decision.deliverable_outcomes[0].reasons).toContainEqual({ code: "missing_evidence", check_id: "unit_tests", evidence_type: "test_report" });
  });

  it("partially accepts independently priced deliverables (scenario E)", () => {
    const t = terms({
      deliverables: [
        { deliverable_id: "api", description: "API", amount_minor: 60, required_checks: ["unit_tests"] },
        { deliverable_id: "docs", description: "Docs", amount_minor: 40, required_checks: ["lint"] },
      ],
    });
    const tests = evidence("test_report", ["api"]);
    const lint = evidence("lint_report", ["docs"]);
    const patch = evidence("patch_ref");
    const decision = evaluateClearing({
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [tests, lint, patch],
      verifier_results: [resultFor(t, "api", "unit_tests", tests, "pass"), resultFor(t, "docs", "lint", lint, "fail")],
    });
    expect(decision.outcome).toBe("partially_accepted");
    expect(decision.accepted_amount_minor).toBe(60);
    expect(decision.rejected_amount_minor).toBe(40);
  });

  it("distinguishes invalid evidence from failed criteria and unavailable verifier (EV-8)", () => {
    const t = terms();
    const tests = evidence("test_report");
    const lint = evidence("lint_report");
    const patch = evidence("patch_ref");
    const decision = evaluateClearing({
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [tests, lint, patch],
      verifier_results: [resultFor(t, "main", "unit_tests", tests, "invalid_evidence")],
    });
    const codes = decision.deliverable_outcomes[0].reasons.map((r) => r.code);
    expect(codes).toContain("invalid_evidence");
    expect(codes).toContain("verifier_unavailable");
  });

  it("routes probabilistic results to human review instead of auto-accepting (CL-6, CL-7)", () => {
    const t = terms({ deliverables: [{ deliverable_id: "main", description: "x", amount_minor: 100, required_checks: ["review"] }] });
    const attestation = evidence("verifier_attestation");
    const patch = evidence("patch_ref");
    const result = { ...resultFor(t, "main", "review", attestation, "pass"), kind: "probabilistic" as const };
    const decision = evaluateClearing({
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [attestation, patch],
      verifier_results: [result],
    });
    expect(decision.outcome).toBe("disputed");
    expect(decision.accepted_amount_minor).toBe(0);
  });

  it("plans one verifier run per deliverable and check", () => {
    const t = terms();
    const plan = planChecks({ terms: t, policy, evidence: [evidence("test_report")] });
    expect(plan.map((p) => p.check.check_id)).toEqual(["unit_tests", "lint"]);
    expect(plan[0].evidence).not.toBeNull();
    expect(plan[1].evidence).toBeNull();
  });
});

describe("journal", () => {
  it("balances the PRD 9.3 example with fee, child cost, and margin", () => {
    const { lines } = buildClearingLines({
      payerId: principal,
      payeeAgentId: orchestrator,
      payeePlatformId: newId("platform"),
      currency: "USD",
      clearableMinor: 100,
      frozenMinor: 0,
      childCostMinor: 80,
      platformFeeBps: 1000,
    });
    const byRole = Object.fromEntries(lines.map((l) => [l.allocation_role, l.debit_minor || l.credit_minor]));
    expect(byRole).toEqual({ payer_expense: 100, platform_fee: 10, child_cost: 80, parent_margin: 10 });
    expect(checkBalanced(lines).balanced).toBe(true);
  });

  it("freezes only the contested amount (CL-9)", () => {
    const { lines } = buildClearingLines({
      payerId: principal,
      payeeAgentId: worker,
      payeePlatformId: newId("platform"),
      currency: "USD",
      clearableMinor: 70,
      frozenMinor: 30,
      childCostMinor: 0,
      platformFeeBps: 0,
    });
    expect(lines.find((l) => l.account_type === "dispute_frozen")?.credit_minor).toBe(30);
    expect(lines.find((l) => l.account_type === "payable")?.credit_minor).toBe(70);
    expect(checkBalanced(lines).balanced).toBe(true);
  });

  it("detects unbalanced batches", () => {
    const check = checkBalanced([
      { account_type: "payable", party_id: "a", allocation_role: "payee_share", currency: "USD", debit_minor: 10, credit_minor: 0 },
      { account_type: "payable", party_id: "b", allocation_role: "payee_share", currency: "USD", debit_minor: 0, credit_minor: 9 },
    ]);
    expect(check.balanced).toBe(false);
  });
});
