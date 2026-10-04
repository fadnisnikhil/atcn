import { canonicalize, signBytes, utf8Encode, verifyBytes } from "@atcn/schema";
import type { DeliveryClaim, ExpectationReport, KeyBindingRecord } from "./documents.js";
import { deliveryStatus } from "./projection.js";
import { costSign, type Rollup } from "./rollup.js";
import type { AssuranceLabel, Expectation, ExpectationIssuer, FinancialEventRecord, HoldStatus } from "./types.js";

/**
 * Estimates and holds (schema 1.5): what the agent, a budget gateway or the operator expected work to cost before it
 * ran, compared with what it actually cost. Record only: ATCN never enforces, blocks or reserves anything.
 */

export const EXPECTATION_STATEMENT_TYPE = "atcn.subledger.expectation";

/** What an agent or gateway signs. It covers every field of the record that carries meaning. */
export interface ExpectationStatement {
  document_type: typeof EXPECTATION_STATEMENT_TYPE;
  type: "estimate" | "hold";
  source: string;
  source_event_id: string;
  provider_reference: string | null;
  amount_minor: number;
  currency: string;
  issued_at: string;
  issued_by: ExpectationIssuer;
  source_ref: string | null;
  basis: string | null;
  expires_at: string | null;
  supersedes: string | null;
  hold_status: HoldStatus | null;
}

export interface ExpectationStatementInput {
  type: "estimate" | "hold";
  source: string;
  source_event_id: string;
  provider_reference?: string | null;
  amount_minor: number;
  currency: string;
  /** The event_date of the record. */
  issued_at: string;
  expectation: Omit<Expectation, "signer">;
}

export function buildExpectationStatement(input: ExpectationStatementInput): ExpectationStatement {
  return {
    document_type: EXPECTATION_STATEMENT_TYPE,
    type: input.type,
    source: input.source,
    source_event_id: input.source_event_id,
    provider_reference: input.provider_reference ?? null,
    amount_minor: input.amount_minor,
    currency: input.currency,
    issued_at: new Date(input.issued_at).toISOString(),
    issued_by: input.expectation.issued_by,
    source_ref: input.expectation.source_ref,
    basis: input.expectation.basis,
    expires_at: input.expectation.expires_at === null ? null : new Date(input.expectation.expires_at).toISOString(),
    supersedes: input.expectation.supersedes,
    hold_status: input.expectation.hold_status ?? null,
  };
}

/** The statement a stored estimate or hold record was signed over. */
export function expectationStatementOf(record: FinancialEventRecord): ExpectationStatement {
  return buildExpectationStatement({
    type: record.type as "estimate" | "hold",
    source: record.source,
    source_event_id: record.source_event_id,
    provider_reference: record.provider_reference,
    amount_minor: record.amount_minor,
    currency: record.currency,
    issued_at: record.event_date,
    expectation: record.expectation!,
  });
}

/** Agent- or gateway-side signing. The operator never holds the signer's private key. */
export function signExpectation(statement: ExpectationStatement, privateKey: string): string {
  return signBytes(utf8Encode(canonicalize(statement)), privateKey);
}

export function verifyExpectationSignature(statement: ExpectationStatement, signature: string, publicKey: string): boolean {
  return verifyBytes(utf8Encode(canonicalize(statement)), signature, publicKey);
}

/**
 * Why a signed estimate or hold does not verify, or null when it does (or carries no signature). The key must be bound
 * to the named provider and not revoked when the record was issued; an agent's estimate must be signed by the
 * provider of the delegation it is attributed to.
 */
