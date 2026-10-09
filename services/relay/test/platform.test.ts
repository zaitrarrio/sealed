import { P256, aesGcmOpenSync, concat, fromB64url, hkdf, toB64url, utf8 } from "@sealed/core";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { HttpError } from "../src/http";
import { limitDevice, limitIp } from "../src/limits";
import { FORBIDDEN_LOG_FIELDS, hashIp, ipPrefix } from "../src/log";
import { encryptWebPush, es256JwtRaw, sendPush } from "../src/push";
import { iceServers, sharedSecretCredentials } from "../src/turn";
import { logRecords } from "./setup";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the RFC 8291 Appendix A message exactly", () => {
    const plaintext = fromB64url("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
    const asPrivate = fromB64url("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
    const uaPublic = fromB64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
    const salt = fromB64url("DGv6ra1nlYgDCS1FRnbzlw");
    const auth = fromB64url("BTBZMqHH6r4Tts7J_aSIgg");
    const out = encryptWebPush(plaintext, uaPublic, auth, asPrivate, salt);
    // RFC 8291 gives the 86-byte header and the ciphertext as separate base64url strings.
    const header = fromB64url("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg" + "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const ciphertext = fromB64url("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ");
    expect(header).toHaveLength(86);
    expect(out).toEqual(concat(header, ciphertext));
  });
});

/** Decrypts an aes128gcm push body as a user agent would (RFC 8291 §3.4 / RFC 8188). */
function uaDecrypt(body: Uint8Array, uaSecret: Uint8Array, auth: Uint8Array): Uint8Array {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const uaPublic = P256.publicKey(uaSecret, false);
  const ikm = hkdf(P256.dh(uaSecret, asPublic), auth, concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic), 32);
  const cek = hkdf(ikm, salt, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = hkdf(ikm, salt, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);
  const padded = aesGcmOpenSync(cek, nonce, body.slice(21 + idlen));
  expect(padded[padded.length - 1]).toBe(2);
  return padded.slice(0, -1);
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: Uint8Array; sig: Uint8Array } {
  const [h, c, s] = jwt.split(".");
  return { header: JSON.parse(new TextDecoder().decode(fromB64url(h!))), claims: JSON.parse(new TextDecoder().decode(fromB64url(c!))), input: utf8(`${h}.${c}`), sig: fromB64url(s!) };
}

async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

const TRANSFER_ID = "AAECAwQFBgcICQoLDA0ODw";

