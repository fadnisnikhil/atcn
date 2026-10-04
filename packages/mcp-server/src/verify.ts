import { verifyClosurePackage } from "@atcn/core";
import type { PublicKeyRecord } from "@atcn/schema";
import { verifySubledgerDocument } from "@atcn/subledger";

export interface VerificationResult {
  valid: boolean;
  /** "task closure", "provider receipt" or "closure package". */
  label: string;
  unsupported_schema_version?: string;
  checks: { name: string; ok: boolean; details: string[]; state?: "not_inspected" }[];
}

/**
 * Verifies a signed ATCN document offline, dispatching as atcn-verify does: subledger task closures and provider
 * receipts (payload.document_type "atcn.subledger.*") go to verifySubledgerDocument, anything else is a closure package.
 */
export function verifyDocument(document: unknown, trustedKeys: PublicKeyRecord[]): VerificationResult {
  const documentType = (document as { payload?: { document_type?: unknown } } | null)?.payload?.document_type;
  if (typeof documentType === "string" && documentType.startsWith("atcn.subledger.")) {
    const report = verifySubledgerDocument(document, { trustedKeys });
    return { ...report, label: report.document_type === "atcn.subledger.receipt" ? "provider receipt" : "task closure" };
  }
  return { ...verifyClosurePackage(document, { trustedKeys }), label: "closure package" };
}
