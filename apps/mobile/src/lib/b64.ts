/** Standard (RFC 4648 §4) base64, which the native modules use across the bridge. */
import { fromB64url, toB64url } from "@sealed/core";

export function toStdB64(b: Uint8Array): string {
  const s = toB64url(b).replace(/-/g, "+").replace(/_/g, "/");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

export function fromStdB64(s: string): Uint8Array {
  // core's decoder accepts both alphabets and ignores padding.
  return fromB64url(s.replace(/\s+/g, ""));
}
