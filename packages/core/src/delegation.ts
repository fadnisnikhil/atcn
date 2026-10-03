import type { ObligationTerms } from "@atcn/schema";

/** The amount both parties agree to on acceptance: the sum of the deliverables' amounts. */
export function agreedAmount(terms: ObligationTerms): number {
  return terms.deliverables.reduce((sum, d) => sum + d.amount_minor, 0);
}

export interface ParentContext {
  terms: ObligationTerms;
  state: string;
  /** Depth of the parent in its tree; root = 0. */
  depth: number;
  /** Subdelegation depth still permitted below the parent's own issuer chain (null = unlimited by ancestors). */
  inheritedMaxDepth: number | null;
  /** Sum of max_amount_minor of the parent's existing exposure-holding children (excluding the child being checked). */
  committedChildExposureMinor: number;
  /** Obligation ids from the parent up to the root, parent first. */
  ancestorIds: string[];
}

export interface DelegationViolation {
  code:
    | "subdelegation_not_allowed"
    | "exceeds_remaining_exposure"
    | "exceeds_subdelegation_total"
    | "depth_exceeded"
    | "currency_mismatch"
    | "deadline_exceeds_parent"
    | "principal_mismatch"
    | "issuer_must_be_parent_counterparty"
    | "payer_must_be_parent_counterparty"
    | "policy_not_permitted"
    | "cycle_detected"
    | "parent_not_active";
  message: string;
}

const PARENT_STATES_ALLOWING_DELEGATION = ["accepted", "active"];

/** Remaining authorized exposure for new children (OB-3). */
export function remainingExposure(parent: ParentContext): number {
  const ceiling = Math.min(
    parent.terms.max_amount_minor,
    parent.terms.subdelegation_limits?.max_total_minor ?? parent.terms.max_amount_minor,
  );
  return Math.max(0, ceiling - parent.committedChildExposureMinor);
}

/**
 * Checks a proposed child obligation against its parent (OB-2, OB-3, OB-5, OB-7).
 * Returns every violation found; an empty list means the child is within bounds.
 */
export function checkChildAgainstParent(parent: ParentContext, child: ObligationTerms): DelegationViolation[] {
  const violations: DelegationViolation[] = [];
  const p = parent.terms;

  if (child.obligation_id === p.obligation_id || parent.ancestorIds.includes(child.obligation_id)) {
    violations.push({ code: "cycle_detected", message: "child obligation id already appears in the parent chain" });
  }
  if (!PARENT_STATES_ALLOWING_DELEGATION.includes(parent.state)) {
    violations.push({ code: "parent_not_active", message: `parent is ${parent.state}; delegation requires accepted or active` });
  }
  if (!p.allow_subdelegation || !p.subdelegation_limits) {
    violations.push({ code: "subdelegation_not_allowed", message: "parent obligation does not permit subdelegation" });
    return violations;
  }
  if (child.issuer_agent_id !== p.counterparty_agent_id) {
    violations.push({ code: "issuer_must_be_parent_counterparty", message: "only the parent's counterparty may delegate" });
  }
  if (child.payer_id !== p.counterparty_agent_id) {
    violations.push({ code: "payer_must_be_parent_counterparty", message: "the delegating agent pays for the child" });
  }
  if (child.principal_id !== p.principal_id) {
    violations.push({ code: "principal_mismatch", message: "child must carry the root principal" });
  }
  if (child.currency !== p.currency) {
    violations.push({ code: "currency_mismatch", message: `child currency ${child.currency} differs from parent ${p.currency}` });
  }
  if (Date.parse(child.deadline) > Date.parse(p.deadline)) {
    violations.push({ code: "deadline_exceeds_parent", message: "child deadline is later than parent deadline" });
  }
  const remaining = remainingExposure(parent);
  if (child.max_amount_minor > remaining) {
    violations.push({
      code: "exceeds_remaining_exposure",
      message: `child max_amount_minor ${child.max_amount_minor} exceeds parent's remaining authorized exposure ${remaining}`,
    });
  }
  const allowedPolicies = [p.acceptance_policy.policy_id, ...p.subdelegation_limits.allowed_policy_ids];
  if (!allowedPolicies.includes(child.acceptance_policy.policy_id)) {
    violations.push({ code: "policy_not_permitted", message: `policy ${child.acceptance_policy.policy_id} is not permitted by the parent` });
  }

  const depthBudget = Math.min(p.subdelegation_limits.max_depth, parent.inheritedMaxDepth ?? Number.MAX_SAFE_INTEGER);
  if (depthBudget < 1) {
    violations.push({ code: "depth_exceeded", message: "no subdelegation depth remains" });
  } else if (child.allow_subdelegation) {
    const childDepth = child.subdelegation_limits?.max_depth ?? 0;
    if (childDepth > depthBudget - 1) {
      violations.push({ code: "depth_exceeded", message: `child may subdelegate at most ${depthBudget - 1} further level(s)` });
    }
    if ((child.subdelegation_limits?.max_total_minor ?? 0) > child.max_amount_minor) {
      violations.push({ code: "exceeds_subdelegation_total", message: "child subdelegation total exceeds its own ceiling" });
    }
  }
  return violations;
}

/** Depth budget a child inherits from its parent chain. */
export function inheritedDepthForChild(parent: ParentContext): number {
  const own = parent.terms.subdelegation_limits?.max_depth ?? 0;
  return Math.min(own, parent.inheritedMaxDepth ?? Number.MAX_SAFE_INTEGER) - 1;
}

/** Generic cycle check over parent links (OB-7). */
export function hasCycle(parentOf: Map<string, string | null>): boolean {
  for (const start of parentOf.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = start;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
  return false;
}
