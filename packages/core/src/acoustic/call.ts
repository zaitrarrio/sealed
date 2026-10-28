/**
 * Paired call crypto (ADR-0013 extension). DTLS-SRTP encrypts the hop; this layer wraps a 32-byte call key
 * with HPKE Auth to the pinned peer and encrypts each encoded media frame under AES-256-GCM so a broken
 * WebRTC hop cannot expose the call. Platforms that cannot encrypt encoded frames MUST refuse the call.
 */
import { concat, utf8 } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getBytes } from "../cbor";
import { aesGcmOpenSync, aesGcmSealSync, randomBytes } from "../crypto/primitives";
import type { AgreementKey } from "../crypto/keys";
import { unwrapKey, wrapKey } from "../crypto/wrap";

export const CALL_KEY_BYTES = 32;
export const CALL_NONCE_BYTES = 12;

/** Generates a fresh call key and an HPKE Auth wrap for the peer. */
export async function createCallKeyMaterial(
  sessionId: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderKey: AgreementKey,
): Promise<{ callKey: Uint8Array; wrap: Uint8Array }> {
  if (sessionId.length !== 16) throw new RangeError("call sessionId must be 16 bytes");
  const callKey = randomBytes(CALL_KEY_BYTES);
  const wrap = await wrapKey(callKey, recipientPublicKey, { kind: "call", sessionId }, senderKey);
  return { callKey, wrap };
}

export async function unwrapCallKey(
  wrapBytes: Uint8Array,
  recipientKey: AgreementKey,
  sessionId: Uint8Array,
  senderPublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (sessionId.length !== 16) throw new RangeError("call sessionId must be 16 bytes");
  return unwrapKey(wrapBytes, recipientKey, { kind: "call", sessionId }, senderPublicKey);
}

/** Counter-mode nonce: 4 zero bytes ∥ u64be(counter). */
export function callNonce(counter: number): Uint8Array {
  if (!Number.isInteger(counter) || counter < 0) throw new RangeError("counter must be a non-negative integer");
  const n = new Uint8Array(CALL_NONCE_BYTES);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  n[4] = (hi >>> 24) & 0xff;
  n[5] = (hi >>> 16) & 0xff;
  n[6] = (hi >>> 8) & 0xff;
  n[7] = hi & 0xff;
  n[8] = (lo >>> 24) & 0xff;
  n[9] = (lo >>> 16) & 0xff;
  n[10] = (lo >>> 8) & 0xff;
  n[11] = lo & 0xff;
  return n;
}

const CALL_AAD = utf8("sealed/v1/call-frame");

/** Encrypts one encoded media frame (e.g. Opus packet) under the call key. */
export function sealCallFrame(callKey: Uint8Array, counter: number, plaintext: Uint8Array): Uint8Array {
  return aesGcmSealSync(callKey, callNonce(counter), plaintext, CALL_AAD);
}

/** Decrypts one encoded media frame. Throws AuthenticationError on tamper. */
export function openCallFrame(callKey: Uint8Array, counter: number, ciphertext: Uint8Array): Uint8Array {
  return aesGcmOpenSync(callKey, callNonce(counter), ciphertext, CALL_AAD);
}

/** CBOR envelope for the call wrap carried in signed signaling: {1: wrap, 2: session}. */
export function encodeCallOffer(wrap: Uint8Array, sessionId: Uint8Array): Uint8Array {
  return encodeCbor({ 1: wrap, 2: sessionId });
}

export function decodeCallOffer(bytes: Uint8Array): { wrap: Uint8Array; sessionId: Uint8Array } {
  const m = asMap(decodeCbor(bytes), "call-offer");
  return { wrap: getBytes(m, 1, "call-offer"), sessionId: getBytes(m, 2, "call-offer", 16) };
}

/** Info bytes matching wrapInfo({ kind: "call", sessionId }). */
export function callInfoBytes(sessionId: Uint8Array): Uint8Array {
  return concat(utf8("sealed/v1/call"), sessionId);
}
