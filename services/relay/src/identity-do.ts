/**
 * IdentityDO — one per identity fingerprint (spec §9.1). Single writer for:
 *   - the verified sigchain (mirrored to D1 for reads), and request-signature verification with a nonce cache,
 *   - per-device one-time prekey pools (atomic hand-out),
 *   - the Paired mailbox index and push tokens,
 *   - WebAuthn challenges bound to actions,
 *   - presence and signaling sockets (Hibernatable WebSocket API).
 */
import {
  Limits,
  PresenceClientFrame,
  activeDevices,
  compress,
  extendChain,
  fromB64url,
  linkHash,
  parseSignatureHeader,
  toB64url,
  toHex,
  verifyChain,
  verifyPrekey,
  verifyRequestSignature,
  type ChainState,
  type DeviceRecord,
  type KeyProtection,
  type MailboxItem,
  type PresenceServerFrame,
  type SignedPrekey,
} from "@sealed/core";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { fail, ok, type Result } from "./http";
import { log } from "./log";
import { sendPush, validatePushToken, type PushPlatform } from "./push";
import { FINGERPRINT_BYTES, decodeB64, isB64Id, nowSeconds, randomId } from "./util";

export interface DeviceAuth {
  fp: string;
  /** b64url(compressed signing key) — the device id used across the API. */
  deviceId: string;
  signingPublicKey: string;
  agreementPublicKey: string;
  protection: KeyProtection;
  headSeq: number;
}

export interface VerifyRequestInput {
  fp: string;
  header: string;
  method: string;
  path: string;
  body: Uint8Array;
  /** Links to apply before checking the signer (append-links, including paper-key recovery). */
  links?: string[];
}

export interface DeliverInput {
  transferId: string;
  senderFp: string;
  senderDevice: string;
  expiresAt: number;
  wraps: { device: string; prekey_id: string | null; wrap: string }[];
}

interface SocketAttachment {
  device: string;
  watch: string[];
}

const NONCE_TTL_SECONDS = 300;
const CHALLENGE_TTL_SECONDS = 300;
const WATCH_TTL_SECONDS = 3600;
const MAX_PREKEYS_PER_DEVICE = 1000;
const MAX_SIGNAL_PAYLOAD_BYTES = 64 * 1024;
const MAX_LINK_BYTES = 8192;

function deviceId(d: DeviceRecord): string {
  return toB64url(compress(d.signingPublicKey));
}

function findDevice(state: ChainState, id: string): DeviceRecord | undefined {
  const bytes = decodeB64(id, 33);
  return bytes ? state.devices.get(toHex(bytes)) : undefined;
}

