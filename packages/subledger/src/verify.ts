import { verifyClosurePackage } from "@atcn/core";
import {
  AgentTraceSchema,
  ClosurePackageSchema,
  canonicalize,
  digestOf,
  executionBinding,
  resolveAttestations,
  summarizeTrace,
  traceDigest,
  traceProblems,
  utf8Decode,
  verifyPayload,
  type AgentTrace,
  type PublicKeyRecord,
} from "@atcn/schema";
import { CLEARING_SOURCE, clearingFacts, settlementEvidence, undoneBatch } from "./bridge.js";
import {
  CLOSURE_DOCUMENT_TYPE,
  RECEIPT_DOCUMENT_TYPE,
  SignedClosureSchema,
  SignedReceiptSchema,
  SIGNED_BY_HOSTED_SERVICE,
  SUBLEDGER_VERIFIER_VERSION,
  SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS,
  type KeyBindingRecord,
  type ObligationLink,
  type OperatorKeyRecord,
  type OperatorSignature,
  type ResponseRecord,
  type DeliveryClaim,
  type SignedClosure,
  type SignedReceipt,
} from "./documents.js";
import { DERIVED_EXCEPTION_KINDS, SERVICE_ONLY_EXCEPTION_KINDS, deriveTaskExceptions, type DerivedException } from "./exceptions.js";
import { buildExpectationReport, expectationSignatureProblem } from "./expectations.js";
import { closureDisclosure, deliveryStatus, labelResponses, receiptTotals, responseAttestation, rollupFor, signerKeyBindings } from "./projection.js";
import { verifyCountersignature, verifyStatementSignature } from "./response.js";
import { outcomeSignatureProblem } from "./outcome.js";
import { buildRailAttestationReport, railAttestationProblem } from "./rails.js";
import { attestableFieldsFor, type ExceptionKind, type FinancialEventRecord } from "./types.js";
import { usageChecksFor } from "./usage.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
  /** Set when the check had nothing it could inspect (for example, traces committed but not supplied). Not a pass. */
  state?: "not_inspected";
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
  /** Time to check a receipt's expires_at against (ISO 8601). Defaults to now. */
  at?: string;
  /** Trace files (raw bytes) behind recorded usage, to recompute each usage summary from its trace. */
  traces?: Uint8Array[];
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

const NOT_CANONICAL = "payload is not canonical JSON: numbers must be safe integers";

