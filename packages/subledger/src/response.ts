import { canonicalize, digestOf, signBytes, utf8Encode, verifyBytes, type AttestationRef, type ExecutionBinding } from "@atcn/schema";
import { RESPONSE_STATEMENT_TYPE, type Correction, type ResponseStatement } from "./documents.js";
import type { AttestableField, EvidenceRef, ResponseType } from "./types.js";

export interface StatementInput {
  receipt: { receipt_id: string; digest: string; revision: number; issuer_operator_id: string };
  response_type: ResponseType;
  fields: AttestableField[];
  note?: string | null;
  evidence?: EvidenceRef[];
  corrections?: Correction[];
  /** Schema 1.4 fields. Each is left out of the statement when not given, so older statements keep their bytes. */
  execution?: ExecutionBinding;
  issued_at?: string;
  expires_at?: string;
  refs?: AttestationRef[];
}

/** Builds the statement a provider responds with. Field order is irrelevant: the signature covers canonical JSON. */
export function buildResponseStatement(input: StatementInput): ResponseStatement {
  return {
    document_type: RESPONSE_STATEMENT_TYPE,
    receipt_id: input.receipt.receipt_id,
    receipt_digest: input.receipt.digest,
    receipt_revision: input.receipt.revision,
    issuer_operator_id: input.receipt.issuer_operator_id,
    response_type: input.response_type,
    fields: [...new Set(input.fields)].sort(),
    note: input.note ?? null,
    evidence: input.evidence ?? [],
    corrections: input.corrections ?? [],
    ...(input.execution !== undefined ? { execution: input.execution } : {}),
    ...(input.issued_at !== undefined ? { issued_at: input.issued_at } : {}),
    ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
  };
}

export function statementDigest(statement: ResponseStatement): string {
  return digestOf(statement);
}

/** Provider-side signing (in the browser page, SDK, or provider tooling). The service never sees the private key. */
export function signStatement(statement: ResponseStatement, privateKey: string): string {
  return signBytes(utf8Encode(canonicalize(statement)), privateKey);
}

/** Operator-side countersignature over a closure or receipt payload, made with a key the operator holds. */
export function countersignPayload(payload: unknown, privateKey: string): string {
  return signBytes(utf8Encode(canonicalize(payload)), privateKey);
}

export function verifyCountersignature(payload: unknown, signature: string, publicKey: string): boolean {
  return verifyBytes(utf8Encode(canonicalize(payload)), signature, publicKey);
}

export function verifyStatementSignature(statement: ResponseStatement, signature: string, publicKey: string): boolean {
  return verifyBytes(utf8Encode(canonicalize(statement)), signature, publicKey);
}
