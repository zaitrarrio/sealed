/**
 * Persistent device state in IndexedDB: the non-extractable device keys, the user's profile (label, identity
 * fingerprint, cached chain links) and settings. The chain is re-verified from link 0 on every load.
 */
import { fromB64url, toB64url, verifyChain, type ChainState } from "@sealed/core";
import { kvDelete, kvGet, kvSet } from "./idb";
import { deviceKeysFromStored, generateStoredDeviceKeys, type StoredDeviceKeys, type WebDeviceKeys } from "./webcrypto-keys";

const KEYS = "device-keys";
const PROFILE = "profile";
const SETTINGS = "settings";

export interface Profile {
  label: string;
  /** base64url identity fingerprint; absent until the browser creates or joins an identity. */
  fingerprint?: string;
  /** base64url encoded links of the last verified chain. */
  chainLinks?: string[];
  passkeyRegistered?: boolean;
  paperKeyCreatedAt?: number;
  onboardedAt?: number;
}

export interface Settings {
  relayUrl?: string;
  pushEnabled?: boolean;
}

/** Loads this browser's device keys, generating and persisting them on first use (receivers need no account). */
export async function loadOrCreateDeviceKeys(): Promise<WebDeviceKeys> {
  const existing = await kvGet<StoredDeviceKeys>(KEYS);
  if (existing) return deviceKeysFromStored(existing);
  const fresh = await generateStoredDeviceKeys();
  await kvSet(KEYS, fresh);
  // Another tab may have raced us; whichever write landed is authoritative.
  const stored = await kvGet<StoredDeviceKeys>(KEYS);
  return deviceKeysFromStored(stored ?? fresh);
}

/** Replaces the device keys (used when an unused browser restores with a paper key into fresh keys). */
export async function resetDeviceKeys(): Promise<WebDeviceKeys> {
  const fresh = await generateStoredDeviceKeys();
  await kvSet(KEYS, fresh);
  return deviceKeysFromStored(fresh);
}

export function defaultDeviceLabel(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export async function loadProfile(): Promise<Profile> {
  return (await kvGet<Profile>(PROFILE)) ?? { label: defaultDeviceLabel() };
}

export async function saveProfile(p: Profile): Promise<void> {
  await kvSet(PROFILE, p);
}

export async function clearProfile(): Promise<void> {
  await kvDelete(PROFILE);
}

export async function loadSettings(): Promise<Settings> {
  return (await kvGet<Settings>(SETTINGS)) ?? {};
}

export async function saveSettings(s: Settings): Promise<void> {
  await kvSet(SETTINGS, s);
}

export function encodeChainLinks(links: readonly Uint8Array[]): string[] {
  return links.map(toB64url);
}

/** Verifies cached links against the stored fingerprint; returns null when they no longer verify. */
export function verifyCachedChain(p: Profile): ChainState | null {
  if (!p.fingerprint || !p.chainLinks || p.chainLinks.length === 0) return null;
  try {
    return verifyChain(p.chainLinks.map(fromB64url), fromB64url(p.fingerprint));
  } catch {
    return null;
  }
}
