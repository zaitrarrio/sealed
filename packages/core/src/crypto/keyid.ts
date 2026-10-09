import { P256, sha256 } from "./primitives";

/** First `length` bytes of SHA-256 over the compressed SEC1 encoding of a P-256 public key. */
export function keyId(publicKey: Uint8Array, length = 8): Uint8Array {
  return sha256(P256.normalizePublicKey(publicKey, true)).slice(0, length);
}

export function compress(publicKey: Uint8Array): Uint8Array {
  return P256.normalizePublicKey(publicKey, true);
}

export function decompress(publicKey: Uint8Array): Uint8Array {
  return P256.normalizePublicKey(publicKey, false);
}
