import { verifyClosurePackage } from "@atcn/core";
import { ClosurePackageSchema, digestOf, verifyPayload, type PublicKeyRecord } from "@atcn/schema";
import { CLEARING_SOURCE, clearingFacts, settlementEvidence, undoneBatch } from "./bridge.js";
import {
  CLOSURE_DOCUMENT_TYPE,
  RECEIPT_DOCUMENT_TYPE,
  SignedClosureSchema,
  SignedReceiptSchema,
  SIGNED_BY_HOSTED_SERVICE,
  SUBLEDGER_VERIFIER_VERSION,
  SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS,
  type ObligationLink,
  type OperatorKeyRecord,
  type OperatorSignature,
  type SignedClosure,
  type SignedReceipt,
} from "./documents.js";
import { receiptTotals, rollupFor } from "./projection.js";
import { verifyCountersignature, verifyStatementSignature } from "./response.js";
import { ATTESTABLE_FIELDS, type FinancialEventRecord } from "./types.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
}

export interface SubledgerVerificationReport {
  valid: boolean;
  document_type: string | null;
  /** Set when the document declares a schema version this verifier does not support; no other check ran. */
  unsupported_schema_version?: string;
  checks: CheckResult[];
}

export interface SubledgerVerifyOptions {
  /** Published service keys trusted out of band (GET /v1/service/keys). */
  trustedKeys: PublicKeyRecord[];
  /** The previous revision/version, when available, to check the chain link. */
  previous?: unknown;
  /** The issuing operator's published keys (GET /v1/operators/{operator_id}/keys), to check countersignatures. */
  operatorKeys?: OperatorKeyRecord[];
  /** Fail unless at least one countersignature by the operator's own key verifies. */
  requireOperatorSignature?: boolean;
  /** Closure packages (GET /v1/exports/{obligation_id}) of the obligations backing linked delegations, to cross-check them. */
  obligationPackages?: unknown[];
}

const SERVICE_ACTOR = "svc_atcn";

function check(name: string, problems: string[]): CheckResult {
  return { name, ok: problems.length === 0, details: problems };
}

function signatureCheck(doc: { payload: unknown; signature: { key_id: string; key_version: number } }, at: string, trustedKeys: PublicKeyRecord[]): CheckResult {
  const key = trustedKeys.find((k) => k.key_id === doc.signature.key_id && k.key_version === doc.signature.key_version && k.actor_id === SERVICE_ACTOR);
  if (!key) return check("issuer_signature", [`signing key ${doc.signature.key_id}#${doc.signature.key_version} is not a trusted service key`]);
  const problems: string[] = [];
  if (!(key.valid_from <= at && (key.revoked_at === null || key.revoked_at > at))) problems.push("signing key was not valid at signing time");
  if (!verifyPayload(doc as never, key.public_key)) problems.push("signature does not verify over the canonical payload");
  return check("issuer_signature", problems);
}

function operatorSignatureCheck(payload: unknown, operatorId: string, signatures: OperatorSignature[] | undefined, options: SubledgerVerifyOptions): CheckResult {
  const list = signatures ?? [];
  const required = options.requireOperatorSignature === true;
  if (list.length === 0) return required ? check("operator_signatures", ["no countersignature by the operator's own key"]) : { name: "operator_signatures", ok: true, details: ["no operator countersignature"] };
  if (!options.operatorKeys) {
    const note = `operator keys not supplied; ${list.length} countersignature(s) not checked`;
    return required ? check("operator_signatures", [note]) : { name: "operator_signatures", ok: true, details: [note] };
  }
  const problems: string[] = [];
  for (const sig of list) {
    const key = options.operatorKeys.find((k) => k.operator_id === operatorId && k.key_id === sig.key_id);
    if (!key) problems.push(`key ${sig.key_id} is not a published key of operator ${operatorId}`);
    else if (key.created_at > sig.signed_at || (key.revoked_at !== null && key.revoked_at <= sig.signed_at)) problems.push(`key ${sig.key_id} was not valid when the countersignature was recorded`);
    else if (!verifyCountersignature(payload, sig.value, key.public_key)) problems.push(`countersignature by ${sig.key_id} does not verify over the canonical payload`);
  }
  return check("operator_signatures", problems);
}

