/**
 * Live Paired transfers (spec §6.4.3, ADR-0013) over a WebRTC data channel, signaled through the presence
 * socket with messages signed by the device signing key (protocol/live.ts). The DTLS fingerprint is part of
 * each signed offer/answer and must match the SDP, binding the peer connection to pinned identities.
 *
 * The channel carries a complete Envelope: hello (wrap) → manifest part → sealed segments in 60 KiB chunks.
 * The receiver acknowledges every verified segment; the sender treats 15 s without an acknowledgement (or an
 * ICE failure) as a stall and the caller falls back to stored delivery.
 *
 * Key choice: the live wrap is HPKE Auth from the sender's device agreement key to the receiving device's
 * agreement key (prekey id 0). The ciphertext never leaves the DTLS session and is never stored, so one-time
 * prekeys are kept for stored deliveries, where they provide forward secrecy for data at rest.
 */
import {
  DEVICE_KEY_PREKEY_ID,
  EnvelopeBuilder,
  EnvelopeReader,
  PayloadExtractor,
  SegmentAssembler,
  compress,
  ctEqual,
  decodeFrame,
  decodeSignal,
  dtlsMatches,
  encodeFrame,
  encodeSignal,
  fromB64url,
  newSessionId,
  randomBytes,
  sdpFingerprint,
  segmentFrames,
  toB64url,
  unwrapKey,
  wrapKey,
  type ChainState,
  type DeviceKeys,
  type DeviceRecord,
  type EnvelopeInput,
  type ExtractSink,
  type Manifest,
  type PresenceServerFrame,
  type RelayClient,
  type SignalMessage,
} from "@sealed/core";
import { buf } from "./bytes";
import type { PresenceSocket } from "./presence";

export const LIVE_STALL_MS = 15_000;
const ICE_GATHER_MS = 3_000;
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
const LIVE_TTL_SECONDS = 3600;

export class LiveStall extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveStall";
  }
}

async function iceServers(client: RelayClient): Promise<RTCIceServer[]> {
  try {
    const t = await client.turn();
    return t.ice_servers.map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) }));
  } catch {
    return [];
  }
}

/** Waits for ICE gathering to finish (or a timeout) so the SDP carries candidates (non-trickle). */
function gathered(pc: RTCPeerConnection, ms = ICE_GATHER_MS): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

async function sendSignal(presence: PresenceSocket, keys: DeviceKeys, toFp: string, toDevice: string | undefined, m: SignalMessage): Promise<void> {
  const payload = toB64url(await encodeSignal(keys.signing, m));
  if (!presence.send({ type: "signal", to_fp: toFp, ...(toDevice ? { to_device: toDevice } : {}), payload })) throw new LiveStall("presence connection is not open");
}

function findDevice(chain: ChainState, compressedSigning: string): DeviceRecord | undefined {
  const target = fromB64url(compressedSigning);
  for (const d of chain.devices.values()) if (d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), target)) return d;
  return undefined;
}

function waitOpen(dc: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new LiveStall("live connection did not open"));
    signal.addEventListener("abort", onAbort, { once: true });
    dc.addEventListener("open", () => resolve(), { once: true });
    dc.addEventListener("close", () => reject(new LiveStall("live channel closed")), { once: true });
  });
}

async function drain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount <= BUFFER_HIGH) return;
  await new Promise<void>((resolve, reject) => {
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new LiveStall("live channel closed"));
    };
    const cleanup = () => {
      dc.removeEventListener("bufferedamountlow", onLow);
      dc.removeEventListener("close", onClose);
    };
    dc.addEventListener("bufferedamountlow", onLow);
    dc.addEventListener("close", onClose);
  });
}

