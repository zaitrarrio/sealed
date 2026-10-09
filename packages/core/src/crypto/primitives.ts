import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { randomBytes as nobleRandom } from "@noble/hashes/utils.js";

/** SHA-256. */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return extract(nobleSha256, ikm, salt);
}

export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return expand(nobleSha256, prk, info, length);
}

/** HKDF-SHA256 (RFC 5869). */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}

/** Cryptographically secure random bytes from the platform CSPRNG. */
export function randomBytes(n: number): Uint8Array {
  if (n <= 65536) return nobleRandom(n);
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) out.set(nobleRandom(Math.min(65536, n - off)), off);
  return out;
}

export class AuthenticationError extends Error {
  constructor(message = "authentication failed") {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** AES-GCM encryption (pure JS); key length selects AES-128 or AES-256. Returns ciphertext || 16-byte tag. */
export function aesGcmSealSync(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  return gcm(key, nonce, aad).encrypt(plaintext);
}

/** AES-GCM decryption (pure JS); throws AuthenticationError on any tag or length failure. */
export function aesGcmOpenSync(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Uint8Array {
  try {
    return gcm(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new AuthenticationError();
  }
}

type Subtle = {
  importKey(format: "raw", key: Uint8Array, algorithm: "AES-GCM", extractable: false, usages: string[]): Promise<unknown>;
  encrypt(alg: { name: "AES-GCM"; iv: Uint8Array; additionalData?: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: { name: "AES-GCM"; iv: Uint8Array; additionalData?: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
};

let subtleOverride: Subtle | null | undefined;

/** Platform WebCrypto (browsers, Workers, Node, react-native-quick-crypto), or null to use the JS fallback. */
function subtle(): Subtle | null {
  if (subtleOverride !== undefined) return subtleOverride;
  const s = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  return s && typeof s.encrypt === "function" ? s : null;
}

/** Forces (null) or restores (undefined) the WebCrypto path; used by tests to exercise both backends. */
export function setSubtleForTesting(s: Subtle | null | undefined): void {
  subtleOverride = s;
}

/** AES-GCM seal using platform WebCrypto when available (≈30x faster than pure JS for large segments). */
export async function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (!s || plaintext.length < 4096) return aesGcmSealSync(key, nonce, plaintext, aad);
  const k = await s.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: nonce, ...(aad ? { additionalData: aad } : {}) }, k, plaintext));
}

export async function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (!s || ciphertext.length < 4096) return aesGcmOpenSync(key, nonce, ciphertext, aad);
  const k = await s.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(await s.decrypt({ name: "AES-GCM", iv: nonce, ...(aad ? { additionalData: aad } : {}) }, k, ciphertext));
  } catch {
    throw new AuthenticationError();
  }
}

export const P256 = {
  /** Uncompressed SEC1 public key length. */
  publicKeyLength: 65,
  compressedLength: 33,
  secretKeyLength: 32,
  order: p256.Point.Fn.ORDER,

  randomSecretKey(): Uint8Array {
    return p256.utils.randomSecretKey();
  },

  publicKey(secret: Uint8Array, compressed = false): Uint8Array {
    return p256.getPublicKey(secret, compressed);
  },

  /** Validates and converts any SEC1 encoding to the requested form. Throws on invalid points. */
  normalizePublicKey(pub: Uint8Array, compressed = false): Uint8Array {
    return p256.Point.fromBytes(pub).toBytes(compressed);
  },

  isValidPublicKey(pub: Uint8Array): boolean {
    try {
      p256.Point.fromBytes(pub).assertValidity();
      return true;
    } catch {
      return false;
    }
  },

  /** ECDH: returns the 32-byte x-coordinate of secret·peer, as DHKEM(P-256) requires. */
  dh(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
    return p256.getSharedSecret(secret, peerPublic, true).slice(1);
  },

  isValidSecretKey(secret: Uint8Array): boolean {
    return p256.utils.isValidSecretKey(secret);
  },

  /** ECDSA-SHA256 over `message`, deterministic (RFC 6979), low-S, 64-byte r||s. */
  sign(secret: Uint8Array, message: Uint8Array): Uint8Array {
    return p256.sign(message, secret, { lowS: true });
  },

  /** Verifies a 64-byte r||s low-S signature of ECDSA-SHA256 over `message`. */
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    try {
      return p256.verify(signature, message, publicKey, { lowS: true });
    } catch {
      return false;
    }
  },

  /** Normalizes a 64-byte r||s signature to low-S form (WebCrypto and some keystores emit high-S). */
  toLowS(signature: Uint8Array): Uint8Array {
    const sig = p256.Signature.fromBytes(signature, "compact");
    const n = p256.Point.Fn.ORDER;
    if (sig.s > n >> 1n) return new p256.Signature(sig.r, n - sig.s).toBytes("compact");
    return signature;
  },

  /** Converts an ASN.1 DER ECDSA signature to 64-byte r||s. */
  derToCompact(der: Uint8Array): Uint8Array {
    return p256.Signature.fromBytes(der, "der").toBytes("compact");
  },
};
