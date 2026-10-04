/**
 * Closure packages, subledger closures with their obligation packages, and clearing verdicts, each with the TypeScript
 * verifier's report, for every SDK's offline verifier to reproduce (packages/core/test-vectors/closure-packages.json).
 *
 * The documents come from real local-runner runs. The runner takes IDs, keys and times from the clock and the system
 * random source, so this script replaces both with a fixed clock and a seeded generator before loading anything, and
 * regenerating gives the same bytes. Never use these keys for anything real.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let clock = Date.parse("2026-10-01T09:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super((clock += 1));
    else super(...(args as [string]));
  }
  static now(): number {
    return (clock += 1);
  }
}
globalThis.Date = FixedDate as DateConstructor;
const advance = (ms: number) => (clock += ms);

let counter = 0;
crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
  const bytes = new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength);
  for (let offset = 0; offset < bytes.length; offset += 32) {
    const block = createHash("sha256").update(`atcn-package-vectors:${counter++}`).digest();
    bytes.set(block.subarray(0, Math.min(32, bytes.length - offset)), offset);
  }
  return array;
};

const { AGENT_USAGE_POLICY_V1, CODE_CHANGE_POLICY_V1, verifyClearingVerdict, verifyClosurePackage } = await import("@atcn/core");
const { acceptanceData, buildEvidenceEnvelope, buildTerms, termsData } = await import("@atcn/sdk");
const { digestOf, executionBinding, sha256Digest, signPayload, traceDigest, utf8Encode } = await import("@atcn/schema");
const { verifySubledgerDocument } = await import("@atcn/subledger");
const { LocalNetwork, LocalSubledger, loadJob, loadOrCreateServiceKey, runJob, servicePublicKey } = await import("../src/index.js");
// Loading may use the clock or random source (tsx does on a cache miss), so start both from the beginning here.
clock = Date.parse("2026-10-01T09:00:00.000Z");
counter = 0;
type EventSigner = import("@atcn/sdk").EventSigner;
type ClosurePackage = import("@atcn/schema").ClosurePackage;
type ExecutionDescriptor = import("@atcn/schema").ExecutionDescriptor;
type PublicKeyRecord = import("@atcn/schema").PublicKeyRecord;

const DEMO_DIR = fileURLToPath(new URL("../demos/calculator-fix", import.meta.url));
const iso = (ms: number) => new RealDate(ms).toISOString();

// ---------- A job with five obligations: accepted and settled, cancelled, without evidence, rejected, not settled ----------

const jobDir = mkdtempSync(join(tmpdir(), "atcn-package-vectors-"));
cpSync(DEMO_DIR, jobDir, { recursive: true });
writeFileSync(join(jobDir, "evidence/eslint-errors.json"), JSON.stringify([{ filePath: "src/math.ts", errorCount: 2, warningCount: 0, messages: [] }]));
const demo = loadJob(join(jobDir, "job.json")) as Record<string, any>;
const evidence = demo.obligations[0].evidence;
const job = {
  ...demo,
  obligations: [
    { ...demo.obligations[0], escrow: { rail: "a2a-se", escrow_ref: "esc-1" } },
    { provider: "Beta Workers", description: "Refactor the parser", amount_minor: 3000, cancel: { reason: "no longer needed" } },
    { provider: "Delta Labs", description: "Document the API", amount_minor: 2000, escrow: { rail: "a2a-se", escrow_ref: "esc-3" } },
    { provider: "Beta Workers", description: "Fix the lint errors", amount_minor: 1500, evidence: { ...evidence, lint_report: "evidence/eslint-errors.json" } },
    { provider: "Delta Labs", description: "Add a subtract() test", amount_minor: 800, evidence, settle: false },
  ],
};
const run = runJob(job, { baseDir: jobDir, dataDir: join(jobDir, ".atcn-local") });
if (!run.valid) throw new Error("the local run does not verify");
const serviceKey = loadOrCreateServiceKey(join(jobDir, ".atcn-local", "service-key.json"));
const trustedKeys: PublicKeyRecord[] = run.trusted_keys;
const [accepted, cancelled, noEvidence, rejected, notSettled] = run.packages;

// ---------- Networks driven directly: usage-priced work with a trace, and verifier attestations (package 1.1) ----------

function network() {
  const net = new LocalNetwork(new LocalSubledger(serviceKey, "Acme Robotics"), serviceKey);
  return { net, buyer: net.registerAgent("Acme Robotics"), principalId: net.registerPrincipal() };
}

function submit(net: InstanceType<typeof LocalNetwork>, producer: EventSigner, obligationId: string, evidenceType: string, content: string, verifiers: string[]) {
  const uri = net.uploadBlob(content);
  const envelope = buildEvidenceEnvelope({ evidenceType, producerId: producer.actorId, content, uri, retrievalMethod: "atcn-blob", mediaType: "application/json", verifiers, deliverableIds: ["main"] });
  net.submitEvidence(producer.sign("evidence.submitted", obligationId, { envelope }));
}

function usagePackage(): { pkg: ClosurePackage; trace: string } {
  const { net, buyer, principalId } = network();
  const worker = net.registerAgent("Gamma Agents");
  const terms = buildTerms({
    principalId,
    issuerAgentId: buyer.actorId,
    counterpartyAgentId: worker.actorId,
    description: "Search and summarize prior bug reports",
    maxAmountMinor: 140,
    deliverables: [{ deliverable_id: "main", description: "Summary", amount_minor: 140, required_checks: ["trace", "usage_cost"] }],
    policy: AGENT_USAGE_POLICY_V1,
    pricing: {
      rates: [
        { meter: "input_tokens", model: { provider: "example", name: "coder" }, price_numerator: 1, price_denominator: 100 },
        { meter: "output_tokens", price_numerator: 4, price_denominator: 100 },
        { meter: "tool_call", tool_name: "search", price_numerator: 5, price_denominator: 1 },
      ],
      fixed_minor: 100,
      tolerance_bps: 500,
    },
  });
  const id = terms.obligation_id;
  net.offerObligation(buyer.sign("obligation.offered", id, termsData(terms)));
  net.acceptObligation(worker.sign("obligation.accepted", id, acceptanceData(terms, worker.actorId)));
  const descriptor: ExecutionDescriptor = { execution_id: "run-1", agent: { agent_id: worker.actorId, agent_version: "1.0.0", model: { provider: "example", name: "coder", version: "2026-09" } } };
  net.appendLifecycleEvent(worker.sign("obligation.started", id, { execution: descriptor }));
  const start = advance(60_000);
  const trace = JSON.stringify({
    trace_version: "1.0",
    execution: executionBinding(descriptor),
    steps: [
      { seq: 0, kind: "model_call", started_at: iso(start), ended_at: iso(start + 5_000), model: { provider: "example", name: "coder" }, usage: { input_tokens: 1_000, output_tokens: 500 } },
      { seq: 1, kind: "tool_call", started_at: iso(start + 6_000), ended_at: iso(start + 7_000), tool: { name: "search" } },
    ],
  });
  advance(60_000);
  submit(net, worker, id, "agent_trace", trace, ["agent_trace", "usage_cost"]);
  net.appendLifecycleEvent(worker.sign("completion.proposed", id, {}));
  const { decision } = net.evaluate(id);
  net.finalize(decision.decision_id);
  net.settleInSandbox(id);
  return { pkg: net.exportClosurePackage(id), trace };
}

function attestedPackage(statuses: ("pass" | "fail")[]): ClosurePackage {
  const { net, buyer, principalId } = network();
  const worker = net.registerAgent("Beta Agents");
  const verifiers = statuses.map((_, i) => net.registerAgent(`Review Co ${i + 1}`));
  const terms = buildTerms({
    principalId,
    issuerAgentId: buyer.actorId,
    counterpartyAgentId: worker.actorId,
    description: "Fix the add() bug",
    maxAmountMinor: 100,
    deliverables: [{ deliverable_id: "main", description: "Fix", amount_minor: 100, required_checks: ["review"] }],
    policy: CODE_CHANGE_POLICY_V1,
    verifierAgentIds: verifiers.map((v) => v.actorId),
  });
  const id = terms.obligation_id;
  net.offerObligation(buyer.sign("obligation.offered", id, termsData(terms)));
  net.acceptObligation(worker.sign("obligation.accepted", id, acceptanceData(terms, worker.actorId)));
  net.appendLifecycleEvent(worker.sign("obligation.started", id, {}));
  submit(net, worker, id, "patch_ref", "diff --git a/src/math.ts b/src/math.ts\n", ["patch_digest"]);
  statuses.forEach((status, i) => {
    const payload = {
      obligation_id: id,
      deliverable_id: "main",
      check_id: "review",
      verifier_id: verifiers[i].actorId,
      status,
      probabilistic: false,
      model: null,
      summary: status === "pass" ? "Fix is correct" : "Fix breaks negative numbers",
    };
    const signed = signPayload(payload, { keyId: verifiers[i].identity.keyId, keyVersion: 1, privateKey: verifiers[i].identity.privateKey });
    submit(net, verifiers[i], id, "verifier_attestation", JSON.stringify(signed), ["external_attestation"]);
  });
  net.appendLifecycleEvent(worker.sign("completion.proposed", id, {}));
  if (statuses.every((s) => s === statuses[0])) {
    const { decision } = net.evaluate(id);
    net.finalize(decision.decision_id);
    net.settleInSandbox(id);
  }
  return net.exportClosurePackage(id);
}

const usage = usagePackage();
const agreeing = attestedPackage(["pass", "pass"]);
const disagreeing = attestedPackage(["pass", "fail"]);

// ---------- Tampering ----------

/** Copies a document and changes it after signing. */
function tampered<T>(document: T, change: (copy: any) => void): T {
  const copy = structuredClone(document);
  change(copy);
  return copy;
}