/** Free-form parts of a payload, such as an embedded rail record, can hold numbers that no signature could cover. */
function isCanonical(payload: unknown): boolean {
  try {
    canonicalize(payload);
    return true;
  } catch {
    return false;
  }
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
  const versions = [...SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS];
  const detail =
    `unsupported schema_version ${String(version)}: this verifier (@atcn/subledger ${SUBLEDGER_VERIFIER_VERSION}) supports ` +
    `${versions.slice(0, -1).join(", ")} and ${versions.at(-1)}. Upgrade @atcn/verify-cli (or @atcn/subledger) to the minimum ` +
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

const SCHEMA_1_4_STATEMENT_FIELDS = ["execution", "issued_at", "expires_at", "refs"] as const;
const SCHEMA_1_4_LABELS: readonly string[] = ["expired", "revoked"];

/** A document that declares 1.2 or 1.3 must not carry 1.4 fields, which those verifiers would drop before checking signatures. */
function schema14Problems(version: string, delegations: { delegation_id: string; execution?: unknown }[], responses: ResponseRecord[], claims: { assurance: string[] }[]): string[] {
  if (version !== "1.2" && version !== "1.3") return [];
  const problems = delegations.filter((d) => d.execution !== undefined).map((d) => `schema ${version} does not allow execution on delegation ${d.delegation_id}`);
  for (const r of responses) {
    for (const field of SCHEMA_1_4_STATEMENT_FIELDS) if (r.statement[field] !== undefined) problems.push(`schema ${version} does not allow statement ${field} (response ${r.response_id})`);
  }
  for (const item of [...responses, ...claims]) {
    for (const label of item.assurance.filter((l) => SCHEMA_1_4_LABELS.includes(l))) problems.push(`schema ${version} does not allow assurance ${label}`);
  }
  return problems;
}

interface Schema15Parts {
  delegations: { delegation_id: string; execution?: { agent: { additional_models?: unknown } }; pricing?: unknown; refund_terms?: unknown; witness_policy?: unknown }[];
  claims: { event_id: string; usage?: unknown; signer?: unknown }[];
  events: { financial_event_id: string; type: string; skill?: unknown; expectation?: unknown; rail_attestation?: unknown; normalized_status: string }[];
  responses: ResponseRecord[];
  fieldLists: string[][];
  hasUsageChecks: boolean;
  hasExpectationReport?: boolean;
  hasEstimateTolerance?: boolean;
  hasRailAttestations?: boolean;
  hasReceiptKeyBindings?: boolean;
  hasResolvedExceptions?: boolean;
}

/** A document that declares 1.2, 1.3 or 1.4 must not carry 1.5 fields, which those verifiers would drop before checking signatures. */
function schema15Problems(version: string, parts: Schema15Parts): string[] {
  if (!["1.2", "1.3", "1.4"].includes(version)) return [];
  const problems: string[] = [];
  for (const d of parts.delegations) {
    if (d.pricing !== undefined) problems.push(`schema ${version} does not allow pricing on delegation ${d.delegation_id}`);
    if (d.refund_terms !== undefined) problems.push(`schema ${version} does not allow refund_terms on delegation ${d.delegation_id}`);
    if (d.witness_policy !== undefined) problems.push(`schema ${version} does not allow witness_policy on delegation ${d.delegation_id}`);
    if (d.execution?.agent.additional_models !== undefined) problems.push(`schema ${version} does not allow additional_models on delegation ${d.delegation_id}`);
  }
  for (const c of parts.claims) {
    if (c.usage !== undefined) problems.push(`schema ${version} does not allow usage on delivery claim ${c.event_id}`);
    if (c.signer !== undefined) problems.push(`schema ${version} does not allow signer on delivery claim ${c.event_id}`);
  }
  for (const e of parts.events) {
    if (e.skill !== undefined) problems.push(`schema ${version} does not allow skill on financial event ${e.financial_event_id}`);
    if (e.normalized_status === "pending_finality") problems.push(`schema ${version} does not allow status pending_finality on financial event ${e.financial_event_id}`);
    if (e.type === "estimate" || e.type === "hold") problems.push(`schema ${version} does not allow ${e.type} events (financial event ${e.financial_event_id})`);
    if (e.expectation !== undefined) problems.push(`schema ${version} does not allow expectation on financial event ${e.financial_event_id}`);
    if (e.rail_attestation !== undefined) problems.push(`schema ${version} does not allow rail_attestation on financial event ${e.financial_event_id}`);
  }
  if (parts.hasUsageChecks) problems.push(`schema ${version} does not allow usage_checks`);
  if (parts.hasExpectationReport) problems.push(`schema ${version} does not allow expectation_report`);
  if (parts.hasEstimateTolerance) problems.push(`schema ${version} does not allow task estimate_tolerance_bps`);
  if (parts.hasRailAttestations) problems.push(`schema ${version} does not allow rail_attestations`);
  if (parts.hasReceiptKeyBindings) problems.push(`schema ${version} does not allow key_bindings on a receipt`);
  if (parts.hasResolvedExceptions) problems.push(`schema ${version} does not allow resolved_exceptions`);
  for (const r of parts.responses) if (r.statement.role !== undefined) problems.push(`schema ${version} does not allow statement role (response ${r.response_id})`);
  const usageFieldUsed = parts.fieldLists.some((list) => list.includes("delivery.usage")) || parts.responses.some((r) => r.statement.fields.includes("delivery.usage") || r.statement.corrections.some((c) => c.field === "delivery.usage"));
  if (usageFieldUsed) problems.push(`schema ${version} does not allow the delivery.usage field`);
  return problems;
}

/**
 * Recomputes each recorded usage summary from its trace file. Usage whose trace was not supplied is reported as not
 * inspected; it neither passes nor fails. A supplied file that is not a well-formed trace fails.
 */
function traceSummaryCheck(claims: Pick<DeliveryClaim, "event_id" | "usage">[], traceFiles: Uint8Array[] | undefined): CheckResult {
  const name = "trace_summary";
  const withUsage = claims.filter((c) => c.usage !== undefined);
  if (withUsage.length === 0) return { name, ok: true, details: ["no usage recorded"] };
  const problems: string[] = [];
  const traces = new Map<string, AgentTrace>();
  (traceFiles ?? []).forEach((bytes, index) => {
    const trace = parseTraceFile(bytes);
    if (typeof trace === "string") problems.push(`trace file ${index + 1}: ${trace}`);
    else traces.set(traceDigest(trace), trace);
  });
  const notInspected: string[] = [];
  const used = new Set<string>();
  for (const claim of withUsage) {
    const usage = claim.usage!;
    const trace = traces.get(usage.trace_digest);
    if (!trace) {
      notInspected.push(`not inspected: delivery claim ${claim.event_id} (trace ${usage.trace_digest} not supplied)`);
      continue;
    }
    used.add(usage.trace_digest);
    if (digestOf(summarizeTrace(trace)) !== digestOf(usage.summary)) problems.push(`delivery claim ${claim.event_id}: recorded usage does not match its trace ${usage.trace_digest}`);
  }
  if (problems.length > 0) return check(name, problems);
  const unused = [...traces.keys()].filter((d) => !used.has(d)).map((d) => `supplied trace ${d} matches no recorded usage`);
  const inspected = withUsage.length - notInspected.length;
  const details = [...(inspected > 0 ? [`${inspected} recorded usage summary(ies) match their traces`] : []), ...notInspected, ...unused];
  return inspected === 0 ? { name, ok: true, details, state: "not_inspected" } : { name, ok: true, details };
}

function parseTraceFile(bytes: Uint8Array): AgentTrace | string {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(bytes));
  } catch {
    return "not JSON";
  }
  const parsed = AgentTraceSchema.safeParse(raw);
  if (!parsed.success) return `not a trace: ${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`;
  const problems = traceProblems(parsed.data);
  return problems.length > 0 ? `malformed trace: ${problems.join("; ")}` : parsed.data;
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
  if (!isCanonical(parsed.data.payload)) return finish(RECEIPT_DOCUMENT_TYPE, [check("schema", [NOT_CANONICAL])]);
  const doc: SignedReceipt = parsed.data;
  const r = doc.payload;
  const schemaProblems = [
    ...versionFeatureProblems(r.schema_version, r.issuer.signed_by, r.delivery_claims, false),
    ...schema14Problems(r.schema_version, [r.delegation], [], r.delivery_claims),
    ...schema15Problems(r.schema_version, {
      delegations: [r.delegation],
      claims: r.delivery_claims,
      events: r.financial_events,
      responses: [],
      fieldLists: [Object.keys(r.field_status), r.unverified_fields, ...r.corrections.map((c) => c.fields)],
      hasUsageChecks: false,
      hasReceiptKeyBindings: r.key_bindings !== undefined,
    }),
  ];
  const checks: CheckResult[] = [check("schema", schemaProblems), signatureCheck(doc, r.issued_at, options.trustedKeys), operatorSignatureCheck(r, r.issuer.operator_id, doc.operator_signatures, options)];

  const events: FinancialEventRecord[] = r.financial_events.map(({ allocation_version: _version, ...e }) => ({ ...e, liability_owner: null, economic_event_id: null, fx: null }));
  checks.push(check("reversals", reversalProblems(events)));

  const recomputed = receiptTotals(r.delegation, events);
  checks.push(check("totals", digestOf(recomputed) === digestOf(r.totals) ? [] : ["totals do not match the listed financial events"]));

  const fieldProblems: string[] = [];
  const fields = attestableFieldsFor(r.schema_version);
  const expectedUnverified = fields.filter((f) => r.field_status[f] !== "missing");
  if (digestOf(expectedUnverified) !== digestOf(r.unverified_fields)) fieldProblems.push("unverified_fields must list every non-missing field");
  for (const f of fields) if (!r.field_status[f]) fieldProblems.push(`field_status is missing ${f}`);
  checks.push(check("field_disclosure", fieldProblems));

  checks.push(receiptSignedRecordsCheck(r, events));
  checks.push(receiptChainCheck(r, options));
  checks.push(receiptExpiryCheck(r, options.at ?? new Date().toISOString()));
  checks.push(traceSummaryCheck(r.delivery_claims, options.traces));
  return finish(RECEIPT_DOCUMENT_TYPE, checks);
}

