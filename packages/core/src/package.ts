import {
  AGENT_TRACE_EVIDENCE_TYPE,
  ATTESTATION_EVIDENCE_TYPES,
  ClosurePackageSchema,
  ObligationTermsSchema,
  checkTrace,
  digestOf,
  sha256Digest,
  SUPPORTED_PACKAGE_VERSIONS,
  traceDigest,
  usageCostDetails,
  utf8Decode,
  utf8Encode,
  verifyPayload,
  type AgentTrace,
  type AttestationConflict,
  type ClosurePackage,
  type ObligationTerms,
  type PolicyTemplate,
  type PublicKeyRecord,
  type RecordedEvent,
  type ClearingDecision,
} from "@atcn/schema";
import { CLEARING_ENGINE_ID_V1_0, decisionDigest, evaluateClearing, verifierOutputDigest } from "./clearing.js";
import { obligationAttestationConflicts, type AttestationKey } from "./conflicts.js";
import { buildEvidenceInputs, declaredExecutions, resolveCounterparty } from "./evidence.js";
import { checkBalanced } from "./journal.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
  /** Set when the check had nothing it could inspect (for example, trace evidence whose files were not supplied). Not a pass. */
  state?: "not_inspected";
}

export interface PackageVerificationReport {
  valid: boolean;
  /** Set when the package declares a version this verifier does not know; upgrade the verifier. */
  unsupported_schema_version?: string;
  checks: CheckResult[];
}

export interface VerifyOptions {
  /** Published public keys trusted out of band. The ATCN service key must be among them. */
  trustedKeys: PublicKeyRecord[];
  /** Trace files (raw bytes) behind agent_trace evidence, to recheck the traces and recompute usage_cost results. */
  traces?: Uint8Array[];
}

const SERVICE_ACTOR = "svc_atcn";

function keyRef(keyId: string, version: number): string {
  return `${keyId}#${version}`;
}

function keyValidAt(key: PublicKeyRecord, at: string): boolean {
  return key.valid_from <= at && (key.revoked_at === null || key.revoked_at > at);
}

function sameInstant(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
}

function sameKey(a: PublicKeyRecord, b: PublicKeyRecord): boolean {
  return a.actor_id === b.actor_id && a.public_key === b.public_key && sameInstant(a.valid_from, b.valid_from) && sameInstant(a.revoked_at, b.revoked_at);
}

/**
 * Offline verification of a closure package (PRD scenario L): signatures, event
 * references, decision inputs (re-running the deterministic clearing engine),
 * journal balance, and settlement references. Makes no network calls.
 */
