import { describe, expect, it } from "vitest";
import {
  digestOf,
  disputesInEffect,
  executionBinding,
  findConflicts,
  inEffect,
  resolveAttestations,
  sha256Digest,
  utf8Encode,
  verifyPayload,
  type EvidenceEnvelope,
  type ExecutionDescriptor,
  type ExternalAttestationPayload,
  type Signed,
  type SkillRef,
  type WitnessPolicy,
} from "@atcn/schema";
import { externalAttestationVerifier, externalAttestationVerifierV1_1, witnessQuorumVerifier, type VerifierPlugin } from "../src/index.js";
import fixtures from "../test-vectors/attestations.json";

const plugins: Record<string, VerifierPlugin> = { "1.0.0": externalAttestationVerifier, "1.1.0": externalAttestationVerifierV1_1 };
type Key = (typeof fixtures.keys)[number];
const keyFor = (keyId: string, keyVersion: number): Key | undefined => fixtures.keys.find((k) => k.key_id === keyId && k.key_version === keyVersion);

const envelope: EvidenceEnvelope = {
  evidence_id: "evd_01J00000000000000000000001",
  evidence_type: "verifier_attestation",
  producer_id: "agt_01J00000000000000000000001",
  created_at: "2026-10-05T11:00:00.000Z",
  content_digest: sha256Digest(""),
  uri: "atcn-blob://fixture",
  retrieval_method: "atcn-blob",
  media_type: "application/json",
  access_policy: { visible_to: ["verifier"] },
  verifiers: ["external_attestation"],
  deliverable_ids: [],
};

