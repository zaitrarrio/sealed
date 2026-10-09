import {
  ErrorCode,
  SIGNATURE_HEADER,
  SoftwareSigningKey,
  approveNewDevice,
  compress,
  createAddDeviceOffer,
  createPaperKey,
  generatePrekeys,
  makeLink,
  parseCode,
  receivePaired,
  recoverWithPaperKey,
  replenishPrekeys,
  sendToContact,
  signRequest,
  toB64url,
  verifyChain,
  type ChainState,
  type PresenceServerFrame,
} from "@sealed/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryPrekeyStore, MemorySink, TestSocket, bytesOf, client, expectRelayError, file, makeDevice, makeIdentity, workerFetch, type TestDevice, type TestIdentity } from "./helpers";

const ORIGIN = "https://sealed.to";

/** Adds a second device to `id` through the add-device ceremony. Returns its keys, client and the new chain. */
async function addSecondDevice(id: TestIdentity, label = "iPad") {
  const dev = makeDevice("secure-enclave", label);
  const offer = await createAddDeviceOffer(ORIGIN, { signing: dev.signing, agreementPublicKey: dev.agreement.publicKey, label, protection: dev.protection });
  const code = parseCode(offer.code);
  if (code.kind !== "add-device") throw new Error("unreachable");
  const state = await approveNewDevice(id.client, id.state, id.device.signing, code);
  id.state = state;
  return { device: dev, client: client({ fingerprint: id.fingerprint, signing: dev.signing }), state };
}

async function chainOf(fp: Uint8Array): Promise<ChainState> {
  const { links } = await client().getChain(fp);
  return verifyChain(links, fp);
}

describe("identities and sigchains (spec §6.3, ADR-0006)", () => {
  it("creates an identity whose fingerprint is SHA-256 of link 0, and serves the chain with ?since", async () => {
    const id = await makeIdentity("secure-enclave");
    expect(id.fp).toBe(toB64url(id.state.fingerprint));
    await addSecondDevice(id);
    const full = await client().getChain(id.fingerprint);
    expect(full.headSeq).toBe(1);
    expect(full.links).toHaveLength(2);
    const tail = await client().getChain(id.fingerprint, 1);
    expect(tail.links).toHaveLength(1);
    expect(verifyChain(full.links, id.fingerprint).seq).toBe(1);
    // Creating the same identity again is idempotent.
    const again = await client().createIdentity(full.links[0]!);
    expect(again.head_seq).toBe(1);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE fp = ? AND status = 'active'").bind(id.fp).first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it("rejects an invalid genesis link and unknown chains", async () => {
    const id = await makeIdentity();
    const { links } = await client().getChain(id.fingerprint);
    const tampered = links[0]!.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    await expectRelayError(client().createIdentity(tampered), 400, ErrorCode.ChainInvalid);
    await expectRelayError(client().getChain(new Uint8Array(32).fill(3)), 404, ErrorCode.NotFound);
  });

  it("rejects forks with 409 chain_invalid", async () => {
    const id = await makeIdentity();
    const base = id.state;
    await addSecondDevice(id, "phone 2");
    // A different link at the same seq (1) as the accepted one: a fork.
    const other = makeDevice("tee", "fork");
    const offer = await createAddDeviceOffer(ORIGIN, { signing: other.signing, agreementPublicKey: other.agreement.publicKey, label: "fork", protection: "tee" });
    const forkLink = await makeLink(base, id.device.signing, offer.statement);
    await expectRelayError(id.client.appendLinks([forkLink]), 409, ErrorCode.ChainInvalid);
    // A link that skips a seq is also invalid.
    const skip = await makeLink({ ...id.state, seq: id.state.seq + 1 }, id.device.signing, { type: "revoke_device", signingPublicKey: other.signing.publicKey, reason: "x" });
    await expectRelayError(id.client.appendLinks([skip]), 409, ErrorCode.ChainInvalid);
    expect((await chainOf(id.fingerprint)).seq).toBe(1);
  });

  it("only an active device of the chain may append, and a revoked device loses access", async () => {
    const id = await makeIdentity();
    const second = await addSecondDevice(id);
    const stranger = makeDevice("secure-enclave");
    const strangerClient = client({ fingerprint: id.fingerprint, signing: stranger.signing });
    const link = await makeLink(id.state, stranger.signing, { type: "revoke_device", signingPublicKey: second.device.signing.publicKey, reason: "x" });
    await expectRelayError(strangerClient.appendLinks([link]), 409, ErrorCode.ChainInvalid);

    const revoke = await makeLink(id.state, id.device.signing, { type: "revoke_device", signingPublicKey: second.device.signing.publicKey, reason: "lost" });
    await id.client.appendLinks([revoke]);
    await expectRelayError(second.client.mailbox(), 401, ErrorCode.Unauthorized);
  });

  it("supports paper-key recovery where the new device signs the request", async () => {
    const id = await makeIdentity();
    const { text } = await createPaperKey(id.client, id.state, id.device.signing);
    const fresh = makeDevice("strongbox", "replacement");
    const recovered = await recoverWithPaperKey(client(), text, { signing: fresh.signing, agreementPublicKey: fresh.agreement.publicKey, label: "replacement", protection: "strongbox" }, () => [id.device.signing.publicKey]);
    const chain = await chainOf(id.fingerprint);
    expect(chain.seq).toBe(recovered.seq);
    const freshClient = client({ fingerprint: id.fingerprint, signing: fresh.signing });
    expect((await freshClient.mailbox()).items).toEqual([]);
    await expectRelayError(id.client.mailbox(), 401, ErrorCode.Unauthorized);
  });
});

