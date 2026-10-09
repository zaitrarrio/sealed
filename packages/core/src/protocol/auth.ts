/**
 * Device-signed requests (spec §9.2). Header:
 *   Sealed-Signature: keyid=<b64url(compressed DSK)>, fp=<b64url(identity fingerprint)>, ts=<unix>, nonce=<b64url(12)>, sig=<b64url(64)>
 * The signature (type "request") covers CBOR {1: METHOD, 2: path-with-query, 3: ts, 4: nonce, 5: SHA-256(body)}.
 * The relay looks the key up in the identity's verified chain, checks the clock window and rejects nonce reuse.
 */
import { fromB64url, toB64url } from "../bytes";
import { compress } from "../crypto/keyid";
import type { SigningKey } from "../crypto/keys";
import { randomBytes, sha256 } from "../crypto/primitives";
import { signObject, verifyObject } from "../crypto/sig";

export const SIGNATURE_HEADER = "Sealed-Signature";

export interface SignedRequestParts {
  keyId: Uint8Array; // compressed signing public key (33 bytes)
  fingerprint: Uint8Array;
  ts: number;
  nonce: Uint8Array;
  sig: Uint8Array;
}

function requestObject(method: string, pathWithQuery: string, ts: number, nonce: Uint8Array, body: Uint8Array) {
  return { 1: method.toUpperCase(), 2: pathWithQuery, 3: ts, 4: nonce, 5: sha256(body) };
}

export async function signRequest(
  key: SigningKey,
  fingerprint: Uint8Array,
  method: string,
  pathWithQuery: string,
  body: Uint8Array = new Uint8Array(0),
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const nonce = randomBytes(12);
  const sig = await signObject(key, "request", requestObject(method, pathWithQuery, now, nonce, body));
  return formatSignatureHeader({ keyId: compress(key.publicKey), fingerprint, ts: now, nonce, sig });
}

export function formatSignatureHeader(p: SignedRequestParts): string {
  return `keyid=${toB64url(p.keyId)}, fp=${toB64url(p.fingerprint)}, ts=${p.ts}, nonce=${toB64url(p.nonce)}, sig=${toB64url(p.sig)}`;
}

export function parseSignatureHeader(h: string): SignedRequestParts {
  const fields = new Map<string, string>();
  for (const part of h.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k || rest.length === 0) throw new Error("malformed signature header");
    fields.set(k, rest.join("="));
  }
  const need = (k: string) => {
    const v = fields.get(k);
    if (!v) throw new Error(`signature header missing ${k}`);
    return v;
  };
  const ts = Number(need("ts"));
  if (!Number.isSafeInteger(ts)) throw new Error("bad ts");
  const p = { keyId: fromB64url(need("keyid")), fingerprint: fromB64url(need("fp")), ts, nonce: fromB64url(need("nonce")), sig: fromB64url(need("sig")) };
  if (p.keyId.length !== 33 || p.fingerprint.length !== 32 || p.nonce.length !== 12 || p.sig.length !== 64) throw new Error("bad signature header field lengths");
  return p;
}

export function verifyRequestSignature(
  publicKey: Uint8Array,
  parts: SignedRequestParts,
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
  now = Math.floor(Date.now() / 1000),
  skewSeconds = 120,
): boolean {
  if (Math.abs(now - parts.ts) > skewSeconds) return false;
  return verifyObject(publicKey, "request", requestObject(method, pathWithQuery, parts.ts, parts.nonce, body), parts.sig);
}