describe("adversarial attestation fixtures", () => {
  it("execution bindings are the digest of the declared descriptor", () => {
    for (const { descriptor, binding } of fixtures.execution_bindings) expect(executionBinding(descriptor as ExecutionDescriptor)).toEqual(binding);
  });

  describe.each(fixtures.plugin_cases)("$name (fixture $fixture)", (c) => {
    const signed = c.attestation as Signed<unknown>;
    const key = keyFor(signed.signature.key_id, signed.signature.key_version)!;

    it("signature verifies as expected", () => {
      expect(verifyPayload(signed, key.public_key)).toBe(c.expected.signature_valid);
    });

    it(`external_attestation@${c.verifier_version} returns ${c.expected.status}${c.expected.code ? ` (${c.expected.code})` : ""}`, () => {
      const ctx = c.context;
      const outcome = plugins[c.verifier_version].run({
        obligationId: ctx.obligation_id,
        deliverableId: ctx.deliverable_id,
        check: { check_id: ctx.check_id, verifier: "external_attestation", verifier_version: c.verifier_version, evidence_type: "verifier_attestation", config: {} },
        envelope,
        content: utf8Encode(JSON.stringify(signed)),
        allowedVerifierIds: ctx.allowed_verifier_ids,
        resolveKey: (keyId, keyVersion) => {
          const k = keyFor(keyId, keyVersion);
          return k ? { actor_id: k.actor_id, public_key: k.public_key, revoked_at: k.revoked_at } : null;
        },
        executions: ctx.declared_executions.map((d, i) => ({ ...executionBinding(d as ExecutionDescriptor), started_event_id: `evt_${i}`, descriptor: d as ExecutionDescriptor })),
        termsSkill: ctx.terms_skill as SkillRef | null,
        obligationEvidenceDigests: ctx.obligation_evidence_digests,
        evaluatedAt: ctx.at,
      });
      expect(outcome.status).toBe(c.expected.status);
      expect(outcome.details.code ?? null).toBe(c.expected.code);
    });
  });

  describe.each(fixtures.resolution_cases)("$name (fixture $fixture)", (c) => {
    it("applies revocation only by the original signer and reports unknown references", () => {
      const signed = c.attestations as Signed<{ verifier_id: string; issued_at?: string; expires_at?: string; refs?: { relation: "revokes" | "disputes"; attestation_digest: string; reason: string }[] }>[];
      const digests = signed.map((a) => digestOf(a.payload));
      for (const a of signed) expect(verifyPayload(a, keyFor(a.signature.key_id, a.signature.key_version)!.public_key)).toBe(true);
      const resolution = resolveAttestations(
        signed.map((a, i) => ({ digest: digests[i], signer: a.payload.verifier_id, issued_at: a.payload.issued_at, expires_at: a.payload.expires_at, refs: a.payload.refs })),
        c.at,
      );
      expect(digests.map((d) => resolution.status[d].revoked_by !== null)).toEqual(c.expected.revoked);
      expect(resolution.problems.map((p) => ({ attestation: digests.indexOf(p.digest), code: p.code, target: digests.includes(p.target) ? digests.indexOf(p.target) : null }))).toEqual(
        c.expected.problems,
      );
    });
  });

  describe.each(fixtures.witness_cases)("$name (fixture $fixture)", (c) => {
    it(`witness_quorum@1.0.0 returns ${c.expected.status}${c.expected.code ? ` (${c.expected.code})` : ""}`, () => {
      const ctx = c.context;
      const domains = ctx.verified_domains as Record<string, string | null>;
      const contents = c.attestations.map((a) => utf8Encode(JSON.stringify(a)));
      const outcome = witnessQuorumVerifier.run({
        obligationId: ctx.obligation_id,
        deliverableId: ctx.deliverable_id,
        check: { check_id: ctx.check_id, verifier: "witness_quorum", verifier_version: "1.0.0", evidence_type: "witness_attestation", config: {} },
        envelope: { ...envelope, evidence_type: "witness_attestation", verifiers: ["witness_quorum"] },
        content: contents[0],
        allowedVerifierIds: [],
        resolveKey: (keyId, keyVersion) => {
          const k = keyFor(keyId, keyVersion);
          return k ? { actor_id: k.actor_id, public_key: k.public_key, revoked_at: k.revoked_at } : null;
        },
        executions: ctx.declared_executions.map((d, i) => ({ ...executionBinding(d as ExecutionDescriptor), started_event_id: `evt_${i}`, descriptor: d as ExecutionDescriptor })),
        termsSkill: ctx.terms_skill as SkillRef | null,
        obligationEvidenceDigests: ctx.obligation_evidence_digests,
        evaluatedAt: ctx.at,
        witnessPolicy: ctx.witness_policy as WitnessPolicy,
        witnessAttestations: contents,
        partyIds: ctx.party_ids,
        verifiedDomainOf: (agentId) => domains[agentId] ?? null,
      });
      expect(outcome.status).toBe(c.expected.status);
      expect(outcome.details.code ?? null).toBe(c.expected.code);
      const counted = String(outcome.details.counted ?? "");
      expect(counted === "" ? [] : counted.split(",").map((w) => w.split("@")[0])).toEqual(c.expected.counted);
    });
  });

  describe.each(fixtures.conflict_cases)("$name (fixture $fixture)", (c) => {
    it("lists the conflicts among attestations in effect", () => {
      const signed = c.attestations as Signed<ExternalAttestationPayload>[];
      const digests = signed.map((a) => digestOf(a.payload));
      for (const a of signed) expect(verifyPayload(a, keyFor(a.signature.key_id, a.signature.key_version)!.public_key)).toBe(true);
      const items = signed.map((a, i) => ({ digest: digests[i], signer: a.payload.verifier_id, issued_at: a.payload.issued_at, expires_at: a.payload.expires_at, refs: a.payload.refs }));
      const resolution = resolveAttestations(items, c.at);
      const claims = signed
        .map((a, i) => ({
          digest: digests[i],
          signer: a.payload.verifier_id,
          subject: `${a.payload.obligation_id}/${a.payload.deliverable_id}/${a.payload.check_id}`,
          status: a.payload.status,
          ...(a.payload.execution ? { execution_digest: a.payload.execution.execution_digest } : {}),
        }))
        .filter((claim) => inEffect(resolution, claim.digest));
      const conflicts = findConflicts(claims, disputesInEffect(items, resolution));
      expect(conflicts.map((x) => ({ kind: x.kind, subject: x.subject, attestations: x.attestation_digests.map((d) => digests.indexOf(d)).sort(), signers: x.signers }))).toEqual(c.expected);
    });
  });
});
