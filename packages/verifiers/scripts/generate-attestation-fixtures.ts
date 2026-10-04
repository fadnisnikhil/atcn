import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bytesToBase64Url,
  digestOf,
  executionBinding,
  publicKeyFromPrivate,
  sha256Digest,
  signPayload,
  type AttestationRef,
  type ExecutionDescriptor,
  type ExternalAttestationPayload,
  type SkillRef,
} from "@atcn/schema";

// Fixed seeds. Never use for real keys.
const seed = (offset: number) => bytesToBase64Url(new Uint8Array(32).map((_, i) => (i + offset) % 256));
const REVIEWER = "agt_01J00000000000000000000001";
const AUDITOR = "agt_01J00000000000000000000002";
const WORKER = "agt_01J00000000000000000000003";
const ISSUER = "agt_01J00000000000000000000004";
const PRINCIPAL = "prn_01J00000000000000000000001";
const WITNESS_A = "agt_01J00000000000000000000011";
const WITNESS_B = "agt_01J00000000000000000000012";
const WITNESS_ON_WORKER_DOMAIN = "agt_01J00000000000000000000013";
const WITNESS_A_SIBLING = "agt_01J00000000000000000000014";
const OBLIGATION = "obl_01J00000000000000000000001";
const OTHER_OBLIGATION = "obl_01J00000000000000000000002";
const AT = "2026-10-05T12:00:00.000Z";
const ISSUED = "2026-10-05T11:00:00.000Z";

const signers = {
  reviewer: { keyId: "key_01J00000000000000000000001", keyVersion: 1, privateKey: seed(1), actorId: REVIEWER, revokedAt: null },
  reviewerRevoked: { keyId: "key_01J00000000000000000000001", keyVersion: 2, privateKey: seed(51), actorId: REVIEWER, revokedAt: "2026-10-05T10:00:00.000Z" },
  auditor: { keyId: "key_01J00000000000000000000002", keyVersion: 1, privateKey: seed(101), actorId: AUDITOR, revokedAt: null },
  witnessA: { keyId: "key_01J00000000000000000000011", keyVersion: 1, privateKey: seed(111), actorId: WITNESS_A, revokedAt: null },
  witnessB: { keyId: "key_01J00000000000000000000012", keyVersion: 1, privateKey: seed(121), actorId: WITNESS_B, revokedAt: null },
  witnessOnWorkerDomain: { keyId: "key_01J00000000000000000000013", keyVersion: 1, privateKey: seed(131), actorId: WITNESS_ON_WORKER_DOMAIN, revokedAt: null },
  witnessASibling: { keyId: "key_01J00000000000000000000014", keyVersion: 1, privateKey: seed(141), actorId: WITNESS_A_SIBLING, revokedAt: null },
};
type SignerName = keyof typeof signers;

const codeFix: SkillRef = { namespace: "a2a", skill_id: "code-fix" };
const codeFixRun: ExecutionDescriptor = {
  execution_id: "run_fx_1",
  protocol: { name: "a2a", task_id: "task-fx-1", context_id: "ctx-fx-1" },
  agent: { agent_id: WORKER, agent_version: "1.0.0", model: { provider: "example", name: "coder", version: "2026-09" } },
  skill: codeFix,
};
const translateRun: ExecutionDescriptor = {
  execution_id: "run_fx_2",
  protocol: { name: "a2a", task_id: "task-fx-2" },
  agent: { agent_id: WORKER, agent_version: "1.0.0" },
  skill: { namespace: "a2a", skill_id: "translate" },
};
const codeFixRunV11: ExecutionDescriptor = {
  execution_id: "run_fx_3",
  protocol: { name: "a2a", task_id: "task-fx-3" },
  agent: { agent_id: WORKER, agent_version: "1.1.0" },
  skill: codeFix,
};
const undeclaredRun: ExecutionDescriptor = { execution_id: "run_fx_9", agent: { agent_id: WORKER, agent_version: "9.9.9" }, skill: codeFix };
const patchDigest = sha256Digest("diff --git a/x b/x\n");

function attestation(changes: Partial<ExternalAttestationPayload> = {}, signer: SignerName = "reviewer"): { payload: ExternalAttestationPayload; signature: unknown } {
  const payload: ExternalAttestationPayload = {
    obligation_id: OBLIGATION,
    deliverable_id: "main",
    check_id: "review",
    verifier_id: signers[signer].actorId,
    status: "pass",
    probabilistic: false,
    model: null,
    summary: "Fix is correct",
    execution: executionBinding(codeFixRun),
    evidence_digests: [patchDigest],
    issued_at: ISSUED,
    ...changes,
  };
  for (const [key, value] of Object.entries(payload)) if (value === undefined) delete payload[key as keyof ExternalAttestationPayload];
  const s = signers[signer];
  return signPayload(payload, { keyId: s.keyId, keyVersion: s.keyVersion, privateKey: s.privateKey });
}

