import {
  ClosurePackageSchema,
  digestOf,
  verifyPayload,
  type ClosurePackage,
  type ObligationTerms,
  type PolicyTemplate,
  type PublicKeyRecord,
  type RecordedEvent,
  type ClearingDecision,
} from "@atcn/schema";
import { decisionDigest, evaluateClearing, verifierOutputDigest } from "./clearing.js";
import { buildEvidenceInputs } from "./evidence.js";
import { checkBalanced } from "./journal.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  details: string[];
}

export interface PackageVerificationReport {
  valid: boolean;
  checks: CheckResult[];
}

export interface VerifyOptions {
  /** Published public keys trusted out of band. The ATCN service key must be among them. */
  trustedKeys: PublicKeyRecord[];
}

const SERVICE_ACTOR = "svc_atcn";

function keyRef(keyId: string, version: number): string {
  return `${keyId}#${version}`;
}

function keyValidAt(key: PublicKeyRecord, at: string): boolean {
  return key.valid_from <= at && (key.revoked_at === null || key.revoked_at > at);
}

/**
 * Offline verification of a closure package (PRD scenario L): signatures, event
 * references, decision inputs (re-running the deterministic clearing engine),
 * journal balance, and settlement references. Makes no network calls.
 */
export function verifyClosurePackage(input: unknown, options: VerifyOptions): PackageVerificationReport {
  const checks: CheckResult[] = [];
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
    if (existing && existing.public_key !== trusted.public_key) keyProblems.push(`package key ${ref} contradicts published key`);
    keys.set(ref, trusted);
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
  const termsByDigest = new Map<string, ObligationTerms>();
  for (const event of body.events) {
    const data = event.payload.data as { terms?: ObligationTerms; terms_digest?: string };
    if (data.terms && data.terms_digest) {
      if (digestOf(data.terms) !== data.terms_digest) lineageProblems.push(`${event.payload.event_id}: terms_digest mismatch`);
      termsByDigest.set(data.terms_digest, data.terms);
    }
  }
  for (const o of body.obligations) {
    if (o.parent_obligation_id && !obligationIds.has(o.parent_obligation_id)) {
      lineageProblems.push(`${o.obligation_id}: parent ${o.parent_obligation_id} missing`);
    }
    if (o.redacted) continue;
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
  for (const decision of body.decisions) {
    decisionProblems.push(...checkDecision(decision, body.events, termsByDigest, policies, body.verifier_results, eventIds, evidenceDigests, resultDigests));
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

  return { valid: checks.every((c) => c.ok), checks };
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
  });
  if (decisionDigest(replay) !== storedDigest) problems.push(`${id}: replaying the clearing policy produced a different decision`);
  return problems;
}
