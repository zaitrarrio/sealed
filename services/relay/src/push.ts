/**
 * Push notifications on mailbox delivery (spec §6.4.2 step 4). The payload is only `{transfer_id}`.
 * Each provider is active only when its secrets are configured:
 *   - Web Push: RFC 8291 (aes128gcm message encryption) + RFC 8292 (VAPID, ES256 JWT).
 *   - FCM HTTP v1: OAuth2 service-account JWT (RS256 via WebCrypto) exchanged for an access token.
 *   - APNs: provider token (ES256 JWT via WebCrypto) to api.push.apple.com over HTTPS.
 */
import { P256, aesGcmSealSync, concat, fromB64url, hkdf, randomBytes, toB64url, utf8 } from "@sealed/core";
import type { Env } from "./env";
import { nowSeconds } from "./util";

export type PushPlatform = "apns" | "fcm" | "webpush";
export type PushOutcome = "sent" | "gone" | "failed" | "skipped";

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Returns an error message for a malformed token, or null when acceptable. */
export function validatePushToken(platform: PushPlatform, token: string): string | null {
  switch (platform) {
    case "apns":
      return /^[0-9a-fA-F]{64,200}$/.test(token) ? null : "APNs token must be hex";
    case "fcm":
      return /^[A-Za-z0-9_:\-.]{20,4096}$/.test(token) ? null : "malformed FCM token";
    case "webpush": {
      const sub = parseSubscription(token);
      return sub ? null : "web push token must be a PushSubscription JSON with an https endpoint and p256dh/auth keys";
    }
  }
}

export function parseSubscription(token: string): WebPushSubscription | null {
  try {
    const v = JSON.parse(token) as Partial<WebPushSubscription>;
    if (typeof v.endpoint !== "string" || !v.keys || typeof v.keys.p256dh !== "string" || typeof v.keys.auth !== "string") return null;
    const url = new URL(v.endpoint);
    if (url.protocol !== "https:" || isLiteralOrLocalHost(url.hostname)) return null;
    const p256dh = fromB64url(v.keys.p256dh);
    const auth = fromB64url(v.keys.auth);
    if (p256dh.length !== 65 || !P256.isValidPublicKey(p256dh) || auth.length !== 16) return null;
    return { endpoint: v.endpoint, keys: { p256dh: v.keys.p256dh, auth: v.keys.auth } };
  } catch {
    return null;
  }
}

/** Push endpoints must be public DNS names; IP literals and localhost are refused (SSRF guard for self-host). */
function isLiteralOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || /^[0-9.]+$/.test(h) || h.startsWith("[");
}

export async function sendPush(env: Env, platform: PushPlatform, token: string, transferId: string): Promise<PushOutcome> {
  try {
    switch (platform) {
      case "webpush":
        return await sendWebPush(env, token, transferId);
      case "fcm":
        return await sendFcm(env, token, transferId);
      case "apns":
        return await sendApns(env, token, transferId);
    }
  } catch {
    return "failed";
  }
}

// ------------------------------------------------------------------ JWT helpers

function b64urlJson(v: unknown): string {
  return toB64url(utf8(JSON.stringify(v)));
}

