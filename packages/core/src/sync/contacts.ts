/**
 * Encrypted contacts sync blob (spec §6.3.4, §12). The relay stores opaque ciphertext under the identity;
 * only devices that hold the sync key can read contacts.
 */
import { concat, fromB64url, toB64url } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getArray, getBytes, getText, getUint } from "../cbor";
import { aesGcmOpen, aesGcmSeal, hkdf, randomBytes, sha256 } from "../crypto/primitives";

export interface ContactRecord {
  fingerprint: Uint8Array;
  displayName: string;
  pairedAt: number;
}

export interface SyncBlob {
  version: number;
  contacts: ContactRecord[];
  updatedAt: number;
}

/** Derive a 32-byte sync key from identity seed material. */
export function deriveSyncKey(identitySeed: Uint8Array): Uint8Array {
  return hkdf(identitySeed, new TextEncoder().encode("sealed"), new TextEncoder().encode("sealed/v1/sync-key"), 32);
}

function encodeBlob(blob: SyncBlob): Uint8Array {
  return encodeCbor({
    1: blob.version,
    2: blob.contacts.map((c) => ({ 1: c.fingerprint, 2: c.displayName, 3: c.pairedAt })),
    3: blob.updatedAt,
  });
}

function decodeBlob(bytes: Uint8Array): SyncBlob {
  const m = asMap(decodeCbor(bytes), "sync blob");
  const contacts = getArray(m, 2, "contacts").map((raw) => {
    const c = asMap(raw, "contact");
    return { fingerprint: getBytes(c, 1, "fingerprint", 32), displayName: getText(c, 2, "displayName"), pairedAt: getUint(c, 3, "pairedAt") };
  });
  return { version: getUint(m, 1, "version"), contacts, updatedAt: getUint(m, 3, "updatedAt") };
}

const AAD = new TextEncoder().encode("sealed/v1/sync");

/** Seal a sync blob: nonce (12) || ciphertext. */
export async function sealSyncBlob(key: Uint8Array, blob: SyncBlob): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const ct = await aesGcmSeal(key, nonce, encodeBlob(blob), AAD);
  return concat(nonce, ct);
}

export async function openSyncBlob(key: Uint8Array, sealed: Uint8Array): Promise<SyncBlob> {
  if (sealed.length < 12 + 16) throw new Error("truncated sync blob");
  const nonce = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  const plain = await aesGcmOpen(key, nonce, ct, AAD);
  return decodeBlob(plain);
}

/** Sync key from fingerprint + device secret material. */
export function syncKeyFromFingerprint(fingerprint: Uint8Array, deviceSecret: Uint8Array): Uint8Array {
  return deriveSyncKey(sha256(concat(fingerprint, deviceSecret)));
}

export function syncBlobToB64(sealed: Uint8Array): string {
  return toB64url(sealed);
}

export function syncBlobFromB64(s: string): Uint8Array {
  return fromB64url(s);
}
