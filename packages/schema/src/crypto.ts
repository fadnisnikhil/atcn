import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { canonicalize } from "./canonical.js";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, utf8Encode } from "./encoding.js";

export const SIGNATURE_ALGORITHM = "Ed25519" as const;

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface SignatureRef {
  key_id: string;
  key_version: number;
  algorithm: typeof SIGNATURE_ALGORITHM;
  value: string;
}

export interface Signed<T> {
  payload: T;
  signature: SignatureRef;
}

export function generateKeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey: bytesToBase64Url(publicKey), privateKey: bytesToBase64Url(privateKey) };
}

export function publicKeyFromPrivate(privateKey: string): string {
  return bytesToBase64Url(ed25519.getPublicKey(base64UrlToBytes(privateKey)));
}

export function sha256Digest(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  return "sha256:" + bytesToHex(sha256(bytes));
}

/** Digest of the canonical JSON form of a value. */
export function digestOf(value: unknown): string {
  return sha256Digest(canonicalize(value));
}

export function signBytes(bytes: Uint8Array, privateKey: string): string {
  return bytesToBase64Url(ed25519.sign(bytes, base64UrlToBytes(privateKey)));
}

export function verifyBytes(bytes: Uint8Array, signature: string, publicKey: string): boolean {
  try {
    return ed25519.verify(base64UrlToBytes(signature), bytes, base64UrlToBytes(publicKey));
  } catch {
    return false;
  }
}

export function signPayload<T>(
  payload: T,
  key: { keyId: string; keyVersion: number; privateKey: string },
): Signed<T> {
  const value = signBytes(utf8Encode(canonicalize(payload)), key.privateKey);
  return {
    payload,
    signature: { key_id: key.keyId, key_version: key.keyVersion, algorithm: SIGNATURE_ALGORITHM, value },
  };
}

export function verifyPayload<T>(signed: Signed<T>, publicKey: string): boolean {
  if (signed.signature.algorithm !== SIGNATURE_ALGORITHM) return false;
  return verifyBytes(utf8Encode(canonicalize(signed.payload)), signed.signature.value, publicKey);
}
