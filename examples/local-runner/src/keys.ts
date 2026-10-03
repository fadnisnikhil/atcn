import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICE_ACTOR_ID } from "@atcn/core";
import { generateKeyPair, newId, type PublicKeyRecord } from "@atcn/schema";

/** The key the runner signs service events, closures, and closure packages with. It never leaves this machine. */
export interface ServiceKey {
  keyId: string;
  keyVersion: number;
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

/** Loads the runner's service key, creating it on first use, so documents from earlier runs keep verifying. */
export function loadOrCreateServiceKey(path: string): ServiceKey {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as ServiceKey;
  const pair = generateKeyPair();
  const key: ServiceKey = { keyId: newId("key"), keyVersion: 1, privateKey: pair.privateKey, publicKey: pair.publicKey, createdAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  return key;
}

/** The public half, in the shape verifiers take as a trusted key. */
export function servicePublicKey(key: ServiceKey): PublicKeyRecord {
  return {
    key_id: key.keyId,
    key_version: key.keyVersion,
    actor_id: SERVICE_ACTOR_ID,
    algorithm: "Ed25519",
    public_key: key.publicKey,
    valid_from: key.createdAt,
    revoked_at: null,
  };
}
