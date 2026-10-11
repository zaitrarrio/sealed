/**
 * Sealed relay Worker (spec §9, ADR-0012). Stateless HTTP edge: authenticates requests, validates bodies against
 * the shared zod contract in @sealed/core, and routes to the TransferDO / IdentityDO that own each piece of state.
 * The relay never holds a content key and never imports any unwrap or decrypt function (ADR-0012 "relay/blind").
 */
import {
  AppendLinksRequest,
  ApproveRequest,
  ClaimRequest,
  CreateIdentityRequest,
  CreateTransferRequest,
  DeliverRequest,
  FinalizeRequest,
  HARDWARE_PROTECTIONS,
  Limits,
  Paths,
  PostPairingReturnRequest,
  PushRegistration,
  PutSyncBlobRequest,
  ReportRequest,
  UploadPrekeysRequest,
  WebAuthnRegisterVerifyRequest,
  approvalAction,
  fromB64url,
  sha256,
  sizeBucket,
  toB64url,
} from "@sealed/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { routePath } from "hono/route";
import { z } from "zod";
import { bearerToken, deviceAuth, hasDeviceSignature, jsonBody, rawBody, readBounded, requireBearer, transferIdFromClaimToken, type AppContext, type AppEnv } from "./auth";
import type { Env } from "./env";
import { Errors, HttpError, errorResponse, unwrap } from "./http";
import { hashIp, log } from "./log";
import { effectiveLimits, limitIp, limitSignup, maxTtlFor, type Plan } from "./limits";
import { deleteTransferObjects, putPart, streamPart } from "./storage";
import type { PartKind } from "./transfer-do";
import { iceServers } from "./turn";
import { FINGERPRINT_BYTES, TRANSFER_ID_BYTES, CLAIM_ID_BYTES, DEVICE_ID_BYTES, hashSecret, hourFloor, isB64Id, nowSeconds, randomId, wsOrigin } from "./util";
import { authenticationOptions, registrationOptions, relyingParty, verifyAssertion, verifyRegistration } from "./webauthn";

export { IdentityDO } from "./identity-do";
export { TransferDO } from "./transfer-do";

const VERSION = "0.1.0";
const MiB = 1024 * 1024;
const MAX_MANIFEST_PART_BYTES = 4 * MiB;

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------- helpers

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw Errors.badRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

function param(c: AppContext, name: string, bytes: number): string {
  const v = c.req.param(name) ?? "";
  if (!isB64Id(v, bytes)) throw Errors.notFound();
  return v;
}

function index(c: AppContext, name: string): number {
  const v = c.req.param(name) ?? "";
  if (!/^(0|[1-9][0-9]{0,6})$/.test(v)) throw Errors.notFound();
  return Number(v);
}

function transfer(env: Env, id: string) {
  return env.TRANSFER.getByName(id);
}

function identity(env: Env, fp: string) {
  return env.IDENTITY.getByName(fp);
}

function isUpgrade(c: AppContext): boolean {
  return c.req.header("upgrade")?.toLowerCase() === "websocket";
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const OK = { ok: true } as const;

// ---------------------------------------------------------------- middleware

app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  const status = c.res.status;
  const ip = c.req.header("cf-connecting-ip");
  // ADR-0015: route pattern (never concrete ids or names), status, hashed IP prefix, hour-rounded timestamp.
  log({
    event: "request",
    method: c.req.method,
    route: routePath(c),
    status,
    duration_ms: Date.now() - started,
    ...(ip && status >= 400 ? { ip_hash: await hashIp(c.env.IP_HASH_SECRET ?? "", ip) } : {}),
  });
});

app.use("*", async (c, next) => {
  // 101 responses carry immutable headers; CORS does not apply to WebSocket upgrades anyway.
  if (isUpgrade(c)) return next();
  return cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization", "sealed-signature"],
    exposeHeaders: ["retry-after", "content-length"],
    maxAge: 600,
  })(c, next);
});

// Rate limiting runs inside CORS so browsers can read 429 responses.
app.use("*", async (c, next) => {
  await limitIp(c.env, c.req.header("cf-connecting-ip") ?? null);
  await next();
});

app.onError((err, c) => {
  if (err instanceof HttpError) return errorResponse(err);
  log({ event: "internal_error", method: c.req.method, route: routePath(c), status: 500 });
  console.error(err);
  return errorResponse(new HttpError(500, "bad_request", "internal error"));
});

app.notFound(() => errorResponse(Errors.notFound()));

