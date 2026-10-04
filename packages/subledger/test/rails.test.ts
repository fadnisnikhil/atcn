import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSubledger, loadOrCreateServiceKey, servicePublicKey } from "@atcn/local-runner";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  A2A_SE_REFUND_SCHEME,
  A2A_SE_RELEASE_SCHEME,
  X402_EXACT_EVM_SCHEME,
  eip3009Digest,
  financialEventFromRailAttestation,
  pythonCanonicalJson,
  verifyRailAttestation,
  verifySubledgerDocument,
  type RailAttestation,
} from "../src/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/a2a-se-attestations.json", import.meta.url), "utf8"));
const release: RailAttestation = { scheme: A2A_SE_RELEASE_SCHEME, record: fixture.release };
const refund: RailAttestation = { scheme: A2A_SE_REFUND_SCHEME, record: fixture.refund };

/** Copies an attestation and changes its record. */
function altered(attestation: RailAttestation, change: (record: any) => void): RailAttestation {
  const copy = structuredClone(attestation);
  change(copy.record);
  return copy;
}

function buyer() {
  const serviceKey = loadOrCreateServiceKey(join(mkdtempSync(join(tmpdir(), "atcn-rails-")), "service-key.json"));
  const s = new LocalSubledger(serviceKey, "Acme");
  const task = s.createTask({ external_ref: "job", currency: "USD" });
  const search = s.createDelegation(task.task_id, { external_ref: "search", provider_job_ref: "a2a-task-7", currency: "USD" });
  const retry = s.createDelegation(task.task_id, { external_ref: "retry", provider_job_ref: "a2a-task-8", currency: "USD" });
  return { s, task, search, retry, trustedKeys: [servicePublicKey(serviceKey)] };
}

describe("A2A-SE escrow attestations", () => {
  it("verifies records made by the A2A-SE reference implementation, including Python's ASCII escaping", () => {
    expect(verifyRailAttestation(release)).toMatchObject({ ok: true, rail: "a2a-se", facts: { type: "payment_reported", amount_minor: 1_200, currency: "USD", rail_ref: "esc-1", job_ref: "a2a-task-7" } });
    expect(verifyRailAttestation(refund)).toMatchObject({ ok: true, facts: { type: "refund", amount_minor: 500, rail_ref: "esc-2", job_ref: "a2a-task-8" } });
    expect(pythonCanonicalJson({ b: "café", a: [1, null, true] })).toBe('{"a":[1,null,true],"b":"caf\\u00e9"}');
  });

  it("refuses a tampered record with a code", () => {
    const code = (attestation: RailAttestation) => {
      const result = verifyRailAttestation(attestation);
      return result.ok ? "ok" : result.code;
    };
    expect(code(altered(release, (r) => (r.payload.amount_paid = 12_000)))).toBe("data_hash_mismatch");
    expect(code(altered(release, (r) => (r.proof[0].sibling_hash = "0".repeat(64))))).toBe("merkle_proof_invalid");
    expect(code(altered(release, (r) => (r.merkle_root = "1".repeat(64))))).toBe("merkle_proof_invalid");
    expect(code(altered(release, (r) => (r.proof[0].side = r.proof[0].side === "left" ? "right" : "left")))).toBe("merkle_proof_invalid");
    expect(code({ scheme: "urn:a2a-se:dispute-resolution-attestation:v1", record: fixture.release })).toBe("unsupported_scheme");
    expect(code({ scheme: A2A_SE_REFUND_SCHEME, record: fixture.release })).toBe("malformed");
  });

  it("records the payment and the refund as rail_attested; the closure re-verifies them offline", () => {
    const { s, task, search, retry, trustedKeys } = buyer();
    s.recordFinancialEvent({ type: "charge", source: "gamma", source_event_id: "ch-7", amount_minor: 1_200, currency: "USD", event_date: "2026-10-01T11:00:00Z", match: { provider_job_ref: "a2a-task-7" } });
    const paid = s.recordFinancialEvent(financialEventFromRailAttestation(release, { source: "a2a-se" }));
    expect(paid.attribution).toEqual({ task_id: task.task_id, delegation_id: search.delegation_id });
    const refunded = s.recordFinancialEvent(financialEventFromRailAttestation(refund, { source: "a2a-se" }));
    expect(refunded.attribution?.delegation_id).toBe(retry.delegation_id);

    const { closure } = s.closeTask(task.task_id, []);
    expect(closure.payload.rail_attestations).toEqual([
      expect.objectContaining({ financial_event_id: paid.financial_event.financial_event_id, scheme: A2A_SE_RELEASE_SCHEME, rail: "a2a-se", rail_ref: "esc-1", assurance: ["rail_attested"] }),
      expect.objectContaining({ financial_event_id: refunded.financial_event.financial_event_id, scheme: A2A_SE_REFUND_SCHEME, rail_ref: "esc-2", assurance: ["rail_attested"] }),
    ]);
    const report = verifySubledgerDocument(closure, { trustedKeys });
    expect(report.valid).toBe(true);
    expect(report.checks.find((c) => c.name === "rail_attestations")!.details[0]).toBe("2 payment/refund record(s) rail_attested, re-verified offline without contacting the rail");

    const tampered = structuredClone(closure);
    (tampered.payload.financial_events.find((e) => e.record.rail_attestation)!.record.rail_attestation!.record as any).payload.amount_paid = 1;
    expect(verifySubledgerDocument(tampered, { trustedKeys }).checks.find((c) => c.name === "rail_attestations")).toMatchObject({
      ok: false,
      details: expect.arrayContaining([expect.stringContaining("rail attestation refused (data_hash_mismatch)")]),
    });
  });

  it("refuses an event that disagrees with its attestation, or a tampered attestation, at intake", () => {
    const { s } = buyer();
    const body = financialEventFromRailAttestation(release, { source: "a2a-se" });
    expect(() => s.recordFinancialEvent({ ...body, amount_minor: 1_000 })).toThrow(/attestation_mismatch.*amount 1000 \(the rail recorded 1200\)/);
    expect(() => s.recordFinancialEvent({ ...body, type: "refund" })).toThrow(/attestation_mismatch/);
    expect(() => s.recordFinancialEvent({ ...body, rail_attestation: altered(release, (r) => (r.payload.settlement.escrow_id = "esc-9")) })).toThrow(/rail attestation refused \(data_hash_mismatch\)/);
    expect(() => financialEventFromRailAttestation(altered(release, (r) => (r.data_hash = "f".repeat(64))), { source: "a2a-se" })).toThrow(/data_hash_mismatch/);
    expect(() => s.recordFinancialEvent({ ...body, type: "charge" })).toThrow(/rail_attestation is allowed only on payment_reported and refund events/);
  });
});

