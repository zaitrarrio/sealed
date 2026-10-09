/**
 * TransferDO — one per transfer (spec §6.1–6.2, ADR-0004, ADR-0012). Single-threaded and strongly consistent:
 *   - Direct: exactly one claim is ever accepted (claim_state open → consumed in one synchronous step).
 *   - Room: claims accepted until the window closes or the cap is reached.
 *   - Claims expire 120 s after creation unless approved (alarm). The transfer expires at its TTL (alarm +
 *     cron sweeper), deleting ciphertext from R2 and all state.
 * Secrets (claim secret, upload token, claim tokens) are only ever stored as SHA-256 hashes.
 */
import {
  Limits,
  P256,
  sha256,
  type ClaimRequest,
  type ClaimStatus,
  type ClaimSummary,
  type KeyProtection,
  type ReceiverEvent,
  type SenderEvent,
} from "@sealed/core";
import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import type { ClaimStatusResponse as ClaimStatusResponseSchema } from "@sealed/core";
import type { Env } from "./env";
import { fail, ok, type Failure, type Result } from "./http";
import { log } from "./log";
import { deleteTransferObjects, r2Keys } from "./storage";
import { ctEqualB64, decodeB64, hashSecret, nowSeconds, randomId } from "./util";

export type TransferMode = "direct" | "room" | "paired";
export type PartKind = "manifest" | "segment" | "padding";

export interface InitTransfer {
  transferId: string;
  mode: TransferMode;
  senderFp: string;
  claimHash: string | null;
  uploadTokenHash: string;
  sizeBucket: number;
  maxSegments: number;
  maxPaddingParts: number;
  maxTotalBytes: number;
  expiresAt: number;
  room: { windowSeconds: number; cap: number; approval: "each" | "batch" | "auto" } | null;
}

export type DownloadAuth = { kind: "claim"; tokenHash: string } | { kind: "device"; fp: string; device: string };

interface TransferRow extends Record<string, SqlStorageValue> {
  id: string;
  mode: TransferMode;
  sender_fp: string;
  claim_hash: string | null;
  upload_hash: string;
  size_bucket: number;
  max_segments: number;
  max_padding: number;
  max_total: number;
  created_at: number;
  expires_at: number;
  uploaded: number;
  claim_state: "open" | "consumed";
  room_window_end: number | null;
  room_cap: number | null;
  room_approval: string | null;
  segments: number | null;
  padding_parts: number | null;
}

interface ClaimRow extends Record<string, SqlStorageValue> {
  id: string;
  token_hash: string;
  receiver_pub: string;
  receiver_sig_pub: string;
  label: string;
  key_protection: KeyProtection;
  status: ClaimStatus;
  created_at: number;
  expires_at: number;
  wrap: string | null;
  completed_at: number | null;
}

type ClaimStatusResponse = z.infer<typeof ClaimStatusResponseSchema>;

const MAX_WAIT_SECONDS = 25;
/**
 * A part being written is leased to one upload at a time, so concurrent PUTs of the same part cannot leave R2
 * holding bytes that differ from the committed size. A crashed upload's lease lapses after this long.
 */
const PART_LEASE_SECONDS = 60;
/** Direct wraps are deleted this long after the receiver confirms completion (spec §9.4). */
const WRAP_RETENTION_AFTER_COMPLETE = 3600;
const MAX_WRAP_BYTES = 1024;
const TERMINAL: readonly ClaimStatus[] = ["denied", "expired", "revoked"];

function partKey(id: string, kind: PartKind, n: number): string {
  switch (kind) {
    case "manifest":
      return r2Keys.manifest(id);
    case "segment":
      return r2Keys.segment(id, n);
    case "padding":
      return r2Keys.padding(id, n);
  }
}

const KIND_CODE: Record<PartKind, string> = { manifest: "m", segment: "s", padding: "p" };