/**
 * Provider-signed outcome claims and signed estimates and holds on a receipt must verify against the key bindings it
 * lists, which must be exactly the bindings their signers name; only verified claims may be labelled provider_key_signed.
 */
function receiptSignedRecordsCheck(r: SignedReceipt["payload"], events: FinancialEventRecord[]): CheckResult {
  const name = "signed_records";
  const listed = r.key_bindings ?? [];
  const problems: string[] = [];
  if (digestOf(signerKeyBindings(r.delivery_claims, events, listed)) !== digestOf(listed)) problems.push("key_bindings must list exactly the bindings the receipt's signers name, in binding_id order");
  const delegation = { provider_id: r.provider.provider_id, provider_job_ref: r.delegation.provider_job_ref };
  for (const claim of r.delivery_claims) {
    const labelled = claim.assurance.includes("provider_key_signed");
    if (!claim.signer) {
      if (labelled) problems.push(`${claim.type} claim ${claim.event_id} is labelled provider_key_signed without a signature`);
      continue;
    }
    const problem = outcomeSignatureProblem({ ...claim, delegation_id: r.delegation.delegation_id }, delegation, listed);
    if (problem) problems.push(problem);
    else if (!labelled) problems.push(`${claim.type} claim ${claim.event_id} is signed but not labelled provider_key_signed`);
  }
  for (const e of events) {
    if (!e.expectation) continue;
    const problem = expectationSignatureProblem(e, r.provider.provider_id, listed);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) return check(name, problems);
  const claims = r.delivery_claims.filter((c) => c.signer).length;
  const estimates = events.filter((e) => e.expectation?.signer).length;
  if (claims + estimates === 0) return { name, ok: true, details: ["no signed claims, estimates or holds"] };
  return { name, ok: true, details: [`${claims} provider-signed outcome claim(s) and ${estimates} signed estimate/hold record(s) verify against the listed key bindings`] };
}