const context = {
  obligation_id: OBLIGATION,
  deliverable_id: "main",
  check_id: "review",
  allowed_verifier_ids: [REVIEWER, AUDITOR],
  terms_skill: codeFix as SkillRef | null,
  declared_executions: [codeFixRun, translateRun],
  obligation_evidence_digests: [patchDigest],
  at: AT,
};

interface PluginCase {
  name: string;
  fixture: number | null;
  description: string;
  verifier_version: string;
  context: typeof context;
  attestation: unknown;
  expected: { signature_valid: boolean; status: string; code: string | null };
}

function pluginCase(name: string, fixture: number | null, description: string, signed: unknown, expected: PluginCase["expected"], contextChanges: Partial<typeof context> = {}, verifierVersion = "1.1.0"): PluginCase {
  return { name, fixture, description, verifier_version: verifierVersion, context: { ...context, ...contextChanges }, attestation: signed, expected };
}

const withoutExpiry = attestation({ expires_at: "2026-10-06T00:00:00.000Z" });
delete (withoutExpiry.payload as Partial<ExternalAttestationPayload>).expires_at;

const legacy = attestation({ execution: undefined, evidence_digests: undefined, issued_at: undefined });

const pluginCases: PluginCase[] = [
  pluginCase("valid", null, "Control: bound to a declared run of the agreed skill, citing evidence on the obligation.", attestation(), { signature_valid: true, status: "pass", code: null }),
  pluginCase("execution_not_declared", 1, "Cites a run no obligation.started event declared.", attestation({ execution: executionBinding(undeclaredRun) }), { signature_valid: true, status: "invalid_evidence", code: "execution_not_declared" }),
  pluginCase("execution_digest_altered", 1, "Cites a declared execution_id with the digest of a different descriptor.", attestation({ execution: { execution_id: codeFixRun.execution_id, execution_digest: executionBinding(undeclaredRun).execution_digest } }), { signature_valid: true, status: "invalid_evidence", code: "execution_not_declared" }),
  pluginCase("skill_mismatch", 2, "Cites a declared run that performed a different skill from terms.skill.", attestation({ execution: executionBinding(translateRun) }), { signature_valid: true, status: "invalid_evidence", code: "skill_mismatch" }),
  pluginCase("execution_required", 2, "The terms name a skill, but the attestation cites no run.", attestation({ execution: undefined }), { signature_valid: true, status: "invalid_evidence", code: "execution_required" }),
  pluginCase("expired", 4, "Expired before the evaluation time, so it does not count.", attestation({ issued_at: "2026-10-04T00:00:00.000Z", expires_at: "2026-10-05T00:00:00.000Z" }), { signature_valid: true, status: "invalid_evidence", code: "expired" }),
  pluginCase("not_yet_valid", 5, "issued_at is more than 5 minutes after the evaluation time.", attestation({ issued_at: "2026-10-05T12:06:00.000Z" }), { signature_valid: true, status: "invalid_evidence", code: "not_yet_valid" }),
  pluginCase("within_clock_skew", 5, "issued_at is 4 minutes after the evaluation time, inside the allowed skew.", attestation({ issued_at: "2026-10-05T12:04:00.000Z" }), { signature_valid: true, status: "pass", code: null }),
  pluginCase("subject_mismatch", 15, "An attestation for obligation A submitted on obligation B.", attestation({ obligation_id: OTHER_OBLIGATION }), { signature_valid: true, status: "invalid_evidence", code: "subject_mismatch" }),
  pluginCase("expiry_stripped", 16, "expires_at was deleted after signing.", withoutExpiry, { signature_valid: false, status: "invalid_evidence", code: "signature_invalid" }),
  pluginCase("key_revoked", 17, "Signed with a key revoked before the attestation's issued_at.", attestation({}, "reviewerRevoked"), { signature_valid: true, status: "invalid_evidence", code: "key_revoked" }),
  pluginCase("evidence_not_on_obligation", null, "Cites an evidence digest never submitted on the obligation.", attestation({ evidence_digests: [sha256Digest("other")] }), { signature_valid: true, status: "invalid_evidence", code: "evidence_not_on_obligation" }),
  pluginCase("legacy_payload_1_1", 19, "A 1.0-shaped attestation, terms without a skill: still passes under 1.1.0.", legacy, { signature_valid: true, status: "pass", code: null }, { terms_skill: null }),
  pluginCase("legacy_payload_1_0", 19, "The same attestation under the unchanged 1.0.0 plugin.", legacy, { signature_valid: true, status: "pass", code: null }, { terms_skill: null }, "1.0.0"),
];

