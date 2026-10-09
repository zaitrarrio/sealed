/**
 * Request authentication for the Worker.
 *   - Device-signed requests (spec §9.2): `Sealed-Signature` header over METHOD, path-with-query, ts, nonce and
 *     SHA-256(body); WebSocket upgrades carry the same value in `?sig=` and sign the path WITHOUT the query
 *     (matching RelayClient.socketUrl). Verification and the nonce cache live in the identity's IdentityDO.
 *   - Bearer secrets: upload tokens and claim tokens, in `Authorization: Bearer` or `?token=` for sockets.
 */
import { SIGNATURE_HEADER, fromB64url, parseSignatureHeader, toB64url } from "@sealed/core";
import type { Context } from "hono";
import type { Env } from "./env";
import { Errors, unwrap } from "./http";
import type { DeviceAuth } from "./identity-do";
import { limitDevice } from "./limits";
import { FINGERPRINT_BYTES, isB64Id } from "./util";

export type AppEnv = { Bindings: Env; Variables: { body?: Uint8Array } };
export type AppContext = Context<AppEnv>;

/** Upper bound for JSON request bodies (32 links × 8 KiB is the largest legitimate body). */
export const MAX_JSON_BODY = 512 * 1024;

/** Reads a request body into memory, refusing anything larger than `max` bytes. */
export async function readBounded(req: Request, max: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) throw Errors.tooLarge(`body exceeds ${max} bytes`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw Errors.tooLarge(`body exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

/** The raw body (cached), used both for the signature hash and for JSON parsing. */
export async function rawBody(c: AppContext): Promise<Uint8Array> {
  const cached = c.get("body");
  if (cached) return cached;
  const b = await readBounded(c.req.raw, MAX_JSON_BODY);
  c.set("body", b);
  return b;
}

export async function jsonBody(c: AppContext): Promise<unknown> {
  const b = await rawBody(c);
  if (b.length === 0) return {};
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b));
  } catch {
    throw Errors.badRequest("body must be JSON");
  }
}

function fingerprintOf(header: string): string {
  try {
    return toB64url(parseSignatureHeader(header).fingerprint);
  } catch (e) {
    throw Errors.unauthorized((e as Error).message);
  }
}

/**
 * Verifies the device signature on this request. `links` (append-links only) are applied before the signer is
 * checked, so a device added by those links — e.g. paper-key recovery — may sign the request.
 */
export async function deviceAuth(c: AppContext, opts: { links?: string[]; socket?: boolean } = {}): Promise<DeviceAuth> {
  const url = new URL(c.req.url);
  const header = opts.socket ? url.searchParams.get("sig") : c.req.header(SIGNATURE_HEADER);
  if (!header) throw Errors.unauthorized("missing device signature");
  const fp = fingerprintOf(header);
  if (!isB64Id(fp, FINGERPRINT_BYTES)) throw Errors.unauthorized("bad fingerprint");
  const body = opts.socket ? new Uint8Array(0) : await rawBody(c);
  const path = opts.socket ? url.pathname : url.pathname + url.search;
  const auth = unwrap(
    await c.env.IDENTITY.getByName(fp).verifyRequest({
      fp,
      header,
      method: c.req.method,
      path,
      body,
      ...(opts.links ? { links: opts.links } : {}),
    }),
  );
  await limitDevice(c.env, auth.deviceId);
  return auth;
}

/** True when the request carries a device signature (header form). */
export function hasDeviceSignature(c: AppContext): boolean {
  return Boolean(c.req.header(SIGNATURE_HEADER));
}

export function bearerToken(c: AppContext, socket = false): string | null {
  if (socket) return new URL(c.req.url).searchParams.get("token");
  const h = c.req.header("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+([A-Za-z0-9_.-]{16,256})$/);
  return m ? m[1]! : null;
}

export function requireBearer(c: AppContext, socket = false): string {
  const t = bearerToken(c, socket);
  if (!t) throw Errors.unauthorized("missing bearer token");
  return t;
}

/** Claim tokens are `{transfer_id}.{secret}` so the Worker can route them to the TransferDO without a lookup. */
export function transferIdFromClaimToken(token: string): string {
  const dot = token.indexOf(".");
  const id = dot > 0 ? token.slice(0, dot) : "";
  const secret = dot > 0 ? token.slice(dot + 1) : "";
  if (!isB64Id(id, 16) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw Errors.unauthorized("malformed claim token");
  return id;
}

export function decodeOrThrow(s: string, length: number, what: string): Uint8Array {
  try {
    const b = fromB64url(s);
    if (b.length !== length) throw new Error();
    return b;
  } catch {
    throw Errors.badRequest(`${what} must be ${length} bytes of base64url`);
  }
}
