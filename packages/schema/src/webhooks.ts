import { signBytes, verifyBytes } from "./crypto.js";
import { utf8Encode } from "./encoding.js";

/**
 * Webhook signature header (IN-6):
 *   ATCN-Signature: t=<unix seconds>,key_id=<key id>,key_version=<n>,sig=<base64url Ed25519 over "<t>.<raw body>">
 */
export const WEBHOOK_SIGNATURE_HEADER = "atcn-signature";

export function signWebhook(
  body: string,
  key: { keyId: string; keyVersion: number; privateKey: string },
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const sig = signBytes(utf8Encode(`${timestampSeconds}.${body}`), key.privateKey);
  return `t=${timestampSeconds},key_id=${key.keyId},key_version=${key.keyVersion},sig=${sig}`;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
  keyId?: string;
  keyVersion?: number;
}

export function parseWebhookHeader(header: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const item of header.split(",")) {
    const index = item.indexOf("=");
    if (index > 0) parts[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return parts;
}

export function verifyWebhook(
  body: string,
  header: string,
  publicKey: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): WebhookVerification {
  const parts = parseWebhookHeader(header);
  const timestamp = Number(parts.t);
  if (!parts.t || !parts.sig || !Number.isInteger(timestamp)) return { valid: false, reason: "malformed_header" };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: "timestamp_outside_tolerance" };
  const valid = verifyBytes(utf8Encode(`${timestamp}.${body}`), parts.sig, publicKey);
  return valid
    ? { valid: true, keyId: parts.key_id, keyVersion: Number(parts.key_version) }
    : { valid: false, reason: "bad_signature" };
}
