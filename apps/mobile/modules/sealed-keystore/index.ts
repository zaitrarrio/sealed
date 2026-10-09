/**
 * JavaScript surface of the SealedKeystore native module (ios/SealedKeystoreModule.swift,
 * android/.../SealedKeystoreModule.kt). Binary values cross the bridge as standard base64 strings.
 *
 * Authentication modes (identical on both platforms):
 *   silent  never prompt; rejects with ERR_AUTH_REQUIRED when no authenticated window is open
 *   window  reuse the purpose's authenticated window if open, otherwise prompt once
 *   fresh   always prompt (approvals and identity changes)
 */
import { requireOptionalNativeModule } from "expo";

export type KeyPolicy = "biometry-current-set" | "user-presence";
export type AuthMode = "silent" | "window" | "fresh";
export type NativeProtection = "secure-enclave" | "strongbox" | "tee" | "software";

export interface GenerateOptions {
  policy?: KeyPolicy;
  signingWindowSeconds?: number;
  agreementWindowSeconds?: number;
}

export interface DeviceKeyRecord {
  agreementPublicKey: string; // base64, 65-byte X9.63 uncompressed
  signingPublicKey: string;
  protection: NativeProtection;
  agreementProtection: NativeProtection;
  signingProtection: NativeProtection;
  policy: KeyPolicy;
}

export interface Capabilities {
  platform: "ios" | "android";
  secureHardware: boolean;
  strongBox: boolean;
  biometrics: "available" | "not-enrolled" | "unavailable";
  deviceCredential: boolean;
}

export interface SealedKeystoreNative {
  getCapabilities(): Capabilities;
  generateDeviceKeys(alias: string, options: GenerateOptions): Promise<DeviceKeyRecord>;
  getDeviceKeys(alias: string): Promise<DeviceKeyRecord | null>;
  deleteDeviceKeys(alias: string): Promise<void>;
  authenticate(alias: string, reason: string): Promise<void>;
  ecdh(alias: string, peerPublicKey: string, reason: string, mode: AuthMode): Promise<string>;
  sign(alias: string, message: string, reason: string, mode: AuthMode): Promise<string>;
  lock(alias: string): boolean;
  getKeyAttestation(alias: string): Promise<{ agreement: string[]; signing: string[] } | null>;
  getAppAttestation(challenge: string): Promise<{ keyId: string; attestation: string } | null>;
}

/** Error codes the native module rejects with. */
export const KeystoreErrors = {
  AuthRequired: "ERR_AUTH_REQUIRED",
  AuthCancelled: "ERR_AUTH_CANCELLED",
  AuthFailed: "ERR_AUTH_FAILED",
  KeyInvalidated: "ERR_KEY_INVALIDATED",
  KeyNotFound: "ERR_KEY_NOT_FOUND",
  KeyExists: "ERR_KEY_EXISTS",
  BadInput: "ERR_BAD_INPUT",
  Keystore: "ERR_KEYSTORE",
  Attestation: "ERR_ATTESTATION",
  NoActivity: "ERR_NO_ACTIVITY",
  NoContext: "ERR_NO_CONTEXT",
} as const;

export function keystoreErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

let override: SealedKeystoreNative | null = null;

/** The native module, or null when running without it (Expo Go, unit tests). */
export function nativeKeystore(): SealedKeystoreNative | null {
  return override ?? requireOptionalNativeModule<SealedKeystoreNative>("SealedKeystore");
}

/** Test hook: substitute an implementation of the native interface. */
export function setNativeKeystoreForTesting(impl: SealedKeystoreNative | null): void {
  override = impl;
}
