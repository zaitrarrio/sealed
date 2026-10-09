/**
 * Code routing. Every Sealed code is an https URL on the client origin whose secret lives in the fragment
 * (packages/core protocol/codes.ts): /c/<transfer>#cs, /p#pairing, /d#add-device, /k#reverse-key. The web client
 * serves exactly those paths, so a phone's camera app opens the right screen directly; scans and pastes inside
 * the app are routed to the same paths. Fragments never leave the browser.
 */
import { CodeError, parseCode, type ParsedCode } from "@sealed/core";

export const CODE_PATHS = {
  claim: (transferId: string) => `/c/${transferId}`,
  pair: "/p",
  addDevice: "/d",
  reverseKey: "/k",
} as const;

export interface RoutedCode {
  parsed: ParsedCode;
  /** In-app path including the fragment, e.g. "/p#oWE...". */
  path: string;
}

/** Parses `text` as a Sealed code from an accepted origin and returns the in-app path that handles it. */
export function routeCode(text: string, acceptedOrigins: readonly string[]): RoutedCode {
  const trimmed = text.trim();
  const parsed = parseCode(trimmed, acceptedOrigins);
  const url = new URL(trimmed);
  const pathname = url.pathname.replace(/\/+$/, "");
  return { parsed, path: `${pathname}${url.hash}` };
}

/** Expects one kind of code; for screens that scan a specific code (pairing, add-device, reverse key). */
export function expectCode<K extends ParsedCode["kind"]>(text: string, kind: K, acceptedOrigins: readonly string[]): Extract<ParsedCode, { kind: K }> {
  const parsed = parseCode(text.trim(), acceptedOrigins);
  if (parsed.kind !== kind) throw new CodeError(`Expected a ${describeKind(kind)}, but this is a ${describeKind(parsed.kind)}.`);
  return parsed as Extract<ParsedCode, { kind: K }>;
}

export function describeKind(kind: ParsedCode["kind"]): string {
  switch (kind) {
    case "claim":
      return "share code";
    case "pair":
      return "pairing code";
    case "add-device":
      return "new-device code";
    case "reverse-key":
      return "offline key code";
  }
}

/** The full code URL for a screen reached directly (a camera app opened /p#...), to parse like a scan. */
export function codeFromLocation(origin: string, pathname: string, hash: string): string | null {
  if (!hash || hash === "#") return null;
  return `${origin}${pathname}${hash}`;
}

export function friendlyCodeError(e: unknown): string {
  if (e instanceof CodeError) {
    const m = e.message;
    if (m.startsWith("not a Sealed code")) return "That is not a Sealed code.";
    if (m.startsWith("code is from an unknown origin")) return "That code comes from a site this app does not trust.";
    if (m.startsWith("code is missing its secret")) return "That code is incomplete. Scan it again.";
    return m.endsWith(".") ? m : `${m}.`;
  }
  return e instanceof Error ? e.message : String(e);
}
