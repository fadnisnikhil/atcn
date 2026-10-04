import type { PolicyTemplate } from "@atcn/schema";

/** Reference template for the initial workflow: code change with tests, lint, and a patch (PRD section 6). */
export const CODE_CHANGE_POLICY_V1: PolicyTemplate = {
  schema_version: "1.0",
  policy_id: "code-change-checks",
  policy_version: "1.0.0",
  task_type: "code_change",
  description: "Code change accepted when the patch is a valid diff, all unit tests pass, and lint reports no errors.",
  evidence_admissibility: { allowed_producers: ["counterparty", "verifier"], require_digest_match: true },
  required_evidence: ["patch_ref"],
  checks: [
    {
      check_id: "unit_tests",
      verifier: "junit_tests",
      verifier_version: "1.0.0",
      evidence_type: "test_report",
      config: { min_tests: 1, min_pass_rate_bps: 10000 },
    },
    {
      check_id: "lint",
      verifier: "eslint_lint",
      verifier_version: "1.0.0",
      evidence_type: "lint_report",
      config: { max_errors: 0, max_warnings: -1 },
    },
    {
      check_id: "patch",
      verifier: "patch_digest",
      verifier_version: "1.0.0",
      evidence_type: "patch_ref",
      config: { min_files_changed: 1 },
    },
    {
      check_id: "review",
      verifier: "external_attestation",
      verifier_version: "1.0.0",
      evidence_type: "verifier_attestation",
      config: {},
    },
  ],
  thresholds: { partial_acceptance: true, failed_portion_outcome: "rejected" },
  verifier_unavailable_outcome: "insufficient_evidence",
  probabilistic_routing: "human_review",
  timeouts: { evaluation_window_seconds: 7 * 24 * 3600 },
  dispute: { window_seconds: 7 * 24 * 3600, review_window_seconds: 14 * 24 * 3600, default_outcome: "uphold" },
  allocation: { platform_fee_bps: 1000 },
  rounding: "largest_remainder",
};

/** A later version with a looser lint threshold, used to demonstrate policy-substitution protection (scenario K). */
export const CODE_CHANGE_POLICY_V1_1: PolicyTemplate = {
  ...CODE_CHANGE_POLICY_V1,
  policy_version: "1.1.0",
  description: "As 1.0.0 but tolerates up to 5 lint errors.",
  checks: CODE_CHANGE_POLICY_V1.checks.map((c) => (c.check_id === "lint" ? { ...c, config: { max_errors: 5, max_warnings: -1 } } : c)),
};

/** Worker-to-subworker template without platform fee (child obligations in the reference flow). */
export const CODE_CHANGE_SUBTASK_POLICY_V1: PolicyTemplate = {
  ...CODE_CHANGE_POLICY_V1,
  policy_id: "code-change-subtask",
  description: "Subtask of a code change; same checks, no platform fee.",
  allocation: { platform_fee_bps: 0 },
};

/**
 * Usage-priced agent work: the counterparty submits the run's trace, which must belong to its declared run, and the
 * usage in it must support each deliverable's amount under the terms' pricing (terms schema 1.2).
 */
export const AGENT_USAGE_POLICY_V1: PolicyTemplate = {
  ...CODE_CHANGE_POLICY_V1,
  policy_id: "agent-usage-checks",
  policy_version: "1.0.0",
  task_type: "agent_work",
  description:
    "Agent work accepted when the run's trace belongs to the declared run and its usage, priced with the agreed rates, supports the amount. Deliverables may also require the code-change checks.",
  required_evidence: ["agent_trace"],
  checks: [
    ...CODE_CHANGE_POLICY_V1.checks,
    { check_id: "trace", verifier: "agent_trace", verifier_version: "1.0.0", evidence_type: "agent_trace", config: {} },
    { check_id: "usage_cost", verifier: "usage_cost", verifier_version: "1.0.0", evidence_type: "agent_trace", config: {} },
  ],
};

/**
 * Witnessed agent work: a deliverable requiring "witnesses" is accepted only when enough independent witnesses, as the
 * terms' witness_policy sets, attested to the declared run. "review_bound" is the run-bound review (external_attestation@1.1.0).
 * Witnesses may submit their attestations themselves.
 */
export const WITNESSED_AGENT_WORK_POLICY_V1: PolicyTemplate = {
  ...CODE_CHANGE_POLICY_V1,
  policy_id: "witnessed-agent-work",
  policy_version: "1.0.0",
  task_type: "agent_work",
  description: "Agent work accepted when the required checks pass, including a quorum of independent witnesses to the declared run when a deliverable requires it.",
  evidence_admissibility: { allowed_producers: ["counterparty", "verifier", "witness"], require_digest_match: true },
  required_evidence: [],
  checks: [
    ...AGENT_USAGE_POLICY_V1.checks,
    { check_id: "review_bound", verifier: "external_attestation", verifier_version: "1.1.0", evidence_type: "verifier_attestation", config: {} },
    { check_id: "witnesses", verifier: "witness_quorum", verifier_version: "1.0.0", evidence_type: "witness_attestation", config: {} },
  ],
};

export const REFERENCE_POLICIES: PolicyTemplate[] = [CODE_CHANGE_POLICY_V1, CODE_CHANGE_POLICY_V1_1, CODE_CHANGE_SUBTASK_POLICY_V1, AGENT_USAGE_POLICY_V1, WITNESSED_AGENT_WORK_POLICY_V1];
