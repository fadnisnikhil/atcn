import { describe, expect, it } from "vitest";
import {
  digestOf,
  executionBinding,
  newId,
  ObligationTermsSchema,
  type EvidenceEnvelope,
  type ExecutionDescriptor,
  type ObligationTerms,
  type RecordedEvent,
  type VerifierResult,
} from "@atcn/schema";
import {
  allocateLargestRemainder,
  buildClearingLines,
  checkBalanced,
  checkChildAgainstParent,
  CODE_CHANGE_POLICY_V1,
  decisionDigest,
  declaredExecutions,
  evaluateClearing,
  hasCycle,
  obligationAttestationConflicts,
  planChecks,
  producerRole,
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

  it("sends failed checks to the reviewer when the refund terms say failures are disputed (A2A discussion #1969)", () => {
    const refundTerms = { on_failure: "dispute" as const, on_timeout: "refund" as const, after_settlement: { cap_minor: 100, window_seconds: 86_400 } };
    const t = terms({ schema_version: "1.2", dispute_reviewer_id: principal, refund_terms: refundTerms });
    expect(ObligationTermsSchema.safeParse(t).success).toBe(true);
    const tests = evidence("test_report");
    const lint = evidence("lint_report");
    const patch = evidence("patch_ref");
    const input = {
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [tests, lint, patch],
      verifier_results: [resultFor(t, "main", "unit_tests", tests, "fail"), resultFor(t, "main", "lint", lint, "pass")],
    };
    const disputed = evaluateClearing(input);
    expect(disputed.outcome).toBe("disputed");
    expect(disputed.disputed_amount_minor).toBe(100);
    expect(disputed.deliverable_outcomes[0].reasons).toContainEqual({ code: "failure_terms_dispute" });

    const refunded = evaluateClearing({ ...input, terms: { ...t, refund_terms: { ...refundTerms, on_failure: "refund" } } });
    expect(refunded.outcome).toBe("rejected");
  });

  it("validates refund terms against the rest of the terms", () => {
    const refundTerms = { on_failure: "dispute" as const, on_timeout: "refund" as const, after_settlement: { cap_minor: 100, window_seconds: 86_400 } };
    const messages = (t: ObligationTerms) => (ObligationTermsSchema.safeParse(t).error?.issues ?? []).map((i) => i.message);
    expect(messages(terms({ refund_terms: refundTerms, dispute_reviewer_id: principal }))).toEqual(["refund_terms requires schema_version 1.2"]);
    expect(messages(terms({ schema_version: "1.2", refund_terms: refundTerms }))).toEqual(["refund_terms.on_failure dispute requires dispute_reviewer_id"]);
    expect(messages(terms({ schema_version: "1.2", dispute_reviewer_id: principal, refund_terms: { ...refundTerms, on_timeout: "dispute" } }))).toEqual([
      "refund_terms.on_timeout must be refund: the network expires an obligation at its deadline and pays nothing",
    ]);
    expect(messages(terms({ schema_version: "1.2", dispute_reviewer_id: principal, refund_terms: { ...refundTerms, after_settlement: { cap_minor: 101, window_seconds: 60 } } }))).toEqual([
      "refund_terms.after_settlement.cap_minor exceeds max_amount_minor",
    ]);
  });

  it("sends a check with conflicting attestations to the reviewer, never picking a winner (evidence plan phase 4)", () => {
    const t = terms({ deliverables: [{ deliverable_id: "main", description: "x", amount_minor: 100, required_checks: ["review"] }] });
    const attestation = evidence("verifier_attestation");
    const patch = evidence("patch_ref");
    const input = {
      terms: t,
      terms_digest: digestOf(t),
      policy,
      policy_digest: policyRef.policy_digest,
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [attestation, patch],
      verifier_results: [resultFor(t, "main", "review", attestation, "pass")],
    };
    expect(evaluateClearing(input).outcome).toBe("accepted");
    const conflict = { kind: "disagreement" as const, subject: `${t.obligation_id}/main/review`, attestation_digests: [digestOf("a"), digestOf("b")].sort(), signers: ["agt_a", "agt_b"] };
    const decision = evaluateClearing({ ...input, attestation_conflicts: [conflict] });
    expect(decision.outcome).toBe("disputed");
    expect(decision.deliverable_outcomes[0].reasons).toContainEqual({ code: "conflicting_attestations", check_id: "review", detail: "disagreement" });
    expect(decision.decision_maker.id).toBe("atcn-clearing-engine@1.1.0");

    const runConflict = { ...conflict, kind: "equivocation" as const, subject: `${t.obligation_id}/execution:run_1` };
    expect(evaluateClearing({ ...input, attestation_conflicts: [runConflict] }).outcome).toBe("disputed");
    const otherObligation = { ...conflict, subject: `obl_other/main/review` };
    expect(evaluateClearing({ ...input, attestation_conflicts: [otherObligation] }).outcome).toBe("accepted");
  });

  it("treats too few independent witnesses as insufficient evidence, not a failure of the work", () => {
    const witnessPolicy = { ...policy, checks: [...policy.checks, { check_id: "witnesses", verifier: "witness_quorum", verifier_version: "1.0.0", evidence_type: "witness_attestation", config: {} }] };
    const t = terms({ deliverables: [{ deliverable_id: "main", description: "x", amount_minor: 100, required_checks: ["witnesses"] }] });
    const witnessed = evidence("witness_attestation");
    const patch = evidence("patch_ref");
    const result: VerifierResult = {
      ...resultFor(t, "main", "review", witnessed, "fail"),
      check_id: "witnesses",
      verifier_name: "witness_quorum",
      verifier_version: "1.0.0",
      config_digest: digestOf({}),
      details: { required: 2, counted: "agt_a@gateway-a.example", refused: "agt_b: shares the domain gateway-a.example with witness agt_a", code: "witness_quorum_not_met" },
    };
    const decision = evaluateClearing({
      terms: t,
      terms_digest: digestOf(t),
      policy: witnessPolicy,
      policy_digest: digestOf(witnessPolicy),
      acceptance_event_id: newId("event"),
      completion_event_id: null,
      evidence: [witnessed, patch],
      verifier_results: [result],
    });
    expect(decision.outcome).toBe("insufficient_evidence");
    expect(decision.deliverable_outcomes[0].reasons).toContainEqual({ code: "witness_quorum_not_met", check_id: "witnesses", detail: "agt_b: shares the domain gateway-a.example with witness agt_a" });
  });

  it("validates the witness policy against the rest of the terms", () => {
    const witnessPolicy = { min_independent_witnesses: 1, independence: "distinct_verified_domain" as const };
    const messages = (t: ObligationTerms) => (ObligationTermsSchema.safeParse(t).error?.issues ?? []).map((i) => i.message);
    expect(messages(terms({ schema_version: "1.2", witness_policy: witnessPolicy }))).toEqual([]);
    expect(messages(terms({ witness_policy: witnessPolicy }))).toEqual(["witness_policy requires schema_version 1.2"]);
    expect(messages(terms({ schema_version: "1.2", witness_policy: { ...witnessPolicy, witness_agent_ids: [worker] } }))).toEqual([
      "witness_policy.witness_agent_ids must not include the issuer, the counterparty or the principal",
    ]);
    const t = terms({ schema_version: "1.2", witness_policy: witnessPolicy });
    expect(producerRole(t, newId("agent"))).toBe("witness");
    expect(producerRole(terms(), newId("agent"))).toBe("other");
  });

  it("flags two descriptors of one run as equivocation by the counterparty (fixture 11)", () => {
    const t = terms();
    const started = (agentVersion: string, sequence: number) =>
      ({
        payload: {
          event_id: newId("event"),
          event_type: "obligation.started",
          obligation_id: t.obligation_id,
          actor_id: worker,
          data: { execution: { execution_id: "run_1", agent: { agent_id: worker, agent_version: agentVersion } } },
        },
        sequence,
        received_at: "2026-10-05T00:00:00.000Z",
      }) as unknown as RecordedEvent;
    const conflicts = obligationAttestationConflicts({ events: [started("1.0.0", 1), started("1.1.0", 2)], terms: t, contents: new Map(), resolveKey: () => null, at: "2026-10-05T12:00:00.000Z" });
    expect(conflicts).toEqual([expect.objectContaining({ kind: "equivocation", subject: `${t.obligation_id}/execution:run_1`, signers: [worker] })]);
    expect(conflicts[0].attestation_digests).toHaveLength(2);
    expect(obligationAttestationConflicts({ events: [started("1.0.0", 1), started("1.0.0", 2)], terms: t, contents: new Map(), resolveKey: () => null, at: "2026-10-05T12:00:00.000Z" })).toEqual([]);
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

describe("runs and skills (schema 1.1 terms)", () => {
  const skill = { namespace: "a2a", skill_id: "code-fix" };
  const run: ExecutionDescriptor = { execution_id: "run_1", protocol: { name: "a2a", task_id: "task-1" }, agent: { agent_id: worker, agent_version: "1.0.0" }, skill };

  function started(actorId: string, data: Record<string, unknown>, sequence = 1): RecordedEvent {
    return {
      payload: {
        schema_version: "1.0",
        event_id: newId("event"),
        event_type: "obligation.started",
        obligation_id: newId("obligation"),
        actor_id: actorId,
        actor_platform_id: newId("platform"),
        event_time: "2026-10-05T00:00:00.000Z",
        causation_ids: [],
        data: data as RecordedEvent["payload"]["data"],
      },
      signature: { key_id: newId("key"), key_version: 1, algorithm: "Ed25519", value: "sig" },
      payload_hash: digestOf(data),
      received_at: "2026-10-05T00:00:00.000Z",
      sequence,
    };
  }

  it("allows a skill only in schema 1.1 terms", () => {
    expect(ObligationTermsSchema.safeParse(terms({ schema_version: "1.1", skill })).success).toBe(true);
    const old = ObligationTermsSchema.safeParse(terms({ skill }));
    expect(old.success).toBe(false);
    expect(old.error?.issues[0].message).toBe("skill requires schema_version 1.1 or later");
    expect(ObligationTermsSchema.parse(terms()).skill).toBeUndefined();
  });

  it("reads runs declared by the counterparty itself and skips any other", () => {
    const declared = declaredExecutions(
      [
        started(worker, { execution: run }),
        started(subworker, { execution: { ...run, execution_id: "run_2", agent: { agent_id: subworker, agent_version: "1.0.0" } } }, 2),
        started(worker, { execution: { ...run, execution_id: "run_3", agent: { agent_id: subworker, agent_version: "1.0.0" } } }, 3),
        started(worker, { execution: { execution_id: "run_4" } }, 4),
        started(worker, {}, 5),
      ],
      worker,
    );
    expect(declared.map((d) => d.execution_id)).toEqual(["run_1"]);
    expect(declared[0].execution_digest).toBe(executionBinding(run).execution_digest);
    expect(declared[0].descriptor).toEqual(run);
  });
});