export interface LiveSendOptions {
  client: RelayClient;
  presence: PresenceSocket;
  keys: DeviceKeys;
  self: { fingerprint: Uint8Array; label: string };
  recipient: ChainState;
  files: readonly EnvelopeInput[];
  source?: string;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Sends files live to whichever online device of `recipient` answers first. Resolves when the receiver has
 * acknowledged every segment; rejects with LiveStall on ICE failure or 15 s without progress.
 */
export async function sendLive(o: LiveSendOptions): Promise<{ transferId: string; manifest: Manifest; device: string }> {
  const session = newSessionId();
  const toFp = toB64url(o.recipient.fingerprint);
  const pc = new RTCPeerConnection({ iceServers: await iceServers(o.client) });
  const dc = pc.createDataChannel("sealed", { ordered: true });
  dc.binaryType = "arraybuffer";
  const stall = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const bump = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), LIVE_STALL_MS);
  };
  const outer = o.signal;
  const onOuterAbort = () => stall.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  let peerDevice: string | null = null;
  let unsubscribe: (() => void) | null = null;
  try {
    bump();
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const offerSdp = pc.localDescription?.sdp ?? "";
    const fp = sdpFingerprint(offerSdp);
    if (!fp) throw new LiveStall("no DTLS fingerprint in the local offer");

    const answered = new Promise<{ device: DeviceRecord; deviceId: string; msg: SignalMessage }>((resolve, reject) => {
      stall.signal.addEventListener("abort", () => reject(new LiveStall("no live answer")), { once: true });
      unsubscribe = o.presence.on((frame: PresenceServerFrame) => {
        if (frame.type !== "signal" || frame.from_fp !== toFp) return;
        const dev = findDevice(o.recipient, frame.from_device);
        if (!dev) return;
        let msg: SignalMessage;
        try {
          msg = decodeSignal(fromB64url(frame.payload), dev.signingPublicKey);
        } catch {
          return;
        }
        if (!ctEqual(msg.session, session)) return;
        if (msg.kind === "answer" && !peerDevice) {
          if (!dtlsMatches(msg)) {
            reject(new LiveStall("the answer's DTLS fingerprint does not match its signature"));
            return;
          }
          peerDevice = frame.from_device;
          resolve({ device: dev, deviceId: frame.from_device, msg });
        } else if (msg.kind === "ice" && frame.from_device === peerDevice && msg.body) {
          void pc.addIceCandidate(JSON.parse(msg.body) as RTCIceCandidateInit).catch(() => undefined);
        } else if (msg.kind === "bye" && frame.from_device === peerDevice) {
          stall.abort();
        }
      });
    });

    await sendSignal(o.presence, o.keys, toFp, undefined, { kind: "offer", session, ts: Math.floor(Date.now() / 1000), body: offerSdp, dtlsFingerprint: fp });
    const { device, deviceId, msg } = await answered;
    await pc.setRemoteDescription({ type: "answer", sdp: msg.body });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") stall.abort();
    });
    await waitOpen(dc, stall.signal);
    bump();

    // Build the Envelope in memory and stream it.
    const transferId = randomBytes(16);
    const cek = randomBytes(32);
    const builder = new EnvelopeBuilder({
      transferId,
      cek,
      ttlSeconds: LIVE_TTL_SECONDS,
      sender: { key: o.keys.signing, label: o.self.label, fingerprint: o.self.fingerprint },
      ...(o.source ? { source: o.source } : {}),
    });
    const segments: Uint8Array[] = [];
    for await (const seg of builder.build(o.files)) segments.push(seg.bytes);
    const wrap = await wrapKey(cek, device.agreementPublicKey, { kind: "paired", transferId, prekeyId: DEVICE_KEY_PREKEY_ID }, o.keys.agreement);
    const totalBytes = segments.reduce((a, s) => a + s.length, 0);
    let acked = -1;
    let ackedBytes = 0;
    const allAcked = new Promise<void>((resolve, reject) => {
      stall.signal.addEventListener("abort", () => reject(new LiveStall("live transfer stalled")), { once: true });
      dc.addEventListener("message", (ev: MessageEvent) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        let f;
        try {
          f = decodeFrame(new Uint8Array(ev.data));
        } catch {
          return;
        }
        if (f.t === "ack" && f.index === acked + 1) {
          acked = f.index;
          ackedBytes += segments[f.index]?.length ?? 0;
          bump();
          o.onProgress?.(ackedBytes, totalBytes);
          if (acked === segments.length - 1) resolve();
        } else if (f.t === "error") {
          reject(new LiveStall(`receiver error: ${f.message}`));
        }
      });
    });
    allAcked.catch(() => undefined);
    const send = async (bytes: Uint8Array) => {
      if (stall.signal.aborted) throw new LiveStall("live transfer stalled");
      await drain(dc);
      dc.send(buf(bytes));
    };
    await send(encodeFrame({ t: "hello", transferId: toB64url(transferId), wrap, prekeyId: DEVICE_KEY_PREKEY_ID, segments: segments.length }));
    await send(encodeFrame({ t: "manifest", bytes: builder.manifestPart() }));
    for (let i = 0; i < segments.length; i++) for (const chunk of segmentFrames(i, segments[i] as Uint8Array)) await send(chunk);
    await send(encodeFrame({ t: "done" }));
    await allAcked;
    return { transferId: toB64url(transferId), manifest: builder.getManifest(), device: deviceId };
  } catch (e) {
    if (peerDevice) await sendSignal(o.presence, o.keys, toFp, peerDevice, { kind: "bye", session, ts: Math.floor(Date.now() / 1000), body: "" }).catch(() => undefined);
    throw e instanceof LiveStall ? e : new LiveStall(e instanceof Error ? e.message : String(e));
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    outer?.removeEventListener("abort", onOuterAbort);
    (unsubscribe as (() => void) | null)?.();
    try {
      dc.close();
      pc.close();
    } catch {
      // closed
    }
  }
}

