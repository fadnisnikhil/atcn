import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { FinancialEventRecord, RailAttestation } from "./types.js";

/**
 * Rail attestations (schema 1.5): a payment rail's own record that a payment or refund happened, embedded in the
 * financial event so the closure re-verifies it offline, without contacting the rail. ATCN never moves money; it checks
 * what the rail recorded and labels the event rail_attested, separately from operator-reported payment status.
 */

/** What a verified rail record proves. */
export interface RailFacts {
  type: "payment_reported" | "refund";
  amount_minor: number;
  currency: string;
  /** The rail's reference for the payment: an escrow id or a transaction hash. Recorded as the event's provider_reference. */
  rail_ref: string;
  /** The buyer's job reference the rail recorded (an A2A task id, an authorization nonce), when it records one. */
  job_ref: string | null;
  occurred_at: string | null;
}

export type RailVerification =
  | { ok: true; rail: string; facts: RailFacts; anchor: string }
  | { ok: false; code: RailRefusalCode; detail: string };

export type RailRefusalCode = "unsupported_scheme" | "malformed" | "data_hash_mismatch" | "merkle_proof_invalid" | "signature_invalid" | "settlement_not_successful" | "unsupported_asset";

/** Verifies one rail's records offline. Add a rail by implementing this and listing it in RAIL_IMPORTERS. */
export interface RailAttestationImporter {
  rail: string;
  schemes: readonly string[];
  verify(attestation: RailAttestation): RailVerification;
}

const refuse = (code: RailRefusalCode, detail: string): RailVerification => ({ ok: false, code, detail });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isHex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isCurrency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const isAmount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// ---------- A2A-SE escrow attestations ----------

export const A2A_SE_RELEASE_SCHEME = "urn:a2a-se:escrow-release-attestation:v1";
export const A2A_SE_REFUND_SCHEME = "urn:a2a-se:escrow-refund-attestation:v1";

