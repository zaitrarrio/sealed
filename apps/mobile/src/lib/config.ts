import { isLocalNetworkHost } from "@sealed/core";

/** Build-time configuration (EXPO_PUBLIC_* env, inlined by Metro) plus runtime overrides chosen under Settings. */

const DEFAULT_RELAY = "http://localhost:8787";
const DEFAULT_WEB_ORIGIN = "https://sealed.to";

function trim(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => trim(s))
    .filter(Boolean);
}

export const env = {
  relayUrl: trim(process.env.EXPO_PUBLIC_RELAY_URL || DEFAULT_RELAY),
  /** Origin written into codes this app displays; the same origin the app claims for universal/app links. */
  publicOrigin: trim(process.env.EXPO_PUBLIC_WEB_ORIGIN || DEFAULT_WEB_ORIGIN),
  acceptedCodeOrigins: list(process.env.EXPO_PUBLIC_ACCEPTED_CODE_ORIGINS),
} as const;

export function codeOrigin(): string {
  return env.publicOrigin;
}

let trusted: string[] = [];

/** Origins the user trusted at runtime (kept in Settings; loaded by the session). */
export function setTrustedOrigins(origins: readonly string[] | undefined): void {
  trusted = [...(origins ?? [])];
}

/** Origins whose codes this app accepts: the build's own, the build's extra list, and the user's trusted ones. */
export function acceptedOrigins(): string[] {
  return [...new Set([codeOrigin(), ...env.acceptedCodeOrigins, ...trusted])];
}

/**
 * Normalizes an origin the user is asked to trust. https anywhere; plain http only for this device and private
 * networks (a development web client on the LAN), matching what code parsing accepts.
 */
export function trustableOrigin(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error("That is not a web address.");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalNetworkHost(u.hostname))) throw new Error("Only https addresses (or http on your local network) can be trusted.");
  return u.origin;
}

export function validateRelayUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("Enter a full URL, for example https://relay.sealed.to");
  }
  const local = isLocalNetworkHost(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("The relay must use https (http is allowed only for local development)");
  if (u.search || u.hash) throw new Error("The relay URL cannot have a query or fragment");
  return trim(u.origin + u.pathname);
}