/** Detects the document type and verifies it offline: no network calls, no service access (acceptance 9). */
export function verifySubledgerDocument(input: unknown, options: SubledgerVerifyOptions): SubledgerVerificationReport {
  const documentType = (input as { payload?: { document_type?: unknown } } | null)?.payload?.document_type;
  if (documentType === RECEIPT_DOCUMENT_TYPE) return verifyReceipt(input, options);
  if (documentType === CLOSURE_DOCUMENT_TYPE) return verifyClosure(input, options);
  return { valid: false, document_type: null, checks: [check("document_type", [`unknown document_type ${String(documentType)}`])] };
}

function finish(documentType: string, checks: CheckResult[]): SubledgerVerificationReport {
  return { valid: checks.every((c) => c.ok), document_type: documentType, checks };
}

function schemaFailure(documentType: string, issues: { path: PropertyKey[]; message: string }[]): SubledgerVerificationReport {
  return finish(documentType, [check("schema", issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`))]);
}

/**
 * Runs before schema parsing. Without it, a document from a newer schema fails with a misleading
 * schema error, or with a signature mismatch once unknown fields are stripped.
 */
function unsupportedVersion(documentType: string, input: unknown): SubledgerVerificationReport | null {
  const version = (input as { payload?: { schema_version?: unknown } } | null)?.payload?.schema_version;
  const supported: readonly unknown[] = SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS;
  if (supported.includes(version)) return null;
  const detail =
    `unsupported schema_version ${String(version)}: this verifier (@atcn/subledger ${SUBLEDGER_VERIFIER_VERSION}) supports ` +
    `${SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS.join(" and ")}. Upgrade @atcn/verify-cli (or @atcn/subledger) to the minimum ` +
    "version listed for this schema in packages/schema/COMPATIBILITY.md.";
  return { valid: false, document_type: documentType, unsupported_schema_version: String(version), checks: [check("schema_version", [detail])] };
}

const SCHEMA_1_2_ASSERTERS: readonly string[] = ["buyer", "provider"];

/** A document that declares 1.2 must not carry 1.3 fields, which 1.2 verifiers cannot read. */
function versionFeatureProblems(version: string, signedBy: string, claims: { asserted_by: string; assurance: string[] }[], hasObligationLinks: boolean): string[] {
  if (version !== "1.2") return [];
  const problems = claims.filter((c) => !SCHEMA_1_2_ASSERTERS.includes(c.asserted_by)).map((c) => `schema 1.2 does not allow asserted_by ${c.asserted_by}`);
  if (claims.some((c) => c.assurance.includes("network_recorded"))) problems.push("schema 1.2 does not allow assurance network_recorded");
  if (hasObligationLinks) problems.push("schema 1.2 does not allow obligation_links");
  if (signedBy !== SIGNED_BY_HOSTED_SERVICE) problems.push(`schema 1.2 does not allow signed_by ${signedBy}`);
  return problems;
}

function reversalProblems(events: FinancialEventRecord[]): string[] {
  const byId = new Map(events.map((e) => [e.financial_event_id, e]));
  const problems: string[] = [];
  for (const e of events.filter((x) => x.type === "reversal")) {
    const original = e.reverses_event_id ? byId.get(e.reverses_event_id) : undefined;
    if (!original) problems.push(`reversal ${e.financial_event_id} references an event not in the document`);
    else if (original.amount_minor !== e.amount_minor || original.currency !== e.currency) problems.push(`reversal ${e.financial_event_id} does not match the reversed amount and currency`);
  }
  return problems;
}

export function verifyReceipt(input: unknown, options: SubledgerVerifyOptions): SubledgerVerificationReport {
  const unsupported = unsupportedVersion(RECEIPT_DOCUMENT_TYPE, input);
  if (unsupported) return unsupported;
  const parsed = SignedReceiptSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(RECEIPT_DOCUMENT_TYPE, parsed.error.issues);
  const doc: SignedReceipt = parsed.data;
  const r = doc.payload;
  const schemaProblems = versionFeatureProblems(r.schema_version, r.issuer.signed_by, r.delivery_claims, false);
  const checks: CheckResult[] = [check("schema", schemaProblems), signatureCheck(doc, r.issued_at, options.trustedKeys), operatorSignatureCheck(r, r.issuer.operator_id, doc.operator_signatures, options)];

  const events: FinancialEventRecord[] = r.financial_events.map(({ allocation_version: _version, ...e }) => ({ ...e, liability_owner: null, economic_event_id: null, fx: null }));
  checks.push(check("reversals", reversalProblems(events)));

  const recomputed = receiptTotals(r.delegation, events);
  checks.push(check("totals", digestOf(recomputed) === digestOf(r.totals) ? [] : ["totals do not match the listed financial events"]));

  const fieldProblems: string[] = [];
  const expectedUnverified = ATTESTABLE_FIELDS.filter((f) => r.field_status[f] !== "missing");
  if (digestOf(expectedUnverified) !== digestOf(r.unverified_fields)) fieldProblems.push("unverified_fields must list every non-missing field");
  for (const f of ATTESTABLE_FIELDS) if (!r.field_status[f]) fieldProblems.push(`field_status is missing ${f}`);
  checks.push(check("field_disclosure", fieldProblems));

  checks.push(receiptChainCheck(r, options));
  return finish(RECEIPT_DOCUMENT_TYPE, checks);
}

function receiptChainCheck(r: SignedReceipt["payload"], options: SubledgerVerifyOptions): CheckResult {
  if (r.revision === 1) return check("revision_chain", r.previous_receipt_digest === null && r.previous_receipt_id === null ? [] : ["revision 1 must not reference a previous receipt"]);
  if (r.previous_receipt_digest === null || r.previous_receipt_id === null) return check("revision_chain", [`revision ${r.revision} must reference its previous receipt`]);
  if (options.previous === undefined) return { name: "revision_chain", ok: true, details: ["previous revision not supplied; link digest not checked"] };
  const previous = SignedReceiptSchema.safeParse(options.previous);
  if (!previous.success) return check("revision_chain", ["supplied previous receipt is not a valid receipt"]);
  const p = previous.data.payload;
  const problems: string[] = [];
  if (p.receipt_id !== r.previous_receipt_id) problems.push("previous_receipt_id does not match the supplied receipt");
  if (digestOf(p) !== r.previous_receipt_digest) problems.push("previous_receipt_digest does not match the supplied receipt");
  if (p.revision + 1 !== r.revision) problems.push("revision is not the next after the supplied receipt");
  if (p.delegation.delegation_id !== r.delegation.delegation_id) problems.push("previous receipt covers a different delegation");
  if (!signatureCheck(previous.data, p.issued_at, options.trustedKeys).ok) problems.push("previous receipt signature does not verify");
  return check("revision_chain", problems);
}

export function verifyClosure(input: unknown, options: SubledgerVerifyOptions): SubledgerVerificationReport {
  const unsupported = unsupportedVersion(CLOSURE_DOCUMENT_TYPE, input);
  if (unsupported) return unsupported;
  const parsed = SignedClosureSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(CLOSURE_DOCUMENT_TYPE, parsed.error.issues);
  const doc: SignedClosure = parsed.data;
  const c = doc.payload;
  const schemaProblems = versionFeatureProblems(c.schema_version, c.issuer.signed_by, c.delivery_claims, c.obligation_links !== undefined);
  const checks: CheckResult[] = [check("schema", schemaProblems), signatureCheck(doc, c.generated_at, options.trustedKeys), operatorSignatureCheck(c, c.issuer.operator_id, doc.operator_signatures, options)];

  const digestProblems = c.financial_events.filter((e) => digestOf(e.record) !== e.event_digest).map((e) => `event ${e.record.financial_event_id} digest mismatch`);
  const ids = c.financial_events.map((e) => e.record.financial_event_id);
  if (new Set(ids).size !== ids.length) digestProblems.push("a financial event appears more than once");
  checks.push(check("event_digests", digestProblems));

  checks.push(check("lineage", lineageProblems(c)));
  checks.push(check("reversals", reversalProblems(c.financial_events.map((e) => e.record))));
  checks.push(check("allocations", allocationProblems(c)));

  const recomputed = rollupFor(c.task, c.delegations, c.financial_events, c.allocations);
  checks.push(check("totals", digestOf(recomputed) === digestOf(c.rollup) ? [] : ["roll-up does not match events, attribution, and allocations"]));

  checks.push(check("provider_responses", responseProblems(c)));
  checks.push(closureChainCheck(c, options));
  checks.push(obligationLinkCheck(c, options));
  return finish(CLOSURE_DOCUMENT_TYPE, checks);
}

/**
 * Delegations backed by clearing-network obligations. Every event recorded from the clearing journal must sit on a
 * linked delegation. With the obligations' closure packages, each package must verify, contain the linked decision,
 * and its journal batches posted before the closure must produce exactly the recorded events.
 */
function obligationLinkCheck(c: SignedClosure["payload"], options: SubledgerVerifyOptions): CheckResult {
  const name = "obligation_links";
  const links = c.obligation_links ?? [];
  const problems: string[] = [];
  const delegationIds = new Set(c.delegations.map((d) => d.delegation_id));
  for (const link of links) if (!delegationIds.has(link.delegation_id)) problems.push(`linked delegation ${link.delegation_id} is not in the task`);
  if (new Set(links.map((l) => l.obligation_id)).size !== links.length) problems.push("an obligation is linked more than once");
  const linked = new Set(links.map((l) => l.delegation_id));
  for (const e of c.financial_events) {
    if (e.record.source === CLEARING_SOURCE && !linked.has(e.attributed_to)) problems.push(`clearing-network event ${e.record.financial_event_id} is attributed to a node without a linked obligation`);
  }
  if (problems.length > 0) return check(name, problems);
  if (links.length === 0) return { name, ok: true, details: ["no delegation is backed by an obligation"] };
  if (!options.obligationPackages) return { name, ok: true, details: [`${links.length} linked obligation(s); closure packages not supplied; not cross-checked`] };
  for (const link of links) problems.push(...linkProblems(c, link, options.obligationPackages, options.trustedKeys));
  return problems.length > 0 ? check(name, problems) : { name, ok: true, details: [`${links.length} linked obligation(s) match their closure packages`] };
}

function linkProblems(c: SignedClosure["payload"], link: ObligationLink, packages: unknown[], trustedKeys: PublicKeyRecord[]): string[] {
  const pkg = packages
    .map((p) => ClosurePackageSchema.safeParse(p))
    .find((r) => r.success && r.data.payload.obligations.some((o) => o.obligation_id === link.obligation_id && !o.redacted));
  if (!pkg?.success) return [`no supplied closure package covers obligation ${link.obligation_id}`];
  const body = pkg.data.payload;
  const problems: string[] = [];

  const report = verifyClosurePackage(pkg.data, { trustedKeys });
  if (!report.valid) problems.push(`closure package for ${link.obligation_id} does not verify (${report.checks.filter((x) => !x.ok).map((x) => x.name).join(", ")})`);
  if (link.decision_id !== null) {
    const decision = body.decisions.find((d) => d.decision_id === link.decision_id && d.obligation_id === link.obligation_id);
    if (!decision) problems.push(`decision ${link.decision_id} is not in the package for ${link.obligation_id}`);
    else if (decision.decision_digest !== link.decision_digest) problems.push(`decision ${link.decision_id} digest differs from the package`);
  }

  const batches = body.posting_batches.filter((b) => b.obligation_id === link.obligation_id);
  const expected = batches
    .filter((b) => b.posted_at <= c.generated_at)
    .flatMap((b) => clearingFacts(b, undoneBatch(b, batches, body.settlement_events)).map((f) => ({ ...f, evidence: settlementEvidence(b, body.settlement_events) })));
  const recorded = c.financial_events.filter((e) => e.record.source === CLEARING_SOURCE && e.attributed_to === link.delegation_id).map((e) => e.record);
  const byKey = new Map(recorded.map((e) => [e.source_event_id, e]));
  for (const f of expected) {
    const e = byKey.get(f.key);
    if (!e) {
      problems.push(`journal fact ${f.key} (${f.type} ${f.amount_minor} ${f.currency}) is missing from the closure`);
      continue;
    }
    if (e.type !== f.type || e.amount_minor !== f.amount_minor || e.currency !== f.currency) problems.push(`event ${e.financial_event_id} does not match journal fact ${f.key}`);
    if (digestOf(e.evidence) !== digestOf(f.evidence)) problems.push(`event ${e.financial_event_id} does not cite the settlement report and basis in the package`);
    if (f.reverses_key !== null && byKey.get(f.reverses_key)?.financial_event_id !== e.reverses_event_id) problems.push(`reversal ${e.financial_event_id} does not undo the event for ${f.reverses_key}`);
  }
  const expectedKeys = new Set(expected.map((f) => f.key));
  for (const e of recorded) if (!expectedKeys.has(e.source_event_id)) problems.push(`event ${e.financial_event_id} (${e.source_event_id}) has no matching fact in the package's journal`);
  return problems;
}

function lineageProblems(c: SignedClosure["payload"]): string[] {
  const problems: string[] = [];
  const byId = new Map(c.delegations.map((d) => [d.delegation_id, d]));
  if (byId.size !== c.delegations.length) problems.push("duplicate delegation IDs");
  for (const d of c.delegations) {
    if (d.parent_delegation_id === null) {
      if (d.depth !== 1) problems.push(`delegation ${d.delegation_id} is a direct child of the task but has depth ${d.depth}`);
      continue;
    }
    const parent = byId.get(d.parent_delegation_id);
    if (!parent) problems.push(`delegation ${d.delegation_id} references a parent outside the task`);
    else if (parent.depth + 1 !== d.depth) problems.push(`delegation ${d.delegation_id} depth does not follow its parent`);
    const seen = new Set<string>([d.delegation_id]);
    let current = parent;
    while (current) {
      if (seen.has(current.delegation_id)) {
        problems.push(`cycle through ${d.delegation_id}`);
        break;
      }
      seen.add(current.delegation_id);
      current = current.parent_delegation_id ? byId.get(current.parent_delegation_id) : undefined;
    }
  }
  const nodes = new Set([c.task.task_id, ...byId.keys()]);
  for (const e of c.financial_events) if (!nodes.has(e.attributed_to)) problems.push(`event ${e.record.financial_event_id} is attributed outside the task tree`);
  for (const claim of c.delivery_claims) if (!byId.has(claim.delegation_id)) problems.push(`delivery claim ${claim.event_id} references a delegation outside the task`);
  return problems;
}

function allocationProblems(c: SignedClosure["payload"]): string[] {
  const problems: string[] = [];
  const events = new Map(c.financial_events.map((e) => [e.record.financial_event_id, e]));
  const versions = new Map<string, number[]>();
  for (const a of c.allocations) {
    const event = events.get(a.financial_event_id);
    if (!event) {
      problems.push(`allocation ${a.allocation_id} references an event not in the closure`);
      continue;
    }
    if (a.source_event_digest !== event.event_digest) problems.push(`allocation ${a.allocation_id} source digest does not match the event`);
    if (a.currency !== event.record.currency) problems.push(`allocation ${a.allocation_id} currency differs from its source`);
    if (a.source_amount_minor !== Math.abs(event.record.amount_minor)) problems.push(`allocation ${a.allocation_id} source amount differs from its event`);
    const sum = a.lines.reduce((total, line) => total + line.amount_minor, 0);
    if (sum !== a.source_amount_minor) problems.push(`allocation ${a.allocation_id} lines sum to ${sum}, source is ${a.source_amount_minor}`);
    versions.set(a.financial_event_id, [...(versions.get(a.financial_event_id) ?? []), a.version]);
  }
  for (const [eventId, list] of versions) {
    const sorted = [...list].sort((x, y) => x - y);
    if (sorted.some((v, i) => v !== i + 1)) problems.push(`allocation versions for ${eventId} are not contiguous from 1`);
  }
  return problems;
}

function responseProblems(c: SignedClosure["payload"]): string[] {
  const problems: string[] = [];
  const receipts = new Map(c.receipts.map((r) => [r.receipt_id, r]));
  const delegationIds = new Set(c.delegations.map((d) => d.delegation_id));
  for (const r of c.receipts) if (!delegationIds.has(r.delegation_id)) problems.push(`receipt ${r.receipt_id} covers a delegation outside the task`);
  for (const response of c.responses) {
    const receipt = receipts.get(response.receipt_id);
    const s = response.statement;
    if (digestOf(s) !== response.statement_digest) problems.push(`response ${response.response_id} statement digest mismatch`);
    if (!receipt) {
      problems.push(`response ${response.response_id} references an unknown receipt`);
      continue;
    }
    if (s.receipt_id !== receipt.receipt_id || s.receipt_digest !== receipt.digest || s.receipt_revision !== receipt.revision || s.receipt_revision !== response.receipt_revision) {
      problems.push(`response ${response.response_id} is not bound to receipt ${receipt.receipt_id} revision ${receipt.revision}`);
    }
    if (s.issuer_operator_id !== c.issuer.operator_id) problems.push(`response ${response.response_id} names another issuer`);
    const claimsKeySigned = response.assurance.includes("provider_key_signed");
    if (!claimsKeySigned) continue;
    const sig = response.provider_signature;
    const binding = sig ? c.key_bindings.find((b) => b.binding_id === sig.binding_id && b.key_id === sig.key_id) : undefined;
    if (!sig || !binding) problems.push(`response ${response.response_id} claims provider_key_signed without a listed key binding`);
    else if (binding.provider_id !== response.provider_id) problems.push(`response ${response.response_id} key binding belongs to another provider`);
    else if (binding.created_at > response.created_at || (binding.revoked_at !== null && binding.revoked_at <= response.created_at)) problems.push(`response ${response.response_id} signed outside the key binding's validity`);
    else if (!verifyStatementSignature(s, sig.value, binding.public_key)) problems.push(`response ${response.response_id} provider signature does not verify`);
  }
  return problems;
}

function closureChainCheck(c: SignedClosure["payload"], options: SubledgerVerifyOptions): CheckResult {
  if (c.version === 1) return check("version_chain", c.previous_closure_digest === null && c.previous_closure_id === null ? [] : ["version 1 must not reference a previous closure"]);
  if (c.previous_closure_digest === null || c.previous_closure_id === null) return check("version_chain", [`version ${c.version} must reference its previous closure`]);
  if (options.previous === undefined) return { name: "version_chain", ok: true, details: ["previous version not supplied; link digest not checked"] };
  const previous = SignedClosureSchema.safeParse(options.previous);
  if (!previous.success) return check("version_chain", ["supplied previous closure is not a valid closure"]);
  const p = previous.data.payload;
  const problems: string[] = [];
  if (p.closure_id !== c.previous_closure_id) problems.push("previous_closure_id does not match the supplied closure");
  if (digestOf(p) !== c.previous_closure_digest) problems.push("previous_closure_digest does not match the supplied closure");
  if (p.version + 1 !== c.version) problems.push("version is not the next after the supplied closure");
  if (p.task.task_id !== c.task.task_id) problems.push("previous closure covers a different task");
  if (!signatureCheck(previous.data, p.generated_at, options.trustedKeys).ok) problems.push("previous closure signature does not verify");
  return check("version_chain", problems);
}
