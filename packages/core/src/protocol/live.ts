/**
 * Live Paired transfers (spec §6.4.3, ADR-0013). Signaling payloads are signed by the sender's device key
 * and carry the DTLS fingerprint, binding the WebRTC session to pinned identities. The data channel carries
 * the same Envelope bytes as stored delivery, framed as CBOR messages of at most 64 KiB.
 */
import { ctEqual } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getBytes, getOptText, getText, getUint } from "../cbor";
import type { SigningKey } from "../crypto/keys";
import { randomBytes } from "../crypto/primitives";
import { signObject, verifyObject } from "../crypto/sig";

export type SignalKind = "offer" | "answer" | "ice" | "bye";

export interface SignalMessage {
  kind: SignalKind;
  session: Uint8Array; // 16 bytes
  ts: number;
  /** SDP for offer/answer, JSON-encoded RTCIceCandidateInit for ice, empty for bye. */
  body: string;
  /** DTLS certificate fingerprint ("sha-256 AB:CD:…") for offer/answer. */
  dtlsFingerprint?: string;
  transferId?: string;
}

function signalObject(m: SignalMessage) {
  return { 1: m.kind, 2: m.session, 3: m.ts, 4: m.body, 5: m.dtlsFingerprint, 6: m.transferId };
}

export async function encodeSignal(key: SigningKey, m: SignalMessage): Promise<Uint8Array> {
  const sig = await signObject(key, "signal", signalObject(m));
  return encodeCbor({ ...signalObject(m), 7: sig });
}

/** Verifies a signal against the sending device's signing key from the pinned chain; rejects stale messages. */
export function decodeSignal(bytes: Uint8Array, senderSigningPublic: Uint8Array, now = Math.floor(Date.now() / 1000), maxAgeSeconds = 120): SignalMessage {
  const m = asMap(decodeCbor(bytes), "signal");
  const kind = getText(m, 1, "signal") as SignalKind;
  if (!["offer", "answer", "ice", "bye"].includes(kind)) throw new Error("unknown signal kind");
  const dtls = getOptText(m, 5, "signal");
  const tid = getOptText(m, 6, "signal");
  const msg: SignalMessage = { kind, session: getBytes(m, 2, "signal", 16), ts: getUint(m, 3, "signal"), body: getText(m, 4, "signal"), ...(dtls ? { dtlsFingerprint: dtls } : {}), ...(tid ? { transferId: tid } : {}) };
  if (!verifyObject(senderSigningPublic, "signal", signalObject(msg), getBytes(m, 7, "signal", 64))) throw new Error("signal signature invalid");
  if (Math.abs(now - msg.ts) > maxAgeSeconds) throw new Error("signal is stale");
  return msg;
}

export function newSessionId(): Uint8Array {
  return randomBytes(16);
}

/** Extracts the sha-256 fingerprint line from an SDP blob. */
export function sdpFingerprint(sdp: string): string | null {
  const m = sdp.match(/^a=fingerprint:(\S+ \S+)\s*$/im);
  return m ? m[1]!.toLowerCase() : null;
}

/** True when the SDP's DTLS fingerprint equals the one signed in the signaling message. */
export function dtlsMatches(msg: SignalMessage): boolean {
  const fp = sdpFingerprint(msg.body);
  return Boolean(fp && msg.dtlsFingerprint && fp === msg.dtlsFingerprint.toLowerCase());
}

// --------------------------------------------------------------- data channel framing

export const LIVE_CHUNK = 60 * 1024;

export type LiveFrame =
  | { t: "hello"; transferId: string; wrap: Uint8Array; prekeyId: Uint8Array; segments: number }
  | { t: "manifest"; bytes: Uint8Array }
  | { t: "chunk"; index: number; offset: number; total: number; bytes: Uint8Array }
  | { t: "ack"; index: number }
  | { t: "done" }
  | { t: "error"; message: string };

export function encodeFrame(f: LiveFrame): Uint8Array {
  switch (f.t) {
    case "hello":
      return encodeCbor({ t: "hello", 1: f.transferId, 2: f.wrap, 3: f.prekeyId, 4: f.segments });
    case "manifest":
      return encodeCbor({ t: "manifest", 1: f.bytes });
    case "chunk":
      return encodeCbor({ t: "chunk", 1: f.index, 2: f.offset, 3: f.total, 4: f.bytes });
    case "ack":
      return encodeCbor({ t: "ack", 1: f.index });
    case "done":
      return encodeCbor({ t: "done" });
    case "error":
      return encodeCbor({ t: "error", 1: f.message.slice(0, 200) });
  }
}

export function decodeFrame(b: Uint8Array): LiveFrame {
  const m = asMap(decodeCbor(b), "frame");
  const t = getText(m, "t", "frame");
  switch (t) {
    case "hello":
      return { t, transferId: getText(m, 1, "hello"), wrap: getBytes(m, 2, "hello"), prekeyId: getBytes(m, 3, "hello", 8), segments: getUint(m, 4, "hello") };
    case "manifest":
      return { t, bytes: getBytes(m, 1, "manifest") };
    case "chunk":
      return { t, index: getUint(m, 1, "chunk"), offset: getUint(m, 2, "chunk"), total: getUint(m, 3, "chunk"), bytes: getBytes(m, 4, "chunk") };
    case "ack":
      return { t, index: getUint(m, 1, "ack") };
    case "done":
      return { t };
    case "error":
      return { t, message: getText(m, 1, "error") };
    default:
      throw new Error(`unknown frame ${t}`);
  }
}

/** Splits one sealed segment into chunk frames. */
export function* segmentFrames(index: number, sealed: Uint8Array): Generator<Uint8Array> {
  for (let off = 0; off < sealed.length || off === 0; off += LIVE_CHUNK) {
    yield encodeFrame({ t: "chunk", index, offset: off, total: sealed.length, bytes: sealed.subarray(off, off + LIVE_CHUNK) });
    if (sealed.length === 0) break;
  }
}

/** Reassembles chunk frames into whole sealed segments, in order. */
export class SegmentAssembler {
  private parts = new Map<number, { total: number; buf: Uint8Array; got: number }>();
  private nextIndex = 0;

  /** Returns the sealed segments that became complete and contiguous after this chunk. */
  add(f: Extract<LiveFrame, { t: "chunk" }>): { index: number; bytes: Uint8Array }[] {
    if (f.index < this.nextIndex) return [];
    if (f.total > 1024 * 1024 + 16 + 8 * 1024 * 1024) throw new Error("segment too large");
    let p = this.parts.get(f.index);
    if (!p) {
      p = { total: f.total, buf: new Uint8Array(f.total), got: 0 };
      this.parts.set(f.index, p);
    }
    if (p.total !== f.total || f.offset + f.bytes.length > p.total) throw new Error("inconsistent chunk");
    p.buf.set(f.bytes, f.offset);
    p.got += f.bytes.length;
    const out: { index: number; bytes: Uint8Array }[] = [];
    for (;;) {
      const q = this.parts.get(this.nextIndex);
      if (!q || q.got < q.total) break;
      out.push({ index: this.nextIndex, bytes: q.buf });
      this.parts.delete(this.nextIndex);
      this.nextIndex++;
    }
    return out;
  }
}

export function sameSession(a: Uint8Array, b: Uint8Array): boolean {
  return ctEqual(a, b);
}
