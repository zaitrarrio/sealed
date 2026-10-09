import {
  ErrorCode,
  claimTransfer,
  downloadTransfer,
  fromB64url,
  sha256,
  startShare,
  toB64url,
  waitForApproval,
  type ClaimSummary,
  type SenderEvent,
} from "@sealed/core";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sweep } from "../src/index";
import { MemorySink, TestSocket, bytesOf, client, expectRelayError, file, makeDevice, makeIdentity, workerFetch } from "./helpers";

const ORIGIN = "https://sealed.to";

async function share(mode: "direct" | "room" = "direct", room?: { windowSeconds: number; cap: number; approval: "each" | "batch" | "auto" }, bytes = bytesOf(150_000, 7)) {
  const sender = await makeIdentity("secure-enclave", "Zay's iPhone");
  const session = await startShare({
    client: sender.client,
    origin: ORIGIN,
    files: [file("photos/beach.raw", bytes)],
    mode,
    ...(room ? { room } : {}),
    sender: { keys: sender.device, label: sender.device.label, fingerprint: sender.fingerprint },
  });
  return { sender, session, bytes };
}

async function claimWith(session: { transferIdBytes: Uint8Array; claimSecret: Uint8Array }, label = "Pixel 8") {
  const receiver = makeDevice("strongbox", label);
  const handle = await claimTransfer({ client: client(), transferId: session.transferIdBytes, claimSecret: session.claimSecret, device: receiver, label });
  return { receiver, handle };
}

