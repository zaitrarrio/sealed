/**
 * Device keys for the native app (spec §5.2, ADR-0005): core's AgreementKey / SigningKey implemented on the
 * SealedKeystore module, so private keys stay in the Secure Enclave (iOS) or Android Keystore (StrongBox/TEE)
 * and every use is gated by Face ID, fingerprint or the device passcode.
 *
 * Without the native module (Expo Go, unit tests) the app falls back to software keys kept in
 * expo-secure-store and reports protection "software", which the relay never accepts as user verification.
 */
import * as SecureStore from "expo-secure-store";
import { P256, SoftwareAgreementKey, SoftwareSigningKey, fromB64url, toB64url, type AgreementKey, type DeviceKeys, type KeyProtection, type SigningKey } from "@sealed/core";
import { nativeKeystore, type AuthMode, type DeviceKeyRecord, type KeyPolicy, type SealedKeystoreNative } from "../../modules/sealed-keystore";
import { fromStdB64, toStdB64 } from "./b64";

export const DEVICE_ALIAS = "sealed.device.v1";
const SOFTWARE_ITEM = "sealed.software-device-keys.v1";

export interface MobileDeviceKeys extends DeviceKeys {
  agreement: NativeOrSoftwareAgreementKey;
  signing: NativeOrSoftwareSigningKey;
  /** Where the keys live, for the UI ("hardware-protected" badge) and diagnostics. */
  hardware: boolean;
}

export interface NativeOrSoftwareAgreementKey extends AgreementKey {
  /** DH with an explicit authentication mode and prompt text. */
  dhWith(peerPublicKey: Uint8Array, mode: AuthMode, reason: string): Promise<Uint8Array>;
  /** Sets the prompt text used by plain `dh()` calls (e.g. naming the transfer being opened). */
  setReason(reason: string): void;
}

export interface NativeOrSoftwareSigningKey extends SigningKey {
  signWith(message: Uint8Array, mode: AuthMode, reason: string): Promise<Uint8Array>;
  /** A view of this key whose every signature prompts the user (approvals, identity changes). */
  fresh(reason: string): SigningKey;
}

const DEFAULT_REASON = "Unlock Sealed";

export class NativeAgreementKey implements NativeOrSoftwareAgreementKey {
  constructor(
    private readonly mod: SealedKeystoreNative,
    private readonly alias: string,
    readonly publicKey: Uint8Array,
    readonly protection: KeyProtection,
    private reason = "Open the files sent to you",
  ) {}

  dh(peerPublicKey: Uint8Array): Promise<Uint8Array> {
    return this.dhWith(peerPublicKey, "window", this.reason);
  }

  async dhWith(peerPublicKey: Uint8Array, mode: AuthMode, reason: string): Promise<Uint8Array> {
    const peer = P256.normalizePublicKey(peerPublicKey, false);
    const out = fromStdB64(await this.mod.ecdh(this.alias, toStdB64(peer), reason || DEFAULT_REASON, mode));
    if (out.length !== 32) throw new Error("keystore returned a shared secret of the wrong length");
    return out;
  }

  /** Sets the prompt text used by plain `dh()` calls (e.g. naming the transfer being opened). */
  setReason(reason: string): void {
    this.reason = reason;
  }
}

export class NativeSigningKey implements NativeOrSoftwareSigningKey {
  constructor(
    private readonly mod: SealedKeystoreNative,
    private readonly alias: string,
    readonly publicKey: Uint8Array,
    readonly protection: KeyProtection,
  ) {}

  sign(message: Uint8Array): Promise<Uint8Array> {
    return this.signWith(message, "window", "Use Sealed");
  }

  async signWith(message: Uint8Array, mode: AuthMode, reason: string): Promise<Uint8Array> {
    const raw = fromStdB64(await this.mod.sign(this.alias, toStdB64(message), reason || DEFAULT_REASON, mode));
    if (raw.length !== 64) throw new Error("keystore returned a signature of the wrong length");
    return P256.toLowS(raw);
  }

  fresh(reason: string): SigningKey {
    return { publicKey: this.publicKey, protection: this.protection, sign: (m) => this.signWith(m, "fresh", reason) };
  }
}

class SoftwareAgreement extends SoftwareAgreementKey implements NativeOrSoftwareAgreementKey {
  dhWith(peerPublicKey: Uint8Array): Promise<Uint8Array> {
    return this.dh(peerPublicKey);
  }
  setReason(): void {
    // Software keys never prompt.
  }
}