interface ResolutionCase {
  name: string;
  fixture: number;
  description: string;
  at: string;
  attestations: unknown[];
  expected: { revoked: boolean[]; problems: { attestation: number; code: string; target: number | null }[] };
}

const original = attestation();
const revokes = (target: { payload: unknown }): AttestationRef[] => [{ relation: "revokes", attestation_digest: digestOf(target.payload), reason: "judged the wrong patch" }];
const later = "2026-10-05T11:30:00.000Z";

const resolutionCases: ResolutionCase[] = [
  {
    name: "revoked_by_own_signer",
    fixture: 6,
    description: "The reviewer revokes its own attestation: it stays visible, marked revoked, and does not count.",
    at: AT,
    attestations: [original, attestation({ status: "fail", issued_at: later, refs: revokes(original) })],
    expected: { revoked: [true, false], problems: [] },
  },
  {
    name: "revoked_by_other_signer",
    fixture: 7,
    description: "The auditor tries to revoke the reviewer's attestation: refused, and the original still counts.",
    at: AT,
    attestations: [original, attestation({ status: "fail", issued_at: later, refs: revokes(original) }, "auditor")],
    expected: { revoked: [false, false], problems: [{ attestation: 1, code: "revocation_not_by_signer", target: 0 }] },
  },
  {
    name: "unknown_reference",
    fixture: 8,
    description: "A ref names an attestation that is not in the set: reported, and nothing else changes.",
    at: AT,
    attestations: [attestation({ refs: [{ relation: "disputes", attestation_digest: sha256Digest("not shared"), reason: "see the auditor's report" }] })],
    expected: { revoked: [false], problems: [{ attestation: 0, code: "unknown_reference", target: null }] },
  },
];

function witness(signer: SignerName, changes: Partial<ExternalAttestationPayload> = {}) {
  return attestation({ role: "witness", check_id: "witnesses", summary: "Observed the run produce the patch", ...changes }, signer);
}

/** Registrable domains the service verified, by agent. The issuer and principal share the buyer's domain. */
const verifiedDomains: Record<string, string | null> = {
  [ISSUER]: "buyer.example",
  [PRINCIPAL]: "buyer.example",
  [WORKER]: "worker.example",
  [WITNESS_A]: "gateway-a.example",
  [WITNESS_B]: "gateway-b.example",
  [WITNESS_ON_WORKER_DOMAIN]: "worker.example",
  [WITNESS_A_SIBLING]: "gateway-a.example",
};

const witnessContext = {
  obligation_id: OBLIGATION,
  deliverable_id: "main",
  check_id: "witnesses",
  party_ids: [ISSUER, WORKER, PRINCIPAL],
  verified_domains: verifiedDomains,
  witness_policy: { min_independent_witnesses: 1, independence: "distinct_verified_domain" } as { min_independent_witnesses: number; witness_agent_ids?: string[]; independence: "distinct_verified_domain" },
  terms_skill: codeFix as SkillRef | null,
  declared_executions: [codeFixRun, translateRun],
  obligation_evidence_digests: [patchDigest],
  at: AT,
};

interface WitnessCase {
  name: string;
  fixture: number | null;
  description: string;
  context: typeof witnessContext;
  attestations: unknown[];
  expected: { status: string; code: string | null; counted: string[] };
}

function witnessCase(name: string, fixture: number | null, description: string, attestations: unknown[], expected: WitnessCase["expected"], contextChanges: Partial<typeof witnessContext> = {}): WitnessCase {
  return { name, fixture, description, context: { ...witnessContext, ...contextChanges }, attestations, expected };
}

