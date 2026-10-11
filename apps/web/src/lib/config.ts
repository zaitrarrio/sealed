import { isLocalNetworkHost } from "@sealed/core";

/** Build-time configuration (Vite env) plus runtime overrides chosen under Settings. */

const DEFAULT_RELAY = "http://localhost:8787";

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
  relayUrl: trim(import.meta.env.VITE_RELAY_URL || DEFAULT_RELAY),
  publicOrigin: trim(import.meta.env.VITE_PUBLIC_ORIGIN || ""),
  acceptedCodeOrigins: list(import.meta.env.VITE_ACCEPTED_CODE_ORIGINS),
  google: {
    clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
    apiKey: import.meta.env.VITE_GOOGLE_API_KEY ?? "",
    appId: import.meta.env.VITE_GOOGLE_APP_ID ?? "",
  },
  vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "",
} as const;

/** Origin written into codes this client displays. */
export function codeOrigin(): string {
  return env.publicOrigin || window.location.origin;
}

let trusted: string[] = [];

/** Origins the user trusted at runtime (kept in Settings; loaded by the session). */
export function setTrustedOrigins(origins: readonly string[] | undefined): void {
  trusted = [...(origins ?? [])];
}

/** Origins whose codes this client accepts. */
export function acceptedOrigins(): string[] {
  return [...new Set([window.location.origin, codeOrigin(), ...env.acceptedCodeOrigins, ...trusted])];
}

/** Normalizes an origin the user is asked to trust: https anywhere, plain http only on local networks. */
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

export function driveConfigured(): boolean {
  return Boolean(env.google.clientId && env.google.apiKey && env.google.appId);
}

export function validateRelayUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("Enter a full URL, for example https://relay.sealed.to");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("The relay must use https (http is allowed only for localhost)");
  if (u.search || u.hash) throw new Error("The relay URL cannot have a query or fragment");
  return trim(u.origin + u.pathname);
}