describe("device-signed requests (spec §9.2)", () => {
  it("rejects replayed signatures, tampered bodies and stale timestamps", async () => {
    const id = await makeIdentity();
    const path = "/v1/mailbox";
    const header = await signRequest(id.device.signing, id.fingerprint, "GET", path);
    const first = await workerFetch(`https://relay.test${path}`, { headers: { [SIGNATURE_HEADER]: header } });
    expect(first.status).toBe(200);
    const replay = await workerFetch(`https://relay.test${path}`, { headers: { [SIGNATURE_HEADER]: header } });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: ErrorCode.Unauthorized, message: "replayed request" });

    const stale = await signRequest(id.device.signing, id.fingerprint, "GET", path, new Uint8Array(0), Math.floor(Date.now() / 1000) - 300);
    expect((await workerFetch(`https://relay.test${path}`, { headers: { [SIGNATURE_HEADER]: stale } })).status).toBe(401);

    const body = new TextEncoder().encode(JSON.stringify({ platform: "fcm", token: "a".repeat(40) }));
    const signed = await signRequest(id.device.signing, id.fingerprint, "POST", "/v1/devices/push", body);
    const tampered = await workerFetch("https://relay.test/v1/devices/push", {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: signed, "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ platform: "fcm", token: "b".repeat(40) })),
    });
    expect(tampered.status).toBe(401);

    // The path with its query is signed.
    const q = await signRequest(id.device.signing, id.fingerprint, "GET", `/v1/identities/${id.fp}/prekeys/count`);
    const wrongQuery = await workerFetch(`https://relay.test/v1/identities/${id.fp}/prekeys/count?device=${toB64url(compress(id.device.signing.publicKey))}`, { headers: { [SIGNATURE_HEADER]: q } });
    expect(wrongQuery.status).toBe(401);
  });
});

