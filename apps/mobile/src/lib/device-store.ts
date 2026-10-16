/**
 * Persistent device state: the user's profile (label, identity fingerprint, cached chain links) and settings,
 * in encrypted app storage. Device keys live in the platform keystore (native-keys.ts). The chain is re-verified
 * from link 0 on every load.
 */
import * as Device from "expo-device";
import { fromB64url, toB64url, verifyChain, type ChainState } from "@sealed/core";
import { kvDelete, kvGet, kvSet } from "./storage";
import type { KeyPolicy } from "../../modules/sealed-keystore";

const PROFILE = "profile";
const SETTINGS = "settings";

export interface Profile {
  label: string;
  fingerprint?: string;
  chainLinks?: string[];
  paperKeyCreatedAt?: number;
  onboardedAt?: number;
}

export interface Settings {
  relayUrl?: string;
  pushEnabled?: boolean;
  /** Key gating chosen at onboarding: biometrics only, or biometrics with passcode fallback. */
  keyPolicy?: KeyPolicy;
  reduceMotion?: boolean;
  /** Web client origins the user chose to trust for codes (development or self-hosted deployments). */
  trustedCodeOrigins?: string[];
  /** Last measured optical decode performance, used to choose the capability tier of the next key code. */
  opticalMeasurement?: { captureFps: number; decodeMsPerFrame: number; at: number };
  /** How this phone draws QR streams when sending offline (set from the Benchmark; ADR-0020). */
  qrStream?: { symbolSize: number; codesPerScreen: 1 | 2 | 4; holdRefreshes60: number };
}

export function defaultDeviceLabel(): string {
  const name = Device.deviceName?.trim();
  if (name) return name.slice(0, 40);
  const model = Device.modelName ?? (Device.osName === "iOS" ? "iPhone" : "Android phone");
  return model.slice(0, 40);
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

export function verifyCachedChain(p: Profile): ChainState | null {
  if (!p.fingerprint || !p.chainLinks || p.chainLinks.length === 0) return null;
  try {
    return verifyChain(p.chainLinks.map(fromB64url), fromB64url(p.fingerprint));
  } catch {
    return null;
  }
}
