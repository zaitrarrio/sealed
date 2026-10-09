import { ctEqual, fromB64url, randomBytes, sha256, toB64url, utf8 } from "@sealed/core";

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Unix seconds rounded down to the hour (ADR-0015: timestamps in logs and metadata are hour-granular). */
export function hourFloor(t: number = nowSeconds()): number {
  return t - (t % 3600);
}

export function randomId(bytes = 16): string {
  return toB64url(randomBytes(bytes));
}

/** b64url(SHA-256(utf8(s))) — how bearer secrets are stored at rest. */
export function hashSecret(secret: string): string {
  return toB64url(sha256(utf8(secret)));
}

/** Constant-time comparison of two b64url strings that encode equal-length digests. */
export function ctEqualB64(a: string, b: string): boolean {
  try {
    return ctEqual(fromB64url(a), fromB64url(b));
  } catch {
    return false;
  }
}

/** Decodes base64url, returning null on malformed input or a length mismatch. */
export function decodeB64(s: string, length?: number): Uint8Array | null {
  try {
    const b = fromB64url(s);
    if (length !== undefined && b.length !== length) return null;
    return b;
  } catch {
    return null;
  }
}

const B64_RE = /^[A-Za-z0-9_-]+$/;

/** True when `s` is canonical unpadded base64url of exactly `bytes` bytes. */
export function isB64Id(s: string, bytes: number): boolean {
  if (!B64_RE.test(s) || s.length !== Math.ceil((bytes * 4) / 3)) return false;
  const b = decodeB64(s, bytes);
  return b !== null && toB64url(b) === s;
}

export const TRANSFER_ID_BYTES = 16;
export const CLAIM_ID_BYTES = 16;
export const FINGERPRINT_BYTES = 32;
export const DEVICE_ID_BYTES = 33;

/** WebSocket origin for event URLs: PUBLIC_URL when configured, else the request's own origin. */
export function wsOrigin(publicUrl: string | undefined, requestUrl: string): string {
  const base = publicUrl && publicUrl.length > 0 ? new URL(publicUrl).origin : new URL(requestUrl).origin;
  return base.replace(/^http/, "ws");
}