describe("Direct flow (spec §6.1, ADR-0004)", () => {
  it("shares, claims, matches SAS, approves with device UV, and downloads exact bytes", async () => {
    const { sender, session, bytes } = await share();
    const events = await TestSocket.open(session.eventsUrl);

    const { receiver, handle } = await claimWith(session);
    const ev = await events.next<SenderEvent>((m) => m.type === "claim");
    if (ev.type !== "claim") throw new Error("unreachable");
    expect(ev.claim.claim_id).toBe(handle.claimId);
    expect(ev.claim.label).toBe("Pixel 8");
    expect(ev.claim.key_protection).toBe("strongbox");
    expect(ev.claim.receiver_pub).toBe(toB64url(receiver.agreement.publicKey));

    // Both screens show the same check code.
    expect(session.sasFor(ev.claim)).toBe(handle.sas);
    expect(handle.sas).toMatch(/^\d{3} \d{3}$/);

    await session.uploaded;
    await events.next<SenderEvent>((m) => m.type === "uploaded");
    await session.approve(ev.claim, async () => ({ kind: "device" }));
    expect((await events.next<SenderEvent>((m) => m.type === "claim_update")) as unknown).toEqual({ type: "claim_update", claim_id: handle.claimId, status: "approved" });

    expect(await waitForApproval(client(), handle)).toBe("approved");
    const sink = new MemorySink();
    const manifest = await downloadTransfer({ client: client(), transferId: handle.transferId, auth: { claimToken: handle.claimToken, claimId: handle.claimId }, device: receiver, sink, requireSigner: sender.device.signing.publicKey });
    expect(manifest.files.map((f) => f.path)).toEqual(["photos/beach.raw"]);
    expect(sink.bytes("photos/beach.raw")).toEqual(bytes);

    const status = await sender.client.transferStatus(session.transferId);
    expect(status.uploaded).toBe(true);
    expect(status.claims.map((c) => c.status)).toEqual(["downloaded"]);
    events.close();
  });

  it("returns 409 claim_consumed to a replayed claim", async () => {
    const { session } = await share();
    await claimWith(session);
    await expectRelayError(claimWith(session, "Observer"), 409, ErrorCode.ClaimConsumed);
  });

  it("accepts exactly one of 50 concurrent claims", async () => {
    const { session } = await share();
    const receiver = makeDevice("browser");
    const c = client();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => claimTransfer({ client: c, transferId: session.transferIdBytes, claimSecret: session.claimSecret, device: receiver, label: `racer ${i}` })),
    );
    const accepted = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(49);
    for (const r of rejected) expect((r.reason as { code: string }).code).toBe(ErrorCode.ClaimConsumed);
  });

  it("rejects a wrong claim secret and unknown transfers", async () => {
    const { session } = await share();
    const receiver = makeDevice("browser");
    await expectRelayError(claimTransfer({ client: client(), transferId: session.transferIdBytes, claimSecret: new Uint8Array(16), device: receiver, label: "x" }), 401, ErrorCode.Unauthorized);
    await expectRelayError(claimTransfer({ client: client(), transferId: new Uint8Array(16).fill(9), claimSecret: session.claimSecret, device: receiver, label: "x" }), 404, ErrorCode.NotFound);
  });

  it("refuses device UV from a non-hardware key and accepts nothing before approval", async () => {
    const sender = await makeIdentity("browser", "Laptop");
    const session = await startShare({ client: sender.client, origin: ORIGIN, files: [file("a.txt", bytesOf(1000))], mode: "direct", sender: { keys: sender.device, label: "Laptop", fingerprint: sender.fingerprint } });
    await session.uploaded;
    const { handle } = await claimWith(session);
    await expectRelayError(client().fetchWrap(handle.transferId, handle.claimId, handle.claimToken), 403, ErrorCode.NotApproved);
    await expectRelayError(client().downloadSegment(handle.transferId, 0, { claimToken: handle.claimToken }), 403, ErrorCode.NotApproved);
    const status = await sender.client.transferStatus(session.transferId);
    await expectRelayError(session.approve(status.claims[0]!, async () => ({ kind: "device" })), 403, ErrorCode.Forbidden);
  });

  it("denies a claim: the receiver sees denied and cannot download", async () => {
    const { session, sender } = await share();
    const { handle } = await claimWith(session);
    await session.deny(handle.claimId);
    expect(await waitForApproval(client(), handle)).toBe("denied");
    await expectRelayError(client().fetchWrap(handle.transferId, handle.claimId, handle.claimToken), 403, ErrorCode.NotApproved);
    expect((await sender.client.transferStatus(session.transferId)).claims[0]!.status).toBe("denied");
  });

  it("only the sender may approve, read status, or cancel", async () => {
    const { session } = await share();
    const { handle } = await claimWith(session);
    const mallory = await makeIdentity("secure-enclave");
    await expectRelayError(mallory.client.approve(session.transferId, handle.claimId, new Uint8Array(100), { kind: "device" }), 403, ErrorCode.Forbidden);
    await expectRelayError(mallory.client.transferStatus(session.transferId), 403, ErrorCode.Forbidden);
    await expectRelayError(mallory.client.cancelTransfer(session.transferId), 403, ErrorCode.Forbidden);
  });

  it("expires an unapproved claim after 120 s (alarm) and pushes the update", async () => {
    const { session } = await share();
    const { handle } = await claimWith(session);
    const receiverEvents = await TestSocket.open(handle.eventsUrl);
    expect(await receiverEvents.next()).toEqual({ type: "status", status: "pending", transfer_ready: false });

    const stub = env.TRANSFER.getByName(session.transferId);
    const expiresAt = await runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ e: number; c: number }>("SELECT expires_at AS e, created_at AS c FROM claims").one());
    expect(expiresAt.e - expiresAt.c).toBe(120);
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE claims SET expires_at = ?", Math.floor(Date.now() / 1000) - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await receiverEvents.next()).toEqual({ type: "status", status: "expired", transfer_ready: false });
    expect(await waitForApproval(client(), handle)).toBe("expired");
    const status = await client().claimStatus(handle.claimId, handle.claimToken);
    expect(status.status).toBe("expired");
    receiverEvents.close();
  });

  it("expires the whole transfer at its TTL: ciphertext deleted, 404 afterwards", async () => {
    const { session } = await share();
    await session.uploaded;
    const before = await env.BUCKET.list({ prefix: `t/${session.transferId}/` });
    expect(before.objects.length).toBeGreaterThanOrEqual(2);
    const stub = env.TRANSFER.getByName(session.transferId);
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE transfer SET expires_at = ?", Math.floor(Date.now() / 1000) - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await env.BUCKET.list({ prefix: `t/${session.transferId}/` })).objects).toHaveLength(0);
    const row = await env.DB.prepare("SELECT status FROM transfers WHERE transfer_id = ?").bind(session.transferId).first<{ status: string }>();
    expect(row?.status).toBe("expired");
    await expectRelayError(claimWith(session), 404, ErrorCode.NotFound);
  });

  it("cron sweeper deletes ciphertext of transfers past their expiry", async () => {
    const { session } = await share();
    await session.uploaded;
    await env.DB.prepare("UPDATE transfers SET expires_at = ? WHERE transfer_id = ?").bind(Math.floor(Date.now() / 1000) - 10, session.transferId).run();
    const r = await sweep(env);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await env.BUCKET.list({ prefix: `t/${session.transferId}/` })).objects).toHaveLength(0);
  });

  it("cancel deletes the transfer immediately", async () => {
    const { session } = await share();
    await session.uploaded;
    await session.cancel();
    expect((await env.BUCKET.list({ prefix: `t/${session.transferId}/` })).objects).toHaveLength(0);
    await expectRelayError(claimWith(session), 404, ErrorCode.NotFound);
  });
});