/** The issuer signed expires_at, so a receipt past it no longer stands, even though its signature still verifies. */
function receiptExpiryCheck(r: SignedReceipt["payload"], at: string): CheckResult {
  if (r.expires_at === null) return { name: "expiry", ok: true, details: ["no expiry"] };
  if (Date.parse(at) >= Date.parse(r.expires_at)) return check("expiry", [`receipt expired at ${r.expires_at} (checked at ${at})`]);
  return { name: "expiry", ok: true, details: [`valid until ${r.expires_at} (checked at ${at})`] };
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
  if (!isCanonical(parsed.data.payload)) return finish(CLOSURE_DOCUMENT_TYPE, [check("schema", [NOT_CANONICAL])]);
  const doc: SignedClosure = parsed.data;
  const c = doc.payload;
  const schemaProblems = [
    ...versionFeatureProblems(c.schema_version, c.issuer.signed_by, c.delivery_claims, c.obligation_links !== undefined),
    ...schema14Problems(c.schema_version, c.delegations, c.responses, c.delivery_claims),
    ...schema15Problems(c.schema_version, {
      delegations: c.delegations,
      claims: c.delivery_claims,
      events: c.financial_events.map((e) => e.record),
      responses: c.responses,
      fieldLists: [],
      hasUsageChecks: c.usage_checks !== undefined,
      hasExpectationReport: c.expectation_report !== undefined,
      hasEstimateTolerance: c.task.estimate_tolerance_bps !== undefined,
      hasRailAttestations: c.rail_attestations !== undefined,
      hasResolvedExceptions: c.resolved_exceptions !== undefined,
    }),
  ];
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

  checks.push(derivedFieldsCheck(c));
  checks.push(providerResponsesCheck(c));
  checks.push(closureChainCheck(c, options));
  checks.push(obligationLinkCheck(c, options));
  checks.push(usageChecksCheck(c, recomputed));
  checks.push(expectationsCheck(c, recomputed));
  checks.push(openExceptionsCheck(c));
  checks.push(signedClaimsCheck(c));
  checks.push(railAttestationsCheck(c));
  checks.push(traceSummaryCheck(c.delivery_claims, options.traces));
  return finish(CLOSURE_DOCUMENT_TYPE, checks);
}