export interface IncomingLive {
  id: string;
  fromFp: string;
  fromDevice: string;
  senderLabel: string;
  manifest: Manifest | null;
  bytesDone: number;
  totalBytes: number;
  status: "connecting" | "receiving" | "done" | "failed";
  error?: string;
}

export interface LiveReceiverOptions {
  client: RelayClient;
  presence: PresenceSocket;
  keys: DeviceKeys;
  /** Resolves a sender fingerprint to its pinned, refreshed chain; null when not a contact or blocked. */
  resolveSender: (fp: string) => Promise<{ chain: ChainState; displayName: string } | null>;
  /** A sink for each incoming transfer's files. */
  makeSink: (id: string) => ExtractSink & { discard?: () => Promise<void> };
  onUpdate: (t: IncomingLive) => void;
}

/** Answers live offers from pinned contacts and receives their Envelopes. Returns a stop function. */
export function startLiveReceiver(o: LiveReceiverOptions): () => void {
  const sessions = new Map<string, { pc: RTCPeerConnection }>();
  /** Sinks of transfers still in flight; a transfer that ends without completing keeps nothing. */
  const pending = new Map<string, { discard?: () => unknown }>();
  const abandon = (key: string) => {
    const sink = pending.get(key);
    pending.delete(key);
    void Promise.resolve(sink?.discard?.()).catch(() => undefined);
  };
  const unsubscribe = o.presence.on((frame) => {
    if (frame.type !== "signal") return;
    void handle(frame).catch(() => undefined);
  });

  async function handle(frame: Extract<PresenceServerFrame, { type: "signal" }>): Promise<void> {
    const sender = await o.resolveSender(frame.from_fp);
    if (!sender) return;
    const dev = findDevice(sender.chain, frame.from_device);
    if (!dev) return;
    const msg = decodeSignal(fromB64url(frame.payload), dev.signingPublicKey);
    const key = toB64url(msg.session);
    if (msg.kind === "bye") {
      sessions.get(key)?.pc.close();
      sessions.delete(key);
      return;
    }
    if (msg.kind === "ice") {
      const s = sessions.get(key);
      if (s && msg.body) await s.pc.addIceCandidate(JSON.parse(msg.body) as RTCIceCandidateInit).catch(() => undefined);
      return;
    }
    if (msg.kind !== "offer" || sessions.has(key)) return;
    if (!dtlsMatches(msg)) return;
    const pc = new RTCPeerConnection({ iceServers: await iceServers(o.client) });
    sessions.set(key, { pc });
    const state: IncomingLive = { id: key, fromFp: frame.from_fp, fromDevice: frame.from_device, senderLabel: sender.displayName, manifest: null, bytesDone: 0, totalBytes: 0, status: "connecting" };
    const update = (patch: Partial<IncomingLive>) => {
      Object.assign(state, patch);
      o.onUpdate({ ...state });
    };
    update({});
    pc.addEventListener("datachannel", (ev) => receiveChannel(ev.channel, dev, frame.from_fp, update, key));
    pc.addEventListener("connectionstatechange", () => {
      if ((pc.connectionState === "failed" || pc.connectionState === "closed") && state.status !== "done") {
        update({ status: "failed", error: "connection lost" });
        abandon(key);
      }
    });
    await pc.setRemoteDescription({ type: "offer", sdp: msg.body });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    const sdp = pc.localDescription?.sdp ?? "";
    const fp = sdpFingerprint(sdp);
    if (!fp) {
      pc.close();
      sessions.delete(key);
      return;
    }
    await sendSignal(o.presence, o.keys, frame.from_fp, frame.from_device, { kind: "answer", session: msg.session, ts: Math.floor(Date.now() / 1000), body: sdp, dtlsFingerprint: fp });
  }

  function receiveChannel(dc: RTCDataChannel, senderDevice: DeviceRecord, fromFp: string, update: (p: Partial<IncomingLive>) => void, key: string): void {
    dc.binaryType = "arraybuffer";
    const sink = o.makeSink(key);
    pending.set(key, sink);
    const assembler = new SegmentAssembler();
    let hello: Extract<ReturnType<typeof decodeFrame>, { t: "hello" }> | null = null;
    let reader: EnvelopeReader | null = null;
    let extractor: PayloadExtractor | null = null;
    let chain = Promise.resolve();
    let segmentsDone = 0;
    const fail = (message: string) => {
      update({ status: "failed", error: message });
      try {
        dc.send(buf(encodeFrame({ t: "error", message })));
      } catch {
        // closed
      }
      dc.close();
      abandon(key);
    };
    dc.addEventListener("message", (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      // Serialize processing: decrypting a segment is async and must stay in order.
      chain = chain
        .then(async () => {
          const f = decodeFrame(bytes);
          if (f.t === "hello") {
            hello = f;
            return;
          }
          if (f.t === "manifest") {
            if (!hello) throw new Error("manifest before hello");
            const transferId = fromB64url(hello.transferId);
            const cek = await unwrapKey(hello.wrap, o.keys.agreement, { kind: "paired", transferId, prekeyId: hello.prekeyId }, senderDevice.agreementPublicKey);
            reader = await EnvelopeReader.open(f.bytes, cek, { expectedTransferId: transferId, requireSigner: senderDevice.signingPublicKey });
            const m = reader.manifest;
            if (m.segmentCount !== hello.segments) throw new Error("segment count mismatch");
            const sender = m.sender?.fingerprint;
            if (!sender || toB64url(sender) !== fromFp) throw new Error("manifest names a different sender identity");
            extractor = new PayloadExtractor(m, sink);
            update({ status: "receiving", manifest: m, totalBytes: m.files.reduce((a, x) => a + x.size, 0) });
            return;
          }
          if (f.t === "chunk") {
            if (!reader || !extractor) throw new Error("data before manifest");
            for (const seg of assembler.add(f)) {
              const m = reader.manifest;
              const last = seg.index === m.segmentCount - 1;
              await extractor.push(await reader.decryptSegment(seg.index, seg.bytes), last);
              segmentsDone = seg.index + 1;
              dc.send(buf(encodeFrame({ t: "ack", index: seg.index })));
              const total = m.files.reduce((a, x) => a + x.size, 0);
              update({ bytesDone: Math.min(total, Math.round((segmentsDone / m.segmentCount) * total)) });
              if (last) {
                pending.delete(key);
                update({ status: "done" });
              }
            }
            return;
          }
          if (f.t === "error") throw new Error(f.message);
        })
        .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
    });
  }

  return () => {
    unsubscribe();
    for (const s of sessions.values()) s.pc.close();
    sessions.clear();
    for (const key of [...pending.keys()]) abandon(key);
  };
}
