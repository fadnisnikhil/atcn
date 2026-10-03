import { createHash, randomBytes } from "node:crypto";

/**
 * The x402 v2 HTTP wire format (github.com/x402-foundation/x402, specs/x402-specification-v2.md and
 * specs/transports-v2/http.md): the three headers carry base64-encoded JSON.
 */
export const PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2 network, e.g. eip155:84532 (Base Sepolia). */
  network: string;
  /** Atomic token units. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** EIP-3009 transferWithAuthorization parameters used by the `exact` EVM scheme. */
export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: ExactEvmAuthorization };
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** Empty when nothing was broadcast. */
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

/** Everything one paid request produced, as the buyer saw it. */
export interface X402Purchase {
  required: PaymentRequired;
  accepted: PaymentRequirements;
  payment: PaymentPayload;
  status: number;
  body: string;
  settlement: SettlementResponse;
}

/**
 * Requests a resource, pays the `exact` requirement it answers 402 with, and retries with the payment.
 *
 * The signature is simulated: a real client signs the EIP-3009 authorization (EIP-712) with the payer's wallet, for
 * example with the x402 reference SDK. Everything ATCN records comes from the decoded headers, which are the same
 * either way.
 */
export async function buyWithX402(url: string, payerAddress: string): Promise<X402Purchase> {
  const first = await fetch(url);
  const requiredHeader = first.headers.get(PAYMENT_REQUIRED);
  if (first.status !== 402 || !requiredHeader) throw new Error(`${url} answered ${first.status} without ${PAYMENT_REQUIRED}`);
  const required = decodeHeader<PaymentRequired>(requiredHeader);
  const accepted = required.accepts.find((a) => a.scheme === "exact");
  if (!accepted) throw new Error(`${url} offers no exact payment scheme`);

  const now = Math.floor(Date.now() / 1000);
  const authorization: ExactEvmAuthorization = {
    from: payerAddress,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + accepted.maxTimeoutSeconds),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  };
  const signature = `0x${createHash("sha256").update(JSON.stringify(authorization)).digest("hex")}`;
  const payment: PaymentPayload = { x402Version: 2, resource: required.resource, accepted, payload: { signature, authorization } };

  const second = await fetch(url, { headers: { [PAYMENT_SIGNATURE]: encodeHeader(payment) } });
  const responseHeader = second.headers.get(PAYMENT_RESPONSE);
  if (!responseHeader) throw new Error(`${url} answered ${second.status} without ${PAYMENT_RESPONSE}`);
  return { required, accepted, payment, status: second.status, body: await second.text(), settlement: decodeHeader<SettlementResponse>(responseHeader) };
}
