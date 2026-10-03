import { describe, expect, it } from "vitest";
import { generateKeyPair, newId, sha256Digest, signPayload, utf8Encode, type EvidenceEnvelope } from "@atcn/schema";
import { runCheck, type AttestationPayload } from "../src/index.js";

const obligationId = newId("obligation");
const verifierAgent = newId("agent");

function envelope(type: string, content: string, verifiers: string[]): EvidenceEnvelope {
  return {
    evidence_id: newId("evidence"),
    evidence_type: type,
    producer_id: newId("agent"),
    created_at: "2026-10-05T00:00:00.000Z",
    content_digest: sha256Digest(content),
    uri: "atcn-blob://x",
    retrieval_method: "atcn-blob",
    media_type: "text/plain",
    access_policy: { visible_to: ["verifier"] },
    verifiers,
    deliverable_ids: [],
  };
}

function run(type: string, verifier: string, content: string, config: Record<string, number> = {}, extra: Partial<Parameters<typeof runCheck>[0]> = {}) {
  const env = envelope(type, content, [verifier]);
  return runCheck({
    obligationId,
    deliverableId: "main",
    check: { check_id: "c", verifier, verifier_version: "1.0.0", evidence_type: type, config },
    envelope: env,
    fetchResult: { ok: true, content: utf8Encode(content) },
    requireDigestMatch: true,
    allowedVerifierIds: [verifierAgent],
    resolveKey: () => null,
    ...extra,
  });
}

const passingJUnit = `<?xml version="1.0"?><testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>`;
const failingJUnit = `<testsuite name="s"><testcase name="a"/><testcase name="b"><failure message="x"/></testcase></testsuite>`;

describe("verifier plugins", () => {
  it("junit passes and fails on counts", () => {
    expect(run("test_report", "junit_tests", passingJUnit).status).toBe("pass");
    const failed = run("test_report", "junit_tests", failingJUnit);
    expect(failed.status).toBe("fail");
    expect(failed.details.failures).toBe(1);
    expect(run("test_report", "junit_tests", "not xml at all").status).toBe("invalid_evidence");
  });

  it("eslint applies thresholds", () => {
    const report = JSON.stringify([{ filePath: "a.ts", errorCount: 0, warningCount: 2, messages: [] }]);
    expect(run("lint_report", "eslint_lint", report).status).toBe("pass");
    expect(run("lint_report", "eslint_lint", report, { max_warnings: 1 }).status).toBe("fail");
    expect(run("lint_report", "eslint_lint", "{}").status).toBe("invalid_evidence");
  });

  it("patch digest checks for a unified diff", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
    expect(run("patch_ref", "patch_digest", diff).status).toBe("pass");
    expect(run("patch_ref", "patch_digest", "hello").status).toBe("invalid_evidence");
  });

  it("distinguishes missing evidence, digest mismatch, and unavailable verifier", () => {
    const base = {
      obligationId,
      deliverableId: "main",
      check: { check_id: "c", verifier: "junit_tests", verifier_version: "1.0.0", evidence_type: "test_report", config: {} },
      requireDigestMatch: true,
      allowedVerifierIds: [],
      resolveKey: () => null,
    };
    expect(runCheck({ ...base, envelope: null, fetchResult: null }).status).toBe("missing_evidence");
    const env = envelope("test_report", passingJUnit, ["junit_tests"]);
    expect(runCheck({ ...base, envelope: env, fetchResult: { ok: true, content: utf8Encode(passingJUnit + "x") } }).status).toBe("invalid_evidence");
    expect(runCheck({ ...base, envelope: env, fetchResult: { ok: false, error: "timeout" } }).status).toBe("unavailable");
    expect(runCheck({ ...base, check: { ...base.check, verifier_version: "9.9.9" }, envelope: env, fetchResult: { ok: true, content: utf8Encode(passingJUnit) } }).status).toBe("unavailable");
  });

  it("accepts signed attestations from agreed verifiers and labels probabilistic ones", () => {
    const keys = generateKeyPair();
    const payload: AttestationPayload = {
      obligation_id: obligationId,
      deliverable_id: "main",
      check_id: "c",
      verifier_id: verifierAgent,
      status: "pass",
      probabilistic: true,
      model: { name: "review-model", version: "2026-09", confidence_bps: 8700 },
      summary: "Looks correct",
    };
    const signed = JSON.stringify(signPayload(payload, { keyId: "key_v", keyVersion: 1, privateKey: keys.privateKey }));
    const resolveKey = () => ({ actor_id: verifierAgent, public_key: keys.publicKey });
    const result = run("verifier_attestation", "external_attestation", signed, {}, { resolveKey });
    expect(result.status).toBe("pass");
    expect(result.kind).toBe("probabilistic");
    expect(result.model?.confidence_bps).toBe(8700);

    const wrongKey = () => ({ actor_id: verifierAgent, public_key: generateKeyPair().publicKey });
    expect(run("verifier_attestation", "external_attestation", signed, {}, { resolveKey: wrongKey }).status).toBe("invalid_evidence");
  });
});
