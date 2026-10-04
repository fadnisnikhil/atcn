import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BILLING_REF_EXTENSION_URI, billingRefFromAgentCard, canonicalize, digestOf, providerJobRefFor, publicKeyFromPrivate, signPayload, signWebhook, bytesToBase64Url } from "../src/index.js";

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

// The same payloads in the layout of the shared RFC 8785 vector sets (A2A discussion #2038), so other
// implementations can cross-run ATCN's canonical form unchanged.
const jcsVectors = {
  name: "atcn_jcs_v1",
  license: "Apache-2.0",
  spec: "RFC 8785 (JCS), restricted to strings, booleans, null, arrays, objects and safe integers. Non-integer numbers are rejected.",
  canon_version: "jcs-rfc8785-v1",
  reference_impl: "@atcn/schema canonicalize",
  vectors: payloads.map((preimage, i) => {
    const bytes = new TextEncoder().encode(canonicalize(preimage));
    return {
      vector_id: `atcn-jcs-${String(i + 1).padStart(3, "0")}`,
      description: ["A signed ATCN network event", "Nested objects, escapes, negative numbers and U+2028", "Key order with uppercase, non-ASCII keys, controls and empty containers"][i],
      preimage,
      expected_jcs_bytes_b64: Buffer.from(bytes).toString("base64"),
      expected_sha256: digestOf(preimage).slice("sha256:".length),
    };
  }),
};
const jcsTarget = fileURLToPath(new URL("../test-vectors/atcn_jcs_v1.json", import.meta.url));
writeFileSync(jcsTarget, JSON.stringify(jcsVectors, null, 2) + "\n");
console.log(`wrote ${jcsTarget}`);

// A2A billing-reference extension: cards, tasks, and the provider_job_ref each yields. Every SDK must agree.
const card = (params: unknown) => ({ name: "Gamma Search", version: "1.0.0", capabilities: { extensions: [{ uri: BILLING_REF_EXTENSION_URI, required: false, params }] } });
const task = { id: "task-123", contextId: "ctx-9", metadata: { invoice_ref: "inv-77" } };
const billingCases = [
  { name: "task_id", card: card({ billing_ref: "task_id", currency: "USD", pricing: [{ skill_id: "web-search", unit: "task", amount_minor: 1200 }] }), task },
  { name: "context_id", card: card({ billing_ref: "context_id" }), task },
  { name: "metadata_key", card: card({ billing_ref: { metadata_key: "invoice_ref" } }), task },
  { name: "metadata_key_missing", card: card({ billing_ref: { metadata_key: "invoice_ref" } }), task: { id: "task-124", contextId: "ctx-9", metadata: {} } },
  { name: "no_extension", card: { name: "Plain Agent", version: "1.0.0", capabilities: {} }, task },
];
const billingVectors = {
  description: "A2A billing-reference extension v1: parsed params and the provider_job_ref for a task. null params means the card does not declare the extension.",
  extension_uri: BILLING_REF_EXTENSION_URI,
  cases: billingCases.map((c) => ({ ...c, params: billingRefFromAgentCard(c.card), provider_job_ref: providerJobRefFor(c.card, c.task) })),
  invalid: [
    { name: "unknown_billing_ref", card: card({ billing_ref: "invoice_id" }) },
    { name: "extra_field", card: card({ billing_ref: "task_id", surprise: true }) },
    { name: "negative_price", card: card({ billing_ref: "task_id", currency: "USD", pricing: [{ skill_id: "s", unit: "task", amount_minor: -1 }] }) },
  ],
};
const billingTarget = fileURLToPath(new URL("../test-vectors/billing-ref.json", import.meta.url));
writeFileSync(billingTarget, JSON.stringify(billingVectors, null, 2) + "\n");
console.log(`wrote ${billingTarget}`);