// ---------------------------------------------------------------- health, turn

app.get(Paths.health(), (c) => c.json({ ok: true, service: "sealed-relay", version: VERSION, time: nowSeconds() }));

app.get(Paths.turn(), async (c) => {
  await deviceAuth(c);
  return c.json(await iceServers(c.env));
});

// ---------------------------------------------------------------- identities

app.post(Paths.identities(), async (c) => {
  await limitSignup(c.env, c.req.header("cf-connecting-ip") ?? null);
  const { link } = parse(CreateIdentityRequest, await jsonBody(c));
  let bytes: Uint8Array;
  try {
    bytes = fromB64url(link);
  } catch {
    throw Errors.badRequest("link must be base64url");
  }
  const fp = toB64url(sha256(bytes));
  const r = unwrap(await identity(c.env, fp).create(fp, link));
  return c.json(r, 201);
});

app.get(Paths.chain(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const sinceRaw = c.req.query("since") ?? "0";
  if (!/^(0|[1-9][0-9]{0,9})$/.test(sinceRaw)) throw Errors.badRequest("since must be a non-negative integer");
  const since = Number(sinceRaw);
  const head = await c.env.DB.prepare("SELECT head_seq FROM identities WHERE fp = ?").bind(fp).first<{ head_seq: number }>();
  if (!head) throw Errors.notFound("unknown identity");
  const rows = await c.env.DB.prepare("SELECT body FROM links WHERE fp = ? AND seq >= ? AND seq <= ? ORDER BY seq").bind(fp, since, head.head_seq).all<{ body: string }>();
  c.header("cache-control", "no-store");
  return c.json({ fingerprint: fp, links: rows.results.map((r) => r.body), head_seq: head.head_seq });
});

app.post(Paths.links(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const { links } = parse(AppendLinksRequest, await jsonBody(c));
  const auth = await deviceAuth(c, { links });
  if (auth.fp !== fp) throw Errors.forbidden("may only append to your own identity");
  return c.json({ head_seq: auth.headSeq });
});