/**
 * Each embedded rail attestation must verify offline (Merkle inclusion for A2A-SE, the payer's signature for x402) and
 * agree with its event, and rail_attestations must list exactly those events.
 */
function railAttestationsCheck(c: SignedClosure["payload"]): CheckResult {
  const name = "rail_attestations";
  const problems: string[] = [];
  for (const { record } of c.financial_events) {
    const problem = railAttestationProblem(record);
    if (problem) problems.push(`${record.type} ${record.financial_event_id}: rail attestation refused (${problem.code}): ${problem.detail}`);
  }
  const expected = buildRailAttestationReport(c.financial_events);
  if (digestOf(expected ?? null) !== digestOf(c.rail_attestations ?? null)) problems.push("rail_attestations do not match the closure's payment and refund records");
  if (problems.length > 0) return check(name, problems);
  if (!expected) return { name, ok: true, details: ["no rail attestations"] };
  return { name, ok: true, details: [`${expected.length} payment/refund record(s) rail_attested, re-verified offline without contacting the rail`, ...expected.map((e) => e.anchor)] };
}

const isRecomputableException = (kind: string) =>
  DERIVED_EXCEPTION_KINDS.includes(kind as ExceptionKind) && !SERVICE_ONLY_EXCEPTION_KINDS.includes(kind as ExceptionKind);

/** The derived exceptions a closure's own records imply at close, as of generated_at; the service must list each as open or resolved. */
export function closureDerivedExceptions(c: SignedClosure["payload"]): DerivedException[] {
  return deriveTaskExceptions({
    task: c.task,
    delegations: c.delegations,
    claims: c.delivery_claims,
    events: c.financial_events,
    rollup: rollupFor(c.task, c.delegations, c.financial_events, c.allocations),
    now: c.generated_at,
    responses: c.responses,
    receipts: c.receipts,
    key_bindings: c.key_bindings,
    closing: true,
  }).filter((d) => isRecomputableException(d.kind));
}

/**
 * Schema 1.5: the derived exceptions recomputed from the closure's own records, as of generated_at and at close, must
 * each be open or listed as resolved by a person, and no open derived exception may lack its condition. Witness quorum
 * (it needs the service's verified domains) and exceptions raised at intake are not recomputed.
 */
