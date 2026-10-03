import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ClearingDecisionSchema,
  ClosurePackageSchema,
  EvidenceEnvelopeSchema,
  ObligationTermsSchema,
  PolicyTemplateSchema,
  PostingBatchSchema,
  PublicKeyRecordSchema,
  SettlementEventSchema,
  SettlementInstructionSchema,
  SignedEventSchema,
  VerifierResultSchema,
} from "../src/index.js";

const schemas: Record<string, z.ZodType> = {
  "obligation-terms": ObligationTermsSchema,
  "signed-event": SignedEventSchema,
  "evidence-envelope": EvidenceEnvelopeSchema,
  "policy-template": PolicyTemplateSchema,
  "verifier-result": VerifierResultSchema,
  "clearing-decision": ClearingDecisionSchema,
  "posting-batch": PostingBatchSchema,
  "settlement-instruction": SettlementInstructionSchema,
  "settlement-event": SettlementEventSchema,
  "public-key": PublicKeyRecordSchema,
  "closure-package": ClosurePackageSchema,
};

const dir = fileURLToPath(new URL("../schemas/1.0/", import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  const document = { $id: `https://schemas.atcn.dev/1.0/${name}.json`, title: name, ...json };
  writeFileSync(`${dir}${name}.json`, JSON.stringify(document, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(schemas).length} schemas to ${dir}`);