describe("Paired delivery (spec §6.4, ADR-0007)", () => {
  it("hands out each one-time prekey exactly once, then null", async () => {
    const bob = await makeIdentity("secure-enclave");
    const alice = await makeIdentity("secure-enclave");
    const { signed } = await generatePrekeys(bob.device.signing, 3);
    expect((await bob.client.uploadPrekeys(signed)).count).toBe(3);
    expect((await bob.client.prekeyCount()).count).toBe(3);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await alice.client.claimPrekeys(bob.fingerprint);
      expect(r.devices).toHaveLength(1);
      const pk = r.devices[0]!.prekey;
      expect(pk).not.toBeNull();
      expect(seen.has(pk!.id)).toBe(false);
      seen.add(pk!.id);
    }
    expect((await alice.client.claimPrekeys(bob.fingerprint)).devices[0]!.prekey).toBeNull();
    expect((await bob.client.prekeyCount()).count).toBe(0);
  });

  it("refuses prekeys signed by another device, and uploads for another device", async () => {
    const bob = await makeIdentity();
    const other = new SoftwareSigningKey();
    const { signed } = await generatePrekeys(other, 1);
    await expectRelayError(bob.client.uploadPrekeys(signed), 400, ErrorCode.BadRequest);
  });

  it("sends to a contact through the mailbox and to the sender's own second device", async () => {
    const alice = await makeIdentity("secure-enclave", "Alice phone");
    const aliceTablet = await addSecondDevice(alice, "Alice tablet");
    const bob = await makeIdentity("strongbox", "Bob phone");

    const bobStore = new MemoryPrekeyStore();
    const tabletStore = new MemoryPrekeyStore();
    expect(await replenishPrekeys(bob.client, bob.device.signing, bobStore)).toBe(100);
    expect(await replenishPrekeys(aliceTablet.client, aliceTablet.device.signing, tabletStore)).toBe(100);

    const data = bytesOf(2_300_000, 11);
    const notes = new TextEncoder().encode("see you at 6");
    const bobChain = await chainOf(bob.fingerprint);
    const aliceChain = await chainOf(alice.fingerprint);
    const bobSocket = await TestSocket.open(await bob.client.socketUrl("/v1/presence", { kind: "device" }));
    const sent = await sendToContact({
      client: alice.client,
      recipient: bobChain,
      self: aliceChain,
      files: [file("trip/video.bin", data), file("trip/notes.txt", notes, "text/plain")],
      sender: { keys: alice.device, label: "Alice phone", fingerprint: alice.fingerprint },
    });
    expect(sent.recipients).toBe(2);
    expect(await bobSocket.next<PresenceServerFrame>((m) => m.type === "mailbox")).toEqual({ type: "mailbox" });

    // Bob receives, with forward-secret one-time prekey, and the prekey secret is deleted after use.
    const bobItems = (await bob.client.mailbox()).items;
    expect(bobItems).toHaveLength(1);
    expect(bobItems[0]!.sender_fp).toBe(alice.fp);
    expect(bobItems[0]!.sender_device).toBe(toB64url(compress(alice.device.signing.publicKey)));
    expect(bobItems[0]!.prekey_id).not.toBeNull();
    const before = bobStore.size;
    const sink = new MemorySink();
    await receivePaired({ client: bob.client, item: bobItems[0]!, device: bob.device, senderChain: aliceChain, prekeys: bobStore, sink });
    expect(sink.bytes("trip/video.bin")).toEqual(data);
    expect(sink.bytes("trip/notes.txt")).toEqual(notes);
    expect(bobStore.size).toBe(before - 1);
    expect((await bob.client.mailbox()).items).toEqual([]);

    // Alice's tablet receives the self-copy; Alice's sending phone does not.
    const tabletItems = (await aliceTablet.client.mailbox()).items;
    expect(tabletItems).toHaveLength(1);
    expect((await alice.client.mailbox()).items).toEqual([]);
    const tabletSink = new MemorySink();
    await receivePaired({ client: aliceTablet.client, item: tabletItems[0]!, device: aliceTablet.device, senderChain: await chainOf(alice.fingerprint), prekeys: tabletStore, sink: tabletSink });
    expect(tabletSink.bytes("trip/video.bin")).toEqual(data);

    // A device that holds no delivery for the transfer cannot download it.
    const eve = await makeIdentity();
    await expectRelayError(eve.client.downloadManifest(sent.transferId, "device"), 403, ErrorCode.Forbidden);
    bobSocket.close();
  });

  it("falls back to the device key when the pool is empty, and rejects wraps for non-devices", async () => {
    const alice = await makeIdentity();
    const bob = await makeIdentity();
    const sent = await sendToContact({
      client: alice.client,
      recipient: await chainOf(bob.fingerprint),
      self: await chainOf(alice.fingerprint),
      files: [file("a.txt", bytesOf(10))],
      sender: { keys: alice.device, label: "a", fingerprint: alice.fingerprint },
    });
    const item = (await bob.client.mailbox()).items[0]!;
    expect(item.prekey_id).toBe(toB64url(new Uint8Array(8)));
    const sink = new MemorySink();
    await receivePaired({ client: bob.client, item, device: bob.device, senderChain: await chainOf(alice.fingerprint), prekeys: new MemoryPrekeyStore(), sink });
    expect(sink.bytes("a.txt")).toEqual(bytesOf(10));

    const stranger = makeDevice("tee");
    await expectRelayError(alice.client.deliver(bob.fingerprint, sent.transferId, [{ device: compress(stranger.signing.publicKey), prekeyId: null, wrap: new Uint8Array(120) }]), 400, ErrorCode.BadRequest);
    // Only the transfer's sender may deliver it.
    await expectRelayError(bob.client.deliver(alice.fingerprint, sent.transferId, [{ device: compress(alice.device.signing.publicKey), prekeyId: null, wrap: new Uint8Array(120) }]), 403, ErrorCode.Forbidden);
  });
});