describe("push providers", () => {
  it("Web Push: VAPID-signed, aes128gcm-encrypted body carrying only the transfer id", async () => {
    const vapidSecret = P256.randomSecretKey();
    const uaSecret = P256.randomSecretKey();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const sub = JSON.stringify({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: toB64url(P256.publicKey(uaSecret, false)), auth: toB64url(auth) } });
    const pushEnv = { VAPID_PUBLIC_KEY: toB64url(P256.publicKey(vapidSecret, false)), VAPID_PRIVATE_KEY: toB64url(vapidSecret), VAPID_SUBJECT: "mailto:ops@sealed.to" } as Env;
    let captured: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(null, { status: 201 });
    });
    expect(await sendPush(pushEnv, "webpush", sub, TRANSFER_ID)).toBe("sent");
    expect(captured!.url).toBe("https://push.example.com/send/abc");
    expect(captured!.headers.get("content-encoding")).toBe("aes128gcm");
    const m = captured!.headers.get("authorization")!.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(m[2]).toBe(pushEnv.VAPID_PUBLIC_KEY);
    const jwt = decodeJwt(m[1]!);
    expect(jwt.claims["aud"]).toBe("https://push.example.com");
    expect(P256.verify(jwt.sig, jwt.input, P256.publicKey(vapidSecret, false))).toBe(true);
    const body = new Uint8Array(await captured!.arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(uaDecrypt(body, uaSecret, auth)))).toEqual({ transfer_id: TRANSFER_ID });
  });

  it("Web Push: 410 marks the subscription gone; missing VAPID config skips", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 410 }));
    const s = P256.randomSecretKey();
    const sub = JSON.stringify({ endpoint: "https://push.example.com/x", keys: { p256dh: toB64url(P256.publicKey(P256.randomSecretKey(), false)), auth: toB64url(new Uint8Array(16)) } });
    expect(await sendPush({ VAPID_PUBLIC_KEY: toB64url(P256.publicKey(s, false)), VAPID_PRIVATE_KEY: toB64url(s) } as Env, "webpush", sub, TRANSFER_ID)).toBe("gone");
    expect(await sendPush({} as Env, "webpush", sub, TRANSFER_ID)).toBe("skipped");
  });

  it("FCM HTTP v1: RS256 service-account assertion, then a data message with only the transfer id", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const sa = { client_email: "relay@sealed-test.iam.gserviceaccount.com", private_key: await pkcs8Pem(kp.privateKey), project_id: "sealed-test", token_uri: "https://oauth2.googleapis.com/token" };
    const calls: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as string, init);
      calls.push(req.clone());
      if (req.url === sa.token_uri) return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      return Response.json({ name: "projects/sealed-test/messages/1" });
    });
    expect(await sendPush({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) } as Env, "fcm", "f".repeat(40), TRANSFER_ID)).toBe("sent");
    const form = new URLSearchParams(new TextDecoder().decode(await calls[0]!.arrayBuffer()));
    const jwt = decodeJwt(form.get("assertion")!);
    expect(jwt.header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(jwt.claims).toMatchObject({ iss: sa.client_email, aud: sa.token_uri, scope: "https://www.googleapis.com/auth/firebase.messaging" });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, jwt.sig, jwt.input)).toBe(true);
    expect(calls[1]!.url).toBe("https://fcm.googleapis.com/v1/projects/sealed-test/messages:send");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer ya29.test");
    expect(await calls[1]!.json()).toEqual({ message: { token: "f".repeat(40), data: { transfer_id: TRANSFER_ID }, android: { priority: "high" } } });
  });

  it("APNs: ES256 provider token and a background push with only the transfer id", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const apnsEnv = { APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456", APNS_KEY_P8: await pkcs8Pem(kp.privateKey), APNS_BUNDLE_ID: "to.sealed.app", APNS_ENVIRONMENT: "sandbox" } as Env;
    let captured: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(null, { status: 200 });
    });
    const token = "ab".repeat(32);
    expect(await sendPush(apnsEnv, "apns", token, TRANSFER_ID)).toBe("sent");
    expect(captured!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${token}`);
    expect(captured!.headers.get("apns-topic")).toBe("to.sealed.app");
    expect(captured!.headers.get("apns-push-type")).toBe("background");
    const jwt = decodeJwt(captured!.headers.get("authorization")!.replace(/^bearer /, ""));
    expect(jwt.header).toMatchObject({ alg: "ES256", kid: "ABC123DEFG" });
    expect(jwt.claims["iss"]).toBe("TEAM123456");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, jwt.sig, jwt.input)).toBe(true);
    expect(await captured!.json()).toEqual({ aps: { "content-available": 1 }, transfer_id: TRANSFER_ID });
  });

  it("es256JwtRaw signatures verify with the VAPID public key", () => {
    const s = P256.randomSecretKey();
    const jwt = decodeJwt(es256JwtRaw(s, { typ: "JWT", alg: "ES256" }, { aud: "https://x.example" }));
    expect(P256.verify(jwt.sig, jwt.input, P256.publicKey(s, false))).toBe(true);
  });
});

describe("TURN", () => {
  it("returns Cloudflare Realtime TURN servers when configured, dropping port 53", async () => {
    let captured: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      captured = new Request(input as string, init);
      return Response.json(
        {
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
          ],
        },
        { status: 201 },
      );
    });
    const r = await iceServers({ TURN_KEY_ID: "key-id", TURN_KEY_API_TOKEN: "tok" } as Env);
    expect(captured!.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers");
    expect(captured!.headers.get("authorization")).toBe("Bearer tok");
    expect(await captured!.json()).toEqual({ ttl: 600 });
    expect(r.ice_servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ]);
  });

  it("issues coturn use-auth-secret credentials for self-hosted TURN", async () => {
    const r = await iceServers({ TURN_URLS: "stun:turn.example.org:3478, turn:turn.example.org:3478?transport=udp", TURN_SHARED_SECRET: "s3cret" } as Env);
    expect(r.ice_servers[0]).toEqual({ urls: ["stun:turn.example.org:3478"] });
    const t = r.ice_servers[1]!;
    expect(t.urls).toEqual(["turn:turn.example.org:3478?transport=udp"]);
    expect(t.username).toBe(`${r.expires_at}:sealed`);
    // Known-answer: HMAC-SHA1("s3cret", "1000600:sealed"), base64.
    const fixed = await sharedSecretCredentials("s3cret", ["turn:t:3478"], 1_000_000);
    const key = await crypto.subtle.importKey("raw", utf8("s3cret"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8("1000600:sealed")));
    expect(fixed.ice_servers[0]).toEqual({ urls: ["turn:t:3478"], username: "1000600:sealed", credential: btoa(String.fromCharCode(...mac)) });
  });

  it("falls back to STUN when the TURN API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const r = await iceServers({ TURN_KEY_ID: "k", TURN_KEY_API_TOKEN: "t" } as Env);
    expect(r.ice_servers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });
});

describe("abuse/logs (ADR-0015)", () => {
  it("never logs raw IPs or forbidden fields; hashes IPs with a daily key at /24 granularity", async () => {
    const ip = "203.0.113.77";
    const res = await exports.default.fetch("https://relay.test/v1/identities/AAAA/chain", { headers: { "cf-connecting-ip": ip } });
    expect(res.status).toBe(404);
    const serialized = JSON.stringify(logRecords);
    expect(serialized).not.toContain(ip);
    expect(serialized).not.toContain("203.0.113.");
    for (const r of logRecords) {
      for (const f of FORBIDDEN_LOG_FIELDS) expect(Object.keys(r)).not.toContain(f);
      expect((r["ts_hour"] as number) % 3600).toBe(0);
    }
    const last = logRecords.filter((r) => r["event"] === "request").at(-1)!;
    expect(last["route"]).toBe("/v1/identities/:fp/chain");
    expect(last["ip_hash"]).toBe(await hashIp("test-ip-secret", "203.0.113.1"));
    const d1 = new Date("2026-10-01T12:00:00Z");
    const d2 = new Date("2026-10-02T12:00:00Z");
    expect(await hashIp("s", ip, d1)).not.toBe(await hashIp("s", ip, d2));
    expect(ipPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(ipPrefix("::1")).toBe("0:0:0::/48");
  });
});

describe("CORS", () => {
  it("answers preflight for allowed origins only", async () => {
    const ok = await exports.default.fetch("https://relay.test/v1/transfers", {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "POST", "access-control-request-headers": "sealed-signature, content-type" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("sealed-signature");
    const bad = await exports.default.fetch("https://relay.test/v1/transfers", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const health = await exports.default.fetch("https://relay.test/v1/health", { headers: { origin: "https://app.test" } });
    expect(health.headers.get("access-control-allow-origin")).toBe("https://app.test");
    const err = await exports.default.fetch("https://relay.test/v1/transfers/AAAAAAAAAAAAAAAAAAAAAA", { headers: { origin: "https://app.test" } });
    expect(err.status).toBe(401);
    expect(err.headers.get("access-control-allow-origin")).toBe("https://app.test");
  });
});

describe("rate limiting", () => {
  it("maps a failed limiter outcome to 429 rate_limited, and is a no-op without bindings", async () => {
    const deny: RateLimit = { limit: async () => ({ success: false }) };
    const keys: string[] = [];
    const allow: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    await expect(limitIp({ RL_IP: deny } as Env, "198.51.100.4")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(limitDevice({ RL_DEVICE: deny } as Env, "dev")).rejects.toBeInstanceOf(HttpError);
    await limitIp({ RL_IP: allow } as Env, "198.51.100.4");
    expect(keys).toEqual(["ip:198.51.100.0/24"]);
    await limitIp({} as Env, "198.51.100.4");
    await limitDevice({} as Env, "dev");
  });
});

describe("errors", () => {
  it("returns JSON ErrorBody with stable codes", async () => {
    const res = await exports.default.fetch("https://relay.test/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    const bad = await exports.default.fetch("https://relay.test/v1/identities", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad_request" });
  });
});

describe("relay/blind (ADR-0012)", () => {
  it("relay sources import no decryption or unwrap function from @sealed/core", () => {
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    const forbidden = /\b(unwrapKey|openEnvelope|EnvelopeReader|PayloadExtractor|aesGcmOpen|aesGcmOpenSync|decodeWrap|downloadTransfer|receivePaired)\b/;
    for (const [file, text] of Object.entries(sources)) expect(forbidden.test(text), file).toBe(false);
  });
});