export function expectationSignatureProblem(record: FinancialEventRecord, delegationProviderId: string | null, keyBindings: KeyBindingRecord[]): string | null {
  const signer = record.expectation?.signer;
  if (!signer) return null;
  const label = `${record.type} ${record.financial_event_id}`;
  const binding = keyBindings.find((b) => b.binding_id === signer.binding_id && b.key_id === signer.key_id);
  if (!binding) return `${label} is signed with a key binding that is not listed`;
  if (binding.provider_id !== signer.provider_id) return `${label} key binding belongs to another provider`;
  if (binding.revoked_at !== null && binding.revoked_at <= record.event_date) return `${label} was signed after its key binding was revoked`;
  if (record.expectation!.issued_by === "agent" && signer.provider_id !== delegationProviderId) return `${label} is an agent estimate signed by a provider other than the delegation's`;
  if (!signedStatementVerifies(() => verifyExpectationSignature(expectationStatementOf(record), signer.value, binding.public_key))) return `${label} signature does not verify`;
  return null;
}

/** Labels are never collapsed: a verified agent signature is provider_key_signed, a gateway's is gateway_signed, anything else is buyer_recorded. */
export function expectationAssurance(record: FinancialEventRecord, delegationProviderId: string | null, keyBindings: KeyBindingRecord[]): AssuranceLabel[] {
  const expectation = record.expectation!;
  if (!expectation.signer || expectationSignatureProblem(record, delegationProviderId, keyBindings) !== null) return ["buyer_recorded"];
  return [expectation.issued_by === "gateway" ? "gateway_signed" : "provider_key_signed"];
}

export interface ExpectationReportInput {
  task: { task_id: string; currency: string };
  delegations: { delegation_id: string; provider_id: string | null }[];
  claims: DeliveryClaim[];
  /** The task's financial events with their attribution (node ID: the task ID or a delegation ID). */
  events: { record: FinancialEventRecord; attributed_to: string }[];
  rollup: Rollup;
  key_bindings: KeyBindingRecord[];
}

type RecordStatus = ExpectationReport["records"][number]["status"];

/** Delivery statuses after which an open hold is treated as released: the work did not go ahead. */
const RELEASING_STATUSES = ["cancelled", "provider_failed"];

/** Variance in basis points of `base`, rounded half away from zero, using integers only. Null when there is no base. */
export function varianceBps(difference: number, base: number | null): number | null {
  if (base === null || base === 0) return null;
  const sign = difference < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(difference) * 10_000 * 2 + base) / (2 * base));
}

/**
 * Estimates and holds compared with actual cost, per node and for the task, in the task's currency. Null when the task
 * has no estimates or holds. A node's actual cost is its own net cost (what was billed against it directly).
 */
