import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, digestOf, publicKeyFromPrivate, signPayload, signWebhook, bytesToBase64Url } from "../src/index.js";

// Fixed 32-byte seed so vectors are reproducible. Never use for real keys.
const seed = new Uint8Array(32).map((_, i) => i + 1);
const privateKey = bytesToBase64Url(seed);
const publicKey = publicKeyFromPrivate(privateKey);
const key = { keyId: "key_01J00000000000000000000000", keyVersion: 1, privateKey };

const payloads: unknown[] = [
  {
    schema_version: "1.0",
    event_id: "evt_01J00000000000000000000001",
    event_type: "obligation.started",
    obligation_id: "obl_01J00000000000000000000001",
    actor_id: "agt_01J00000000000000000000001",
    actor_platform_id: "plt_01J00000000000000000000001",
    event_time: "2026-10-02T14:00:00.000Z",
    causation_ids: [],
    data: {},
  },
  {
    zeta: "last",
    alpha: { nested_b: [3, 2, 1], nested_a: null },
    unicode: "caf\u00e9 \u20ac \u2028 \"quoted\" \\ \n\t",
    amount_minor: 25000,
    negative: -42,
    flag: true,
  },
  {
    Zed: "uppercase sorts before lowercase",
    a: "ascii",
    "\u00e9tape": "non-ascii key sorts after ascii",
    control: "\u0001\u001f\b\f\r",
    empty: { list: [], object: {} },
  },
];

const vectors = {
  description: "ATCN canonical JSON + Ed25519 signing vectors. Every SDK must reproduce canonical, digest, and signature exactly.",
  private_key: privateKey,
  public_key: publicKey,
  key_id: key.keyId,
  key_version: key.keyVersion,
  cases: payloads.map((payload) => ({
    payload,
    canonical: canonicalize(payload),
    digest: digestOf(payload),
    signature: signPayload(payload, key).signature.value,
  })),
  webhook: {
    body: '{"event_type":"journal.posted","obligation_id":"obl_01J00000000000000000000001"}',
    timestamp: 1790000000,
    header: signWebhook(
      '{"event_type":"journal.posted","obligation_id":"obl_01J00000000000000000000001"}',
      key,
      1790000000,
    ),
  },
};

const target = fileURLToPath(new URL("../test-vectors/vectors.json", import.meta.url));
writeFileSync(target, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${target}`);
