/**
 * Paired voice calls (ADR-0013 extension). Signed signaling with call=true and an HPKE Auth wrap of a
 * 32-byte call key; each encoded Opus frame is sealed with AES-256-GCM. Platforms without insertable
 * streams refuse the call rather than falling back to SRTP alone.
 */
import {
  compress,
  createCallKeyMaterial,
  ctEqual,
  decodeSignal,
  dtlsMatches,
  encodeSignal,
  fromB64url,
  newSessionId,
  openCallFrame,
  sdpFingerprint,
  sealCallFrame,
  toB64url,
  unwrapCallKey,
  wrapKey,
  type ChainState,
  type DeviceKeys,
  type DeviceRecord,
  type PresenceServerFrame,
  type RelayClient,
  type SignalMessage,
} from "@sealed/core";
import type { PresenceSocket } from "./presence";

export class CallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallError";
  }
}

/** True when this browser can encrypt encoded media frames (Chrome/Edge insertable streams). */
export function supportsEncodedFrameEncryption(): boolean {
  return typeof RTCPeerConnection !== "undefined" && typeof RTCRtpSender !== "undefined" && "createEncodedStreams" in RTCRtpSender.prototype;
}

async function iceServers(client: RelayClient): Promise<RTCIceServer[]> {
  try {
    const t = await client.turn();
    return t.ice_servers.map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) }));
  } catch {
    return [];
  }
}

function gathered(pc: RTCPeerConnection, ms = 3_000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener(
      "icegatheringstatechange",
      () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          resolve();
        }
      },
      { once: true },
    );
  });
}

async function sendSignal(presence: PresenceSocket, keys: DeviceKeys, toFp: string, toDevice: string | undefined, m: SignalMessage): Promise<void> {
  const payload = toB64url(await encodeSignal(keys.signing, m));
  if (!presence.send({ type: "signal", to_fp: toFp, ...(toDevice ? { to_device: toDevice } : {}), payload })) {
    throw new CallError("presence connection is not open");
  }
}

function findDevice(chain: ChainState, compressedSigning: string): DeviceRecord | undefined {
  const target = fromB64url(compressedSigning);
  for (const d of chain.devices.values()) if (d.revokedSeq === undefined && ctEqual(compress(d.signingPublicKey), target)) return d;
  return undefined;
}

type EncodedFrame = { data: ArrayBuffer };

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function encryptTransform(callKey: Uint8Array, counter: { n: number }): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream({
    transform(frame, controller) {
      const plain = new Uint8Array(frame.data);
      const sealed = sealCallFrame(callKey, counter.n++, plain);
      controller.enqueue({ ...frame, data: toArrayBuffer(sealed) });
    },
  });
}

function decryptTransform(callKey: Uint8Array, counter: { n: number }): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream({
    transform(frame, controller) {
      try {
        const opened = openCallFrame(callKey, counter.n++, new Uint8Array(frame.data));
        controller.enqueue({ ...frame, data: toArrayBuffer(opened) });
      } catch {
        // Drop tampered / out-of-order frames.
      }
    },
  });
}

function attachEncodedCrypto(pc: RTCPeerConnection, callKey: Uint8Array): void {
  if (!supportsEncodedFrameEncryption()) throw new CallError("this browser cannot encrypt call frames; refusing SRTP-only");
  const tx = { n: 0 };
  const rx = { n: 0 };
  const wireSender = (sender: RTCRtpSender) => {
    if (sender.track?.kind !== "audio") return;
    const streams = (sender as RTCRtpSender & { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream } }).createEncodedStreams?.();
    if (!streams) throw new CallError("encoded streams unavailable on sender");
    void streams.readable.pipeThrough(encryptTransform(callKey, tx) as unknown as TransformStream).pipeTo(streams.writable);
  };
  for (const sender of pc.getSenders()) wireSender(sender);
  pc.addEventListener("track", (ev) => {
    const receiver = ev.receiver as RTCRtpReceiver & { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream } };
    const streams = receiver.createEncodedStreams?.();
    if (!streams) throw new CallError("encoded streams unavailable on receiver");
    void streams.readable.pipeThrough(decryptTransform(callKey, rx) as unknown as TransformStream).pipeTo(streams.writable);
  });
}