export function verifyClosurePackage(input: unknown, options: VerifyOptions): PackageVerificationReport {
  const checks: CheckResult[] = [];
  const declared = (input as { payload?: { package_version?: unknown } } | null)?.payload?.package_version;
  if (typeof declared === "string" && !(SUPPORTED_PACKAGE_VERSIONS as readonly string[]).includes(declared)) {
    return {
      valid: false,
      unsupported_schema_version: declared,
      checks: [{ name: "schema", ok: false, details: [`package_version ${declared} is not supported by this verifier (supports ${SUPPORTED_PACKAGE_VERSIONS.join(", ")})`] }],
    };
  }
  const parsed = ClosurePackageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      checks: [{ name: "schema", ok: false, details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }],
    };
  }
  const pkg: ClosurePackage = parsed.data;
  const body = pkg.payload;
  checks.push({ name: "schema", ok: true, details: [] });

  // Keys: trusted keys win; package keys must not contradict them.
  const keys = new Map<string, PublicKeyRecord>();
  const keyProblems: string[] = [];
  for (const k of body.public_keys) keys.set(keyRef(k.key_id, k.key_version), k);
  for (const trusted of options.trustedKeys) {
    const ref = keyRef(trusted.key_id, trusted.key_version);
    const existing = keys.get(ref);
    if (existing && !sameKey(existing, trusted)) keyProblems.push(`package key ${ref} contradicts published key`);
    keys.set(ref, trusted);
  }
  const usedKeys = new Set([
    keyRef(pkg.signature.key_id, pkg.signature.key_version),
    ...body.events.map((e) => keyRef(e.signature.key_id, e.signature.key_version)),
    ...attestationSignatureKeys(body),
  ]);
  for (const k of body.public_keys) {
    if (!usedKeys.has(keyRef(k.key_id, k.key_version))) keyProblems.push(`package key ${keyRef(k.key_id, k.key_version)} signs nothing in the package`);
  }
  checks.push({ name: "keys_consistent", ok: keyProblems.length === 0, details: keyProblems });

  // Package signature by the ATCN service.
  const serviceKey = options.trustedKeys.find(
    (k) => k.key_id === pkg.signature.key_id && k.key_version === pkg.signature.key_version && k.actor_id === SERVICE_ACTOR,
  );
  const packageSigOk = !!serviceKey && verifyPayload(pkg, serviceKey.public_key);
  checks.push({
    name: "package_signature",
    ok: packageSigOk,
    details: packageSigOk ? [] : [serviceKey ? "signature does not verify" : "service key not among trusted keys"],
  });

  // Event signatures, hashes, key validity, and causation references.
  const eventIds = new Set(body.events.map((e) => e.payload.event_id));
  const eventProblems: string[] = [];
  for (const event of body.events) {
    const id = event.payload.event_id;
    if (digestOf(event.payload) !== event.payload_hash) eventProblems.push(`${id}: payload_hash mismatch`);
    const key = keys.get(keyRef(event.signature.key_id, event.signature.key_version));
    if (!key) {
      eventProblems.push(`${id}: unknown signing key ${event.signature.key_id}#${event.signature.key_version}`);
      continue;
    }
    if (key.actor_id !== event.payload.actor_id) eventProblems.push(`${id}: key belongs to ${key.actor_id}, not ${event.payload.actor_id}`);
    if (!keyValidAt(key, event.received_at)) eventProblems.push(`${id}: key not valid at receipt time ${event.received_at}`);
    if (!verifyPayload(event, key.public_key)) eventProblems.push(`${id}: signature does not verify`);
    for (const cause of event.payload.causation_ids) {
      if (!eventIds.has(cause)) eventProblems.push(`${id}: causation ${cause} not in package`);
    }
  }
  checks.push({ name: "event_signatures_and_references", ok: eventProblems.length === 0, details: eventProblems });

  // Obligation lineage and terms digests.
  const obligationIds = new Set(body.obligations.map((o) => o.obligation_id));
  const lineageProblems: string[] = [];
  const root = body.obligations.find((o) => o.obligation_id === body.root_obligation_id);
  if (!root) lineageProblems.push(`root obligation ${body.root_obligation_id} missing`);
  else if (root.parent_obligation_id !== null) lineageProblems.push(`root obligation ${body.root_obligation_id} has a parent`);
  if (!obligationIds.has(body.requested_obligation_id)) lineageProblems.push(`requested obligation ${body.requested_obligation_id} missing`);
  const termsByDigest = new Map<string, ObligationTerms>();
  for (const event of body.events) {
    const data = event.payload.data as { terms?: ObligationTerms; terms_digest?: string };
    if (data.terms && data.terms_digest) {
      if (digestOf(data.terms) !== data.terms_digest) lineageProblems.push(`${event.payload.event_id}: terms_digest mismatch`);
      // Only valid terms can be replayed; a decision citing other terms finds none.
      if (ObligationTermsSchema.safeParse(data.terms).success) termsByDigest.set(data.terms_digest, data.terms);
    }
  }
  for (const o of body.obligations) {
    if (o.parent_obligation_id && !obligationIds.has(o.parent_obligation_id)) {
      lineageProblems.push(`${o.obligation_id}: parent ${o.parent_obligation_id} missing`);
    }
    if (o.redacted) {
      if (o.effective_terms !== null || o.effective_terms_digest !== null) lineageProblems.push(`${o.obligation_id}: redacted obligation carries terms`);
      continue;
    }
    if (!o.effective_terms || !o.effective_terms_digest) {
      lineageProblems.push(`${o.obligation_id}: unredacted obligation without terms`);
      continue;
    }
    if (digestOf(o.effective_terms) !== o.effective_terms_digest) lineageProblems.push(`${o.obligation_id}: effective terms digest mismatch`);
    const accepted = body.events.some(
      (e) =>
        e.payload.obligation_id === o.obligation_id &&
        e.payload.event_type === "obligation.accepted" &&
        e.payload.data.terms_digest === o.effective_terms_digest,
    );
    const offeredOnly = ["draft", "offered", "cancelled", "expired"].includes(o.state);
    if (!accepted && !offeredOnly) lineageProblems.push(`${o.obligation_id}: no acceptance event for effective terms`);
  }
  const parentOf = new Map(body.obligations.map((o) => [o.obligation_id, o.parent_obligation_id]));
  for (const id of parentOf.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = id;
    while (current) {
      if (seen.has(current)) {
        lineageProblems.push(`cycle at ${id}`);
        break;
      }
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
  checks.push({ name: "obligation_lineage", ok: lineageProblems.length === 0, details: lineageProblems });

  // Decisions: inputs exist, digests recompute, automated decisions replay identically.
  const decisionProblems: string[] = [];
  const evidenceDigests = new Set(body.evidence.map((e) => e.content_digest));
  const resultDigests = new Set(body.verifier_results.map(verifierOutputDigest));
  const policies = new Map<string, PolicyTemplate>(body.policies.map((p) => [`${p.policy_id}@${p.policy_version}`, p]));
  const contents = attestationContents(body);
  const resolveKey = (keyId: string, keyVersion: number): AttestationKey | null => keys.get(keyRef(keyId, keyVersion)) ?? null;
  for (const decision of body.decisions) {
    decisionProblems.push(...checkDecision(decision, body.events, termsByDigest, policies, body.verifier_results, eventIds, evidenceDigests, resultDigests, contents, resolveKey));
  }
  checks.push({ name: "decision_inputs_and_replay", ok: decisionProblems.length === 0, details: decisionProblems });

  // Journal balance and references.
  const decisionIds = new Set(body.decisions.map((d) => d.decision_id));
  const batchIds = new Set(body.posting_batches.map((b) => b.batch_id));
  const journalProblems: string[] = [];
  for (const batch of body.posting_batches) {
    const balance = checkBalanced(batch.lines);
    if (!balance.balanced) journalProblems.push(`${batch.batch_id}: ${balance.problems.join("; ")}`);
    if (batch.decision_id && !decisionIds.has(batch.decision_id)) journalProblems.push(`${batch.batch_id}: decision ${batch.decision_id} missing`);
    if (batch.reverses_batch_id && !batchIds.has(batch.reverses_batch_id)) journalProblems.push(`${batch.batch_id}: reversed batch missing`);
    for (const source of batch.source_event_ids) {
      if (!eventIds.has(source)) journalProblems.push(`${batch.batch_id}: source event ${source} missing`);
    }
  }
  checks.push({ name: "journal_balance_and_references", ok: journalProblems.length === 0, details: journalProblems });

  // Settlement references.
  const instructionIds = new Set(body.settlement_instructions.map((i) => i.instruction_id));
  const settlementProblems: string[] = [];
  for (const instruction of body.settlement_instructions) {
    if (!obligationIds.has(instruction.obligation_id)) settlementProblems.push(`${instruction.instruction_id}: obligation missing`);
    if (!decisionIds.has(instruction.decision_id)) settlementProblems.push(`${instruction.instruction_id}: decision missing`);
  }
  for (const event of body.settlement_events) {
    if (event.instruction_id && !instructionIds.has(event.instruction_id)) {
      settlementProblems.push(`${event.settlement_event_id}: instruction ${event.instruction_id} missing`);
    }
  }
  for (const batch of body.posting_batches) {
    if (batch.settlement_event_id && !body.settlement_events.some((s) => s.settlement_event_id === batch.settlement_event_id)) {
      settlementProblems.push(`${batch.batch_id}: settlement event ${batch.settlement_event_id} missing`);
    }
  }
  checks.push({ name: "settlement_references", ok: settlementProblems.length === 0, details: settlementProblems });
  checks.push(recordsMatchEventsCheck(body));
  checks.push(traceEvidenceCheck(body, options.traces ?? []));
  if (body.package_version !== "1.0") checks.push(attestationConflictsCheck(body, contents, resolveKey));

  return { valid: checks.every((c) => c.ok), checks };
}

/** Attestation text by content digest, from a 1.1 package's attestations. */
function attestationContents(body: ClosurePackage["payload"]): Map<string, string> {
  return new Map((body.attestations ?? []).map((a) => [sha256Digest(utf8Encode(a.content)), a.content]));
}

/** Key references of the signatures on the package's attestations, so their keys count as used. */
function attestationSignatureKeys(body: ClosurePackage["payload"]): string[] {
  return (body.attestations ?? []).flatMap((a) => {
    try {
      const signature = (JSON.parse(a.content) as { signature?: { key_id?: unknown; key_version?: unknown } }).signature;
      return typeof signature?.key_id === "string" && typeof signature.key_version === "number" ? [keyRef(signature.key_id, signature.key_version)] : [];
    } catch {
      return [];
    }
  });
}

/** The conflicts a package must record: every unredacted obligation's attestation conflicts at generated_at. */
export function packageAttestationConflicts(
  body: Pick<ClosurePackage["payload"], "obligations" | "events" | "generated_at">,
  contents: Map<string, string>,
  resolveKey: (keyId: string, keyVersion: number) => AttestationKey | null,
): AttestationConflict[] {
  return body.obligations
    .filter((o) => !o.redacted && o.effective_terms !== null)
    .flatMap((o) =>
      obligationAttestationConflicts({
        events: body.events.filter((e) => e.payload.obligation_id === o.obligation_id),
        terms: o.effective_terms!,
        contents,
        resolveKey,
        at: body.generated_at,
      }),
    )
    .sort((a, b) => (a.subject !== b.subject ? (a.subject < b.subject ? -1 : 1) : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * Package 1.1: every attestation evidence item must come with its exact text (whose SHA-256 is the envelope's
 * content_digest), and attestation_conflicts must be exactly what those attestations produce at generated_at, so a
 * conflict cannot be removed to make the package look clean.
 */
function attestationConflictsCheck(
  body: ClosurePackage["payload"],
  contents: Map<string, string>,
  resolveKey: (keyId: string, keyVersion: number) => AttestationKey | null,
): CheckResult {
  const problems: string[] = [];
  const envelopes = new Map(body.evidence.map((e) => [e.evidence_id, e]));
  for (const a of body.attestations ?? []) {
    const envelope = envelopes.get(a.evidence_id);
    if (!envelope || !ATTESTATION_EVIDENCE_TYPES.includes(envelope.evidence_type)) problems.push(`attestation ${a.evidence_id} is not attestation evidence in the package`);
    else if (sha256Digest(utf8Encode(a.content)) !== envelope.content_digest) problems.push(`attestation ${a.evidence_id} text does not match its content digest`);
  }
  const supplied = new Set((body.attestations ?? []).map((a) => a.evidence_id));
  for (const e of body.evidence) {
    if (ATTESTATION_EVIDENCE_TYPES.includes(e.evidence_type) && !supplied.has(e.evidence_id)) problems.push(`attestation evidence ${e.evidence_id} has no text in the package`);
  }
  const expected = packageAttestationConflicts(body, contents, resolveKey);
  if (digestOf(expected) !== digestOf(body.attestation_conflicts ?? [])) {
    problems.push(`attestation_conflicts do not match the attestations (expected ${expected.length} conflict(s), recorded ${(body.attestation_conflicts ?? []).length})`);
  }
  if (problems.length > 0) return { name: "attestation_conflicts", ok: false, details: problems };
  return { name: "attestation_conflicts", ok: true, details: [expected.length === 0 ? "no conflicting attestations" : `${expected.length} conflict(s) recomputed: ${expected.map((c) => `${c.kind} on ${c.subject}`).join("; ")}`] };
}

/**
 * The package's tables repeat facts the service also signed as events. Each table row must match its event:
 * settlement events their settlement.reported event, posting batches their journal event, and decisions their outcome
 * event. Posting lines may name only the obligation's payer, payee and the actors and platforms in its events, and
 * settlement instructions may not exceed what the decision's clearing batch made payable to the beneficiary.
 */
function recordsMatchEventsCheck(body: ClosurePackage["payload"]): CheckResult {
  const problems: string[] = [];
  const eventsOfType = (types: string[]) => body.events.filter((e) => types.includes(e.payload.event_type));
  // A value that is not canonical JSON (batch totals past the safe integer range) matches nothing.
  const same = (a: unknown, b: unknown) => {
    try {
      return digestOf(a ?? null) === digestOf(b ?? null);
    } catch {
      return false;
    }
  };

  const reports = eventsOfType(["settlement.reported"]);
  for (const s of body.settlement_events) {
    const data = reports.find((e) => e.payload.data.settlement_event_id === s.settlement_event_id)?.payload.data;
    if (!data) {
      problems.push(`settlement event ${s.settlement_event_id} has no settlement.reported event`);
      continue;
    }
    const fields = ["instruction_id", "provider", "provider_reference", "provider_status", "normalized_status", "amount_minor", "currency"] as const;
    const differing = fields.filter((f) => !same(s[f], data[f]));
    if (differing.length > 0) problems.push(`settlement event ${s.settlement_event_id} ${differing.join(", ")} differ from its settlement.reported event`);
  }

  const journalEvents = eventsOfType(["journal.posted", "journal.reversed"]);
  for (const b of body.posting_batches) {
    const event = journalEvents.find((e) => e.payload.data.batch_id === b.batch_id);
    if (!event) {
      problems.push(`posting batch ${b.batch_id} has no journal event`);
      continue;
    }
    const data = event.payload.data;
    const totals = Object.fromEntries(Object.entries(checkBalanced(b.lines).byCurrency).map(([currency, t]) => [currency, t.debit]));
    if (event.payload.obligation_id !== b.obligation_id) problems.push(`posting batch ${b.batch_id} belongs to ${event.payload.obligation_id} by its journal event`);
    if (!same(data.entry_type, b.entry_type) || !same(data.reverses_batch_id, b.reverses_batch_id) || !same(data.decision_id, b.decision_id)) {
      problems.push(`posting batch ${b.batch_id} entry type, reversal or decision differ from its journal event`);
    }
    if (!same(data.totals, totals)) problems.push(`posting batch ${b.batch_id} totals differ from its journal event`);
    if (!same([...b.source_event_ids].sort(), [...event.payload.causation_ids].sort())) problems.push(`posting batch ${b.batch_id} source events differ from its journal event's causes`);
    const obligationEvents = body.events.filter((e) => e.payload.obligation_id === b.obligation_id);
    const agreedPolicyVersions = obligationEvents.map((e) => (e.payload.data as { terms?: ObligationTerms }).terms?.acceptance_policy?.policy_version);
    if (b.policy_version !== null && !agreedPolicyVersions.includes(b.policy_version)) problems.push(`posting batch ${b.batch_id} policy version ${b.policy_version} is not in the obligation's terms`);
    const obligation = body.obligations.find((o) => o.obligation_id === b.obligation_id);
    if (obligation?.effective_terms) {
      const terms = resolveCounterparty(obligation.effective_terms, obligationEvents);
      const parties = new Set<string>([terms.payer_id, ...(terms.counterparty_agent_id ? [terms.counterparty_agent_id] : [])]);
      for (const e of obligationEvents) parties.add(e.payload.actor_id).add(e.payload.actor_platform_id);
      for (const line of b.lines) if (!parties.has(line.party_id)) problems.push(`posting batch ${b.batch_id} names ${line.party_id}, who is not a party to ${b.obligation_id}`);
    }
  }

  const outcomeEvents = eventsOfType(["completion.accepted", "completion.partially_accepted", "completion.rejected", "completion.insufficient_evidence", "completion.disputed"]);
  for (const d of body.decisions) {
    const event = outcomeEvents.find((e) => e.payload.data.decision_id === d.decision_id);
    if (!event) {
      problems.push(`decision ${d.decision_id} has no outcome event`);
      continue;
    }
    const data = event.payload.data;
    if (!same(data.decision_digest, d.decision_digest) || !same(data.outcome, d.outcome) || !same(data.supersedes_decision_id, d.supersedes_decision_id)) {
      problems.push(`decision ${d.decision_id} differs from its outcome event`);
    }
    if (Date.parse(d.decided_at) > Date.parse(event.payload.event_time)) problems.push(`decision ${d.decision_id} was decided after its outcome event`);
    if (d.input_cutoff_sequence >= event.sequence) problems.push(`decision ${d.decision_id} input cutoff is not before its outcome event`);
  }

  const instructed = new Map<string, number>();
  for (const i of body.settlement_instructions) {
    const key = `${i.decision_id}|${i.beneficiary_party_id}|${i.currency}`;
    instructed.set(key, (instructed.get(key) ?? 0) + i.amount_minor);
  }
  for (const [key, amount] of instructed) {
    const [decisionId, beneficiary, currency] = key.split("|");
    const payable = body.posting_batches
      .filter((b) => b.entry_type === "clearing" && b.decision_id === decisionId)
      .flatMap((b) => b.lines)
      .filter((l) => l.account_type === "payable" && l.party_id === beneficiary && l.currency === currency)
      .reduce((sum, l) => sum + l.credit_minor - l.debit_minor, 0);
    if (amount > payable) problems.push(`settlement instructions for decision ${decisionId} pay ${beneficiary} ${amount} ${currency}, more than the ${payable} its clearing made payable`);
  }

  return { name: "records_match_signed_events", ok: problems.length === 0, details: problems };
}

/**
 * Trace evidence, when its files are supplied: each file must match an agent_trace envelope's content digest, pass
 * every agent_trace rule against the obligation's declared runs, and each recorded usage_cost result must recompute
 * from the terms' pricing and its traces. Evidence whose file was not supplied is reported as not inspected.
 */
function traceEvidenceCheck(body: ClosurePackage["payload"], files: Uint8Array[]): CheckResult {
  const name = "trace_evidence";
  const envelopes = body.evidence.filter((e) => e.evidence_type === AGENT_TRACE_EVIDENCE_TYPE);
  const usageResults = body.verifier_results.filter((r) => r.verifier_name === "usage_cost" && typeof r.details.trace_digests === "string");
  if (envelopes.length === 0 && usageResults.length === 0) return { name, ok: true, details: ["no trace evidence"] };

  const fileByDigest = new Map(files.map((bytes) => [sha256Digest(bytes), bytes]));
  const obligationOfEvidence = new Map<string, string>();
  for (const e of body.events) {
    const envelope = e.payload.data.envelope as { evidence_id?: string } | undefined;
    if (e.payload.event_type === "evidence.submitted" && envelope?.evidence_id) obligationOfEvidence.set(envelope.evidence_id, e.payload.obligation_id);
  }
  const problems: string[] = [];
  const notes: string[] = [];
  const tracesByObligation = new Map<string, Map<string, AgentTrace>>();
  let inspected = 0;

  for (const envelope of envelopes) {
    const bytes = fileByDigest.get(envelope.content_digest);
    const obligationId = obligationOfEvidence.get(envelope.evidence_id);
    if (!bytes) {
      notes.push(`not inspected: trace evidence ${envelope.evidence_id} (file not supplied)`);
      continue;
    }
    const obligation = body.obligations.find((o) => o.obligation_id === obligationId);
    if (!obligationId || !obligation?.effective_terms) {
      problems.push(`trace evidence ${envelope.evidence_id}: its obligation is not in the package`);
      continue;
    }
    inspected += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(utf8Decode(bytes));
    } catch {
      problems.push(`trace evidence ${envelope.evidence_id}: file is not JSON`);
      continue;
    }
    const events = body.events.filter((e) => e.payload.obligation_id === obligationId);
    const terms = resolveCounterparty(obligation.effective_terms, events);
    const checked = checkTrace(raw, declaredExecutions(events, terms.counterparty_agent_id), null);
    if (!checked.ok) {
      problems.push(`trace evidence ${envelope.evidence_id}: ${checked.code}: ${checked.error}`);
      continue;
    }
    const traces = tracesByObligation.get(obligationId) ?? new Map<string, AgentTrace>();
    traces.set(traceDigest(checked.trace), checked.trace);
    tracesByObligation.set(obligationId, traces);
  }

  for (const result of usageResults) {
    const digests = String(result.details.trace_digests).split(",").filter((d) => d.length > 0);
    const available = tracesByObligation.get(result.obligation_id) ?? new Map<string, AgentTrace>();
    const missing = digests.filter((d) => !available.has(d));
    const label = `usage_cost result for ${result.obligation_id}/${result.deliverable_id}`;
    if (digests.length === 0 || missing.length > 0) {
      notes.push(`not inspected: ${label} (${missing.length || "no"} trace file(s) not supplied)`);
      continue;
    }
    const terms = body.obligations.find((o) => o.obligation_id === result.obligation_id)?.effective_terms;
    const deliverable = terms?.deliverables.find((d) => d.deliverable_id === result.deliverable_id);
    if (!terms?.pricing || !deliverable) {
      problems.push(`${label}: the package's terms carry no pricing for this deliverable`);
      continue;
    }
    inspected += 1;
    let recomputed: ReturnType<typeof usageCostDetails>;
    try {
      recomputed = usageCostDetails(
        terms.pricing,
        deliverable.amount_minor,
        digests.map((d) => available.get(d)!),
      );
    } catch {
      problems.push(`${label}: usage too large to price exactly`);
      continue;
    }
    const fields = ["expected_minor", "amount_minor", "within_tolerance", "trace_digests", "lines_digest", "unpriced"] as const;
    const differing = fields.filter((f) => recomputed[f] !== result.details[f]);
    if (differing.length > 0) problems.push(`${label}: recorded ${differing.join(", ")} do not match the traces and pricing`);
  }

  if (problems.length > 0) return { name, ok: false, details: problems };
  const details = [...(inspected > 0 ? [`${inspected} trace item(s) and usage result(s) rechecked`] : []), ...notes];
  return inspected === 0 ? { name, ok: true, details, state: "not_inspected" } : { name, ok: true, details };
}

function checkDecision(
  decision: ClearingDecision,
  events: RecordedEvent[],
  termsByDigest: Map<string, ObligationTerms>,
  policies: Map<string, PolicyTemplate>,
  verifierResults: ClosurePackage["payload"]["verifier_results"],
  eventIds: Set<string>,
  evidenceDigests: Set<string>,
  resultDigests: Set<string>,
  contents: Map<string, string>,
  resolveKey: (keyId: string, keyVersion: number) => AttestationKey | null,
): string[] {
  const problems: string[] = [];
  const id = decision.decision_id;
  const {
    decision_id: _id,
    decision_digest: storedDigest,
    decided_at: _decidedAt,
    supersedes_decision_id: _supersedes,
    input_cutoff_sequence: cutoff,
    ...body
  } = decision;
  if (decisionDigest(body) !== storedDigest) problems.push(`${id}: decision_digest does not match decision body`);
  for (const e of decision.input_event_ids) if (!eventIds.has(e)) problems.push(`${id}: input event ${e} missing`);
  for (const d of decision.evidence_digests) if (!evidenceDigests.has(d)) problems.push(`${id}: evidence digest ${d} missing`);
  for (const d of decision.verifier_output_digests) if (!resultDigests.has(d)) problems.push(`${id}: verifier output ${d} missing`);
  if (decision.decision_maker.type !== "automated") return problems;

  const terms = termsByDigest.get(decision.terms_digest);
  const policy = policies.get(`${decision.policy.policy_id}@${decision.policy.policy_version}`);
  if (!terms) return [...problems, `${id}: terms ${decision.terms_digest} not in package`];
  if (!policy) return [...problems, `${id}: policy ${decision.policy.policy_id}@${decision.policy.policy_version} not in package`];
  if (digestOf(policy) !== decision.policy.policy_digest) problems.push(`${id}: policy digest mismatch`);

  const obligationEvents = events.filter((e) => e.payload.obligation_id === decision.obligation_id);
  const acceptance = obligationEvents.find(
    (e) => e.payload.event_type === "obligation.accepted" && e.payload.data.terms_digest === decision.terms_digest,
  );
  const completion = obligationEvents
    .filter((e) => e.payload.event_type === "completion.proposed" && e.sequence <= cutoff)
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!acceptance) return [...problems, `${id}: acceptance event not in package`];

  const replay = evaluateClearing({
    terms,
    terms_digest: decision.terms_digest,
    policy,
    policy_digest: decision.policy.policy_digest,
    acceptance_event_id: acceptance.payload.event_id,
    completion_event_id: completion?.payload.event_id ?? null,
    evidence: buildEvidenceInputs(obligationEvents, terms, cutoff),
    verifier_results: verifierResults.filter((r) => r.obligation_id === decision.obligation_id && r.executed_at <= decision.decided_at),
    decision_maker: decision.decision_maker,
    attestation_conflicts:
      decision.decision_maker.id === CLEARING_ENGINE_ID_V1_0
        ? []
        : obligationAttestationConflicts({ events: obligationEvents, terms, contents, resolveKey, at: decision.decided_at, cutoffSequence: cutoff }),
  });
  if (decisionDigest(replay) !== storedDigest) problems.push(`${id}: replaying the clearing policy produced a different decision`);
  return problems;
}