export function buildExpectationReport(input: ExpectationReportInput): ExpectationReport | null {
  const currency = input.task.currency;
  const expectations = input.events.filter((e) => e.record.expectation !== undefined);
  if (expectations.length === 0) return null;

  const providerOf = new Map(input.delegations.map((d) => [d.delegation_id, d.provider_id]));
  const statusOfDelegation = (nodeId: string) => deliveryStatus(input.claims.filter((c) => c.delegation_id === nodeId));
  const supersededIds = new Set(
    expectations.filter((e) => e.record.expectation!.supersedes !== null).map((e) => `${e.record.source}\u0000${e.record.type}\u0000${e.record.expectation!.supersedes}`),
  );
  const isSuperseded = (record: FinancialEventRecord) => supersededIds.has(`${record.source}\u0000${record.type}\u0000${record.source_event_id}`);
  const directNetCost = (nodeId: string) => input.rollup.nodes.find((n) => n.node_id === nodeId)?.direct[currency]?.net_cost ?? 0;
  const chargesOn = (nodeId: string) =>
    input.events
      .filter((e) => e.attributed_to === nodeId && e.record.currency === currency && costSign(e.record.type) === 1 && !input.rollup.excluded_event_ids.reversed.includes(e.record.financial_event_id))
      .map((e) => e.record);
  const firstChargeAt = (nodeId: string) => chargesOn(nodeId).map((r) => r.event_date).sort()[0] ?? null;
  const firstChargeRecordedAt = (nodeId: string) => chargesOn(nodeId).map((r) => r.imported_at).sort()[0] ?? null;
  // An estimate dated before the first charge but recorded after it was back-dated, unless the import says it is retrospective.
  const isAfterCharge = (record: FinancialEventRecord, nodeId: string) => {
    const firstCharge = firstChargeAt(nodeId);
    if (firstCharge === null) return false;
    return record.event_date > firstCharge || (!record.retrospective && record.imported_at > firstChargeRecordedAt(nodeId)!);
  };

  const records: ExpectationReport["records"] = expectations.map(({ record, attributed_to: nodeId }) => {
    let status: RecordStatus = "current";
    if (record.currency !== currency) status = "other_currency";
    else if (isSuperseded(record)) status = "superseded";
    else if (record.type === "estimate" && isAfterCharge(record, nodeId)) status = "after_charge";
    let holdStatus: HoldStatus | null = record.expectation!.hold_status ?? null;
    if (holdStatus === "open" && RELEASING_STATUSES.includes(statusOfDelegation(nodeId))) holdStatus = "released";
    const assurance = expectationAssurance(record, providerOf.get(nodeId) ?? null, input.key_bindings);
    return {
      financial_event_id: record.financial_event_id,
      node_id: nodeId,
      type: record.type as "estimate" | "hold",
      issued_by: record.expectation!.issued_by,
      status,
      hold_status: holdStatus,
      assurance: status === "superseded" ? [...assurance, "superseded"] : assurance,
    };
  });

  // Of several current estimates on a node, the latest issued is used; the others stay listed as not_latest.
  const recordById = new Map(expectations.map((e) => [e.record.financial_event_id, e.record]));
  const nodeIds = [...new Set(records.map((r) => r.node_id))];
  const usedEstimate = new Map<string, FinancialEventRecord>();
  for (const nodeId of nodeIds) {
    const current = records.filter((r) => r.node_id === nodeId && r.type === "estimate" && r.status === "current").map((r) => recordById.get(r.financial_event_id)!);
    const latest = current.reduce<FinancialEventRecord | null>((best, e) => (best === null || e.event_date >= best.event_date ? e : best), null);
    if (latest) usedEstimate.set(nodeId, latest);
  }
  for (const r of records) {
    if (r.type === "estimate" && r.status === "current" && usedEstimate.get(r.node_id)?.financial_event_id !== r.financial_event_id) r.status = "not_latest";
  }

  const nodes: ExpectationReport["nodes"] = nodeIds.map((nodeId) => {
    const estimate = usedEstimate.get(nodeId) ?? null;
    const held = records
      .filter((r) => r.node_id === nodeId && r.type === "hold" && r.status === "current" && (r.hold_status === "open" || r.hold_status === "captured"))
      .reduce((total, r) => total + recordById.get(r.financial_event_id)!.amount_minor, 0);
    const hasHold = records.some((r) => r.node_id === nodeId && r.type === "hold" && r.status === "current");
    return { node_id: nodeId, estimate_event_id: estimate?.financial_event_id ?? null, ...variance(estimate?.amount_minor ?? null, hasHold ? held : null, directNetCost(nodeId)) };
  });

  const estimated = nodes.some((n) => n.estimated_minor !== null) ? nodes.reduce((total, n) => total + (n.estimated_minor ?? 0), 0) : null;
  const anyHold = records.some((r) => r.type === "hold" && r.status === "current");
  const held = nodes.reduce((total, n) => total + n.held_minor, 0);
  const actual = input.rollup.root_total[currency]?.net_cost ?? 0;
  const estimatedNodes = new Set(nodes.filter((n) => n.estimated_minor !== null).map((n) => n.node_id));
  const unestimated = input.rollup.nodes.filter((n) => !estimatedNodes.has(n.node_id)).reduce((total, n) => total + (n.direct[currency]?.net_cost ?? 0), 0);
  return { currency, task: { ...variance(estimated, anyHold ? held : null, actual), unestimated_minor: unestimated }, nodes, records };
}