describe("Room (spec §6.2)", () => {
  it("enforces the cap with 429 room_full and revocation with 410 revoked", async () => {
    const { session, sender, bytes } = await share("room", { windowSeconds: 600, cap: 2, approval: "each" }, bytesOf(5000, 3));
    await session.uploaded;
    const a = await claimWith(session, "A");
    const b = await claimWith(session, "B");
    await expectRelayError(claimWith(session, "C"), 429, ErrorCode.RoomFull);

    const claims = (await sender.client.transferStatus(session.transferId)).claims;
    const byId = new Map(claims.map((c): [string, ClaimSummary] => [c.claim_id, c]));
    for (const h of [a, b]) {
      expect(session.sasFor(byId.get(h.handle.claimId)!)).toBe(h.handle.sas);
      await session.approve(byId.get(h.handle.claimId)!, async () => ({ kind: "device" }));
    }

    const sinkA = new MemorySink();
    await downloadTransfer({ client: client(), transferId: a.handle.transferId, auth: { claimToken: a.handle.claimToken, claimId: a.handle.claimId }, device: a.receiver, sink: sinkA });
    expect(sinkA.bytes("photos/beach.raw")).toEqual(bytes);

    await session.revoke(b.handle.claimId);
    await expectRelayError(client().fetchWrap(b.handle.transferId, b.handle.claimId, b.handle.claimToken), 410, ErrorCode.Revoked);
    await expectRelayError(client().downloadManifest(b.handle.transferId, { claimToken: b.handle.claimToken }), 410, ErrorCode.Revoked);
    expect(await waitForApproval(client(), b.handle)).toBe("revoked");
  });

  it("closes the room after its window with 410 claim_window_closed", async () => {
    const { session } = await share("room", { windowSeconds: 60, cap: 10, approval: "auto" }, bytesOf(100));
    await claimWith(session, "early");
    await runInDurableObject(env.TRANSFER.getByName(session.transferId), (_i, state) => {
      state.storage.sql.exec("UPDATE transfer SET room_window_end = ?", Math.floor(Date.now() / 1000) - 1);
    });
    await expectRelayError(claimWith(session, "late"), 410, ErrorCode.ClaimWindowClosed);
  });

  it("caps room TTL at 7 days", async () => {
    const sender = await makeIdentity();
    await expectRelayError(
      sender.client.createTransfer({ mode: "room", claim_hash: toB64url(sha256(new Uint8Array(16))), size_bucket: 65536, segments: 1, ttl_seconds: 8 * 86400, room: { window_seconds: 600, cap: 10, approval: "each" } }),
      400,
      ErrorCode.BadRequest,
    );
  });
});