app.put(Paths.sync(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const { ciphertext } = parse(PutSyncBlobRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  if (auth.fp !== fp) throw Errors.forbidden("may only write your own sync blob");
  unwrap(await identity(c.env, fp).putSyncBlob(fp, ciphertext));
  return c.json({ ok: true });
});

app.get(Paths.sync(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const auth = await deviceAuth(c);
  if (auth.fp !== fp) throw Errors.forbidden("may only read your own sync blob");
  c.header("cache-control", "no-store");
  return c.json(unwrap(await identity(c.env, fp).getSyncBlob(fp)));
});

app.post(Paths.pairingReturn(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const { bundle } = parse(PostPairingReturnRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  unwrap(await identity(c.env, fp).postPairingReturn(auth.fp, bundle));
  return c.json({ ok: true });
});

app.get(Paths.pairingReturn(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const auth = await deviceAuth(c);
  if (auth.fp !== fp) throw Errors.forbidden("may only read your own pairing return");
  c.header("cache-control", "no-store");
  return c.json(unwrap(await identity(c.env, fp).getPairingReturn(fp)));
});

app.post(Paths.prekeys(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const body = parse(UploadPrekeysRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  if (auth.fp !== fp || body.device !== auth.deviceId) throw Errors.forbidden("a device may upload only its own prekeys");
  return c.json(unwrap(await identity(c.env, fp).uploadPrekeys(auth.deviceId, body.prekeys)));
});

app.get(Paths.prekeyCount(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const auth = await deviceAuth(c);
  if (auth.fp !== fp) throw Errors.forbidden();
  const device = c.req.query("device") ?? auth.deviceId;
  if (!isB64Id(device, DEVICE_ID_BYTES)) throw Errors.badRequest("device must be a compressed signing key");
  return c.json(unwrap(await identity(c.env, fp).prekeyCount(device)));
});

const ClaimPrekeysBody = z.object({ devices: z.array(z.string()).max(64).optional() });

app.post(Paths.claimPrekeys(":fp"), async (c) => {
  const fp = param(c, "fp", FINGERPRINT_BYTES);
  const body = parse(ClaimPrekeysBody, await jsonBody(c));
  await deviceAuth(c);
  return c.json(unwrap(await identity(c.env, fp).claimPrekeys(body.devices)));
});

// ---------------------------------------------------------------- transfers (sender)

app.post(Paths.transfers(), async (c) => {
  const req = parse(CreateTransferRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  const now = nowSeconds();

  if (req.mode === "paired") {
    if (req.claim_hash !== undefined || req.room !== undefined) throw Errors.badRequest("paired transfers take no claim_hash or room options");
  } else {
    if (!req.claim_hash || !isB64Id(req.claim_hash, 32)) throw Errors.badRequest("claim_hash must be base64url SHA-256");
    if (req.mode === "direct" && req.room !== undefined) throw Errors.badRequest("room options require mode room");
  }
  if (req.ttl_seconds > maxTtlFor(req.mode)) throw Errors.badRequest(`ttl_seconds exceeds the ${req.mode} maximum of ${maxTtlFor(req.mode)}`);
  if (sizeBucket(req.size_bucket) !== req.size_bucket) throw Errors.badRequest("size_bucket must be a size bucket (spec §8.3)");

  const account = await c.env.DB.prepare("SELECT plan, created_at FROM identities WHERE fp = ?").bind(auth.fp).first<{ plan: Plan; created_at: number }>();
  if (!account) throw Errors.unauthorized("unknown identity");
  const limits = effectiveLimits(account.plan, account.created_at, now);
  if (req.size_bucket > limits.maxBucketBytes) throw Errors.tooLarge(`size bucket exceeds your plan limit of ${limits.maxBucketBytes} bytes`);
  const room = req.mode === "room" ? (req.room ?? { window_seconds: Limits.roomDefaultWindowSeconds, cap: Limits.roomDefaultCap, approval: "each" as const }) : null;
  if (room && room.cap > limits.maxRoomCap) throw Errors.forbidden(`room cap exceeds your plan limit of ${limits.maxRoomCap}`);
  const usage = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size_bucket), 0) AS bytes FROM transfers WHERE sender_fp = ? AND created_hour >= ?")
    .bind(auth.fp, hourFloor(now) - 23 * 3600)
    .first<{ n: number; bytes: number }>();
  if (usage && (usage.n >= limits.maxTransfersPerDay || usage.bytes + req.size_bucket > limits.maxDailyBytes)) throw Errors.rateLimited(3600);

  const maxSegments = Math.max(1, Math.ceil(req.size_bucket / MiB));
  if (req.segments > maxSegments) throw Errors.badRequest("segments exceed the size bucket");
  const transferId = randomId(TRANSFER_ID_BYTES);
  const uploadToken = randomId(32);
  const expiresAt = now + req.ttl_seconds;

  await c.env.DB.prepare("INSERT INTO transfers (transfer_id, sender_fp, mode, size_bucket, created_hour, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, 'open')")
    .bind(transferId, auth.fp, req.mode, req.size_bucket, hourFloor(now), expiresAt)
    .run();
  unwrap(
    await transfer(c.env, transferId).init({
      transferId,
      mode: req.mode,
      senderFp: auth.fp,
      claimHash: req.claim_hash ?? null,
      uploadTokenHash: hashSecret(uploadToken),
      sizeBucket: req.size_bucket,
      maxSegments,
      maxPaddingParts: Math.ceil(req.size_bucket / Limits.maxPaddingPartBytes) + 1,
      maxTotalBytes: req.size_bucket,
      expiresAt,
      room: room ? { windowSeconds: room.window_seconds, cap: room.cap, approval: room.approval } : null,
    }),
  );
  log({ event: "transfer_created", transfer_id: transferId, mode: req.mode, size_bucket: req.size_bucket });
  return c.json(
    { transfer_id: transferId, upload_token: uploadToken, expires_at: expiresAt, events_url: `${wsOrigin(c.env.PUBLIC_URL, c.req.url)}${Paths.transferEvents(transferId)}?token=${encodeURIComponent(uploadToken)}` },
    201,
  );
});

async function uploadPart(c: AppContext, kind: PartKind, n: number): Promise<Response> {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const token = requireBearer(c);
  const max = kind === "segment" ? Limits.maxSegmentCipherBytes : kind === "padding" ? Limits.maxPaddingPartBytes : MAX_MANIFEST_PART_BYTES;
  const bytes = await readBounded(c.req.raw, max);
  const stub = transfer(c.env, id);
  const { key, expiresAt, lease } = unwrap(await stub.beginPart(token, kind, n, bytes.length));
  let stored: number;
  try {
    stored = await putPart(c.env, key, bytes, expiresAt);
  } catch (e) {
    await stub.abortPart(kind, n, lease);
    throw e;
  }
  unwrap(await stub.commitPart(token, kind, n, lease, stored));
  return c.json(OK);
}

app.put(Paths.manifest(":id"), (c) => uploadPart(c, "manifest", 0));
app.put(Paths.segment(":id", ":n" as unknown as number), (c) => uploadPart(c, "segment", index(c, "n")));
app.put(Paths.padding(":id", ":k" as unknown as number), (c) => uploadPart(c, "padding", index(c, "k")));

app.post(Paths.finalize(":id"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const token = requireBearer(c);
  const req = parse(FinalizeRequest, await jsonBody(c));
  unwrap(await transfer(c.env, id).finalize(token, req.segments, req.padding_parts));
  return c.json(OK);
});

app.get(Paths.transfer(":id"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const auth = await deviceAuth(c);
  return c.json(unwrap(await transfer(c.env, id).status(auth.fp)));
});

app.delete(Paths.transfer(":id"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const auth = await deviceAuth(c);
  unwrap(await transfer(c.env, id).cancel(auth.fp));
  return c.json(OK);
});

/** Forwards a WebSocket upgrade to a Durable Object with server-set (never client-set) routing headers. */
function forwardSocket(c: AppContext, stub: { fetch(r: Request): Promise<Response> }, headers: Record<string, string>): Promise<Response> {
  if (!isUpgrade(c)) throw new HttpError(426, "bad_request", "expected a WebSocket upgrade");
  const h = new Headers({ upgrade: "websocket", ...headers });
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    const v = c.req.header(name);
    if (v) h.set(name, v);
  }
  return stub.fetch(new Request("https://do.internal/ws", { headers: h }));
}

app.get(Paths.transferEvents(":id"), (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const token = requireBearer(c, true);
  return forwardSocket(c, transfer(c.env, id), { "x-sealed-role": "sender", "x-sealed-token-hash": hashSecret(token) });
});

// ---------------------------------------------------------------- claims

app.post(Paths.claims(":id"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const req = parse(ClaimRequest, await jsonBody(c));
  const r = unwrap(await transfer(c.env, id).claim(req, wsOrigin(c.env.PUBLIC_URL, c.req.url)));
  return c.json(r, 202);
});

app.post(Paths.approve(":id", ":cid"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const req = parse(ApproveRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  let wrap: Uint8Array;
  try {
    wrap = fromB64url(req.wrap);
  } catch {
    throw Errors.badRequest("wrap must be base64url");
  }
  if (req.uv.kind === "device") {
    // ADR-0005: the request signature itself is user verification only when the key is hardware-gated.
    if (!HARDWARE_PROTECTIONS.includes(auth.protection)) throw Errors.forbidden("device user verification requires a hardware-protected key; use a passkey");
  } else {
    await verifyAssertion(c.env, relyingParty(c.env, c.req.url), auth.fp, approvalAction(id, cid, wrap), req.uv);
  }
  unwrap(await transfer(c.env, id).approve(auth.fp, cid, req.wrap));
  return c.json(OK);
});

app.post(Paths.deny(":id", ":cid"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const auth = await deviceAuth(c);
  unwrap(await transfer(c.env, id).deny(auth.fp, cid));
  return c.json(OK);
});

app.delete(Paths.claim(":id", ":cid"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const auth = await deviceAuth(c);
  unwrap(await transfer(c.env, id).revoke(auth.fp, cid));
  return c.json(OK);
});

/** Resolves a claim token and checks that it belongs to the transfer in the path (when there is one). */
function claimToken(c: AppContext, pathTransferId?: string, socket = false): { transferId: string; tokenHash: string } {
  const token = requireBearer(c, socket);
  const transferId = transferIdFromClaimToken(token);
  if (pathTransferId !== undefined && transferId !== pathTransferId) throw Errors.unauthorized("claim token is for a different transfer");
  return { transferId, tokenHash: hashSecret(token) };
}

app.get(Paths.wrap(":id", ":cid"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const { tokenHash } = claimToken(c, id);
  c.header("cache-control", "no-store");
  return c.json(unwrap(await transfer(c.env, id).getWrap(cid, tokenHash)));
});

app.post(Paths.complete(":id", ":cid"), async (c) => {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const { tokenHash } = claimToken(c, id);
  unwrap(await transfer(c.env, id).complete(cid, tokenHash));
  return c.json(OK);
});

app.get(Paths.claimStatus(":cid"), async (c) => {
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const { transferId, tokenHash } = claimToken(c);
  const waitRaw = c.req.query("wait") ?? "0";
  const wait = /^[0-9]{1,3}$/.test(waitRaw) ? Number(waitRaw) : 0;
  return c.json(unwrap(await transfer(c.env, transferId).claimStatus(cid, tokenHash, wait)));
});

app.get(Paths.claimEvents(":cid"), (c) => {
  const cid = param(c, "cid", CLAIM_ID_BYTES);
  const { transferId, tokenHash } = claimToken(c, undefined, true);
  return forwardSocket(c, transfer(c.env, transferId), { "x-sealed-role": "receiver", "x-sealed-token-hash": tokenHash, "x-sealed-claim": cid });
});

// ---------------------------------------------------------------- downloads

async function download(c: AppContext, kind: "manifest" | "segment", n: number): Promise<Response> {
  const id = param(c, "id", TRANSFER_ID_BYTES);
  let auth: { kind: "claim"; tokenHash: string } | { kind: "device"; fp: string; device: string };
  if (bearerToken(c)) {
    auth = { kind: "claim", tokenHash: claimToken(c, id).tokenHash };
  } else if (hasDeviceSignature(c)) {
    const d = await deviceAuth(c);
    auth = { kind: "device", fp: d.fp, device: d.deviceId };
  } else {
    throw Errors.unauthorized("a claim token or device signature is required");
  }
  const { key } = unwrap(await transfer(c.env, id).authorizeDownload(auth, kind, n));
  const res = await streamPart(c.env, key);
  if (!res) throw Errors.notFound("ciphertext missing");
  return res;
}

app.get(Paths.manifest(":id"), (c) => download(c, "manifest", 0));
app.get(Paths.segment(":id", ":n" as unknown as number), (c) => download(c, "segment", index(c, "n")));

// ---------------------------------------------------------------- mailbox (Paired)

app.post(Paths.mailbox(":fp"), async (c) => {
  const recipientFp = param(c, "fp", FINGERPRINT_BYTES);
  const req = parse(DeliverRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  if (req.sender_fp !== auth.fp) throw Errors.forbidden("sender_fp must be the signing identity");
  if (!isB64Id(req.transfer_id, TRANSFER_ID_BYTES)) throw Errors.badRequest("transfer_id must be 16 bytes");
  const t = transfer(c.env, req.transfer_id);
  // Validates sender ownership and mode, and yields the transfer expiry used as the mailbox TTL.
  const { expiresAt } = unwrap(await t.grant(auth.fp, recipientFp, []));
  const { devices } = unwrap(
    await identity(c.env, recipientFp).deliver({ transferId: req.transfer_id, senderFp: auth.fp, senderDevice: auth.deviceId, expiresAt, wraps: req.wraps }),
  );
  unwrap(await t.grant(auth.fp, recipientFp, devices));
  log({ event: "mailbox_delivered", transfer_id: req.transfer_id, count: devices.length });
  return c.json(OK);
});

app.get(Paths.myMailbox(), async (c) => {
  const auth = await deviceAuth(c);
  c.header("cache-control", "no-store");
  return c.json({ items: await identity(c.env, auth.fp).listMailbox(auth.deviceId) });
});

app.delete(Paths.mailboxItem(":transferId"), async (c) => {
  const transferId = param(c, "transferId", TRANSFER_ID_BYTES);
  const auth = await deviceAuth(c);
  await identity(c.env, auth.fp).ackMailbox(auth.deviceId, transferId);
  return c.json(OK);
});

// ---------------------------------------------------------------- presence

app.get(Paths.presence(), async (c) => {
  if (!isUpgrade(c)) throw new HttpError(426, "bad_request", "expected a WebSocket upgrade");
  const auth = await deviceAuth(c, { socket: true });
  return forwardSocket(c, identity(c.env, auth.fp), { "x-sealed-device": auth.deviceId });
});

// ---------------------------------------------------------------- push, webauthn, reports

app.post(Paths.push(), async (c) => {
  const req = parse(PushRegistration, await jsonBody(c));
  const auth = await deviceAuth(c);
  unwrap(await identity(c.env, auth.fp).registerPush(auth.deviceId, req.platform, req.token));
  return c.json(OK);
});

app.post(Paths.webauthnRegisterOptions(), async (c) => {
  const auth = await deviceAuth(c);
  return c.json({ options: await registrationOptions(c.env, relyingParty(c.env, c.req.url), auth.fp, "Sealed") });
});

app.post(Paths.webauthnRegisterVerify(), async (c) => {
  const { response } = parse(WebAuthnRegisterVerifyRequest, await jsonBody(c));
  const auth = await deviceAuth(c);
  await verifyRegistration(c.env, relyingParty(c.env, c.req.url), auth.fp, response);
  return c.json(OK);
});

const AuthOptionsBody = z.object({ action: z.string().min(1).max(256) });

app.post(Paths.webauthnAuthOptions(), async (c) => {
  const { action } = parse(AuthOptionsBody, await jsonBody(c));
  const auth = await deviceAuth(c);
  return c.json({ options: await authenticationOptions(c.env, relyingParty(c.env, c.req.url), auth.fp, action) });
});

app.post(Paths.reports(), async (c) => {
  const req = parse(ReportRequest, await jsonBody(c));
  if (!isB64Id(req.transfer_id, TRANSFER_ID_BYTES)) throw Errors.badRequest("transfer_id must be 16 bytes");
  if (req.evidence_sha256 !== undefined && !isB64Id(req.evidence_sha256, 32)) throw Errors.badRequest("evidence_sha256 must be 32 bytes");
  let reporterKind: "claim" | "device";
  let reporter: string;
  let senderFp: string | null;
  if (bearerToken(c)) {
    const { tokenHash } = claimToken(c, req.transfer_id);
    const ctx = unwrap(await transfer(c.env, req.transfer_id).reportContext(tokenHash));
    reporterKind = "claim";
    reporter = ctx.claimId;
    senderFp = ctx.senderFp;
  } else {
    const auth = await deviceAuth(c);
    const row = await c.env.DB.prepare("SELECT sender_fp FROM transfers WHERE transfer_id = ?").bind(req.transfer_id).first<{ sender_fp: string }>();
    if (!row) throw Errors.notFound("unknown transfer");
    reporterKind = "device";
    reporter = auth.fp;
    senderFp = row.sender_fp;
  }
  const ip = c.req.header("cf-connecting-ip");
  await c.env.DB.prepare(
    "INSERT INTO reports (report_id, transfer_id, sender_fp, reporter_kind, reporter, reason, details, evidence_sha256, ip_hash, created_hour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(16), req.transfer_id, senderFp, reporterKind, reporter, req.reason, req.details ?? null, req.evidence_sha256 ?? null, ip ? await hashIp(c.env.IP_HASH_SECRET ?? "", ip) : null, hourFloor())
    .run();
  log({ event: "report", transfer_id: req.transfer_id, code: req.reason });
  return c.json(OK, 201);
});

// ---------------------------------------------------------------- expiry sweeper (cron)

/** How long expired/cancelled transfer rows are kept for daily-limit accounting before deletion. */
const ROW_RETENTION_SECONDS = 2 * 86400;
const SWEEP_BATCH = 200;

export async function sweep(env: Env, now = nowSeconds()): Promise<{ expired: number; orphans: number; rows: number }> {
  let expired = 0;
  const due = await env.DB.prepare("SELECT transfer_id FROM transfers WHERE status IN ('open', 'uploaded') AND expires_at <= ? LIMIT ?").bind(now, SWEEP_BATCH).all<{ transfer_id: string }>();
  for (const { transfer_id } of due.results) {
    await transfer(env, transfer_id).expire("expired");
    await env.DB.prepare("UPDATE transfers SET status = 'expired' WHERE transfer_id = ? AND status IN ('open', 'uploaded')").bind(transfer_id).run();
    expired++;
  }

  // Objects whose `expires` metadata has passed (e.g. their DO state was lost) are deleted directly.
  let orphans = 0;
  let cursor: string | undefined;
  const stale = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const list = await env.BUCKET.list({ prefix: "t/", include: ["customMetadata"], limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of list.objects) {
      const exp = Number(o.customMetadata?.["expires"] ?? "0");
      if (exp > 0 && exp <= now) stale.add(o.key.split("/")[1] ?? "");
    }
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  for (const id of stale) {
    if (!id) continue;
    orphans += await deleteTransferObjects(env, id);
  }

  const del = await env.DB.prepare("DELETE FROM transfers WHERE status IN ('expired', 'cancelled') AND expires_at <= ?").bind(now - ROW_RETENTION_SECONDS).run();
  const rows = del.meta.changes ?? 0;
  if (expired + orphans + rows > 0) log({ event: "sweep", count: expired + orphans + rows });
  return { expired, orphans, rows };
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;
