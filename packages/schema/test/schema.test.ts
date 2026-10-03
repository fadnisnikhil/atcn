import { describe, expect, it } from "vitest";
import vectors from "../test-vectors/vectors.json";
import {
  canonicalize,
  digestOf,
  generateKeyPair,
  hasPrefix,
  newId,
  publicKeyFromPrivate,
  signPayload,
  verifyPayload,
  verifyWebhook,
  canTransition,
} from "../src/index.js";

describe("canonical JSON and signing vectors", () => {
  it("reproduces every vector exactly", () => {
    expect(publicKeyFromPrivate(vectors.private_key)).toBe(vectors.public_key);
    for (const testCase of vectors.cases) {
      expect(canonicalize(testCase.payload)).toBe(testCase.canonical);
      expect(digestOf(testCase.payload)).toBe(testCase.digest);
      const signed = signPayload(testCase.payload, {
        keyId: vectors.key_id,
        keyVersion: vectors.key_version,
        privateKey: vectors.private_key,
      });
      expect(signed.signature.value).toBe(testCase.signature);
      expect(verifyPayload(signed, vectors.public_key)).toBe(true);
    }
  });

  it("verifies the webhook vector and rejects tampering", () => {
    const now = vectors.webhook.timestamp + 10;
    expect(verifyWebhook(vectors.webhook.body, vectors.webhook.header, vectors.public_key, { nowSeconds: now }).valid).toBe(true);
    expect(verifyWebhook(vectors.webhook.body + " ", vectors.webhook.header, vectors.public_key, { nowSeconds: now }).valid).toBe(false);
    expect(verifyWebhook(vectors.webhook.body, vectors.webhook.header, vectors.public_key, { nowSeconds: now + 10_000 }).reason).toBe(
      "timestamp_outside_tolerance",
    );
  });

  it("rejects floats and sorts keys", () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow(/safe integers/);
    expect(canonicalize({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });

  it("fails verification when the payload changes", () => {
    const keys = generateKeyPair();
    const signed = signPayload({ amount_minor: 100 }, { keyId: "key_x", keyVersion: 1, privateKey: keys.privateKey });
    expect(verifyPayload(signed, keys.publicKey)).toBe(true);
    expect(verifyPayload({ ...signed, payload: { amount_minor: 101 } }, keys.publicKey)).toBe(false);
  });
});

describe("ids and states", () => {
  it("generates prefixed ULIDs", () => {
    const id = newId("obligation");
    expect(hasPrefix(id, "obligation")).toBe(true);
    expect(id).toHaveLength(30);
  });

  it("enforces the lifecycle", () => {
    expect(canTransition("offered", "accepted")).toBe(true);
    expect(canTransition("cancelled", "active")).toBe(false);
    expect(canTransition("completion_proposed", "insufficient_evidence")).toBe(true);
  });
});
