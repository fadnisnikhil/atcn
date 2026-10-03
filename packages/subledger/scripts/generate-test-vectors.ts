import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToBase64Url, canonicalize, digestOf, publicKeyFromPrivate } from "@atcn/schema";
import { buildResponseStatement, countersignPayload, signStatement, type StatementInput } from "../src/index.js";

// Same fixed seed as the schema vectors. Never use for real keys.
const privateKey = bytesToBase64Url(new Uint8Array(32).map((_, i) => i + 1));

const statementInputs: StatementInput[] = [
  {
    receipt: { receipt_id: "rcp_01J00000000000000000000001", digest: `sha256:${"a".repeat(64)}`, revision: 2, issuer_operator_id: "ten_01J00000000000000000000001" },
    response_type: "signed_attestation",
    fields: ["financial.amounts", "delivery.status", "delivery.status"],
  },
  {
    receipt: { receipt_id: "rcp_01J00000000000000000000002", digest: `sha256:${"b".repeat(64)}`, revision: 1, issuer_operator_id: "ten_01J00000000000000000000001" },
    response_type: "propose_correction",
    fields: [],
    note: "caf\u00e9: two of three files",
    evidence: [{ uri: "https://provider.example/delivery/7", digest: null, evidence_type: "delivery_log" }],
    corrections: [{ field: "delivery.status", proposed_value: "partial_completion", reason: "file 3 missing" }],
  },
];

const countersignedPayload = { document_type: "atcn.subledger.closure", closure_id: "cls_01J00000000000000000000001", version: 1, totals: { USD: { net_cost: 1500 } } };

const vectors = {
  description: "Subledger response statements and operator countersignatures. Every SDK must reproduce statement, canonical, digest, and signature exactly.",
  private_key: privateKey,
  public_key: publicKeyFromPrivate(privateKey),
  statements: statementInputs.map((input) => {
    const statement = buildResponseStatement(input);
    return { input, statement, canonical: canonicalize(statement), digest: digestOf(statement), signature: signStatement(statement, privateKey) };
  }),
  countersignature: { payload: countersignedPayload, signature: countersignPayload(countersignedPayload, privateKey) },
};

const dir = fileURLToPath(new URL("../test-vectors/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}vectors.json`, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${dir}vectors.json`);