export interface CallHandle {
  pc: RTCPeerConnection;
  localStream: MediaStream;
  hangup: () => Promise<void>;
}

export interface PlaceCallOptions {
  client: RelayClient;
  presence: PresenceSocket;
  keys: DeviceKeys;
  recipient: ChainState;
  /** Preferred device agreement key to wrap to; defaults to the first active device. */
  signal?: AbortSignal;
  onRemoteStream?: (stream: MediaStream) => void;
}

/** Places a paired call. The offer is broadcast to all online devices; the first valid answer wins. */
export async function placeCall(o: PlaceCallOptions): Promise<CallHandle> {
  if (!supportsEncodedFrameEncryption()) throw new CallError("this browser cannot encrypt call frames; refusing SRTP-only");
  const session = newSessionId();
  const toFp = toB64url(o.recipient.fingerprint);
  const firstDev = [...o.recipient.devices.values()].find((d) => d.revokedSeq === undefined);
  if (!firstDev) throw new CallError("contact has no active devices");

  const pc = new RTCPeerConnection({ iceServers: await iceServers(o.client) });
  const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  let peerDevice: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let settled = false;

  const hangup = async () => {
    if (peerDevice) {
      await sendSignal(o.presence, o.keys, toFp, peerDevice, { kind: "bye", session, ts: Math.floor(Date.now() / 1000), body: "", call: true }).catch(() => undefined);
    }
    localStream.getTracks().forEach((t) => t.stop());
    pc.close();
    unsubscribe?.();
  };

  try {
    // Wrap a call key to every active device so whichever answers can unwrap.
    // Practical approach: wrap to first device in the offer; answerer that isn't that device sends a
    // fresh wrap of the same key in the answer after unwrapping via… they can't unwrap.
    // So: include one wrap per active device is too heavy for CBOR field. Instead wrap to first and
    // require the answering device to be that one, OR re-offer. For multi-device: wrap to firstDev;
    // other devices decline. Caller can retry.
    const { callKey, wrap } = await createCallKeyMaterial(session, firstDev.agreementPublicKey, o.keys.agreement);

    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const offerSdp = pc.localDescription?.sdp ?? "";
    const fp = sdpFingerprint(offerSdp);
    if (!fp) throw new CallError("no DTLS fingerprint in the local offer");

    const answered = new Promise<{ device: DeviceRecord; deviceId: string; msg: SignalMessage }>((resolve, reject) => {
      o.signal?.addEventListener("abort", () => reject(new CallError("aborted")), { once: true });
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
        if (msg.kind === "answer" && !settled) {
          if (!msg.call) {
            reject(new CallError("peer answered without call flag"));
            return;
          }
          if (!dtlsMatches(msg)) {
            reject(new CallError("the answer's DTLS fingerprint does not match its signature"));
            return;
          }
          // Only the device we wrapped to can hold the call key (unless answer carries a wrap we made).
          if (!ctEqual(compress(dev.agreementPublicKey), compress(firstDev.agreementPublicKey)) && !msg.callWrap) {
            reject(new CallError("answering device cannot unwrap the call key"));
            return;
          }
          settled = true;
          peerDevice = frame.from_device;
          resolve({ device: dev, deviceId: frame.from_device, msg });
        } else if (msg.kind === "ice" && frame.from_device === peerDevice && msg.body) {
          void pc.addIceCandidate(JSON.parse(msg.body) as RTCIceCandidateInit).catch(() => undefined);
        } else if (msg.kind === "bye" && frame.from_device === peerDevice) {
          void hangup();
        }
      });
    });

    await sendSignal(o.presence, o.keys, toFp, undefined, {
      kind: "offer",
      session,
      ts: Math.floor(Date.now() / 1000),
      body: offerSdp,
      dtlsFingerprint: fp,
      call: true,
      callWrap: wrap,
    });

    const { device, msg } = await answered;
    let activeKey = callKey;
    if (msg.callWrap && !ctEqual(compress(device.agreementPublicKey), compress(firstDev.agreementPublicKey))) {
      // Answerer re-wrapped — not used for first-device path.
      activeKey = await unwrapCallKey(msg.callWrap, o.keys.agreement, session, device.agreementPublicKey);
    }

    pc.addEventListener("track", (ev) => {
      if (ev.streams[0]) o.onRemoteStream?.(ev.streams[0]);
    });
    await pc.setRemoteDescription({ type: "answer", sdp: msg.body });
    attachEncodedCrypto(pc, activeKey);
    return { pc, localStream, hangup };
  } catch (e) {
    await hangup().catch(() => undefined);
    throw e instanceof CallError ? e : new CallError(e instanceof Error ? e.message : String(e));
  }
}