/** Changes a package's payload and signs it again with the service key, so only the deeper checks can catch it. */
function resigned(pkg: ClosurePackage, change: (body: any) => void): ClosurePackage {
  const body = structuredClone(pkg.payload) as any;
  change(body);
  return signPayload(body, serviceKey) as ClosurePackage;
}

function resignedDocument<T extends { payload: unknown }>(document: T, change: (payload: any) => void): T {
  const payload = structuredClone(document.payload) as any;
  change(payload);
  return signPayload(payload, serviceKey) as unknown as T;
}

const flip = (text: string) => (text[10] === "A" ? `${text.slice(0, 10)}B${text.slice(11)}` : `${text.slice(0, 10)}A${text.slice(11)}`);
const eventOf = (body: any, type: string) => body.events.find((e: any) => e.payload.event_type === type);
const batchOf = (body: any, type: string) => body.posting_batches.find((b: any) => b.entry_type === type);
const otherKey = { keyId: serviceKey.keyId, keyVersion: 1, privateKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA" };
const strangerKey: PublicKeyRecord = { ...trustedKeys[0], key_id: "key_01J00000000000000000000099", public_key: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg" };
const usageResult = (body: any) => body.verifier_results.find((r: any) => r.verifier_name === "usage_cost");
const notJson = "not json";
/** The usage trace with two model calls whose input tokens together pass the safe integer range. */
const hugeTrace = (() => {
  const trace = JSON.parse(usage.trace);
  const call = { ...trace.steps[0], usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } };
  trace.steps = [call, { ...call, seq: 1 }, { ...trace.steps[1], seq: 2 }];
  return JSON.stringify(trace);
})();

interface PackageCase {
  name: string;
  package: unknown;
  options?: { traces?: string[]; trusted_keys?: PublicKeyRecord[] };
}

const packageCases: PackageCase[] = [
  { name: "accepted and settled (1.0)", package: accepted },
  { name: "cancelled after starting", package: cancelled },
  { name: "insufficient evidence", package: noEvidence },
  { name: "rejected by lint", package: rejected },
  { name: "accepted, not settled", package: notSettled },
  { name: "usage-priced work, trace supplied", package: usage.pkg, options: { traces: [usage.trace] } },
  { name: "usage-priced work, trace not supplied", package: usage.pkg },
  { name: "usage-priced work, an unrelated trace file", package: usage.pkg, options: { traces: [JSON.stringify({ trace_version: "1.0" }), notJson] } },
  {
    name: "usage-priced work, recorded usage_cost result changed, re-signed",
    package: resigned(usage.pkg, (b) => (usageResult(b).details.expected_minor = 1)),
    options: { traces: [usage.trace] },
  },
  {
    name: "usage-priced work, trace envelope points at a non-JSON file, re-signed",
    package: resigned(usage.pkg, (b) => (b.evidence[0].content_digest = sha256Digest(notJson))),
    options: { traces: [notJson] },
  },
  {
    name: "usage-priced work, trace that breaks the trace rules, re-signed",
    package: resigned(usage.pkg, (b) => (b.evidence[0].content_digest = sha256Digest(JSON.stringify({ trace_version: "1.0" })))),
    options: { traces: [JSON.stringify({ trace_version: "1.0" })] },
  },
  {
    name: "usage-priced work, usage too large to price exactly, re-signed",
    package: resigned(usage.pkg, (b) => {
      b.evidence[0].content_digest = sha256Digest(hugeTrace);
      usageResult(b).details.trace_digests = traceDigest(JSON.parse(hugeTrace));
    }),
    options: { traces: [hugeTrace] },
  },
  {
    name: "usage-priced work, terms pricing removed, re-signed",
    package: resigned(usage.pkg, (b) => delete b.obligations[0].effective_terms.pricing),
    options: { traces: [usage.trace] },
  },
  { name: "verifier attestations that agree (1.1)", package: agreeing },
  { name: "verifier attestations that disagree, conflict recorded (1.1)", package: disagreeing },
  { name: "unknown fields are dropped before checking", package: tampered(accepted, (p) => ((p.payload.internal_note = "not signed"), (p.payload.events[0].internal = 1))) },
  { name: "decision accepted amount changed", package: tampered(accepted, (p) => (p.payload.decisions[0].accepted_amount_minor = 5_000)) },
  { name: "decision outcome changed", package: tampered(accepted, (p) => (p.payload.decisions[0].outcome = "rejected")) },
  { name: "event signature broken", package: tampered(accepted, (p) => (p.payload.events[2].signature.value = flip(p.payload.events[2].signature.value))) },
  { name: "event payload changed", package: tampered(accepted, (p) => (eventOf(p.payload, "completion.proposed").payload.data.note = "changed")) },
  { name: "event removed, breaking causation", package: tampered(accepted, (p) => p.payload.events.splice(1, 1)) },
  { name: "events reordered", package: tampered(accepted, (p) => p.payload.events.reverse()) },
  { name: "posting line amount changed", package: tampered(accepted, (p) => (batchOf(p.payload, "clearing").lines[0].debit_minor += 1)) },
  { name: "verifier result changed", package: tampered(accepted, (p) => (p.payload.verifier_results[0].status = "fail")) },
  { name: "evidence envelope removed", package: tampered(accepted, (p) => p.payload.evidence.splice(0, 1)) },
  { name: "package signature broken", package: tampered(accepted, (p) => (p.signature.value = flip(p.signature.value))) },
  { name: "package signed by another key", package: signPayload(accepted.payload, otherKey) },
  { name: "service key not trusted", package: accepted, options: { trusted_keys: [strangerKey] } },
  {
    name: "published key revoked before the package's events",
    package: accepted,
    options: { trusted_keys: [...trustedKeys, { ...accepted.payload.public_keys.find((k) => k.actor_id !== "svc_atcn")!, revoked_at: "2026-10-01T00:00:00.000Z" }] },
  },
  { name: "unknown package version", package: tampered(accepted, (p) => (p.payload.package_version = "9.9")) },
  { name: "not a package", package: { payload: { package_version: 1 }, signature: null } },
  { name: "null", package: null },
  {
    name: "schema failures",
    package: tampered(accepted, (p) => {
      delete p.payload.generated_at;
      p.payload.root_obligation_id = "obl_bad";
      p.payload.decisions[0].accepted_amount_minor = -1;
      p.payload.posting_batches[0].lines = [p.payload.posting_batches[0].lines[0]];
      p.payload.events[0].sequence = 1.5;
      p.payload.obligations[0].effective_terms.deliverables[0].amount_minor = 2 ** 60;
    }),
  },
  { name: "a float in event data", package: tampered(accepted, (p) => (p.payload.events[0].payload.data.extra = { nested: [1, 2.5] })) },
  { name: "an unsafe integer in event data", package: tampered(accepted, (p) => (p.payload.events[0].payload.data.extra = { nested: [2 ** 60] })) },
  { name: "a lone surrogate in a string", package: tampered(accepted, (p) => ((p.payload.obligations[0].effective_terms.scope.description = "\ud800"), (p.payload.events[0].payload.actor_id = "\udfff"))) },
  { name: "obligation terms that break their refinements", package: tampered(accepted, (p) => (p.payload.obligations[0].effective_terms.max_amount_minor = 1)) },
  { name: "decision amount changed, re-signed", package: resigned(accepted, (b) => (b.decisions[0].accepted_amount_minor = 5_000)) },
  { name: "unbalanced journal, re-signed", package: resigned(accepted, (b) => (batchOf(b, "clearing").lines[0].debit_minor += 1)) },
  { name: "settlement instruction above the payable, re-signed", package: resigned(accepted, (b) => (b.settlement_instructions[0].amount_minor += 1_000)) },
  { name: "settlement event differs from its report, re-signed", package: resigned(accepted, (b) => ((b.settlement_events[0].amount_minor = 1), (b.settlement_events[0].provider_status = "failed"))) },
  { name: "outcome event removed, re-signed", package: resigned(accepted, (b) => (b.events = b.events.filter((e: any) => e.payload.event_type !== "completion.accepted"))) },
  { name: "policy changed, re-signed", package: resigned(accepted, (b) => (b.policies[0].allocation.platform_fee_bps = 0)) },
  { name: "obligation terms changed, re-signed", package: resigned(accepted, (b) => (b.obligations[0].effective_terms.scope.description = "something else")) },
  { name: "obligation state draft without acceptance, re-signed", package: resigned(cancelled, (b) => ((b.obligations[0].state = "draft"), (b.events = b.events.filter((e: any) => e.payload.event_type !== "obligation.accepted")))) },
  {
    name: "root obligation missing and a parent cycle, re-signed",
    package: resigned(accepted, (b) => {
      const copy = structuredClone(b.obligations[0]);
      copy.obligation_id = "obl_01J00000000000000000000009";
      copy.parent_obligation_id = b.obligations[0].obligation_id;
      b.obligations[0].parent_obligation_id = copy.obligation_id;
      b.obligations.push(copy);
    }),
  },
  { name: "redacted obligation that carries terms, re-signed", package: resigned(accepted, (b) => (b.obligations[0].redacted = true)) },
  { name: "posting line names a stranger, re-signed", package: resigned(accepted, (b) => (batchOf(b, "clearing").lines[1].party_id = "agt_01J00000000000000000000077")) },
  { name: "decision decided after its outcome event, re-signed", package: resigned(accepted, (b) => ((b.decisions[0].decided_at = "2030-01-01T00:00:00.000Z"), (b.decisions[0].input_cutoff_sequence = 999))) },
  { name: "unused public key, re-signed", package: resigned(accepted, (b) => b.public_keys.push({ ...strangerKey, actor_id: "agt_01J00000000000000000000077" })) },
  { name: "terms digest in an event changed, re-signed", package: resigned(accepted, (b) => (eventOf(b, "obligation.offered").payload.data.terms_digest = `sha256:${"0".repeat(64)}`)) },
  { name: "pending_finality in a 1.0 package, re-signed", package: resigned(accepted, (b) => (b.settlement_events[0].normalized_status = "pending_finality")) },
  { name: "attestations in a 1.0 package, re-signed", package: resigned(accepted, (b) => ((b.attestations = []), (b.attestation_conflicts = []))) },
  { name: "1.1 package without attestations, re-signed", package: resigned(accepted, (b) => (b.package_version = "1.1")) },
  { name: "1.0 package re-signed as 1.1 with no attestations", package: resigned(accepted, (b) => ((b.package_version = "1.1"), (b.attestations = []), (b.attestation_conflicts = []))) },
  { name: "1.1 conflict removed, re-signed", package: resigned(disagreeing, (b) => (b.attestation_conflicts = [])) },
  { name: "1.1 attestation text withheld, re-signed", package: resigned(disagreeing, (b) => ((b.attestations = b.attestations.slice(1)), (b.attestation_conflicts = []))) },
  { name: "1.1 attestation text altered, re-signed", package: resigned(agreeing, (b) => (b.attestations[0].content = b.attestations[0].content.replace("Fix is correct", "Fix is wrong"))) },
  { name: "1.1 attestation for evidence not in the package, re-signed", package: resigned(agreeing, (b) => (b.attestations[0].evidence_id = "evd_01J00000000000000000000001")) },
  { name: "1.1 attestation that is not JSON, re-signed", package: resigned(agreeing, (b) => (b.attestations.push({ evidence_id: b.evidence[0].evidence_id, content: "{not json" }))) },
  { name: "1.1 replayed decision without its attestations, re-signed", package: resigned(agreeing, (b) => (b.verifier_results = [])) },
  // Inputs that used to throw in the TypeScript verifier instead of failing a check.
  { name: "terms without an acceptance policy on a later event, re-signed", package: resigned(accepted, (b) => (eventOf(b, "completion.proposed").payload.data.terms = { x: 1 })) },
  { name: "evidence event without an envelope, re-signed", package: resigned(accepted, (b) => (eventOf(b, "evidence.submitted").payload.data = {})) },
  {
    name: "invalid terms replayed through their digest, re-signed",
    package: resigned(accepted, (b) => {
      const digest = digestOf({ x: 1 });
      eventOf(b, "obligation.offered").payload.data.terms = { x: 1 };
      eventOf(b, "obligation.offered").payload.data.terms_digest = digest;
      eventOf(b, "obligation.accepted").payload.data.terms_digest = digest;
      b.decisions[0].terms_digest = digest;
    }),
  },
  {
    name: "journal totals past the safe integer range, re-signed",
    package: resigned(accepted, (b) => {
      const line = batchOf(b, "clearing").lines[0];
      batchOf(b, "clearing").lines = [
        { ...line, debit_minor: Number.MAX_SAFE_INTEGER, credit_minor: 0 },
        { ...line, debit_minor: Number.MAX_SAFE_INTEGER, credit_minor: 0 },
      ];
    }),
  },
  {
    name: "1.1 attestation with a fraction in an unknown member, re-signed",
    package: resigned(agreeing, (b) => {
      const attestation = b.attestations[0];
      const signed = JSON.parse(attestation.content);
      signed.payload.extra = 1.5;
      attestation.content = JSON.stringify(signed);
      const digest = sha256Digest(attestation.content);
      b.evidence.find((e: any) => e.evidence_id === attestation.evidence_id).content_digest = digest;
      b.events.find((e: any) => e.payload.data.envelope?.evidence_id === attestation.evidence_id).payload.data.envelope.content_digest = digest;
    }),
  },
];

const packages = packageCases.map(({ name, package: pkg, options = {} }) => ({
  name,
  package: pkg,
  options,
  report: verifyClosurePackage(pkg, { trustedKeys: options.trusted_keys ?? trustedKeys, traces: options.traces?.map(utf8Encode) }),
}));

// ---------- The task closure, cross-checked against its obligations' packages ----------

const closure = run.closure;
const clearingEvent = (payload: any) => payload.financial_events.find((e: any) => e.record.source === "atcn-clearing" && e.record.type === "charge");
const closureCases: { name: string; document: unknown; obligation_packages: unknown[] | null }[] = [
  { name: "every obligation package supplied", document: closure, obligation_packages: run.packages },
  { name: "packages not supplied", document: closure, obligation_packages: null },
  { name: "one package missing, with junk alongside", document: closure, obligation_packages: [null, { payload: {} }, ...run.packages.slice(1)] },
  { name: "a package that does not verify", document: closure, obligation_packages: [tampered(accepted, (p) => (p.payload.decisions[0].accepted_amount_minor = 5_000)), ...run.packages.slice(1)] },
  { name: "a package whose obligation is redacted", document: closure, obligation_packages: [resigned(accepted, (b) => ((b.obligations[0].redacted = true), (b.obligations[0].effective_terms = null), (b.obligations[0].effective_terms_digest = null))), ...run.packages.slice(1)] },
  { name: "linked decision digest differs, re-signed", document: resignedDocument(closure, (c) => (c.obligation_links[0].decision_digest = `sha256:${"0".repeat(64)}`)), obligation_packages: run.packages },
  { name: "linked decision not in the package, re-signed", document: resignedDocument(closure, (c) => (c.obligation_links[0].decision_id = "dec_01J00000000000000000000001")), obligation_packages: run.packages },
  { name: "recorded clearing charge changed, re-signed", document: resignedDocument(closure, (c) => (clearingEvent(c).record.amount_minor += 1)), obligation_packages: run.packages },
  { name: "recorded settlement evidence changed, re-signed", document: resignedDocument(closure, (c) => (c.financial_events.find((e: any) => e.record.source === "atcn-clearing" && e.record.evidence).record.evidence.digest = `sha256:${"0".repeat(64)}`)), obligation_packages: run.packages },
  { name: "recorded clearing fee removed, re-signed", document: resignedDocument(closure, (c) => (c.financial_events = c.financial_events.filter((e: any) => !(e.record.source === "atcn-clearing" && e.record.type === "fee")))), obligation_packages: run.packages },
  { name: "package journal batch posted after the closure, re-signed", document: closure, obligation_packages: [resigned(accepted, (b) => (batchOf(b, "settlement").posted_at = "2030-01-01T00:00:00.000Z")), ...run.packages.slice(1)] },
  { name: "package with an extra journal batch, re-signed", document: closure, obligation_packages: [resigned(accepted, (b) => b.posting_batches.push({ ...batchOf(b, "settlement"), batch_id: "pbt_extra" })), ...run.packages.slice(1)] },
];

const closures = closureCases.map(({ name, document, obligation_packages }) => ({
  name,
  document,
  obligation_packages,
  report: verifySubledgerDocument(document, { trustedKeys, ...(obligation_packages ? { obligationPackages: obligation_packages } : {}) }),
}));

// ---------- Clearing verdicts, checked against the package they were read from ----------

const [verdict, pendingVerdict] = run.verdicts;
const verdictCases: { name: string; verdict: unknown; closure_package?: unknown; trusted_keys?: PublicKeyRecord[] }[] = [
  { name: "verdict with its package", verdict, closure_package: accepted },
  { name: "verdict without its package", verdict },
  { name: "verdict for insufficient evidence, not final", verdict: pendingVerdict, closure_package: noEvidence },
  { name: "verdict with a tampered package", verdict, closure_package: tampered(accepted, (p) => ((p.payload.decisions[0].accepted_amount_minor = 5_000), (p.payload.events[2].signature.value = flip(p.payload.events[2].signature.value)))) },
  { name: "verdict with another obligation's package", verdict, closure_package: noEvidence },
  { name: "verdict with its package re-signed with a change", verdict, closure_package: resigned(accepted, (b) => (b.generated_at = "2026-10-01T09:00:00.000Z")) },
  { name: "verdict re-signed with a misstated amount", verdict: resignedDocument(verdict, (v) => (v.decision.accepted_amount_minor = 20_000)), closure_package: accepted },
  { name: "verdict that is not record only", verdict: tampered(verdict, (v) => (v.payload.stance = "release_authority")), closure_package: accepted },
  { name: "verdict with an untrusted key", verdict, closure_package: accepted, trusted_keys: [strangerKey] },
  { name: "verdict with a package holding a fraction in an unknown member", verdict, closure_package: tampered(accepted, (p) => (p.payload.extra = 1.5)) },
];

const verdicts = verdictCases.map(({ name, verdict: input, closure_package, trusted_keys }) => ({
  name,
  verdict: input,
  ...(closure_package === undefined ? {} : { closure_package }),
  ...(trusted_keys ? { trusted_keys } : {}),
  report: verifyClearingVerdict(input, { trustedKeys: trusted_keys ?? trustedKeys, ...(closure_package === undefined ? {} : { closurePackage: closure_package }) }),
}));

const vectors = {
  description:
    "Closure packages (verifyClosurePackage), task closures with their obligations' packages (verifySubledgerDocument with obligationPackages), and clearing verdicts (verifyClearingVerdict), each with the TypeScript verifier's report. Made from local-runner runs with a fixed clock and seeded keys. Options are snake_case; traces are UTF-8 trace files; a case's trusted_keys replace the top-level ones. Every SDK's offline verifier must give the same report.",
  trusted_keys: trustedKeys,
  packages,
  closures,
  verdicts,
};

const dir = fileURLToPath(new URL("../../../packages/core/test-vectors/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}closure-packages.json`, JSON.stringify(vectors) + "\n");
console.log(`wrote ${dir}closure-packages.json (${packages.length} packages, ${closures.length} closures, ${verdicts.length} verdicts)`);
