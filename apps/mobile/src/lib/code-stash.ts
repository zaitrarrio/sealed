/**
 * Codes carry their secret in the URL fragment (packages/core protocol/codes.ts). Router paths and params are
 * kept in navigation state and can surface in logs or crash reports, so the full code never travels through
 * the router: it is held here in memory under a random reference, and screens receive only `?ref=<id>`.
 * A reference can be taken once.
 */
import { randomBytes, toB64url } from "@sealed/core";
import { CODE_PATHS, routeCode } from "./routing";

const stash = new Map<string, { code: string; at: number }>();
const TTL_MS = 10 * 60_000;

function prune(now: number): void {
  for (const [k, v] of stash) if (now - v.at > TTL_MS) stash.delete(k);
}

export function stashCode(code: string): string {
  const now = Date.now();
  prune(now);
  const ref = toB64url(randomBytes(9));
  stash.set(ref, { code, at: now });
  return ref;
}

/** Returns the stashed code once; later calls with the same reference return null. */
export function takeCode(ref: string | string[] | undefined): string | null {
  const key = Array.isArray(ref) ? ref[0] : ref;
  if (!key) return null;
  const v = stash.get(key);
  stash.delete(key);
  return v ? v.code : null;
}

/** Peek without consuming (for screens that may re-render before using the code). */
export function peekCode(ref: string | string[] | undefined): string | null {
  const key = Array.isArray(ref) ? ref[0] : ref;
  return key ? (stash.get(key)?.code ?? null) : null;
}

/**
 * Maps a scanned or opened Sealed code to the in-app route that handles it, with the secret stashed.
 * Throws CodeError for anything that is not a code from an accepted origin.
 */
export function inAppRouteFor(code: string, acceptedOrigins: readonly string[]): string {
  const { parsed } = routeCode(code, acceptedOrigins);
  const ref = stashCode(code.trim());
  switch (parsed.kind) {
    case "claim":
      return `${CODE_PATHS.claim(toB64url(parsed.transferId))}?ref=${ref}`;
    case "pair":
      return `${CODE_PATHS.pair}?ref=${ref}`;
    case "add-device":
      return `${CODE_PATHS.addDevice}?ref=${ref}`;
    case "reverse-key":
      return `${CODE_PATHS.reverseKey}?ref=${ref}`;
  }
}
