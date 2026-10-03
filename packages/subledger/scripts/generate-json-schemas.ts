import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AllocationInputSchema,
  DelegationEventInputSchema,
  DelegationInputSchema,
  FinancialEventInputSchema,
  OperatorKeyRecordSchema,
  ResponseStatementSchema,
  SignedClosureSchema,
  SignedReceiptSchema,
  SUBLEDGER_SCHEMA_VERSION,
  TaskInputSchema,
} from "../src/index.js";

/**
 * Publishes the current subledger schemas next to the 1.0 schemas, for independent verifiers and integrators.
 * Earlier version directories are kept as published and are not regenerated.
 */
const schemas: Record<string, z.ZodType> = {
  "subledger-receipt": SignedReceiptSchema,
  "subledger-closure": SignedClosureSchema,
  "subledger-response-statement": ResponseStatementSchema,
  "subledger-task-input": TaskInputSchema,
  "subledger-delegation-input": DelegationInputSchema,
  "subledger-delegation-event-input": DelegationEventInputSchema,
  "subledger-financial-event-input": FinancialEventInputSchema,
  "subledger-allocation-input": AllocationInputSchema,
  "subledger-operator-key": OperatorKeyRecordSchema,
};

const dir = fileURLToPath(new URL(`../../schema/schemas/${SUBLEDGER_SCHEMA_VERSION}/`, import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  const document = { $id: `https://schemas.atcn.dev/${SUBLEDGER_SCHEMA_VERSION}/${name}.json`, title: name, ...json };
  writeFileSync(`${dir}${name}.json`, JSON.stringify(document, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(schemas).length} schemas to ${dir}`);