export interface CallReceiverOptions {
  client: RelayClient;
  presence: PresenceSocket;
  keys: DeviceKeys;
  resolveSender: (fp: string) => Promise<{ chain: ChainState; displayName: string } | null>;
  onIncoming: (info: { id: string; fromFp: string; displayName: string; accept: () => Promise<CallHandle>; decline: () => void }) => void;
  onRemoteStream?: (stream: MediaStream) => void;
}

/**
 * Listens for paired call offers. Non-pinned senders are ignored. Data-only offers are ignored.
 * File live receiver ignores call=true symmetrically.
 */
export function startCallReceiver(o: CallReceiverOptions): () => void {
  const sessions = new Map<string, { pc: RTCPeerConnection }>();
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
    if (msg.kind !== "offer" || !msg.call || sessions.has(key)) return;
    if (!dtlsMatches(msg)) return;
    if (!msg.callWrap) return;
    if (!supportsEncodedFrameEncryption()) return;

    const decline = () => {
      void sendSignal(o.presence, o.keys, frame.from_fp, frame.from_device, {
        kind: "bye",
        session: msg.session,
        ts: Math.floor(Date.now() / 1000),
        body: "",
        call: true,
      }).catch(() => undefined);
    };

    let accepted = false;
    const accept = async (): Promise<CallHandle> => {
      if (accepted) throw new CallError("already accepted");
      accepted = true;
      if (!supportsEncodedFrameEncryption()) throw new CallError("this browser cannot encrypt call frames; refusing SRTP-only");
      const callKey = await unwrapCallKey(msg.callWrap!, o.keys.agreement, msg.session, dev.agreementPublicKey);
      const pc = new RTCPeerConnection({ iceServers: await iceServers(o.client) });
      sessions.set(key, { pc });
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
      pc.addEventListener("track", (ev) => {
        if (ev.streams[0]) o.onRemoteStream?.(ev.streams[0]);
      });
      await pc.setRemoteDescription({ type: "offer", sdp: msg.body });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      const sdp = pc.localDescription?.sdp ?? "";
      const fp = sdpFingerprint(sdp);
      if (!fp) throw new CallError("no DTLS fingerprint in the local answer");
      const answerWrap = await wrapKey(callKey, dev.agreementPublicKey, { kind: "call", sessionId: msg.session }, o.keys.agreement);
      await sendSignal(o.presence, o.keys, frame.from_fp, frame.from_device, {
        kind: "answer",
        session: msg.session,
        ts: Math.floor(Date.now() / 1000),
        body: sdp,
        dtlsFingerprint: fp,
        call: true,
        callWrap: answerWrap,
      });
      attachEncodedCrypto(pc, callKey);
      const hangup = async () => {
        await sendSignal(o.presence, o.keys, frame.from_fp, frame.from_device, {
          kind: "bye",
          session: msg.session,
          ts: Math.floor(Date.now() / 1000),
          body: "",
          call: true,
        }).catch(() => undefined);
        localStream.getTracks().forEach((t) => t.stop());
        pc.close();
        sessions.delete(key);
      };
      return { pc, localStream, hangup };
    };

    o.onIncoming({ id: key, fromFp: frame.from_fp, displayName: sender.displayName, accept, decline });
  }

  return () => {
    unsubscribe();
    for (const s of sessions.values()) s.pc.close();
    sessions.clear();
  };
}