describe("upload validation", () => {
  it("enforces bearer upload tokens and part size limits", async () => {
    const sender = await makeIdentity();
    const t = await sender.client.createTransfer({ mode: "direct", claim_hash: toB64url(sha256(new Uint8Array(16))), size_bucket: 4 * 1024 * 1024, segments: 3, ttl_seconds: 3600 });
    const c = client();
    await expectRelayError(c.uploadSegment(t.transfer_id, "x".repeat(43), 0, new Uint8Array(100)), 401, ErrorCode.Unauthorized);
    await expectRelayError(c.uploadSegment(t.transfer_id, t.upload_token, 0, new Uint8Array(1024 * 1024 + 17)), 413, ErrorCode.TooLarge);
    await expectRelayError(c.uploadSegment(t.transfer_id, t.upload_token, 4, new Uint8Array(100)), 413, ErrorCode.TooLarge);
    await expectRelayError(c.uploadPadding(t.transfer_id, t.upload_token, 0, new Uint8Array(8 * 1024 * 1024 + 1)), 413, ErrorCode.TooLarge);
    // Non-final segments must be full; the last may be shorter.
    await c.uploadSegment(t.transfer_id, t.upload_token, 0, new Uint8Array(1000));
    await c.uploadSegment(t.transfer_id, t.upload_token, 1, new Uint8Array(500));
    await c.uploadManifest(t.transfer_id, t.upload_token, new Uint8Array(200));
    await expectRelayError(c.finalize(t.transfer_id, t.upload_token, 2, 0), 400, ErrorCode.BadRequest);
    await c.uploadSegment(t.transfer_id, t.upload_token, 0, new Uint8Array(1024 * 1024 + 16));
    // Segment 2 was never uploaded.
    await expectRelayError(c.finalize(t.transfer_id, t.upload_token, 3, 0), 409, ErrorCode.Conflict);
    await c.finalize(t.transfer_id, t.upload_token, 2, 0);
    await expectRelayError(c.uploadSegment(t.transfer_id, t.upload_token, 1, new Uint8Array(500)), 409, ErrorCode.Conflict);
  });

  it("leases a part to one writer at a time", async () => {
    const sender = await makeIdentity();
    const t = await sender.client.createTransfer({ mode: "direct", claim_hash: toB64url(sha256(new Uint8Array(16))), size_bucket: 4 * 1024 * 1024, segments: 2, ttl_seconds: 3600 });
    const stub = env.TRANSFER.getByName(t.transfer_id);
    const first = await stub.beginPart(t.upload_token, "segment", 0, 1000);
    expect(first.ok).toBe(true);
    const second = await stub.beginPart(t.upload_token, "segment", 0, 2000);
    expect(second).toMatchObject({ ok: false, status: 409, code: "conflict" });
    if (!first.ok) throw new Error("unreachable");
    // Committing with a size that differs from what was reserved is refused.
    expect(await stub.commitPart(t.upload_token, "segment", 0, first.value.lease, 999)).toMatchObject({ ok: false, status: 409 });
    await stub.abortPart("segment", 0, first.value.lease);
    expect((await stub.beginPart(t.upload_token, "segment", 0, 2000)).ok).toBe(true);
  });

  it("rejects malformed create requests", async () => {
    const sender = await makeIdentity();
    await expectRelayError(sender.client.createTransfer({ mode: "direct", size_bucket: 65536, segments: 1, ttl_seconds: 3600 }), 400);
    await expectRelayError(sender.client.createTransfer({ mode: "direct", claim_hash: "abc", size_bucket: 65536, segments: 1, ttl_seconds: 3600 }), 400);
    await expectRelayError(sender.client.createTransfer({ mode: "paired", claim_hash: toB64url(sha256(new Uint8Array(1))), size_bucket: 65536, segments: 1, ttl_seconds: 3600 }), 400);
    await expectRelayError(sender.client.createTransfer({ mode: "direct", claim_hash: toB64url(sha256(new Uint8Array(1))), size_bucket: 70000, segments: 1, ttl_seconds: 3600 }), 400);
    // New accounts are limited to 256 MiB buckets for their first 7 days (ADR-0015).
    await expectRelayError(sender.client.createTransfer({ mode: "direct", claim_hash: toB64url(sha256(new Uint8Array(1))), size_bucket: 512 * 1024 * 1024, segments: 1, ttl_seconds: 3600 }), 413, ErrorCode.TooLarge);
  });
});

describe("reports", () => {
  it("accepts a receiver report authenticated by its claim token", async () => {
    const { session, sender } = await share();
    const { handle } = await claimWith(session);
    await client().report({ transfer_id: session.transferId, reason: "malware", evidence_sha256: toB64url(sha256(new Uint8Array([1]))) }, handle.claimToken);
    const row = await env.DB.prepare("SELECT sender_fp, reporter_kind, reason FROM reports WHERE transfer_id = ?").bind(session.transferId).first();
    expect(row).toEqual({ sender_fp: sender.fp, reporter_kind: "claim", reason: "malware" });
    const anon = await workerFetch("https://relay.test/v1/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transfer_id: session.transferId, reason: "spam" }) });
    expect(anon.status).toBe(401);
  });
});

describe("abuse/no-public-url (ADR-0015)", () => {
  it("serves no ciphertext or wrap without a per-claim token", async () => {
    const { session } = await share();
    await session.uploaded;
    for (const path of [`/v1/transfers/${session.transferId}/manifest`, `/v1/transfers/${session.transferId}/segments/0`]) {
      const res = await workerFetch(`https://relay.test${path}`);
      expect(res.status).toBe(401);
    }
    const forged = `${session.transferId}.${toB64url(new Uint8Array(32))}`;
    const res = await workerFetch(`https://relay.test/v1/transfers/${session.transferId}/manifest`, { headers: { authorization: `Bearer ${forged}` } });
    expect(res.status).toBe(401);
    expect(fromB64url(session.transferId)).toHaveLength(16);
  });
});