describe("x402 exact EVM payments", () => {
  const payerKey = secp256k1.utils.randomPrivateKey();
  const payer = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(payerKey, false).slice(1)).slice(-20))}`;
  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "1200000",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    extra: { name: "USDC", version: "2" },
  };
  const authorization = { from: payer, to: requirements.payTo, value: "1200000", validAfter: "0", validBefore: "1893456000", nonce: `0x${"ab".repeat(32)}` };

  function signed(auth = authorization, key = payerKey): string {
    const digest = eip3009Digest(auth, { name: "USDC", version: "2", chainId: 84532n, verifyingContract: requirements.asset });
    const signature = secp256k1.sign(digest, key);
    return `0x${bytesToHex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`;
  }
  const attestation = (change: (record: any) => void = () => {}): RailAttestation => {
    const record = { requirements: structuredClone(requirements), payload: { signature: signed(), authorization: { ...authorization } }, settlement: { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:84532", payer } };
    change(record);
    return { scheme: X402_EXACT_EVM_SCHEME, record };
  };
  const code = (a: RailAttestation) => {
    const result = verifyRailAttestation(a);
    return result.ok ? "ok" : result.code;
  };

  it("verifies the payer's EIP-3009 authorization offline and records USD cents", () => {
    expect(verifyRailAttestation(attestation())).toMatchObject({ ok: true, rail: "x402", facts: { type: "payment_reported", amount_minor: 120, currency: "USD", rail_ref: `0x${"cd".repeat(32)}`, job_ref: authorization.nonce } });
    const body = financialEventFromRailAttestation(attestation(), { source: "x402:eip155:84532", eventDate: "2026-10-01T12:00:00Z" });
    expect(body).toMatchObject({ type: "payment_reported", amount_minor: 120, match: { provider_job_ref: authorization.nonce } });
  });

  it("refuses a signature by someone other than the payer, a changed amount, a failed settlement and an unknown asset", () => {
    expect(code(attestation((r) => (r.payload.signature = signed(authorization, secp256k1.utils.randomPrivateKey()))))).toBe("signature_invalid");
    expect(code(attestation((r) => (r.payload.authorization.validBefore = "1893456001")))).toBe("signature_invalid");
    expect(code(attestation((r) => (r.requirements.amount = "1300000")))).toBe("malformed");
    expect(code(attestation((r) => (r.settlement.success = false)))).toBe("settlement_not_successful");
    expect(code(attestation((r) => (r.requirements.asset = "0x0000000000000000000000000000000000000001")))).toBe("signature_invalid");
    expect(() => financialEventFromRailAttestation(attestation(), { source: "x402" })).toThrow(/pass eventDate/);
  });
});