export class IdentityDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** undefined = not loaded yet; null = no identity stored in this object. */
  private chain: ChainState | null | undefined;

  /** Whether the schema exists. Unknown fingerprints never write storage, so probes persist nothing. */
  private hasSchema: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.hasSchema = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'links'").toArray().length > 0;
    // Presence keep-alive frames are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  private ensureSchema(): void {
    if (!this.hasSchema) {
      this.sql.exec(`
      CREATE TABLE IF NOT EXISTS links (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS prekeys (device TEXT NOT NULL, id TEXT NOT NULL, pub TEXT NOT NULL, sig TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (device, id));
      CREATE INDEX IF NOT EXISTS prekeys_order ON prekeys (device, seq);
      CREATE TABLE IF NOT EXISTS mailbox (transfer_id TEXT NOT NULL, device TEXT NOT NULL, sender_fp TEXT NOT NULL, sender_device TEXT NOT NULL, prekey_id TEXT, wrap TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (transfer_id, device));
      CREATE INDEX IF NOT EXISTS mailbox_device ON mailbox (device, created_at);
      CREATE TABLE IF NOT EXISTS push (device TEXT NOT NULL, platform TEXT NOT NULL, token TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (device, platform));
      CREATE TABLE IF NOT EXISTS challenges (challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, action TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watchers (fp TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `);
      this.hasSchema = true;
    }
    // Additive tables for sync + one-sided pairing (safe on already-initialized DOs).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sync_blob (k INTEGER PRIMARY KEY CHECK (k = 1), ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_return (bundle TEXT NOT NULL, from_fp TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }

  // ------------------------------------------------------------------ chain

  private load(): ChainState | null {
    if (this.chain !== undefined) return this.chain;
    if (!this.hasSchema) return null;
    const rows = this.sql.exec<{ body: string }>("SELECT body FROM links ORDER BY seq").toArray();
    this.chain = rows.length === 0 ? null : verifyChain(rows.map((r) => fromB64url(r.body)));
    return this.chain;
  }

  private fingerprint(): string | null {
    const s = this.load();
    return s ? toB64url(s.fingerprint) : null;
  }

  /**
   * Mirrors identity, links and devices to D1 (the read path for GET …/chain). The DO is the source of truth;
   * `mirrored_seq` in DO storage records what D1 holds, so a failed mirror is repaired on the next request
   * instead of leaving D1 permanently behind. D1 batches are transactional and every write is idempotent.
   */
  private async mirror(): Promise<void> {
    const state = this.load();
    if (!state) return;
    const mirrored = Number(this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'mirrored_seq'").toArray()[0]?.v ?? "-1");
    if (mirrored >= state.seq) return;
    const fp = toB64url(state.fingerprint);
    const createdAt = Number(this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'created_at'").one().v);
    const links = this.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM links WHERE seq > ? ORDER BY seq", mirrored).toArray();
    const stmts: D1PreparedStatement[] = [
      this.env.DB.prepare("INSERT OR IGNORE INTO identities (fp, created_at, head_seq, head_hash) VALUES (?, ?, ?, ?)").bind(fp, createdAt, state.seq, toB64url(state.headHash)),
      this.env.DB.prepare("UPDATE identities SET head_seq = ?, head_hash = ? WHERE fp = ? AND head_seq < ?").bind(state.seq, toB64url(state.headHash), fp, state.seq),
    ];
    for (const l of links) {
      stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO links (fp, seq, hash, body) VALUES (?, ?, ?, ?)").bind(fp, l.seq, toB64url(linkHash(fromB64url(l.body))), l.body));
    }
    for (const d of state.devices.values()) {
      stmts.push(
        this.env.DB.prepare(
          "INSERT INTO devices (fp, dsk_id, dak_pub, dsk_pub, protection, status, added_seq, revoked_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (fp, dsk_id) DO UPDATE SET status = excluded.status, revoked_seq = excluded.revoked_seq",
        ).bind(fp, deviceId(d), toB64url(compress(d.agreementPublicKey)), toB64url(d.signingPublicKey), d.protection, d.revokedSeq === undefined ? "active" : "revoked", d.addedSeq, d.revokedSeq ?? null),
      );
    }
    await this.env.DB.batch(stmts);
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('mirrored_seq', ?)", String(state.seq));
  }

  async create(fp: string, linkB64: string): Promise<Result<{ fingerprint: string; head_seq: number }>> {
    const link = decodeB64(linkB64);
    if (!link || link.length === 0 || link.length > MAX_LINK_BYTES) return fail(400, "bad_request", "link must be base64url CBOR");
    let state: ChainState;
    try {
      state = verifyChain([link]);
    } catch (e) {
      return fail(400, "chain_invalid", (e as Error).message);
    }
    if (toB64url(state.fingerprint) !== fp) return fail(400, "chain_invalid", "fingerprint mismatch");
    const existing = this.load();
    if (existing) {
      await this.mirror();
      return ok({ fingerprint: fp, head_seq: existing.seq });
    }
    this.ensureSchema();
    const now = nowSeconds();
    this.sql.exec("INSERT INTO links (seq, body) VALUES (0, ?)", linkB64);
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('created_at', ?)", String(now));
    this.chain = state;
    await this.mirror();
    log({ event: "identity_created", fp });
    return ok({ fingerprint: fp, head_seq: 0 });
  }

  async headSeq(): Promise<number | null> {
    return this.load()?.seq ?? null;
  }

  /**
   * Verifies a device-signed request (spec §9.2): known identity, signer active (after applying `links`, if
   * any), signature valid within ±120 s, nonce unseen in the last 5 minutes. Persists `links` on success.
   */
  async verifyRequest(input: VerifyRequestInput): Promise<Result<DeviceAuth>> {
    let parts;
    try {
      parts = parseSignatureHeader(input.header);
    } catch (e) {
      return fail(401, "unauthorized", (e as Error).message);
    }
    const current = this.load();
    if (!current) return fail(401, "unauthorized", "unknown identity");
    const fp = toB64url(current.fingerprint);
    if (toB64url(parts.fingerprint) !== fp || input.fp !== fp) return fail(401, "unauthorized", "identity mismatch");

    let next = current;
    const added: { seq: number; body: Uint8Array }[] = [];
    if (input.links && input.links.length > 0) {
      try {
        const bodies = input.links.map((l) => {
          const b = decodeB64(l);
          if (!b || b.length === 0 || b.length > MAX_LINK_BYTES) throw new Error("malformed link");
          return b;
        });
        next = extendChain(current, bodies);
        // extendChain skips links that match the verified prefix; keep only the newly applied ones.
        for (const b of bodies) {
          const seq = next.hashes.findIndex((h, i) => i > current.seq && toB64url(h) === toB64url(linkHash(b)));
          if (seq > current.seq) added.push({ seq, body: b });
        }
        if (added.length !== next.seq - current.seq) throw new Error("internal: applied links do not match the new head");
      } catch (e) {
        return fail(409, "chain_invalid", (e as Error).message);
      }
    }

    const device = next.devices.get(toHex(parts.keyId));
    if (!device || device.revokedSeq !== undefined) return fail(401, "unauthorized", "signing device is not active in this identity");
    const now = nowSeconds();
    if (!verifyRequestSignature(device.signingPublicKey, parts, input.method, input.path, input.body, now, Limits.requestClockSkewSeconds)) {
      return fail(401, "unauthorized", "bad request signature or clock skew");
    }
    const nonce = toB64url(parts.nonce);
    this.sql.exec("DELETE FROM nonces WHERE expires_at < ?", now);
    if (this.sql.exec("SELECT 1 FROM nonces WHERE nonce = ?", nonce).toArray().length > 0) return fail(401, "unauthorized", "replayed request");
    this.sql.exec("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)", nonce, now + NONCE_TTL_SECONDS);

    if (added.length > 0) {
      for (const l of added) this.sql.exec("INSERT INTO links (seq, body) VALUES (?, ?)", l.seq, toB64url(l.body));
      const revoked = [...current.devices.values()].filter((d) => d.revokedSeq === undefined && next.devices.get(toHex(compress(d.signingPublicKey)))?.revokedSeq !== undefined);
      this.chain = next;
      for (const d of revoked) this.forgetDevice(deviceId(d));
      log({ event: "chain_extended", fp, count: added.length });
    }
    if (input.links) await this.mirror();

    return ok({
      fp,
      deviceId: toB64url(parts.keyId),
      signingPublicKey: toB64url(device.signingPublicKey),
      agreementPublicKey: toB64url(compress(device.agreementPublicKey)),
      protection: device.protection,
      headSeq: next.seq,
    });
  }

  /** Drops everything held for a revoked device and closes its sockets. */
  private forgetDevice(device: string): void {
    this.sql.exec("DELETE FROM prekeys WHERE device = ?", device);
    this.sql.exec("DELETE FROM mailbox WHERE device = ?", device);
    this.sql.exec("DELETE FROM push WHERE device = ?", device);
    for (const ws of this.ctx.getWebSockets(`dev:${device}`)) {
      try {
        ws.close(4003, "device revoked");
      } catch {
        // already closed
      }
    }
  }

  /** Active device ids of this identity (for delivery validation by callers). */
  async activeDeviceIds(): Promise<string[] | null> {
    const s = this.load();
    return s ? activeDevices(s).map(deviceId) : null;
  }

  // ------------------------------------------------------------------ prekeys

  async uploadPrekeys(device: string, prekeys: SignedPrekey[]): Promise<Result<{ count: number }>> {
    const s = this.load();
    const d = s ? findDevice(s, device) : undefined;
    if (!d || d.revokedSeq !== undefined) return fail(403, "forbidden", "device is not active");
    for (const p of prekeys) {
      if (!isB64Id(p.id, 8) || !verifyPrekey(d.signingPublicKey, p)) return fail(400, "bad_request", "invalid prekey signature");
    }
    const have = this.countPrekeys(device);
    if (have + prekeys.length > MAX_PREKEYS_PER_DEVICE) return fail(413, "too_large", `at most ${MAX_PREKEYS_PER_DEVICE} prekeys per device`);
    let seq = this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM prekeys WHERE device = ?", device).one().m ?? 0;
    for (const p of prekeys) {
      seq++;
      this.sql.exec("INSERT OR IGNORE INTO prekeys (device, id, pub, sig, seq) VALUES (?, ?, ?, ?, ?)", device, p.id, p.pub, p.sig, seq);
    }
    return ok({ count: this.countPrekeys(device) });
  }

  private countPrekeys(device: string): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM prekeys WHERE device = ?", device).one().n;
  }

  async prekeyCount(device: string): Promise<Result<{ count: number }>> {
    const s = this.load();
    const d = s ? findDevice(s, device) : undefined;
    if (!d || d.revokedSeq !== undefined) return fail(404, "not_found", "unknown device");
    return ok({ count: this.countPrekeys(device) });
  }

  /** Hands out one one-time prekey per active device, removing it from the pool in the same turn. */
  async claimPrekeys(filter?: string[]): Promise<Result<{ fingerprint: string; head_seq: number; devices: { device: string; prekey: SignedPrekey | null }[] }>> {
    const s = this.load();
    if (!s) return fail(404, "not_found", "unknown identity");
    const wanted = filter ? new Set(filter) : null;
    const devices: { device: string; prekey: SignedPrekey | null }[] = [];
    for (const d of activeDevices(s)) {
      const id = deviceId(d);
      if (wanted && !wanted.has(id)) continue;
      const row = this.sql.exec<{ id: string; pub: string; sig: string }>("SELECT id, pub, sig FROM prekeys WHERE device = ? ORDER BY seq LIMIT 1", id).toArray()[0];
      if (row) this.sql.exec("DELETE FROM prekeys WHERE device = ? AND id = ?", id, row.id);
      devices.push({ device: id, prekey: row ? { id: row.id, pub: row.pub, sig: row.sig } : null });
    }
    return ok({ fingerprint: toB64url(s.fingerprint), head_seq: s.seq, devices });
  }

  // ------------------------------------------------------------------ mailbox

  async deliver(input: DeliverInput): Promise<Result<{ devices: string[] }>> {
    const s = this.load();
    if (!s) return fail(404, "not_found", "unknown recipient identity");
    const seen = new Set<string>();
    for (const w of input.wraps) {
      const d = findDevice(s, w.device);
      if (!d || d.revokedSeq !== undefined) return fail(400, "bad_request", "wrap addressed to a device that is not active in the recipient identity");
      if (seen.has(w.device)) return fail(400, "bad_request", "duplicate device in wraps");
      seen.add(w.device);
      if (w.prekey_id !== null && !isB64Id(w.prekey_id, 8)) return fail(400, "bad_request", "prekey_id must be 8 bytes");
      const wrap = decodeB64(w.wrap);
      if (!wrap || wrap.length === 0 || wrap.length > 1024) return fail(400, "bad_request", "malformed wrap");
    }
    const now = nowSeconds();
    for (const w of input.wraps) {
      this.sql.exec(
        "INSERT OR REPLACE INTO mailbox (transfer_id, device, sender_fp, sender_device, prekey_id, wrap, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        input.transferId,
        w.device,
        input.senderFp,
        input.senderDevice,
        w.prekey_id,
        w.wrap,
        now,
        input.expiresAt,
      );
    }
    await this.scheduleAlarm();
    const devices = [...seen];
    for (const dev of devices) this.sendTo(dev, { type: "mailbox" });
    this.ctx.waitUntil(this.notifyPush(devices, input.transferId));
    return ok({ devices });
  }

  async listMailbox(device: string): Promise<MailboxItem[]> {
    const rows = this.sql
      .exec<{ transfer_id: string; sender_fp: string; sender_device: string; prekey_id: string | null; wrap: string; created_at: number; expires_at: number }>(
        "SELECT transfer_id, sender_fp, sender_device, prekey_id, wrap, created_at, expires_at FROM mailbox WHERE device = ? AND expires_at > ? ORDER BY created_at",
        device,
        nowSeconds(),
      )
      .toArray();
    return rows.map((r) => ({ ...r }));
  }

  async ackMailbox(device: string, transferId: string): Promise<boolean> {
    const n = this.sql.exec("DELETE FROM mailbox WHERE device = ? AND transfer_id = ?", device, transferId).rowsWritten;
    return n > 0;
  }

  // ------------------------------------------------------------------ push

  async registerPush(device: string, platform: PushPlatform, token: string): Promise<Result<true>> {
    const s = this.load();
    const d = s ? findDevice(s, device) : undefined;
    if (!d || d.revokedSeq !== undefined) return fail(403, "forbidden", "device is not active");
    const err = validatePushToken(platform, token);
    if (err) return fail(400, "bad_request", err);
    this.sql.exec("INSERT OR REPLACE INTO push (device, platform, token, updated_at) VALUES (?, ?, ?, ?)", device, platform, token, nowSeconds());
    return ok(true);
  }

  private async notifyPush(devices: string[], transferId: string): Promise<void> {
    for (const device of devices) {
      const rows = this.sql.exec<{ platform: PushPlatform; token: string }>("SELECT platform, token FROM push WHERE device = ?", device).toArray();
      for (const r of rows) {
        const outcome = await sendPush(this.env, r.platform, r.token, transferId);
        if (outcome === "gone") this.sql.exec("DELETE FROM push WHERE device = ? AND platform = ? AND token = ?", device, r.platform, r.token);
        if (outcome !== "skipped") log({ event: "push", provider: r.platform, code: outcome });
      }
    }
  }

  // ------------------------------------------------------------------ webauthn challenges

  async issueChallenge(kind: "register" | "auth", action: string): Promise<string> {
    const now = nowSeconds();
    this.sql.exec("DELETE FROM challenges WHERE expires_at < ?", now);
    const challenge = randomId(32);
    this.sql.exec("INSERT INTO challenges (challenge, kind, action, expires_at) VALUES (?, ?, ?, ?)", challenge, kind, action, now + CHALLENGE_TTL_SECONDS);
    return challenge;
  }

  /** Consumes a challenge if it was issued for exactly this kind and action and has not expired. */
  async consumeChallenge(challenge: string, kind: "register" | "auth", action: string): Promise<boolean> {
    const row = this.sql.exec<{ kind: string; action: string; expires_at: number }>("SELECT kind, action, expires_at FROM challenges WHERE challenge = ?", challenge).toArray()[0];
    if (!row) return false;
    this.sql.exec("DELETE FROM challenges WHERE challenge = ?", challenge);
    return row.kind === kind && row.action === action && row.expires_at >= nowSeconds();
  }

  // ------------------------------------------------------------------ presence and signaling

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    const device = request.headers.get("x-sealed-device");
    const s = this.load();
    const d = s && device ? findDevice(s, device) : undefined;
    if (!device || !d || d.revokedSeq !== undefined) return new Response("unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`dev:${device}`]);
    const att: SocketAttachment = { device, watch: [] };
    server.serializeAttachment(att);
    this.ctx.waitUntil(this.broadcastPresence());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_SIGNAL_PAYLOAD_BYTES * 2) return;
    let frame;
    try {
      const parsed = PresenceClientFrame.safeParse(JSON.parse(message));
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    const fp = this.fingerprint();
    if (!att || !fp) return;
    switch (frame.type) {
      case "ping":
        this.send(ws, { type: "pong" });
        return;
      case "signal": {
        if (!isB64Id(frame.to_fp, FINGERPRINT_BYTES)) return;
        const payload = decodeB64(frame.payload);
        if (!payload || payload.length > MAX_SIGNAL_PAYLOAD_BYTES) return;
        const out: PresenceServerFrame = { type: "signal", from_fp: fp, from_device: att.device, payload: frame.payload };
        if (frame.to_fp === fp) this.routeLocal(out, frame.to_device);
        else await this.env.IDENTITY.getByName(frame.to_fp).routeSignal(out, frame.to_device ?? null);
        return;
      }
      case "watch": {
        const fps = [...new Set(frame.fps.filter((f) => isB64Id(f, FINGERPRINT_BYTES)))];
        ws.serializeAttachment({ device: att.device, watch: fps } satisfies SocketAttachment);
        const counts = await Promise.all(fps.map((target) => (target === fp ? Promise.resolve(this.onlineCount()) : this.env.IDENTITY.getByName(target).subscribe(fp))));
        fps.forEach((target, i) => this.send(ws, { type: "presence", fp: target, devices_online: counts[i] ?? 0 }));
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    await this.broadcastPresence(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.broadcastPresence(ws);
  }

  /** Delivers a signaling frame from another identity to this identity's sockets. */
  async routeSignal(frame: PresenceServerFrame, toDevice: string | null): Promise<number> {
    return this.routeLocal(frame, toDevice ?? undefined);
  }

  private routeLocal(frame: PresenceServerFrame, toDevice?: string): number {
    const sockets = toDevice ? this.ctx.getWebSockets(`dev:${toDevice}`) : this.ctx.getWebSockets();
    for (const ws of sockets) this.send(ws, frame);
    return sockets.length;
  }

  /** Registers `watcherFp` for presence updates of this identity; returns the current online device count. */
  async subscribe(watcherFp: string): Promise<number> {
    if (!this.load()) return 0;
    this.sql.exec("INSERT OR REPLACE INTO watchers (fp, expires_at) VALUES (?, ?)", watcherFp, nowSeconds() + WATCH_TTL_SECONDS);
    return this.onlineCount();
  }

  /** Called by a watched identity's object when its online count changes. */
  async presenceChanged(fp: string, count: number): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.watch.includes(fp)) this.send(ws, { type: "presence", fp, devices_online: count });
    }
  }

  private onlineCount(exclude?: WebSocket): number {
    const devices = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude || ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att) devices.add(att.device);
    }
    return devices.size;
  }

  private async broadcastPresence(exclude?: WebSocket): Promise<void> {
    const fp = this.fingerprint();
    if (!fp) return;
    const count = this.onlineCount(exclude);
    const now = nowSeconds();
    this.sql.exec("DELETE FROM watchers WHERE expires_at < ?", now);
    const watchers = this.sql.exec<{ fp: string }>("SELECT fp FROM watchers").toArray();
    await this.presenceChanged(fp, count);
    await Promise.allSettled(watchers.filter((w) => w.fp !== fp).map((w) => this.env.IDENTITY.getByName(w.fp).presenceChanged(fp, count)));
  }

  private sendTo(device: string, frame: PresenceServerFrame): void {
    for (const ws of this.ctx.getWebSockets(`dev:${device}`)) this.send(ws, frame);
  }

  private send(ws: WebSocket, frame: PresenceServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // socket closing; presence is best-effort
    }
  }

  // ------------------------------------------------------------------ expiry

  // ------------------------------------------------------------------ contacts sync + one-sided pairing (spec §6.3.3–6.3.4)

  /** Store an opaque encrypted contacts sync blob. Only members of this identity may write. */
  async putSyncBlob(fp: string, ciphertext: string): Promise<Result<true>> {
    this.ensureSchema();
    const state = this.load();
    if (!state || toB64url(state.fingerprint) !== fp) return fail(404, "not_found", "unknown identity");
    if (ciphertext.length > 512_000) return fail(413, "too_large", "sync blob too large");
    this.sql.exec("INSERT INTO sync_blob (k, ciphertext, updated_at) VALUES (1, ?, ?) ON CONFLICT(k) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at", ciphertext, nowSeconds());
    return ok(true);
  }

  async getSyncBlob(fp: string): Promise<Result<{ ciphertext: string }>> {
    this.ensureSchema();
    const state = this.load();
    if (!state || toB64url(state.fingerprint) !== fp) return fail(404, "not_found", "unknown identity");
    const row = this.sql.exec<{ ciphertext: string }>("SELECT ciphertext FROM sync_blob WHERE k = 1").toArray()[0];
    if (!row) return fail(404, "not_found", "no sync blob");
    return ok({ ciphertext: row.ciphertext });
  }

  /** Bob posts a return bundle into Alice's identity DO (one-sided pairing). */
  async postPairingReturn(fromFp: string, bundle: string): Promise<Result<true>> {
    this.ensureSchema();
    if (!this.load()) return fail(404, "not_found", "unknown identity");
    if (bundle.length > 256_000) return fail(413, "too_large", "pairing return too large");
    const now = nowSeconds();
    // Keep only the latest pending return (one ceremony at a time).
    this.sql.exec("DELETE FROM pairing_return");
    this.sql.exec("INSERT INTO pairing_return (bundle, from_fp, created_at, expires_at) VALUES (?, ?, ?, ?)", bundle, fromFp, now, now + 600);
    await this.scheduleAlarm();
    return ok(true);
  }

  async getPairingReturn(fp: string): Promise<Result<{ bundle: string }>> {
    this.ensureSchema();
    const state = this.load();
    if (!state || toB64url(state.fingerprint) !== fp) return fail(404, "not_found", "unknown identity");
    const now = nowSeconds();
    this.sql.exec("DELETE FROM pairing_return WHERE expires_at <= ?", now);
    const row = this.sql.exec<{ bundle: string }>("SELECT bundle FROM pairing_return LIMIT 1").toArray()[0];
    if (!row) return fail(404, "not_found", "no pairing return");
    this.sql.exec("DELETE FROM pairing_return");
    return ok({ bundle: row.bundle });
  }

  private async scheduleAlarm(): Promise<void> {
    const nextMailbox = this.sql.exec<{ m: number | null }>("SELECT MIN(expires_at) AS m FROM mailbox").one().m;
    const nextPair = this.sql.exec<{ m: number | null }>("SELECT MIN(expires_at) AS m FROM pairing_return").toArray()[0]?.m ?? null;
    const candidates = [nextMailbox, nextPair].filter((x): x is number => x !== null && x !== undefined);
    if (candidates.length === 0) return;
    const next = Math.min(...candidates);
    const at = next * 1000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    if (!this.hasSchema) return;
    const now = nowSeconds();
    this.sql.exec("DELETE FROM mailbox WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM nonces WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM challenges WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM watchers WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM pairing_return WHERE expires_at <= ?", now);
    await this.scheduleAlarm();
  }
}