class SoftwareSigning extends SoftwareSigningKey implements NativeOrSoftwareSigningKey {
  signWith(message: Uint8Array): Promise<Uint8Array> {
    return this.sign(message);
  }
  fresh(): SigningKey {
    return this;
  }
}

function fromRecord(mod: SealedKeystoreNative, alias: string, r: DeviceKeyRecord): MobileDeviceKeys {
  const agreementPublic = fromStdB64(r.agreementPublicKey);
  const signingPublic = fromStdB64(r.signingPublicKey);
  if (!P256.isValidPublicKey(agreementPublic) || !P256.isValidPublicKey(signingPublic)) throw new Error("keystore returned an invalid public key");
  const hardware = r.protection !== "software";
  return {
    agreement: new NativeAgreementKey(mod, alias, P256.normalizePublicKey(agreementPublic, false), r.agreementProtection),
    signing: new NativeSigningKey(mod, alias, P256.normalizePublicKey(signingPublic, false), r.signingProtection),
    hardware,
  };
}

async function softwareKeys(): Promise<MobileDeviceKeys> {
  const opts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  const stored = await SecureStore.getItemAsync(SOFTWARE_ITEM, opts);
  let agreementSecret: Uint8Array;
  let signingSecret: Uint8Array;
  if (stored) {
    const [a, s] = stored.split(".");
    agreementSecret = fromB64url(a ?? "");
    signingSecret = fromB64url(s ?? "");
  } else {
    agreementSecret = P256.randomSecretKey();
    signingSecret = P256.randomSecretKey();
    await SecureStore.setItemAsync(SOFTWARE_ITEM, `${toB64url(agreementSecret)}.${toB64url(signingSecret)}`, opts);
  }
  return { agreement: new SoftwareAgreement(agreementSecret), signing: new SoftwareSigning(signingSecret), hardware: false };
}

/** Loads this installation's device keys, generating them on first use. */
export async function loadOrCreateDeviceKeys(policy: KeyPolicy = "biometry-current-set"): Promise<MobileDeviceKeys> {
  const mod = nativeKeystore();
  if (!mod) return softwareKeys();
  const existing = await mod.getDeviceKeys(DEVICE_ALIAS);
  if (existing) return fromRecord(mod, DEVICE_ALIAS, existing);
  const caps = mod.getCapabilities();
  // Without enrolled biometrics, fall back to the device passcode rather than refusing to create keys.
  const effective: KeyPolicy = caps.biometrics === "available" ? policy : "user-presence";
  return fromRecord(mod, DEVICE_ALIAS, await mod.generateDeviceKeys(DEVICE_ALIAS, { policy: effective, signingWindowSeconds: 300, agreementWindowSeconds: 15 }));
}

/** Deletes and regenerates the device keys (after Face ID enrollment changes invalidated them). */
export async function resetDeviceKeys(policy: KeyPolicy = "biometry-current-set"): Promise<MobileDeviceKeys> {
  const mod = nativeKeystore();
  if (!mod) {
    await SecureStore.deleteItemAsync(SOFTWARE_ITEM);
    return softwareKeys();
  }
  await mod.deleteDeviceKeys(DEVICE_ALIAS);
  return loadOrCreateDeviceKeys(policy);
}

/** Platform attestation for claims (App Attest on iOS, Key Attestation chain on Android), when available. */
export async function claimAttestation(challenge: Uint8Array): Promise<Uint8Array | undefined> {
  const mod = nativeKeystore();
  if (!mod) return undefined;
  try {
    const caps = mod.getCapabilities();
    if (caps.platform === "ios") {
      const a = await mod.getAppAttestation(toStdB64(challenge));
      return a ? fromStdB64(a.attestation) : undefined;
    }
    const chain = await mod.getKeyAttestation(DEVICE_ALIAS);
    return chain?.agreement[0] ? fromStdB64(chain.agreement[0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prompts for Face ID / fingerprint / passcode and opens the signing key's authenticated window, so the next
 * signed relay request (an approval carrying UV evidence {kind:"device"}) is backed by a fresh user check.
 * Resolves false when the device has no hardware-gated key, which the relay never accepts as verification.
 */
export async function confirmUser(reason: string): Promise<boolean> {
  const mod = nativeKeystore();
  if (!mod) return false;
  await mod.authenticate(DEVICE_ALIAS, reason);
  return true;
}
