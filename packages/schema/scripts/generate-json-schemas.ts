import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ClearingDecisionSchema,
  ClosurePackageSchema,
  EvidenceEnvelopeSchema,
  ExecutionDescriptorSchema,
  ObligationTermsSchema,
  PolicyTemplateSchema,
  PostingBatchSchema,
  PublicKeyRecordSchema,
  SettlementEventSchema,
  SettlementInstructionSchema,
  SignedEventSchema,
  SignedExternalAttestationSchema,
  TERMS_SCHEMA_VERSIONS,
  VerifierResultSchema,
} from "../src/index.js";

/**
 * Publishes the schemas for the current terms schema_version. Earlier version directories (1.0) are kept as
 * published and are not regenerated.
 */
const version = TERMS_SCHEMA_VERSIONS[TERMS_SCHEMA_VERSIONS.length - 1];
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
  "external-attestation": SignedExternalAttestationSchema,
  "execution-descriptor": ExecutionDescriptorSchema,
};

const dir = fileURLToPath(new URL(`../schemas/${version}/`, import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  const document = { $id: `https://schemas.atcn.dev/${version}/${name}.json`, title: name, ...json };
  writeFileSync(`${dir}${name}.json`, JSON.stringify(document, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(schemas).length} schemas to ${dir}`);