export class TransferDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Whether the schema exists. Unknown ids never write storage, so probing random ids persists nothing. */
  private hasSchema: boolean | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private schemaExists(): boolean {
    if (this.hasSchema === undefined) {
      this.hasSchema = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transfer'").toArray().length > 0;
    }
    return this.hasSchema;
  }

  private ensureSchema(): void {
    this.hasSchema = true;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS transfer (
        k INTEGER PRIMARY KEY CHECK (k = 1), id TEXT NOT NULL, mode TEXT NOT NULL, sender_fp TEXT NOT NULL, claim_hash TEXT,
        upload_hash TEXT NOT NULL, size_bucket INTEGER NOT NULL, max_segments INTEGER NOT NULL, max_padding INTEGER NOT NULL,
        max_total INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0,
        claim_state TEXT NOT NULL DEFAULT 'open', room_window_end INTEGER, room_cap INTEGER, room_approval TEXT,
        segments INTEGER, padding_parts INTEGER);
      CREATE TABLE IF NOT EXISTS parts (kind TEXT NOT NULL, n INTEGER NOT NULL, size INTEGER NOT NULL, committed INTEGER NOT NULL, lease TEXT, leased_at INTEGER, PRIMARY KEY (kind, n));
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, receiver_pub TEXT NOT NULL, receiver_sig_pub TEXT NOT NULL, label TEXT NOT NULL,
        key_protection TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, wrap TEXT,
        completed_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS claims_token ON claims (token_hash);
      CREATE TABLE IF NOT EXISTS grants (fp TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (fp, device));
    `);
  }

  private row(): TransferRow | null {
    if (!this.schemaExists()) return null;
    return this.sql.exec<TransferRow>("SELECT * FROM transfer WHERE k = 1").toArray()[0] ?? null;
  }

  /** Loads the transfer, failing with 404 when unknown or expired (spec §6.1.2). */
  private live(): Result<TransferRow> {
    const t = this.row();
    if (!t) return fail(404, "not_found", "unknown or expired transfer");
    if (t.expires_at <= nowSeconds()) return fail(404, "not_found", "unknown or expired transfer");
    return ok(t);
  }

  private claimRow(id: string): ClaimRow | null {
    return this.sql.exec<ClaimRow>("SELECT * FROM claims WHERE id = ?", id).toArray()[0] ?? null;
  }

  private summary(c: ClaimRow): ClaimSummary {
    return { claim_id: c.id, receiver_pub: c.receiver_pub, receiver_sig_pub: c.receiver_sig_pub, label: c.label, key_protection: c.key_protection, status: c.status, created_at: c.created_at };
  }

  // ------------------------------------------------------------------ lifecycle

  async init(p: InitTransfer): Promise<Result<true>> {
    if (this.row()) return fail(409, "conflict", "transfer already exists");
    this.ensureSchema();
    const now = nowSeconds();
    this.sql.exec(
      `INSERT INTO transfer (k, id, mode, sender_fp, claim_hash, upload_hash, size_bucket, max_segments, max_padding, max_total, created_at, expires_at, room_window_end, room_cap, room_approval)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.transferId,
      p.mode,
      p.senderFp,
      p.claimHash,
      p.uploadTokenHash,
      p.sizeBucket,
      p.maxSegments,
      p.maxPaddingParts,
      p.maxTotalBytes,
      now,
      p.expiresAt,
      p.room ? Math.min(now + p.room.windowSeconds, p.expiresAt) : null,
      p.room ? p.room.cap : null,
      p.room ? p.room.approval : null,
    );
    await this.scheduleAlarm();
    return ok(true);
  }

  private checkUpload(t: TransferRow, uploadToken: string): Failure | null {
    if (!ctEqualB64(hashSecret(uploadToken), t.upload_hash)) return fail(401, "unauthorized", "invalid upload token");
    return null;
  }

  /** Phase 1 of a part upload: authorizes and reserves the part; returns the R2 key to write. */
  async beginPart(uploadToken: string, kind: PartKind, n: number, size: number): Promise<Result<{ key: string; expiresAt: number; lease: string }>> {
    const r = this.live();
    if (!r.ok) return r;
    const t = r.value;
    const authErr = this.checkUpload(t, uploadToken);
    if (authErr) return authErr;
    if (t.uploaded) return fail(409, "conflict", "transfer already finalized");
    if (!Number.isSafeInteger(n) || n < 0) return fail(400, "bad_request", "invalid part index");
    if (kind === "segment") {
      if (n >= t.max_segments) return fail(413, "too_large", "segment index beyond the declared size bucket");
      if (size < 16 || size > Limits.maxSegmentCipherBytes) return fail(413, "too_large", `segments must be 16..${Limits.maxSegmentCipherBytes} bytes`);
    } else if (kind === "padding") {
      if (n >= t.max_padding) return fail(413, "too_large", "padding index beyond the declared size bucket");
      if (size < 1 || size > Limits.maxPaddingPartBytes) return fail(413, "too_large", `padding parts must be 1..${Limits.maxPaddingPartBytes} bytes`);
    } else {
      if (n !== 0) return fail(400, "bad_request", "manifest has no index");
      if (size < 26 + 16 || size > 4 * 1024 * 1024) return fail(413, "too_large", "manifest part size out of range");
    }
    const code = KIND_CODE[kind];
    const others = this.sql.exec<{ total: number | null }>("SELECT SUM(size) AS total FROM parts WHERE NOT (kind = ? AND n = ?)", code, n).one().total ?? 0;
    if (others + size > t.max_total) return fail(413, "too_large", "upload exceeds the declared size bucket");
    const now = nowSeconds();
    const held = this.sql.exec<{ leased_at: number | null; committed: number }>("SELECT leased_at, committed FROM parts WHERE kind = ? AND n = ?", code, n).toArray()[0];
    if (held && held.committed === 0 && held.leased_at !== null && now - held.leased_at < PART_LEASE_SECONDS) {
      return fail(409, "conflict", "this part is already being uploaded");
    }
    const lease = randomId(16);
    this.sql.exec("INSERT OR REPLACE INTO parts (kind, n, size, committed, lease, leased_at) VALUES (?, ?, ?, 0, ?, ?)", code, n, size, lease, now);
    return ok({ key: partKey(t.id, kind, n), expiresAt: t.expires_at, lease });
  }

  /** Releases a lease after a failed R2 write so the client can retry immediately. */
  async abortPart(kind: PartKind, n: number, lease: string): Promise<void> {
    if (!this.row()) return;
    this.sql.exec("DELETE FROM parts WHERE kind = ? AND n = ? AND lease = ? AND committed = 0", KIND_CODE[kind], n, lease);
  }

  /** Phase 2: marks the part durable after the R2 write succeeded. */
  async commitPart(uploadToken: string, kind: PartKind, n: number, lease: string, storedSize: number): Promise<Result<true>> {
    const r = this.live();
    if (!r.ok) return r;
    const authErr = this.checkUpload(r.value, uploadToken);
    if (authErr) return authErr;
    const res = this.sql.exec("UPDATE parts SET committed = 1, lease = NULL, leased_at = NULL WHERE kind = ? AND n = ? AND lease = ? AND size = ?", KIND_CODE[kind], n, lease, storedSize);
    if (res.rowsWritten === 0) return fail(409, "conflict", "the upload lease expired; retry the part");
    return ok(true);
  }

  async finalize(uploadToken: string, segments: number, paddingParts: number): Promise<Result<true>> {
    const r = this.live();
    if (!r.ok) return r;
    const t = r.value;
    const authErr = this.checkUpload(t, uploadToken);
    if (authErr) return authErr;
    if (t.uploaded) {
      return t.segments === segments && t.padding_parts === paddingParts ? ok(true) : fail(409, "conflict", "transfer already finalized with different parts");
    }
    if (segments > t.max_segments || paddingParts > t.max_padding) return fail(400, "bad_request", "part counts exceed the declared size bucket");
    const parts = this.sql.exec<{ kind: string; n: number; size: number; committed: number }>("SELECT kind, n, size, committed FROM parts").toArray();
    const get = (kind: string, n: number) => parts.find((p) => p.kind === kind && p.n === n && p.committed === 1);
    if (!get("m", 0)) return fail(409, "conflict", "manifest not uploaded");
    for (let i = 0; i < segments; i++) {
      if (!get("s", i)) return fail(409, "conflict", `segment ${i} not uploaded`);
    }
    for (let k = 0; k < paddingParts; k++) {
      if (!get("p", k)) return fail(409, "conflict", `padding part ${k} not uploaded`);
    }
    for (let i = 0; i < segments - 1; i++) {
      // Every segment but the last is a full 1 MiB plaintext segment plus its 16-byte tag.
      if (get("s", i)!.size !== Limits.maxSegmentCipherBytes) return fail(400, "bad_request", `segment ${i} must be ${Limits.maxSegmentCipherBytes} bytes`);
    }
    const extra = parts.filter((p) => (p.kind === "s" && p.n >= segments) || (p.kind === "p" && p.n >= paddingParts));
    if (extra.length > 0) return fail(400, "bad_request", "parts uploaded beyond the finalized counts");
    this.sql.exec("UPDATE transfer SET uploaded = 1, segments = ?, padding_parts = ? WHERE k = 1", segments, paddingParts);
    await this.env.DB.prepare("UPDATE transfers SET status = 'uploaded' WHERE transfer_id = ? AND status = 'open'").bind(t.id).run();
    this.broadcastSender({ type: "uploaded" });
    for (const c of this.sql.exec<ClaimRow>("SELECT * FROM claims").toArray()) this.pushReceiver(c, true);
    this.wakeAll();
    log({ event: "transfer_uploaded", transfer_id: t.id, mode: t.mode, size_bucket: t.size_bucket, count: segments });
    return ok(true);
  }

  async status(senderFp: string): Promise<Result<{ transfer_id: string; mode: TransferMode; uploaded: boolean; expires_at: number; claims: ClaimSummary[] }>> {
    const r = this.live();
    if (!r.ok) return r;
    const t = r.value;
    if (t.sender_fp !== senderFp) return fail(403, "forbidden", "not the sender of this transfer");
    const claims = this.sql.exec<ClaimRow>("SELECT * FROM claims ORDER BY created_at, id").toArray().map((c) => this.summary(c));
    return ok({ transfer_id: t.id, mode: t.mode, uploaded: t.uploaded === 1, expires_at: t.expires_at, claims });
  }

  /** Sender withdraws the transfer: equivalent to immediate expiry. */
  async cancel(senderFp: string): Promise<Result<true>> {
    const r = this.live();
    if (!r.ok) return r;
    if (r.value.sender_fp !== senderFp) return fail(403, "forbidden", "not the sender of this transfer");
    await this.expire("cancelled");
    return ok(true);
  }

  // ------------------------------------------------------------------ claims

  async claim(req: ClaimRequest, origin: string): Promise<Result<{ claim_id: string; claim_token: string; status: "pending"; events_url: string }>> {
    const r = this.live();
    if (!r.ok) return r;
    const t = r.value;
    if (t.mode === "paired" || !t.claim_hash) return fail(404, "not_found", "transfer does not accept claims");
    const cs = decodeB64(req.cs, 16);
    const stored = decodeB64(t.claim_hash, 32);
    if (!cs || !stored) return fail(401, "unauthorized", "invalid claim secret");
    // Constant-time H(cs) comparison (spec §6.1.2).
    const digest = sha256(cs);
    let diff = 0;
    for (let i = 0; i < 32; i++) diff |= (digest[i] as number) ^ (stored[i] as number);
    if (diff !== 0) return fail(401, "unauthorized", "invalid claim secret");

    const receiverPub = decodeB64(req.receiver_pub, 65);
    const receiverSigPub = decodeB64(req.receiver_sig_pub, 65);
    if (!receiverPub || !receiverSigPub || !P256.isValidPublicKey(receiverPub) || !P256.isValidPublicKey(receiverSigPub)) {
      return fail(400, "bad_request", "receiver keys must be uncompressed P-256 points");
    }

    const now = nowSeconds();
    if (t.mode === "direct") {
      if (t.claim_state !== "open") return fail(409, "claim_consumed", "this code has already been claimed");
    } else {
      if (t.room_window_end !== null && now >= t.room_window_end) return fail(410, "claim_window_closed", "the room is closed");
      const active = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM claims WHERE status NOT IN ('denied', 'expired')").one().n;
      if (t.room_cap !== null && active >= t.room_cap) return fail(429, "room_full", "the room is full");
    }

    const claimId = randomId(16);
    const claimToken = `${t.id}.${randomId(32)}`;
    // Everything above ran synchronously in this turn; the state transition below is therefore atomic.
    if (t.mode === "direct") this.sql.exec("UPDATE transfer SET claim_state = 'consumed' WHERE k = 1");
    this.sql.exec(
      "INSERT INTO claims (id, token_hash, receiver_pub, receiver_sig_pub, label, key_protection, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      claimId,
      hashSecret(claimToken),
      req.receiver_pub,
      req.receiver_sig_pub,
      req.label,
      req.key_protection,
      now,
      Math.min(now + Limits.claimTimeoutSeconds, t.expires_at),
    );
    const c = this.claimRow(claimId)!;
    this.broadcastSender({ type: "claim", claim: this.summary(c) });
    await this.scheduleAlarm();
    log({ event: "claim", transfer_id: t.id, mode: t.mode });
    return ok({ claim_id: claimId, claim_token: claimToken, status: "pending", events_url: `${origin}/v1/claims/${claimId}/events?token=${encodeURIComponent(claimToken)}` });
  }

  private senderClaim(senderFp: string, claimId: string): Result<{ t: TransferRow; c: ClaimRow }> {
    const r = this.live();
    if (!r.ok) return r;
    if (r.value.sender_fp !== senderFp) return fail(403, "forbidden", "not the sender of this transfer");
    const c = this.claimRow(claimId);
    if (!c) return fail(404, "not_found", "unknown claim");
    return ok({ t: r.value, c });
  }

  /** Stores the wrap for a pending claim. User verification has already been checked by the Worker. */
  async approve(senderFp: string, claimId: string, wrap: string): Promise<Result<true>> {
    const r = this.senderClaim(senderFp, claimId);
    if (!r.ok) return r;
    const { c } = r.value;
    const bytes = decodeB64(wrap);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_WRAP_BYTES) return fail(400, "bad_request", "malformed wrap");
    if (c.status === "approved" && c.wrap === wrap) return ok(true);
    if (c.status === "expired" || (c.status === "pending" && c.expires_at <= nowSeconds())) {
      this.setStatus(c, "expired");
      return fail(410, "expired", "the claim expired before approval");
    }
    if (c.status === "revoked") return fail(410, "revoked", "the claim was revoked");
    if (c.status !== "pending") return fail(409, "conflict", `claim is ${c.status}`);
    this.sql.exec("UPDATE claims SET status = 'approved', wrap = ? WHERE id = ?", wrap, claimId);
    this.setStatus(this.claimRow(claimId)!, "approved", false);
    await this.scheduleAlarm();
    return ok(true);
  }

  async deny(senderFp: string, claimId: string): Promise<Result<true>> {
    const r = this.senderClaim(senderFp, claimId);
    if (!r.ok) return r;
    const { c } = r.value;
    if (c.status === "denied") return ok(true);
    if (c.status !== "pending") return fail(409, "conflict", `claim is ${c.status}`);
    this.setStatus(c, "denied");
    return ok(true);
  }

  /** Deletes the wrap and token validity; downloads return 410 revoked thereafter (spec §6.2). */
  async revoke(senderFp: string, claimId: string): Promise<Result<true>> {
    const r = this.senderClaim(senderFp, claimId);
    if (!r.ok) return r;
    const { c } = r.value;
    if (c.status === "revoked") return ok(true);
    if (c.status === "denied" || c.status === "expired") return fail(409, "conflict", `claim is ${c.status}`);
    this.sql.exec("UPDATE claims SET wrap = NULL WHERE id = ?", claimId);
    this.setStatus(this.claimRow(claimId)!, "revoked");
    return ok(true);
  }

  private authClaim(claimId: string, tokenHash: string): Result<ClaimRow> {
    const c = this.claimRow(claimId);
    if (!c || !ctEqualB64(c.token_hash, tokenHash)) return fail(401, "unauthorized", "invalid claim token");
    return ok(c);
  }

  /**
   * Finds a claim by the SHA-256 of its token. An indexed equality lookup on a hash of a 256-bit random secret
   * leaks nothing useful through timing: an attacker cannot choose hash prefixes without inverting SHA-256.
   */
  private claimByToken(tokenHash: string): ClaimRow | null {
    return this.sql.exec<ClaimRow>("SELECT * FROM claims WHERE token_hash = ?", tokenHash).toArray()[0] ?? null;
  }

  private statusOf(c: ClaimRow, t: TransferRow): ClaimStatusResponse {
    const status: ClaimStatus = c.status === "pending" && c.expires_at <= nowSeconds() ? "expired" : c.status;
    return { claim_id: c.id, status, transfer_ready: t.uploaded === 1 && (status === "approved" || status === "downloaded") };
  }

  async claimStatus(claimId: string, tokenHash: string, waitSeconds: number): Promise<Result<ClaimStatusResponse>> {
    const read = (): Result<ClaimStatusResponse> => {
      const r = this.live();
      if (!r.ok) return r;
      const c = this.authClaim(claimId, tokenHash);
      if (!c.ok) return c;
      return ok(this.statusOf(c.value, r.value));
    };
    let r = read();
    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, MAX_WAIT_SECONDS)) * 1000;
    const settled = (s: ClaimStatusResponse) => s.status !== "pending" && !(s.status === "approved" && !s.transfer_ready);
    while (r.ok && !settled(r.value) && Date.now() < deadline) {
      await this.waitFor(claimId, deadline - Date.now());
      r = read();
    }
    return r;
  }

  private waitFor(claimId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(claimId);
      if (!set) {
        set = new Set();
        this.waiters.set(claimId, set);
      }
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        if (set!.size === 0) this.waiters.delete(claimId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      set.add(done);
    });
  }

  private wake(claimId: string): void {
    for (const w of [...(this.waiters.get(claimId) ?? [])]) w();
  }

  private wakeAll(): void {
    for (const id of [...this.waiters.keys()]) this.wake(id);
  }

  async getWrap(claimId: string, tokenHash: string): Promise<Result<{ wrap: string }>> {
    const r = this.live();
    if (!r.ok) return r;
    const c = this.authClaim(claimId, tokenHash);
    if (!c.ok) return c;
    const denied = this.accessError(c.value);
    if (denied) return denied;
    if (!c.value.wrap) return fail(410, "revoked", "wrap no longer available");
    return ok({ wrap: c.value.wrap });
  }

  private accessError(c: ClaimRow): Failure | null {
    switch (c.status) {
      case "approved":
      case "downloaded":
        return null;
      case "revoked":
        return fail(410, "revoked", "access was revoked");
      case "expired":
        return fail(410, "expired", "the claim expired");
      case "pending":
        return c.expires_at <= nowSeconds() ? fail(410, "expired", "the claim expired") : fail(403, "not_approved", "waiting for the sender's approval");
      case "denied":
        return fail(403, "not_approved", "the sender denied this claim");
    }
  }

  /** Authorizes a manifest or segment download; returns the R2 key. */
  async authorizeDownload(auth: DownloadAuth, kind: "manifest" | "segment", n: number): Promise<Result<{ key: string }>> {
    const r = this.live();
    if (!r.ok) return r;
    const t = r.value;
    if (auth.kind === "claim") {
      const c = this.claimByToken(auth.tokenHash);
      if (!c) return fail(401, "unauthorized", "invalid claim token");
      const denied = this.accessError(c);
      if (denied) return denied;
    } else {
      const g = this.sql.exec("SELECT 1 FROM grants WHERE fp = ? AND device = ?", auth.fp, auth.device).toArray();
      if (g.length === 0) return fail(403, "forbidden", "this device holds no delivery for the transfer");
    }
    if (!t.uploaded) return fail(409, "conflict", "upload not finalized yet");
    if (kind === "segment" && (!Number.isSafeInteger(n) || n < 0 || n >= (t.segments ?? 0))) return fail(404, "not_found", "no such segment");
    return ok({ key: partKey(t.id, kind, kind === "manifest" ? 0 : n) });
  }

  async complete(claimId: string, tokenHash: string): Promise<Result<true>> {
    const r = this.live();
    if (!r.ok) return r;
    const c = this.authClaim(claimId, tokenHash);
    if (!c.ok) return c;
    if (c.value.status === "downloaded") return ok(true);
    const denied = this.accessError(c.value);
    if (denied) return denied;
    this.sql.exec("UPDATE claims SET completed_at = ? WHERE id = ?", nowSeconds(), claimId);
    this.setStatus(this.claimRow(claimId)!, "downloaded");
    await this.scheduleAlarm();
    return ok(true);
  }

  /** Verifies a claim token for reports; returns the transfer's sender fingerprint and the claim id. */
  async reportContext(tokenHash: string): Promise<Result<{ senderFp: string; claimId: string }>> {
    const t = this.row();
    if (!t) return fail(404, "not_found", "unknown transfer");
    const c = this.claimByToken(tokenHash);
    if (!c) return fail(401, "unauthorized", "invalid claim token");
    return ok({ senderFp: t.sender_fp, claimId: c.id });
  }

  // ------------------------------------------------------------------ paired delivery

  /** Grants device-signed download access to recipient devices (spec §6.4.2). */
  async grant(senderFp: string, recipientFp: string, devices: string[]): Promise<Result<{ expiresAt: number }>> {
    const r = this.live();
    if (!r.ok) return r;
    const t = r.value;
    if (t.sender_fp !== senderFp) return fail(403, "forbidden", "not the sender of this transfer");
    if (t.mode !== "paired") return fail(400, "bad_request", "only paired transfers are delivered to mailboxes");
    for (const d of devices) this.sql.exec("INSERT OR IGNORE INTO grants (fp, device) VALUES (?, ?)", recipientFp, d);
    return ok({ expiresAt: t.expires_at });
  }

  // ------------------------------------------------------------------ status changes and sockets

  private setStatus(c: ClaimRow, status: ClaimStatus, write = true): void {
    if (write) this.sql.exec("UPDATE claims SET status = ? WHERE id = ?", status, c.id);
    const updated = { ...c, status };
    this.broadcastSender({ type: "claim_update", claim_id: c.id, status });
    this.pushReceiver(updated);
    this.wake(c.id);
  }

  private pushReceiver(c: ClaimRow, force = false): void {
    const t = this.row();
    if (!t) return;
    const s = this.statusOf(c, t);
    if (!force && s.status === "pending") return;
    const ev: ReceiverEvent = { type: "status", status: s.status, transfer_ready: s.transfer_ready };
    for (const ws of this.ctx.getWebSockets(`claim:${c.id}`)) this.send(ws, ev);
  }

  private broadcastSender(ev: SenderEvent): void {
    for (const ws of this.ctx.getWebSockets("sender")) this.send(ws, ev);
  }

  private send(ws: WebSocket, ev: SenderEvent | ReceiverEvent): void {
    try {
      ws.send(JSON.stringify(ev));
    } catch {
      // socket closing
    }
  }

  /**
   * WebSocket upgrades forwarded by the Worker. Roles: sender (upload token) or receiver (claim token).
   * Tokens are re-verified here; the Worker strips client headers and passes only hashed credentials.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    const r = this.live();
    if (!r.ok) return new Response(JSON.stringify({ error: r.code, message: r.message }), { status: r.status, headers: { "content-type": "application/json" } });
    const t = r.value;
    const role = request.headers.get("x-sealed-role");
    const tokenHash = request.headers.get("x-sealed-token-hash") ?? "";
    let tags: string[];
    let initial: (SenderEvent | ReceiverEvent)[];
    if (role === "sender") {
      if (!ctEqualB64(tokenHash, t.upload_hash)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      tags = ["sender"];
      initial = this.sql.exec<ClaimRow>("SELECT * FROM claims ORDER BY created_at, id").toArray().map((c): SenderEvent => ({ type: "claim", claim: this.summary(c) }));
      if (t.uploaded) initial.push({ type: "uploaded" });
    } else if (role === "receiver") {
      const claimId = request.headers.get("x-sealed-claim") ?? "";
      const c = this.authClaim(claimId, tokenHash);
      if (!c.ok) return new Response(JSON.stringify({ error: c.code }), { status: c.status, headers: { "content-type": "application/json" } });
      tags = [`claim:${claimId}`];
      const s = this.statusOf(c.value, t);
      initial = [{ type: "status", status: s.status, transfer_ready: s.transfer_ready }];
    } else {
      return new Response("bad role", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, tags);
    for (const ev of initial) this.send(server, ev);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Event sockets are server-push only; answer keep-alives and ignore everything else.
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------------ expiry

  private async scheduleAlarm(): Promise<void> {
    const t = this.row();
    if (!t) return;
    let next = t.expires_at;
    const pending = this.sql.exec<{ m: number | null }>("SELECT MIN(expires_at) AS m FROM claims WHERE status = 'pending'").one().m;
    if (pending !== null) next = Math.min(next, pending);
    const done = this.sql.exec<{ m: number | null }>("SELECT MIN(completed_at) AS m FROM claims WHERE wrap IS NOT NULL AND completed_at IS NOT NULL").one().m;
    if (done !== null && t.mode === "direct") next = Math.min(next, done + WRAP_RETENTION_AFTER_COMPLETE);
    await this.ctx.storage.setAlarm(next * 1000);
  }

  override async alarm(): Promise<void> {
    const t = this.row();
    if (!t) return;
    const now = nowSeconds();
    if (t.expires_at <= now) {
      await this.expire("expired");
      return;
    }
    for (const c of this.sql.exec<ClaimRow>("SELECT * FROM claims WHERE status = 'pending' AND expires_at <= ?", now).toArray()) this.setStatus(c, "expired");
    if (t.mode === "direct") this.sql.exec("UPDATE claims SET wrap = NULL WHERE completed_at IS NOT NULL AND completed_at + ? <= ?", WRAP_RETENTION_AFTER_COMPLETE, now);
    await this.scheduleAlarm();
  }

  /** Deletes ciphertext and all state. Idempotent; also invoked by the cron sweeper. */
  async expire(reason: "expired" | "cancelled" = "expired"): Promise<Result<{ deleted: number }>> {
    const t = this.row();
    if (!t) return ok({ deleted: 0 });
    this.broadcastSender({ type: "expired" });
    for (const c of this.sql.exec<ClaimRow>("SELECT * FROM claims").toArray()) {
      if (!TERMINAL.includes(c.status)) {
        for (const ws of this.ctx.getWebSockets(`claim:${c.id}`)) this.send(ws, { type: "status", status: "expired", transfer_ready: false });
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4010, reason);
      } catch {
        // already closed
      }
    }
    const deleted = await deleteTransferObjects(this.env, t.id);
    await this.env.DB.prepare("UPDATE transfers SET status = ? WHERE transfer_id = ?").bind(reason, t.id).run();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.hasSchema = false;
    this.wakeAll();
    log({ event: `transfer_${reason}`, transfer_id: t.id, mode: t.mode, count: deleted });
    return ok({ deleted });
  }
}