describe("presence and signaling", () => {
  async function connect(id: { fingerprint: Uint8Array }, dev: TestDevice) {
    return TestSocket.open(await client({ fingerprint: id.fingerprint, signing: dev.signing }).socketUrl("/v1/presence", { kind: "device" }));
  }

  it("routes signal frames between identities with relay-filled sender fields, and reports presence", async () => {
    const alice = await makeIdentity();
    const bob = await makeIdentity();
    const bobTablet = await addSecondDevice(bob, "tablet");
    const a = await connect(alice, alice.device);
    a.send({ type: "watch", fps: [bob.fp] });
    expect(await a.next<PresenceServerFrame>((m) => m.type === "presence")).toEqual({ type: "presence", fp: bob.fp, devices_online: 0 });

    const b1 = await connect(bob, bob.device);
    expect(await a.next<PresenceServerFrame>((m) => m.type === "presence")).toEqual({ type: "presence", fp: bob.fp, devices_online: 1 });
    const b2 = await connect(bob, bobTablet.device);
    expect(await a.next<PresenceServerFrame>((m) => m.type === "presence")).toEqual({ type: "presence", fp: bob.fp, devices_online: 2 });

    const payload = toB64url(new TextEncoder().encode("signed-offer-bytes"));
    // Targeted at one device: only that device receives it.
    a.send({ type: "signal", to_fp: bob.fp, to_device: toB64url(compress(bobTablet.device.signing.publicKey)), payload });
    const got = await b2.next<PresenceServerFrame>((m) => m.type === "signal");
    expect(got).toEqual({ type: "signal", from_fp: alice.fp, from_device: toB64url(compress(alice.device.signing.publicKey)), payload });
    await expect(b1.next<PresenceServerFrame>((m) => m.type === "signal", 300)).rejects.toThrow();

    // Broadcast to all of Bob's devices; the answer flows back.
    a.send({ type: "signal", to_fp: bob.fp, payload });
    await b1.next<PresenceServerFrame>((m) => m.type === "signal");
    await b2.next<PresenceServerFrame>((m) => m.type === "signal");
    b1.send({ type: "signal", to_fp: alice.fp, payload: "YW5zd2Vy" });
    expect(await a.next<PresenceServerFrame>((m) => m.type === "signal")).toEqual({ type: "signal", from_fp: bob.fp, from_device: toB64url(compress(bob.device.signing.publicKey)), payload: "YW5zd2Vy" });

    a.send({ type: "ping" });
    expect(await a.next<PresenceServerFrame>((m) => m.type === "pong")).toEqual({ type: "pong" });

    b2.close();
    expect(await a.next<PresenceServerFrame>((m) => m.type === "presence")).toEqual({ type: "presence", fp: bob.fp, devices_online: 1 });
    a.close();
    b1.close();
  });

  it("refuses presence sockets without a valid signature", async () => {
    const alice = await makeIdentity();
    const url = await client({ fingerprint: alice.fingerprint, signing: alice.device.signing }).socketUrl("/v1/presence", { kind: "device" });
    const res = await workerFetch(url.replace(/^ws/, "http").replace("/v1/presence", "/v1/presence"), { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
    // Reusing the same signed URL is a replay.
    const replay = await workerFetch(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } });
    expect(replay.status).toBe(401);
    const unsigned = await workerFetch("https://relay.test/v1/presence", { headers: { upgrade: "websocket" } });
    expect(unsigned.status).toBe(401);
  });
});

describe("TURN and push registration", () => {
  it("falls back to STUN without TURN credentials", async () => {
    const id = await makeIdentity();
    const r = await id.client.turn();
    expect(r.ice_servers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    expect(r.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("validates and stores push tokens per device", async () => {
    const id = await makeIdentity();
    await id.client.registerPush("apns", "ab".repeat(32));
    await expectRelayError(id.client.registerPush("apns", "not-hex"), 400, ErrorCode.BadRequest);
    await expectRelayError(id.client.registerPush("webpush", JSON.stringify({ endpoint: "https://127.0.0.1/x", keys: { p256dh: "a", auth: "b" } })), 400, ErrorCode.BadRequest);
  });
});
