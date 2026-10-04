import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_CHANGE_POLICY_V1, verifyClosurePackage } from "@atcn/core";
import { acceptanceData, buildEvidenceEnvelope, buildTerms, termsData, type EventSigner } from "@atcn/sdk";
import { signPayload, type ClosurePackage, type ExternalAttestationPayload } from "@atcn/schema";
import { describe, expect, it } from "vitest";
import { LocalNetwork, LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "../src/index.js";

/** An obligation whose two agreed verifiers sign opposite judgements of the one required check. */
function disagreeingVerifiers() {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-conflicts-")), "service-key.json"));
  const network = new LocalNetwork(new LocalSubledger(serviceKey, "Acme Robotics"), serviceKey);
  const buyer = network.registerAgent("Acme Robotics");
  const worker = network.registerAgent("Beta Agents");
  const reviewer = network.registerAgent("Review Co");
  const auditor = network.registerAgent("Audit Co");
  const terms = buildTerms({
    principalId: network.registerPrincipal(),
    issuerAgentId: buyer.actorId,
    counterpartyAgentId: worker.actorId,
    description: "Fix the add() bug",
    maxAmountMinor: 100,
    deliverables: [{ deliverable_id: "main", description: "Fix", amount_minor: 100, required_checks: ["review"] }],
    policy: CODE_CHANGE_POLICY_V1,
    verifierAgentIds: [reviewer.actorId, auditor.actorId],
  });
  const obligationId = terms.obligation_id;
  network.offerObligation(buyer.sign("obligation.offered", obligationId, termsData(terms)));
  network.acceptObligation(worker.sign("obligation.accepted", obligationId, acceptanceData(terms, worker.actorId)));
  network.appendLifecycleEvent(worker.sign("obligation.started", obligationId, {}));

  const submit = (producer: EventSigner, evidenceType: string, content: string, verifiers: string[]) => {
    const uri = network.uploadBlob(content);
    const envelope = buildEvidenceEnvelope({ evidenceType, producerId: producer.actorId, content, uri, retrievalMethod: "atcn-blob", mediaType: "application/json", verifiers, deliverableIds: ["main"] });
    network.submitEvidence(producer.sign("evidence.submitted", obligationId, { envelope }));
  };
  const attest = (verifier: EventSigner, status: "pass" | "fail") => {
    const payload: ExternalAttestationPayload = {
      obligation_id: obligationId,
      deliverable_id: "main",
      check_id: "review",
      verifier_id: verifier.actorId,
      status,
      probabilistic: false,
      model: null,
      summary: status === "pass" ? "Fix is correct" : "Fix breaks negative numbers",
    };
    const signed = signPayload(payload, { keyId: verifier.identity.keyId, keyVersion: 1, privateKey: verifier.identity.privateKey });
    submit(verifier, "verifier_attestation", JSON.stringify(signed), ["external_attestation"]);
  };
  submit(worker, "patch_ref", "diff --git a/src/math.ts b/src/math.ts\n", ["patch_digest"]);
  attest(reviewer, "pass");
  attest(auditor, "fail");
  network.appendLifecycleEvent(worker.sign("completion.proposed", obligationId, {}));
  return { network, serviceKey, obligationId, reviewer, auditor };
}

describe("conflicting attestations (evidence plan phase 4)", () => {
  it("sends a deliverable with disagreeing verifiers to the reviewer instead of using the newest result", () => {
    const { network, obligationId } = disagreeingVerifiers();
    expect(() => network.evaluate(obligationId)).toThrow("routes 100 to dispute review");
  });

  it("records the conflict in a 1.1 closure package that verifies offline", () => {
    const { network, serviceKey, obligationId, reviewer, auditor } = disagreeingVerifiers();
    const pkg = network.exportClosurePackage(obligationId);
    expect(pkg.payload.package_version).toBe("1.1");
    expect(pkg.payload.attestations).toHaveLength(2);
    expect(pkg.payload.attestation_conflicts).toEqual([
      expect.objectContaining({ kind: "disagreement", subject: `${obligationId}/main/review`, signers: [reviewer.actorId, auditor.actorId].sort() }),
    ]);
    const report = verifyClosurePackage(pkg, { trustedKeys: [servicePublicKey(serviceKey)] });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.find((c) => c.name === "attestation_conflicts")?.details[0]).toContain(`disagreement on ${obligationId}/main/review`);
  });

  it("fails verification when a conflict is removed from the package, even re-signed with the service key (fixture 18)", () => {
    const { network, serviceKey, obligationId } = disagreeingVerifiers();
    const pkg = network.exportClosurePackage(obligationId);
    const trustedKeys = [servicePublicKey(serviceKey)];
    const resign = (change: (body: ClosurePackage["payload"]) => void) => {
      const body = structuredClone(pkg.payload);
      change(body);
      return verifyClosurePackage(signPayload(body, serviceKey), { trustedKeys });
    };

    const cleaned = resign((body) => {
      body.attestation_conflicts = [];
    });
    expect(cleaned.valid).toBe(false);
    expect(cleaned.checks.find((c) => c.name === "attestation_conflicts")?.details).toEqual(["attestation_conflicts do not match the attestations (expected 1 conflict(s), recorded 0)"]);

    const withheld = resign((body) => {
      body.attestations = body.attestations!.slice(1);
      body.attestation_conflicts = [];
    });
    expect(withheld.valid).toBe(false);
    expect(withheld.checks.find((c) => c.name === "attestation_conflicts")?.details[0]).toMatch(/^attestation evidence evd_\w+ has no text in the package$/);
  });

  it("reports a package version it does not know as unsupported, not invalid", () => {
    const { network, obligationId } = disagreeingVerifiers();
    const pkg = network.exportClosurePackage(obligationId);
    const unsupported = verifyClosurePackage({ ...pkg, payload: { ...pkg.payload, package_version: "9.0" } }, { trustedKeys: [] });
    expect(unsupported.unsupported_schema_version).toBe("9.0");
  });
});
