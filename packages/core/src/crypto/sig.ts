import { concat, utf8 } from "../bytes";
import { encodeCbor, type CborValue } from "../cbor";
import { P256 } from "./primitives";
import type { SigningKey } from "./keys";

/** Domain-separated signature types (spec §5.5). */
export type SignatureType = "manifest" | "link" | "prekey" | "signal" | "broadcast" | "request" | "approval" | "mailbox" | "contact";

/** The exact bytes ECDSA-SHA256 is computed over: "sealed/v1/sig/" ∥ type ∥ 0x00 ∥ canonical CBOR. */
export function signingInput(type: SignatureType, object: CborValue): Uint8Array {
  return concat(utf8(`sealed/v1/sig/${type}`), new Uint8Array([0]), encodeCbor(object));
}

export async function signObject(key: SigningKey, type: SignatureType, object: CborValue): Promise<Uint8Array> {
  return P256.toLowS(await key.sign(signingInput(type, object)));
}

export function verifyObject(publicKey: Uint8Array, type: SignatureType, object: CborValue, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  return P256.verify(signature, signingInput(type, object), publicKey);
}

export function signRaw(key: SigningKey, message: Uint8Array): Promise<Uint8Array> {
  return key.sign(message).then((s) => P256.toLowS(s));
}

export function verifyRaw(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return signature.length === 64 && P256.verify(signature, message, publicKey);
}