const quorumOfTwo = { min_independent_witnesses: 2, independence: "distinct_verified_domain" as const };
const witnessCases: WitnessCase[] = [
  witnessCase("independent_witness", null, "Control: one witness on its own verified domain, quorum 1.", [witness("witnessA")], { status: "pass", code: null, counted: [WITNESS_A] }),
  witnessCase("witness_on_counterparty_domain", 12, "The only witness shares the counterparty's verified domain, so it is not independent.", [witness("witnessOnWorkerDomain")], {
    status: "fail",
    code: "witness_quorum_not_met",
    counted: [],
  }),
  witnessCase("two_witnesses_one_domain", 13, "Two witnesses under one registrable domain count once; the quorum of 2 is not met.", [witness("witnessA"), witness("witnessASibling")], {
    status: "fail",
    code: "witness_quorum_not_met",
    counted: [WITNESS_A],
  }, { witness_policy: quorumOfTwo }),
  witnessCase("two_independent_witnesses", 13, "Control: two witnesses on different domains meet a quorum of 2.", [witness("witnessA"), witness("witnessB")], { status: "pass", code: null, counted: [WITNESS_A, WITNESS_B] }, {
    witness_policy: quorumOfTwo,
  }),
  witnessCase("witness_not_agreed", 14, "The witness is not in witness_agent_ids, so it does not count.", [witness("witnessB")], { status: "fail", code: "witness_quorum_not_met", counted: [] }, {
    witness_policy: { min_independent_witnesses: 1, witness_agent_ids: [WITNESS_A], independence: "distinct_verified_domain" },
  }),
  witnessCase("independence_unverifiable", null, "The counterparty has no verified domain, so overlap cannot be checked.", [witness("witnessA")], { status: "invalid_evidence", code: "independence_unverifiable", counted: [] }, {
    verified_domains: { ...verifiedDomains, [WORKER]: null },
  }),
];

interface ConflictCase {
  name: string;
  fixture: number;
  description: string;
  at: string;
  attestations: unknown[];
  expected: { kind: string; subject: string; attestations: number[]; signers: string[] }[];
}

const reviewSubject = `${OBLIGATION}/main/review`;
const passByReviewer = attestation();
const conflictCases: ConflictCase[] = [
  {
    name: "execution_mismatch",
    fixture: 3,
    description: "Two runs were declared (agent 1.0.0 and 1.1.0); two verifiers judged the same check on different runs.",
    at: AT,
    attestations: [passByReviewer, attestation({ execution: executionBinding(codeFixRunV11) }, "auditor")],
    expected: [{ kind: "execution_mismatch", subject: reviewSubject, attestations: [0, 1], signers: [REVIEWER, AUDITOR].sort() }],
  },
  {
    name: "disputed_by_other_verifier",
    fixture: 9,
    description: "The auditor disputes the reviewer's pass with its own fail: both are kept, as a disagreement and a dispute.",
    at: AT,
    attestations: [
      passByReviewer,
      attestation({ status: "fail", issued_at: later, refs: [{ relation: "disputes", attestation_digest: digestOf(passByReviewer.payload), reason: "tests were skipped" }] }, "auditor"),
    ],
    expected: [
      { kind: "disagreement", subject: reviewSubject, attestations: [0, 1], signers: [REVIEWER, AUDITOR].sort() },
      { kind: "disputed", subject: reviewSubject, attestations: [0, 1], signers: [REVIEWER, AUDITOR].sort() },
    ],
  },
  {
    name: "equivocation",
    fixture: 10,
    description: "The reviewer signs both pass and fail for the same check without revoking either.",
    at: AT,
    attestations: [passByReviewer, attestation({ status: "fail", issued_at: later })],
    expected: [{ kind: "equivocation", subject: reviewSubject, attestations: [0, 1], signers: [REVIEWER] }],
  },
  {
    name: "revoked_then_replaced",
    fixture: 10,
    description: "Control: the reviewer revokes its pass and signs a fail; a revoked attestation no longer conflicts.",
    at: AT,
    attestations: [passByReviewer, attestation({ status: "fail", issued_at: later, refs: revokes(passByReviewer) })],
    expected: [],
  },
];

const fixtures = {
  description:
    "Adversarial external attestations. plugin_cases run external_attestation at verifier_version against context; " +
    "resolution_cases apply expiry and revocation, where an attestation's signer is its verifier_id and its digest is the digest of its payload. " +
    "witness_cases run witness_quorum@1.0.0 over all the attestations, with verified_domains as the service's domain records. " +
    "conflict_cases list the conflicts among attestations in effect at `at`, each claim's subject being obligation_id/deliverable_id/check_id. " +
      "declared_executions are the run descriptors the counterparty declared; each one's binding is executionBinding(descriptor).",
  keys: Object.values(signers).map((s) => ({ key_id: s.keyId, key_version: s.keyVersion, actor_id: s.actorId, public_key: publicKeyFromPrivate(s.privateKey), revoked_at: s.revokedAt })),
  execution_bindings: [codeFixRun, translateRun, codeFixRunV11, undeclaredRun].map((descriptor) => ({ descriptor, binding: executionBinding(descriptor) })),
  plugin_cases: pluginCases,
  resolution_cases: resolutionCases,
  witness_cases: witnessCases,
  conflict_cases: conflictCases,
};

const dir = fileURLToPath(new URL("../test-vectors/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}attestations.json`, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${dir}attestations.json`);
