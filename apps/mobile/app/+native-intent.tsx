/**
 * Incoming universal links / app links (a phone camera scanned a Sealed code, or a code link was tapped).
 * The code — fragment and all — is stashed in memory and the router receives only the screen path plus an
 * opaque reference, so the secret never enters navigation state.
 */
import { CodeError } from "@sealed/core";
import { inAppRouteFor } from "../src/lib/code-stash";
import { acceptedOrigins } from "../src/lib/config";

export function redirectSystemPath({ path }: { path: string | null; initial: boolean }): string | null {
  if (!path) return path;
  if (!/^https?:\/\//i.test(path)) return path;
  try {
    return inAppRouteFor(path, acceptedOrigins());
  } catch (e) {
    if (e instanceof CodeError) return "/unknown-code";
    return "/";
  }
}