function openExceptionsCheck(c: SignedClosure["payload"]): CheckResult {
  const name = "open_exceptions";
  if (["1.2", "1.3", "1.4"].includes(c.schema_version)) return { name, ok: true, details: [`schema ${c.schema_version}: open exceptions are not recomputed`] };
  const derived = closureDerivedExceptions(c);
  const sameCondition = (x: { kind: string; delegation_id: string | null; detail: string }, d: { kind: string; delegation_id: string | null; detail: string }) =>
    x.kind === d.kind && x.delegation_id === d.delegation_id && x.detail === d.detail;
  const open = c.open_exceptions.filter((x) => isRecomputableException(x.kind));
  const resolved = c.resolved_exceptions ?? [];
  const problems: string[] = c.open_exceptions.filter((x) => x.status !== "open").map((x) => `open_exceptions lists ${x.kind} exception ${x.exception_id} with status ${x.status}`);
  for (const d of derived) {
    if (!open.some((x) => sameCondition(x, d)) && !resolved.some((x) => sameCondition(x, d))) problems.push(`${d.kind} on ${d.delegation_id ?? c.task.task_id} holds but is neither open nor resolved: ${d.detail}`);
  }
  for (const x of open) if (!derived.some((d) => sameCondition(x, d))) problems.push(`${x.kind} exception ${x.exception_id} is open but its condition does not hold at generated_at`);
  for (const x of resolved) {
    if (x.status === "open" || x.resolved_by === "system") problems.push(`resolved exception ${x.exception_id} must be resolved or dismissed by a person`);
    if (!derived.some((d) => sameCondition(x, d))) problems.push(`resolved exception ${x.exception_id} (${x.kind}) does not match a condition that holds at generated_at`);
  }
  if (problems.length > 0) return check(name, problems);
  return {
    name,
    ok: true,
    details: [
      `${derived.length} derived exception(s) recomputed as of generated_at: ${derived.length - resolved.length} open, ${resolved.length} resolved by a person`,
      "not recomputed: witness_quorum_not_met (needs the service's verified domains) and exceptions raised at intake",
    ],
  };
}

/** Provider-signed outcome claims must verify against the listed key bindings, and only they may be labelled provider_key_signed. */
function signedClaimsCheck(c: SignedClosure["payload"]): CheckResult {
  const name = "signed_claims";
  const delegationOf = new Map(c.delegations.map((d) => [d.delegation_id, d]));
  const problems: string[] = [];
  for (const claim of c.delivery_claims) {
    const labelled = claim.assurance.includes("provider_key_signed");
    if (!claim.signer) {
      if (labelled) problems.push(`${claim.type} claim ${claim.event_id} is labelled provider_key_signed without a signature`);
      continue;
    }
    const delegation = delegationOf.get(claim.delegation_id);
    const problem = delegation ? outcomeSignatureProblem(claim, delegation, c.key_bindings) : `${claim.type} claim ${claim.event_id} names a delegation not in the closure`;
    if (problem) problems.push(problem);
    else if (!labelled) problems.push(`${claim.type} claim ${claim.event_id} is signed but not labelled provider_key_signed`);
  }
  if (problems.length > 0) return check(name, problems);
  const signed = c.delivery_claims.filter((claim) => claim.signer).length;
  return { name, ok: true, details: [signed > 0 ? `${signed} provider-signed outcome claim(s) verify` : "no provider-signed outcome claims"] };
}

/** Fields the closure derives from its own records must be exactly what those records produce: each delegation's delivery status, the lineage summary and the disclosure lists. */
function derivedFieldsCheck(c: SignedClosure["payload"]): CheckResult {
  const problems: string[] = [];
  for (const d of c.delegations) {
    const expected = deliveryStatus(c.delivery_claims.filter((claim) => claim.delegation_id === d.delegation_id));
    if (d.delivery_status !== expected) problems.push(`delegation ${d.delegation_id} delivery status ${d.delivery_status} does not follow from its claims (${expected})`);
  }
  if (c.lineage.complete !== (c.lineage.capture_gaps.length === 0)) problems.push("lineage.complete does not match the capture gaps");
  const unknownDownstream = c.delegations.filter((d) => d.downstream_visibility === "unknown").map((d) => d.delegation_id);
  if (digestOf(unknownDownstream) !== digestOf(c.lineage.unknown_downstream)) problems.push("lineage.unknown_downstream does not match the delegations");
  const disclosure = closureDisclosure({
    task: c.task,
    delegations: c.delegations,
    claims: c.delivery_claims,
    events: c.financial_events.map((e) => ({ record: e.record, attributed_to: e.attributed_to })),
    responses: c.responses,
    receipts: c.receipts,
    ...(["1.2", "1.3", "1.4"].includes(c.schema_version) ? {} : { generated_at: c.generated_at }),
  });
  if (digestOf(disclosure) !== digestOf(c.disclosure)) problems.push("disclosure lists do not match the closure's records");
  return check("derived_fields", problems);
}

