/**
 * Short-lived ICE servers for live Paired transfers (spec §6.4.3). With TURN_KEY_ID / TURN_KEY_API_TOKEN set,
 * credentials come from Cloudflare Realtime TURN:
 *   POST https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers {"ttl": 600}
 *   → 201 {"iceServers": [{urls: [...]}, {urls: [...], username, credential}]}
 * Self-hosted deployments with coturn set TURN_URLS + TURN_SHARED_SECRET instead: credentials follow coturn's
 * REST API scheme (`use-auth-secret`): username = "{expiry}:sealed", credential = base64(HMAC-SHA1(secret, username)).
 * Otherwise (and on upstream failure) the relay returns STUN only.
 */
import { utf8 } from "@sealed/core";
import type { Env } from "./env";
import { nowSeconds } from "./util";

export const TURN_TTL_SECONDS = 600;
export const STUN_FALLBACK = "stun:stun.cloudflare.com:3478";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface CloudflareIceResponse {
  iceServers?: { urls?: unknown; username?: unknown; credential?: unknown }[];
}

/** Browsers block port 53; drop those URLs (Cloudflare docs, "generate credentials"). */
function usable(url: string): boolean {
  return !/:53(\?|$)/.test(url);
}

/** coturn `use-auth-secret` credentials for the configured TURN URLs. */
export async function sharedSecretCredentials(secret: string, urls: string[], now = nowSeconds()): Promise<{ ice_servers: IceServer[]; expires_at: number }> {
  const expires = now + TURN_TTL_SECONDS;
  const username = `${expires}:sealed`;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(username)));
  const credential = btoa(String.fromCharCode(...mac));
  const stun = urls.filter((u) => u.startsWith("stun:"));
  const turn = urls.filter((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  return { ice_servers: [...(stun.length ? [{ urls: stun }] : []), { urls: turn, username, credential }], expires_at: expires };
}

export async function iceServers(env: Env): Promise<{ ice_servers: IceServer[]; expires_at: number }> {
  const now = nowSeconds();
  const selfHosted = (env.TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^(stun|turns?):/.test(u));
  if (env.TURN_SHARED_SECRET && selfHosted.some((u) => !u.startsWith("stun:"))) return sharedSecretCredentials(env.TURN_SHARED_SECRET, selfHosted, now);
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      });
      if (res.ok) {
        const j = (await res.json()) as CloudflareIceResponse;
        const servers: IceServer[] = [];
        for (const s of j.iceServers ?? []) {
          const raw = Array.isArray(s.urls) ? s.urls : typeof s.urls === "string" ? [s.urls] : [];
          const urls = raw.filter((u): u is string => typeof u === "string" && usable(u));
          if (urls.length === 0) continue;
          servers.push({
            urls,
            ...(typeof s.username === "string" ? { username: s.username } : {}),
            ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
          });
        }
        if (servers.length > 0) return { ice_servers: servers, expires_at: now + TURN_TTL_SECONDS };
      }
    } catch {
      // fall through to STUN-only
    }
  }
  return { ice_servers: [{ urls: [STUN_FALLBACK] }], expires_at: now + TURN_TTL_SECONDS };
}
