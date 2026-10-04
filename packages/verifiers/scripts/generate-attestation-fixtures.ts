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
const OBLIGATION = "obl_01J00000000000000000000001";
const OTHER_OBLIGATION = "obl_01J00000000000000000000002";
const AT = "2026-10-05T12:00:00.000Z";
const ISSUED = "2026-10-05T11:00:00.000Z";

const signers = {
  reviewer: { keyId: "key_01J00000000000000000000001", keyVersion: 1, privateKey: seed(1), actorId: REVIEWER, revokedAt: null },
  reviewerRevoked: { keyId: "key_01J00000000000000000000001", keyVersion: 2, privateKey: seed(51), actorId: REVIEWER, revokedAt: "2026-10-05T10:00:00.000Z" },
  auditor: { keyId: "key_01J00000000000000000000002", keyVersion: 1, privateKey: seed(101), actorId: AUDITOR, revokedAt: null },
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

const fixtures = {
  description:
    "Adversarial external attestations. plugin_cases run external_attestation at verifier_version against context; " +
    "resolution_cases apply expiry and revocation, where an attestation's signer is its verifier_id and its digest is the digest of its payload. " +
      "declared_executions are the run descriptors the counterparty declared; each one's binding is executionBinding(descriptor).",
  keys: Object.values(signers).map((s) => ({ key_id: s.keyId, key_version: s.keyVersion, actor_id: s.actorId, public_key: publicKeyFromPrivate(s.privateKey), revoked_at: s.revokedAt })),
  execution_bindings: [codeFixRun, translateRun, undeclaredRun].map((descriptor) => ({ descriptor, binding: executionBinding(descriptor) })),
  plugin_cases: pluginCases,
  resolution_cases: resolutionCases,
};

const dir = fileURLToPath(new URL("../test-vectors/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}attestations.json`, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${dir}attestations.json`);