/** The closure's usage checks must be exactly what its pricing, usage claims, roll-up and responses produce. */
function usageChecksCheck(c: SignedClosure["payload"], rollup: ReturnType<typeof rollupFor>): CheckResult {
  const name = "usage_checks";
  const expected = usageChecksFor(c.delegations, c.delivery_claims, rollup, c.responses, c.receipts);
  const recorded = c.usage_checks ?? [];
  if (digestOf(expected) !== digestOf(recorded)) return check(name, ["usage_checks do not match the delegations' pricing, recorded usage and billed amounts"]);
  if (recorded.length === 0) return { name, ok: true, details: ["no delegation has both pricing and recorded usage"] };
  const outside = recorded.filter((u) => u.within_tolerance === false || u.expected_minor === null).map((u) => u.delegation_id);
  return { name, ok: true, details: [`${recorded.length} usage check(s) recomputed`, ...(outside.length > 0 ? [`outside tolerance or unpriced: ${outside.join(", ")}`] : [])] };
}

/** Signed estimates and holds must verify, and the expectation report must be exactly what the closure's records produce. */
function expectationsCheck(c: SignedClosure["payload"], rollup: ReturnType<typeof rollupFor>): CheckResult {
  const name = "expectations";
  const providerOf = new Map(c.delegations.map((d) => [d.delegation_id, d.provider_id]));
  const problems: string[] = [];
  for (const e of c.financial_events) {
    if (!e.record.expectation) continue;
    const problem = expectationSignatureProblem(e.record, providerOf.get(e.attributed_to) ?? null, c.key_bindings);
    if (problem) problems.push(problem);
  }
  const expected = buildExpectationReport({ task: c.task, delegations: c.delegations, claims: c.delivery_claims, events: c.financial_events, rollup, key_bindings: c.key_bindings });
  if (digestOf(expected ?? null) !== digestOf(c.expectation_report ?? null)) problems.push("expectation_report does not match the closure's estimates, holds and costs");
  if (problems.length > 0) return check(name, problems);
  if (!expected) return { name, ok: true, details: ["no estimates or holds"] };
  const signed = expected.records.filter((r) => !r.assurance.includes("buyer_recorded")).length;
  return { name, ok: true, details: [`${expected.records.length} estimate/hold record(s), ${signed} signed by the agent or a gateway; report recomputed`, "recorded only: nothing was enforced, blocked or reserved"] };
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

function providerResponsesCheck(c: SignedClosure["payload"]): CheckResult {
  const problems = responseProblems(c);
  const notes: string[] = [];
  const resolution = resolveAttestations(c.responses.map(responseAttestation), c.generated_at);
  const responseIdOf = new Map(c.responses.map((r) => [r.statement_digest, r.response_id]));
  for (const p of resolution.problems) {
    const id = responseIdOf.get(p.digest);
    if (p.code === "revocation_not_by_signer") problems.push(`response ${id} revokes ${p.target}, which its provider key did not sign`);
    else notes.push(`response ${id} references ${p.target}, which is not in this closure`);
  }
  for (const r of c.responses) {
    if (resolution.status[r.statement_digest].time === "not_yet_valid") problems.push(`response ${r.response_id} was issued after the closure was generated`);
  }
  const expected = new Map(labelResponses(c.responses, c.generated_at).map((r) => [r.response_id, r.assurance]));
  for (const r of c.responses) {
    for (const label of SCHEMA_1_4_LABELS) {
      const shouldHave = expected.get(r.response_id)!.includes(label as ResponseRecord["assurance"][number]);
      if (shouldHave !== r.assurance.includes(label as ResponseRecord["assurance"][number])) {
        problems.push(`response ${r.response_id} ${shouldHave ? "lacks" : "carries"} assurance ${label}, which does not match its expiry and revocations at ${c.generated_at}`);
      }
    }
  }
  return problems.length > 0 ? check("provider_responses", problems) : { name: "provider_responses", ok: true, details: notes };
}

function responseProblems(c: SignedClosure["payload"]): string[] {
  const problems: string[] = [];
  const receipts = new Map(c.receipts.map((r) => [r.receipt_id, r]));
  const delegations = new Map(c.delegations.map((d) => [d.delegation_id, d]));
  for (const r of c.receipts) if (!delegations.has(r.delegation_id)) problems.push(`receipt ${r.receipt_id} covers a delegation outside the task`);
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
    if (s.issued_at === undefined && (s.expires_at !== undefined || s.refs !== undefined)) problems.push(`response ${response.response_id} needs issued_at with expires_at or refs`);
    if (s.issued_at !== undefined && s.expires_at !== undefined && Date.parse(s.expires_at) <= Date.parse(s.issued_at)) problems.push(`response ${response.response_id} expires before it was issued`);
    if (s.execution) {
      const declared = delegations.get(receipt.delegation_id)?.execution;
      if (!declared) problems.push(`response ${response.response_id} cites run ${s.execution.execution_id}, but delegation ${receipt.delegation_id} records none`);
      else if (digestOf(executionBinding(declared)) !== digestOf(s.execution)) problems.push(`response ${response.response_id} cites run ${s.execution.execution_id}, which is not the run recorded on delegation ${receipt.delegation_id}`);
    }
    const claimsKeySigned = response.assurance.includes("provider_key_signed");
    const sig = response.provider_signature;
    const binding = sig ? c.key_bindings.find((b) => b.binding_id === sig.binding_id && b.key_id === sig.key_id) : undefined;
    if (s.role === "witness") problems.push(...witnessStatementProblems(response, delegations.get(receipt.delegation_id)?.provider_id ?? null, claimsKeySigned ? binding : undefined));
    if (!claimsKeySigned) continue;
    if (!sig || !binding) problems.push(`response ${response.response_id} claims provider_key_signed without a listed key binding`);
    else if (binding.provider_id !== response.provider_id) problems.push(`response ${response.response_id} key binding belongs to another provider`);
    else if (binding.created_at > response.created_at || (binding.revoked_at !== null && binding.revoked_at <= response.created_at)) problems.push(`response ${response.response_id} signed outside the key binding's validity`);
    else if (!verifyStatementSignature(s, sig.value, binding.public_key)) problems.push(`response ${response.response_id} provider signature does not verify`);
  }
  return problems;
}

/**
 * A witness statement is a signed_attestation that cites the run and at least one evidence item, signed with a
 * domain-challenged key of a provider other than the delegation's own.
 */
function witnessStatementProblems(response: ResponseRecord, delegationProviderId: string | null, binding: KeyBindingRecord | undefined): string[] {
  const s = response.statement;
  const problems: string[] = [];
  const label = `witness response ${response.response_id}`;
  if (s.response_type !== "signed_attestation") problems.push(`${label} must be a signed_attestation`);
  if (!s.execution) problems.push(`${label} must cite the run it observed`);
  if (s.evidence.length === 0) problems.push(`${label} must cite the evidence it saw`);
  if (!binding) problems.push(`${label} must be signed with a listed key binding`);
  else if (binding.method !== "domain_challenge") problems.push(`${label} must be signed with a domain-challenged key`);
  if (response.provider_id !== null && response.provider_id === delegationProviderId) problems.push(`${label} is from the delegation's own provider`);
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
