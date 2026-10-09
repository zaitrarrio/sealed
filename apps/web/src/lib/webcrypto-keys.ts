/**
 * Device keys backed by WebCrypto (spec §5.2, ADR-0005, web column): non-extractable P-256 keys whose
 * CryptoKey handles persist in IndexedDB. Script on this origin can use them but cannot read them out.
 *
 *   - Agreement (DAK): ECDH, `deriveBits(256)` yields exactly the 32-byte x-coordinate DHKEM(P-256) needs.
 *   - Signing (DSK): ECDSA-SHA256; WebCrypto returns IEEE P1363 r||s (64 bytes), normalized here to low-S.
 */
import { P256, type AgreementKey, type DeviceKeys, type KeyProtection, type SigningKey } from "@sealed/core";
import { buf } from "./bytes";

const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

export class WebCryptoAgreementKey implements AgreementKey {
  readonly protection: KeyProtection = "browser";

  constructor(
    readonly privateKey: CryptoKey,
    readonly publicKey: Uint8Array,
  ) {
    if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("agreement public key must be uncompressed SEC1");
  }

  async dh(peerPublicKey: Uint8Array): Promise<Uint8Array> {
    // WebCrypto only imports uncompressed points in every engine; normalize (and validate) first.
    const peer = P256.normalizePublicKey(peerPublicKey, false);
    const pub = await crypto.subtle.importKey("raw", buf(peer), EC, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, this.privateKey, 256);
    return new Uint8Array(bits);
  }
}

export class WebCryptoSigningKey implements SigningKey {
  readonly protection: KeyProtection = "browser";

  constructor(
    readonly privateKey: CryptoKey,
    readonly publicKey: Uint8Array,
  ) {
    if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("signing public key must be uncompressed SEC1");
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, buf(message)));
    if (sig.length !== 64) throw new Error(`unexpected ECDSA signature length ${sig.length}`);
    return P256.toLowS(sig);
  }
}

/** The persisted form: CryptoKey handles are structured-cloneable into IndexedDB; private halves stay sealed. */
export interface StoredDeviceKeys {
  agreementPrivate: CryptoKey;
  agreementPublic: Uint8Array;
  signingPrivate: CryptoKey;
  signingPublic: Uint8Array;
  createdAt: number;
}

export interface WebDeviceKeys extends DeviceKeys {
  readonly agreement: WebCryptoAgreementKey;
  readonly signing: WebCryptoSigningKey;
}

export async function generateStoredDeviceKeys(): Promise<StoredDeviceKeys> {
  const agreement = await crypto.subtle.generateKey(EC, false, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"]);
  const agreementPublic = new Uint8Array(await crypto.subtle.exportKey("raw", agreement.publicKey));
  const signingPublic = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));
  if (agreement.privateKey.extractable || signing.privateKey.extractable) throw new Error("device private keys must be non-extractable");
  return { agreementPrivate: agreement.privateKey, agreementPublic, signingPrivate: signing.privateKey, signingPublic, createdAt: Date.now() };
}

export function deviceKeysFromStored(s: StoredDeviceKeys): WebDeviceKeys {
  return {
    agreement: new WebCryptoAgreementKey(s.agreementPrivate, new Uint8Array(s.agreementPublic)),
    signing: new WebCryptoSigningKey(s.signingPrivate, new Uint8Array(s.signingPublic)),
  };
}