function variance(estimated: number | null, held: number | null, actual: number) {
  return {
    estimated_minor: estimated,
    held_minor: held ?? 0,
    actual_minor: actual,
    variance_vs_estimate_minor: estimated === null ? null : actual - estimated,
    variance_vs_estimate_bps: estimated === null ? null : varianceBps(actual - estimated, estimated),
    variance_vs_hold_minor: held === null ? null : actual - held,
    variance_vs_hold_bps: held === null ? null : varianceBps(actual - held, held),
  };
}

export interface ExpectationException {
  kind: "actual_exceeds_estimate" | "actual_exceeds_hold" | "hold_not_released" | "estimate_after_charge";
  dedupe_key: string;
  delegation_id: string | null;
  detail: string;
}

/**
 * Signals from the expectation report. Recorded, not prevented: none of them blocks work or changes a clearing outcome.
 * `closing` marks the derivation done when the task is closed, where an open hold with nothing charged is flagged.
 */
export function expectationExceptions(
  report: ExpectationReport,
  input: { task: { task_id: string; estimate_tolerance_bps?: number }; events: { record: FinancialEventRecord }[]; now: string; closing?: boolean },
): ExpectationException[] {
  const result: ExpectationException[] = [];
  const delegationOf = (nodeId: string) => (nodeId === input.task.task_id ? null : nodeId);
  const tolerance = input.task.estimate_tolerance_bps ?? 0;
  const recordById = new Map(input.events.map((e) => [e.record.financial_event_id, e.record]));
  for (const node of report.nodes) {
    if (node.estimated_minor !== null && node.actual_minor * 10_000 > node.estimated_minor * (10_000 + tolerance)) {
      result.push({
        kind: "actual_exceeds_estimate",
        dedupe_key: `actual_exceeds_estimate:${node.node_id}`,
        delegation_id: delegationOf(node.node_id),
        detail: `actual ${node.actual_minor} ${report.currency} exceeds estimate ${node.estimated_minor} by ${node.variance_vs_estimate_minor} (${node.variance_vs_estimate_bps} bps, tolerance ${tolerance} bps); recorded, not prevented`,
      });
    }
    if (node.variance_vs_hold_minor !== null && node.variance_vs_hold_minor > 0) {
      result.push({
        kind: "actual_exceeds_hold",
        dedupe_key: `actual_exceeds_hold:${node.node_id}`,
        delegation_id: delegationOf(node.node_id),
        detail: `actual ${node.actual_minor} ${report.currency} exceeds held ${node.held_minor} by ${node.variance_vs_hold_minor}; recorded, not prevented`,
      });
    }
  }
  for (const r of report.records) {
    const record = recordById.get(r.financial_event_id)!;
    if (r.status === "after_charge") {
      result.push({
        kind: "estimate_after_charge",
        dedupe_key: `estimate_after_charge:${r.financial_event_id}`,
        delegation_id: delegationOf(r.node_id),
        detail: `estimate ${r.financial_event_id} issued ${record.event_date} and recorded ${record.imported_at}, after the first charge on its node; kept, not used as the estimate`,
      });
    }
    if (r.type !== "hold" || r.status !== "current" || r.hold_status !== "open") continue;
    const expiresAt = record.expectation!.expires_at;
    const expired = expiresAt !== null && expiresAt < input.now;
    const nothingCharged = report.nodes.find((n) => n.node_id === r.node_id)!.actual_minor === 0;
    if (expired || (input.closing === true && nothingCharged)) {
      result.push({
        kind: "hold_not_released",
        dedupe_key: `hold_not_released:${r.financial_event_id}`,
        delegation_id: delegationOf(r.node_id),
        detail: expired ? `hold ${r.financial_event_id} of ${record.amount_minor} ${record.currency} is still open past its expiry ${expiresAt}` : `hold ${r.financial_event_id} of ${record.amount_minor} ${record.currency} is still open at close with nothing charged`,
      });
    }
  }
  return result;
}

/** A statement whose dates cannot be read cannot have been signed as given, so it does not verify. */
function signedStatementVerifies(verify: () => boolean): boolean {
  try {
    return verify();
  } catch {
    return false;
  }
}