/** Python's json.dumps(value, sort_keys=True, separators=(",", ":")), which A2A-SE hashes: keys by code point, non-ASCII escaped. */
export function pythonCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`number ${value} is not an integer; A2A-SE records carry integers only`);
    return String(value);
  }
  if (typeof value === "string") return asciiJsonString(value);
  if (Array.isArray(value)) return `[${value.map(pythonCanonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort(byCodePoint);
    return `{${keys.map((key) => `${asciiJsonString(key)}:${pythonCanonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`${typeof value} cannot be serialized`);
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function byCodePoint(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}

const leafHash = (canonical: string) => bytesToHex(sha256(concatBytes(new Uint8Array([0]), utf8ToBytes(canonical))));
const nodeHash = (left: string, right: string) => bytesToHex(sha256(concatBytes(new Uint8Array([1]), hexToBytes(left), hexToBytes(right))));

/**
 * A record from GET /v1/exchange/escrow/{escrow_id}/attestations: { leaf_index, data_hash, merkle_root, proof, schema_id,
 * payload }. The payload's leaf hash must be data_hash, and folding the proof must give merkle_root. A2A-SE attestations
 * are not signed; the anchor is the Merkle root of the exchange's append-only log, which the reader should compare with
 * the root the exchange publishes.
 */
export const a2aSeImporter: RailAttestationImporter = {
  rail: "a2a-se",
  schemes: [A2A_SE_RELEASE_SCHEME, A2A_SE_REFUND_SCHEME],
  verify({ scheme, record }) {
    const { payload, data_hash, merkle_root, proof, schema_id } = record;
    if (schema_id !== scheme) return refuse("malformed", `schema_id ${String(schema_id)} is not the declared scheme ${scheme}`);
    if (!isObject(payload) || !isObject(payload.header) || payload.header.schema_id !== scheme) return refuse("malformed", "payload.header.schema_id must be the declared scheme");
    if (!isHex64(data_hash) || !isHex64(merkle_root) || !Array.isArray(proof)) return refuse("malformed", "data_hash, merkle_root and proof are required");

    let canonical: string;
    try {
      canonical = pythonCanonicalJson(payload);
    } catch (error) {
      return refuse("malformed", (error as Error).message);
    }
    if (leafHash(canonical) !== data_hash) return refuse("data_hash_mismatch", "the payload does not hash to data_hash");
    let computed = data_hash;
    for (const step of proof) {
      if (!isObject(step) || !isHex64(step.sibling_hash) || (step.side !== "left" && step.side !== "right")) return refuse("malformed", "each proof step needs sibling_hash and side");
      computed = step.side === "left" ? nodeHash(step.sibling_hash, computed) : nodeHash(computed, step.sibling_hash);
    }
    if (computed !== merkle_root) return refuse("merkle_proof_invalid", "the proof does not lead from data_hash to merkle_root");

    const settlement = payload.settlement;
    const amount = scheme === A2A_SE_RELEASE_SCHEME ? payload.amount_paid : payload.amount_returned;
    if (!isObject(settlement) || typeof settlement.escrow_id !== "string" || !isCurrency(settlement.currency) || !isAmount(amount)) {
      return refuse("malformed", "settlement.escrow_id, settlement.currency and the amount are required");
    }
    return {
      ok: true,
      rail: "a2a-se",
      anchor: `A2A-SE log leaf ${String(record.leaf_index)} under Merkle root ${merkle_root} (unsigned; compare the root with the one the exchange publishes)`,
      facts: {
        type: scheme === A2A_SE_RELEASE_SCHEME ? "payment_reported" : "refund",
        amount_minor: amount,
        currency: settlement.currency,
        rail_ref: settlement.escrow_id,
        job_ref: typeof settlement.task_id === "string" ? settlement.task_id : null,
        occurred_at: typeof settlement.occurred_at === "string" ? settlement.occurred_at : null,
      },
    };
  },
};

// ---------- x402 exact (EVM) payments ----------

export const X402_EXACT_EVM_SCHEME = "x402:exact-evm:v2";

/** USD stablecoins, by CAIP-2 network and token address (lowercase). ATCN records them as USD cents at 1:1. */
export const X402_USD_ASSETS: Record<string, { name: string; decimals: number }> = {
  "eip155:84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e": { name: "USDC", decimals: 6 },
  "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USDC", decimals: 6 },
};

const keccakText = (text: string) => keccak_256(utf8ToBytes(text));
const word = (value: bigint) => hexToBytes(value.toString(16).padStart(64, "0"));
const addressWord = (address: string) => word(BigInt(address));
const TRANSFER_TYPEHASH = keccakText("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
const DOMAIN_TYPEHASH = keccakText("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** The EIP-712 digest a payer signs for an EIP-3009 transferWithAuthorization (the x402 "exact" EVM scheme). */
export function eip3009Digest(authorization: X402Authorization, domain: { name: string; version: string; chainId: bigint; verifyingContract: string }): Uint8Array {
  const domainSeparator = keccak_256(concatBytes(DOMAIN_TYPEHASH, keccakText(domain.name), keccakText(domain.version), word(domain.chainId), addressWord(domain.verifyingContract)));
  const structHash = keccak_256(
    concatBytes(
      TRANSFER_TYPEHASH,
      addressWord(authorization.from),
      addressWord(authorization.to),
      word(BigInt(authorization.value)),
      word(BigInt(authorization.validAfter)),
      word(BigInt(authorization.validBefore)),
      hexToBytes(authorization.nonce.slice(2)),
    ),
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
}

/** The address that made a 65-byte (r, s, v) secp256k1 signature over a digest. */
export function recoverAddress(digest: Uint8Array, signature: string): string {
  const bytes = hexToBytes(signature.slice(2));
  const v = bytes[64];
  const point = secp256k1.Signature.fromCompact(bytes.slice(0, 64))
    .addRecoveryBit(v >= 27 ? v - 27 : v)
    .recoverPublicKey(digest);
  return `0x${bytesToHex(keccak_256(point.toRawBytes(false).slice(1)).slice(-20))}`;
}

/**
 * A settled x402 payment: { requirements, payload, settlement } as the client and facilitator exchanged them. The payer's
 * EIP-3009 authorization signature must recover its `from` address and authorize exactly the required amount to payTo.
 * The facilitator's settlement response supplies success and the transaction hash; on-chain inclusion is not checked
 * offline.
 */
export const x402Importer: RailAttestationImporter = {
  rail: "x402",
  schemes: [X402_EXACT_EVM_SCHEME],
  verify({ record }) {
    const { requirements, payload, settlement } = record;
    if (!isObject(requirements) || !isObject(payload) || !isObject(settlement) || !isObject(payload.authorization) || typeof payload.signature !== "string") {
      return refuse("malformed", "requirements, payload.authorization, payload.signature and settlement are required");
    }
    const authorization = payload.authorization as unknown as X402Authorization;
    const extra = isObject(requirements.extra) ? requirements.extra : {};
    const network = String(requirements.network);
    const chain = /^eip155:(\d+)$/.exec(network);
    const hexFields = [authorization.from, authorization.to, String(requirements.asset), String(requirements.payTo)];
    if (requirements.scheme !== "exact" || !chain || typeof extra.name !== "string" || typeof extra.version !== "string" || !hexFields.every((f) => /^0x[0-9a-fA-F]{40}$/.test(f))) {
      return refuse("malformed", "requirements must be the exact scheme on an eip155 network, with extra.name, extra.version and EVM addresses");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce) || !/^0x[0-9a-fA-F]{130}$/.test(payload.signature)) return refuse("malformed", "nonce must be 32 bytes and signature 65 bytes, hex");
    if (authorization.to.toLowerCase() !== String(requirements.payTo).toLowerCase() || authorization.value !== String(requirements.amount)) {
      return refuse("malformed", "the authorization must pay exactly the required amount to payTo");
    }
    let signer: string;
    try {
      signer = recoverAddress(eip3009Digest(authorization, { name: extra.name, version: extra.version, chainId: BigInt(chain[1]), verifyingContract: String(requirements.asset) }), payload.signature);
    } catch {
      return refuse("signature_invalid", "the authorization signature cannot be recovered");
    }
    if (signer !== authorization.from.toLowerCase()) return refuse("signature_invalid", `the authorization was signed by ${signer}, not the payer ${authorization.from}`);
    if (settlement.success !== true || typeof settlement.transaction !== "string" || settlement.transaction === "" || settlement.network !== network) {
      return refuse("settlement_not_successful", "the facilitator did not report a successful settlement on the required network");
    }
    const asset = X402_USD_ASSETS[`${network}:${String(requirements.asset)}`.toLowerCase()];
    const perCent = asset ? 10n ** BigInt(asset.decimals - 2) : 0n;
    if (!asset || BigInt(authorization.value) % perCent !== 0n) return refuse("unsupported_asset", `no whole-cent USD conversion for ${String(requirements.asset)} on ${network}`);
    return {
      ok: true,
      rail: "x402",
      anchor: `payer ${authorization.from} signed the EIP-3009 authorization; transaction ${settlement.transaction} as reported by the facilitator (on-chain inclusion not checked offline)`,
      facts: { type: "payment_reported", amount_minor: Number(BigInt(authorization.value) / perCent), currency: "USD", rail_ref: settlement.transaction, job_ref: authorization.nonce, occurred_at: null },
    };
  },
};

// ---------- Registry, consistency and the closure report ----------

export const RAIL_IMPORTERS: readonly RailAttestationImporter[] = [a2aSeImporter, x402Importer];

export function verifyRailAttestation(attestation: RailAttestation, importers: readonly RailAttestationImporter[] = RAIL_IMPORTERS): RailVerification {
  const importer = importers.find((i) => i.schemes.includes(attestation.scheme));
  return importer ? importer.verify(attestation) : refuse("unsupported_scheme", `no importer for scheme ${attestation.scheme}`);
}

/** Why a financial event's rail attestation does not support it, or null when it verifies and agrees with the event. */
export function railAttestationProblem(event: Pick<FinancialEventRecord, "type" | "amount_minor" | "currency" | "provider_reference" | "rail_attestation">): { code: string; detail: string } | null {
  if (!event.rail_attestation) return null;
  const result = verifyRailAttestation(event.rail_attestation);
  if (!result.ok) return { code: result.code, detail: result.detail };
  const { facts } = result;
  const mismatches = [
    facts.type !== event.type ? `type ${event.type} (the rail recorded ${facts.type})` : null,
    facts.amount_minor !== event.amount_minor ? `amount ${event.amount_minor} (the rail recorded ${facts.amount_minor})` : null,
    facts.currency !== event.currency ? `currency ${event.currency} (the rail recorded ${facts.currency})` : null,
    facts.rail_ref !== event.provider_reference ? `provider_reference ${String(event.provider_reference)} (the rail recorded ${facts.rail_ref})` : null,
  ].filter((m) => m !== null);
  return mismatches.length > 0 ? { code: "attestation_mismatch", detail: `the event does not match its rail attestation: ${mismatches.join("; ")}` } : null;
}

export interface RailAttestationEntry {
  financial_event_id: string;
  scheme: string;
  rail: string;
  rail_ref: string;
  anchor: string;
  assurance: ["rail_attested"];
}

/** The closure's rail_attestations: one entry per event whose embedded attestation verifies and agrees with it; null when none carry one. */
export function buildRailAttestationReport(events: { record: FinancialEventRecord }[]): RailAttestationEntry[] | null {
  const attested = events.filter((e) => e.record.rail_attestation);
  if (attested.length === 0) return null;
  return attested.flatMap(({ record }) => {
    const result = verifyRailAttestation(record.rail_attestation!);
    if (!result.ok || railAttestationProblem(record) !== null) return [];
    return [{ financial_event_id: record.financial_event_id, scheme: record.rail_attestation!.scheme, rail: result.rail, rail_ref: result.facts.rail_ref, anchor: result.anchor, assurance: ["rail_attested"] as ["rail_attested"] }];
  });
}

/**
 * Buyer side: the financial event body for a rail record, after verifying it. Throws RailAttestationError with the
 * refusal code when it does not verify. Matching uses the job reference the rail recorded unless `match` is given.
 */
export function financialEventFromRailAttestation(
  attestation: RailAttestation,
  options: { source: string; match?: Record<string, string>; eventDate?: string },
): Record<string, unknown> {
  const result = verifyRailAttestation(attestation);
  if (!result.ok) throw new RailAttestationError(result.code, result.detail);
  const { facts } = result;
  const eventDate = facts.occurred_at ?? options.eventDate;
  if (!eventDate) throw new RailAttestationError("malformed", "the rail recorded no time; pass eventDate");
  return {
    type: facts.type,
    source: options.source,
    source_event_id: `${attestation.scheme}:${facts.rail_ref}`,
    provider_reference: facts.rail_ref,
    amount_minor: facts.amount_minor,
    currency: facts.currency,
    event_date: eventDate,
    normalized_status: facts.type === "refund" ? "refunded" : "reported_paid",
    match: options.match ?? (facts.job_ref ? { provider_job_ref: facts.job_ref } : {}),
    rail_attestation: attestation,
  };
}

export class RailAttestationError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}
