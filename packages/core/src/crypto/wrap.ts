/**
 * Content-key wraps (spec §5.4): HPKE encapsulations of the 32-byte CEK to one recipient public key,
 * serialized as deterministic CBOR {1: kem, 2: kdf, 3: aead, 4: enc, 5: ct, 6: recipient_key_id}.
 */
import { concat, ctEqual, utf8 } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getBytes, getUint } from "../cbor";
import { AEAD_AES256_GCM, KDF_HKDF_SHA256, KEM_P256_SHA256, open, seal } from "./hpke";
import { keyId } from "./keyid";
import type { AgreementKey } from "./keys";

export type WrapContext =
  | { kind: "direct"; transferId: Uint8Array }
  | { kind: "paired"; transferId: Uint8Array; prekeyId: Uint8Array }
  | { kind: "airgap"; streamId: Uint8Array }
  | { kind: "local"; fileId: Uint8Array };

export function wrapInfo(ctx: WrapContext): Uint8Array {
  switch (ctx.kind) {
    case "direct":
      return concat(utf8("sealed/v1/wrap"), ctx.transferId);
    case "paired":
      return concat(utf8("sealed/v1/paired"), ctx.transferId, ctx.prekeyId);
    case "airgap":
      return concat(utf8("sealed/v1/airgap"), ctx.streamId);
    case "local":
      return concat(utf8("sealed/v1/local"), ctx.fileId);
  }
}

export interface Wrap {
  enc: Uint8Array;
  ciphertext: Uint8Array;
  recipientKeyId: Uint8Array;
}

export function encodeWrap(w: Wrap): Uint8Array {
  return encodeCbor({ 1: KEM_P256_SHA256, 2: KDF_HKDF_SHA256, 3: AEAD_AES256_GCM, 4: w.enc, 5: w.ciphertext, 6: w.recipientKeyId });
}

export function decodeWrap(b: Uint8Array): Wrap {
  const m = asMap(decodeCbor(b), "wrap");
  if (getUint(m, 1, "wrap") !== KEM_P256_SHA256 || getUint(m, 2, "wrap") !== KDF_HKDF_SHA256 || getUint(m, 3, "wrap") !== AEAD_AES256_GCM) {
    throw new Error("wrap: unsupported HPKE suite");
  }
  return { enc: getBytes(m, 4, "wrap", 65), ciphertext: getBytes(m, 5, "wrap", 48), recipientKeyId: getBytes(m, 6, "wrap", 8) };
}

/** Wraps a CEK to `recipientPublicKey`. With `senderKey`, HPKE Auth mode binds the sender's identity. */
export async function wrapKey(cek: Uint8Array, recipientPublicKey: Uint8Array, ctx: WrapContext, senderKey?: AgreementKey): Promise<Uint8Array> {
  if (cek.length !== 32) throw new Error("CEK must be 32 bytes");
  const { enc, ciphertext } = await seal({
    recipientPublicKey,
    info: wrapInfo(ctx),
    plaintext: cek,
    ...(senderKey ? { senderKey } : {}),
  });
  return encodeWrap({ enc, ciphertext, recipientKeyId: keyId(recipientPublicKey) });
}

/** Unwraps a CEK. Pass `senderPublicKey` to require HPKE Auth mode from that sender. */
export async function unwrapKey(wrapBytes: Uint8Array, recipientKey: AgreementKey, ctx: WrapContext, senderPublicKey?: Uint8Array): Promise<Uint8Array> {
  const w = decodeWrap(wrapBytes);
  if (!ctEqual(w.recipientKeyId, keyId(recipientKey.publicKey))) throw new Error("wrap is addressed to a different key");
  return open({
    recipientKey,
    enc: w.enc,
    info: wrapInfo(ctx),
    ciphertext: w.ciphertext,
    ...(senderPublicKey ? { senderPublicKey } : {}),
  });
}