/** ES256 JWT signed with a raw 32-byte P-256 secret (VAPID). */
export function es256JwtRaw(secret: Uint8Array, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = P256.sign(secret, utf8(input));
  return `${input}.${toB64url(sig)}`;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** JWT signed via WebCrypto with a PKCS#8 PEM key; WebCrypto ECDSA already returns raw r||s (JWS form). */
async function webcryptoJwt(pem: string, alg: "ES256" | "RS256", header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const algo = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), algo, false, ["sign"]);
  const input = `${b64urlJson({ ...header, alg, typ: "JWT" })}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, key, utf8(input));
  return `${input}.${toB64url(new Uint8Array(sig))}`;
}

// ------------------------------------------------------------------ Web Push (RFC 8291 / RFC 8292)

const WEBPUSH_RECORD_SIZE = 4096;

/**
 * Encrypts `plaintext` for a push subscription as a single aes128gcm record (RFC 8188 + RFC 8291 §3.4).
 * `asSecret` and `salt` are injectable for the RFC 8291 Appendix A test vector; production uses fresh values.
 */
export function encryptWebPush(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  asSecret: Uint8Array = P256.randomSecretKey(),
  salt: Uint8Array = randomBytes(16),
): Uint8Array {
  if (plaintext.length + 1 + 16 > WEBPUSH_RECORD_SIZE) throw new Error("push payload too large for one record");
  const asPublic = P256.publicKey(asSecret, false);
  const ecdh = P256.dh(asSecret, uaPublic);
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = hkdf(ecdh, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = hkdf(ikm, salt, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);
  const record = aesGcmSealSync(cek, nonce, concat(plaintext, new Uint8Array([2])));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, WEBPUSH_RECORD_SIZE, false);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, record);
}

async function sendWebPush(env: Env, token: string, transferId: string): Promise<PushOutcome> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return "skipped";
  const sub = parseSubscription(token);
  if (!sub) return "gone";
  const endpoint = new URL(sub.endpoint);
  const jwt = es256JwtRaw(fromB64url(env.VAPID_PRIVATE_KEY), { typ: "JWT", alg: "ES256" }, { aud: endpoint.origin, exp: nowSeconds() + 12 * 3600, sub: env.VAPID_SUBJECT ?? "mailto:ops@sealed.to" });
  const body = encryptWebPush(utf8(JSON.stringify({ transfer_id: transferId })), fromB64url(sub.keys.p256dh), fromB64url(sub.keys.auth));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return "gone";
  return res.ok ? "sent" : "failed";
}

// ------------------------------------------------------------------ FCM HTTP v1

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

let fcmToken: { value: string; expires: number; account: string } | null = null;

async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  const now = nowSeconds();
  if (fcmToken && fcmToken.account === sa.client_email && fcmToken.expires - 60 > now) return fcmToken.value;
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = await webcryptoJwt(sa.private_key, "RS256", {}, { iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat: now, exp: now + 3600 });
  const res = await fetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("FCM token exchange returned no access_token");
  fcmToken = { value: j.access_token, expires: now + (j.expires_in ?? 3600), account: sa.client_email };
  return j.access_token;
}

async function sendFcm(env: Env, token: string, transferId: string): Promise<PushOutcome> {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return "skipped";
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  const access = await fcmAccessToken(sa);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { token, data: { transfer_id: transferId }, android: { priority: "high" } } }),
  });
  if (res.ok) return "sent";
  if (res.status === 404) return "gone";
  const text = await res.text();
  return text.includes("UNREGISTERED") ? "gone" : "failed";
}

// ------------------------------------------------------------------ APNs

let apnsJwt: { value: string; issued: number; kid: string } | null = null;

async function apnsProviderToken(env: Env): Promise<string> {
  const now = nowSeconds();
  // Apple rejects tokens older than 60 minutes and throttles regeneration more often than every 20.
  if (apnsJwt && apnsJwt.kid === env.APNS_KEY_ID && now - apnsJwt.issued < 45 * 60) return apnsJwt.value;
  const value = await webcryptoJwt(env.APNS_KEY_P8!, "ES256", { kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: now });
  apnsJwt = { value, issued: now, kid: env.APNS_KEY_ID! };
  return value;
}

async function sendApns(env: Env, token: string, transferId: string): Promise<PushOutcome> {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_KEY_P8 || !env.APNS_BUNDLE_ID) return "skipped";
  const host = env.APNS_ENVIRONMENT === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const res = await fetch(`${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsProviderToken(env)}`,
      "apns-topic": env.APNS_BUNDLE_ID,
      "apns-push-type": "background",
      "apns-priority": "5",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps: { "content-available": 1 }, transfer_id: transferId }),
  });
  if (res.ok) return "sent";
  if (res.status === 410) return "gone";
  if (res.status === 400) {
    const text = await res.text();
    return text.includes("BadDeviceToken") ? "gone" : "failed";
  }
  return "failed";
}
