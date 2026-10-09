import { P256, randomBytes } from "./primitives";

/** Where a private key lives; reported to peers so senders can see "hardware-protected" vs "browser key". */
export type KeyProtection = "secure-enclave" | "strongbox" | "tee" | "browser" | "software";

export const HARDWARE_PROTECTIONS: readonly KeyProtection[] = ["secure-enclave", "strongbox", "tee"];

/**
 * A P-256 key-agreement key whose private half may be non-exportable (Secure Enclave, Android Keystore,
 * WebCrypto). Sealed never needs the private bytes: HPKE only needs the Diffie-Hellman output.
 */
export interface AgreementKey {
  /** Uncompressed SEC1 public key, 65 bytes. */
  readonly publicKey: Uint8Array;
  readonly protection: KeyProtection;
  /** Returns the 32-byte x-coordinate of private·peer. May prompt for biometrics on hardware keys. */
  dh(peerPublicKey: Uint8Array): Promise<Uint8Array>;
}

/** A P-256 ECDSA key; `sign` computes ECDSA-SHA256 over the message and returns low-S 64-byte r||s. */
export interface SigningKey {
  readonly publicKey: Uint8Array;
  readonly protection: KeyProtection;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** Software key with exportable secret; used for ephemeral keys, prekeys (wrapped at rest) and tests. */
export class SoftwareAgreementKey implements AgreementKey {
  readonly publicKey: Uint8Array;
  readonly protection: KeyProtection = "software";

  constructor(readonly secretKey: Uint8Array = P256.randomSecretKey()) {
    if (!P256.isValidSecretKey(secretKey)) throw new Error("invalid P-256 secret key");
    this.publicKey = P256.publicKey(secretKey, false);
  }

  async dh(peerPublicKey: Uint8Array): Promise<Uint8Array> {
    return P256.dh(this.secretKey, peerPublicKey);
  }

  dhSync(peerPublicKey: Uint8Array): Uint8Array {
    return P256.dh(this.secretKey, peerPublicKey);
  }
}

export class SoftwareSigningKey implements SigningKey {
  readonly publicKey: Uint8Array;
  readonly protection: KeyProtection = "software";

  constructor(readonly secretKey: Uint8Array = P256.randomSecretKey()) {
    if (!P256.isValidSecretKey(secretKey)) throw new Error("invalid P-256 secret key");
    this.publicKey = P256.publicKey(secretKey, false);
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return P256.sign(this.secretKey, message);
  }
}

/** The pair of hardware-bound keys every installation holds (spec §5.2). */
export interface DeviceKeys {
  readonly agreement: AgreementKey;
  readonly signing: SigningKey;
}

/** 8-byte key identifier: first 8 bytes of SHA-256 over the compressed public key (spec §5.4). */
export { keyId } from "./keyid";

export function randomId(bytes = 16): Uint8Array {
  return randomBytes(bytes);
}
