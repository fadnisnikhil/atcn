import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyClosurePackage } from "@atcn/core";
import { PublicKeyRecordSchema, type PublicKeyRecord } from "@atcn/schema";
import {
  OperatorKeyRecordSchema,
  SUBLEDGER_VERIFIER_VERSION,
  SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS,
  verifySubledgerDocument,
  type OperatorKeyRecord,
} from "@atcn/subledger";

const USAGE = `usage: atcn-verify <document.json> --keys <published-keys.json> [--previous <previous-revision.json>]
                   [--operator-keys <operator-keys.json>] [--require-operator-signature]
                   [--obligation-package <closure-package.json> ...] [--json]

Verifies offline, without contacting the service:
  - ATCN closure packages (obligations): signatures, key validity, event references,
    obligation lineage, decision replay, journal balance, and settlement references.
  - Subledger task closures (atcn.subledger.closure): signature, schema, event digests,
    delegation lineage, reversals, allocation sums and versions, roll-up totals,
    provider response signatures, and the version chain.
  - Subledger provider receipts (atcn.subledger.receipt): signature, schema, reversals,
    totals, field disclosure, and the revision chain.
--keys accepts a JSON array of public key records or the /v1/service/keys response ({"items": [...]}).
--previous checks the chain link to the prior receipt revision or closure version.
--operator-keys checks countersignatures made with the operator's own keys
  (GET /v1/operators/{operator_id}/keys); --require-operator-signature fails without one.
--obligation-package (repeatable) cross-checks a task closure's obligation-backed delegations against
  the obligations' closure packages (GET /v1/exports/{obligation_id}): each package must verify, and its
  journal must produce exactly the costs the closure recorded from the clearing network.
Subledger schema versions supported: ${SUPPORTED_SUBLEDGER_SCHEMA_VERSIONS.join(", ")} (atcn-verify ${SUBLEDGER_VERIFIER_VERSION}).
Exit code 0 = valid, 1 = invalid, 2 = usage or input error, 3 = unsupported schema version (upgrade atcn-verify).`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function keyList(path: string): unknown[] {
  const raw = readJson(path);
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown[] }).items;
  if (!Array.isArray(list)) throw new Error(`${path} must be an array or an object with an items array`);
  return list;
}

function loadKeys(path: string): PublicKeyRecord[] {
  return keyList(path).map((k) => PublicKeyRecordSchema.parse(k));
}

function loadOperatorKeys(path: string): OperatorKeyRecord[] {
  return keyList(path).map((k) => OperatorKeyRecordSchema.parse(k));
}

function isSubledgerDocument(doc: unknown): boolean {
  const type = (doc as { payload?: { document_type?: unknown } } | null)?.payload?.document_type;
  return typeof type === "string" && type.startsWith("atcn.subledger.");
}

function main(): number {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        keys: { type: "string" },
        previous: { type: "string" },
        "operator-keys": { type: "string" },
        "require-operator-signature": { type: "boolean" },
        "obligation-package": { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help || parsed.positionals.length !== 1 || !parsed.values.keys) {
    console.error(USAGE);
    return 2;
  }
  let report: { valid: boolean; unsupported_schema_version?: string; checks: { name: string; ok: boolean; details: string[] }[] };
  let label: string;
  try {
    const doc = readJson(parsed.positionals[0]);
    const trustedKeys = loadKeys(parsed.values.keys);
    if (isSubledgerDocument(doc)) {
      const previous = parsed.values.previous ? readJson(parsed.values.previous) : undefined;
      const operatorKeysPath = parsed.values["operator-keys"];
      const operatorKeys = operatorKeysPath ? loadOperatorKeys(operatorKeysPath) : undefined;
      const obligationPackages = parsed.values["obligation-package"]?.map(readJson);
      const result = verifySubledgerDocument(doc, {
        trustedKeys,
        previous,
        operatorKeys,
        requireOperatorSignature: parsed.values["require-operator-signature"],
        obligationPackages,
      });
      report = result;
      label = result.document_type === "atcn.subledger.receipt" ? "provider receipt" : "task closure";
    } else {
      report = verifyClosurePackage(doc, { trustedKeys });
      label = "closure package";
    }
  } catch (error) {
    console.error(`cannot read input: ${(error as Error).message}`);
    return 2;
  }
  if (parsed.values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.unsupported_schema_version !== undefined) {
    console.error(`UNSUPPORTED  ${report.checks[0].details[0]}`);
  } else {
    for (const check of report.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
      for (const detail of check.details) console.log(`      ${detail}`);
    }
    console.log(report.valid ? `\n${label} is VALID` : `\n${label} is INVALID`);
    console.log("A valid signature attests to the signer's statement, not to the truth of the underlying work or payment.");
  }
  if (report.unsupported_schema_version !== undefined) return 3;
  return report.valid ? 0 : 1;
}

process.exit(main());
