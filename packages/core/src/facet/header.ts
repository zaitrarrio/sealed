/**
 * Facet frame header (spec §7.5): 12 bytes, protected by RS(20,12) over GF(256) in the grid tiers and by QR's
 * own error correction in T0.
 *
 *   byte 0      magic 0xF (high nibble) ∥ version 1 (low nibble)
 *   byte 1      tier (bits 7–5) ∥ frame type (bits 4–2) ∥ loop flag (bit 1) ∥ signed flag (bit 0)
 *   bytes 2–5   stream_id
 *   byte 6      SBN
 *   bytes 7–9   ESI (big-endian)
 *   bytes 10–11 CRC-16/CCITT-FALSE over bytes 0–9 ∥ first 64 payload bytes (zero-extended if shorter)
 *
 * The CRC binds the header to the payload decoded under it; a receiver can only check it after decoding the
 * data region, which is how torn frames (header from one frame, data from another) are rejected.
 */
import { ReedSolomon } from "../fec/index";
import type { FrameType, Tier } from "./types";
import { isTier } from "./tiers";
import { Xorshift32, seedFrom } from "./random";

export const HEADER_BYTES = 12;
export const HEADER_RS_N = 20;
export const HEADER_BITS = HEADER_RS_N * 8;
export const CODEC_VERSION = 1;
const MAGIC = 0xf;
/** Payload bytes covered by the CRC. */
export const CRC_PAYLOAD_BYTES = 64;

const FRAME_TYPES: readonly FrameType[] = ["calibration", "descriptor", "data", "end"];

export interface FrameHeader {
  tier: Tier;
  type: FrameType;
  loop: boolean;
  signed: boolean;
  streamId: Uint8Array;
  sbn: number;
  esi: number;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR). Check("123456789") = 0x29B1. */
export function crc16CcittFalse(...parts: readonly Uint8Array[]): number {
  let crc = 0xffff;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      crc ^= (p[i] as number) << 8;
      for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function crcPayload(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(CRC_PAYLOAD_BYTES);
  out.set(payload.subarray(0, CRC_PAYLOAD_BYTES));
  return out;
}

/** Serialize a header for `payload` (computes the CRC). */
export function encodeFrameHeader(h: FrameHeader, payload: Uint8Array): Uint8Array {
  if (h.streamId.length !== 4) throw new RangeError("stream_id must be 4 bytes");
  if (!Number.isInteger(h.sbn) || h.sbn < 0 || h.sbn > 0xff) throw new RangeError("SBN out of range");
  if (!Number.isInteger(h.esi) || h.esi < 0 || h.esi > 0xffffff) throw new RangeError("ESI out of range");
  const t = FRAME_TYPES.indexOf(h.type);
  const out = new Uint8Array(HEADER_BYTES);
  out[0] = (MAGIC << 4) | CODEC_VERSION;
  out[1] = (h.tier << 5) | (t << 2) | (h.loop ? 2 : 0) | (h.signed ? 1 : 0);
  out.set(h.streamId, 2);
  out[6] = h.sbn;
  out[7] = (h.esi >>> 16) & 0xff;
  out[8] = (h.esi >>> 8) & 0xff;
  out[9] = h.esi & 0xff;
  const crc = crc16CcittFalse(out.subarray(0, 10), crcPayload(payload));
  out[10] = crc >>> 8;
  out[11] = crc & 0xff;
  return out;
}

/** Parse the header fields (magic, version, tier and type checked; CRC not checked). Null if malformed. */
export function parseFrameHeader(b: Uint8Array): FrameHeader | null {
  if (b.length < HEADER_BYTES) return null;
  const b0 = b[0] as number;
  const b1 = b[1] as number;
  if (b0 >> 4 !== MAGIC || (b0 & 0xf) !== CODEC_VERSION) return null;
  const tier = b1 >> 5;
  const type = FRAME_TYPES[(b1 >> 2) & 7];
  if (!isTier(tier) || !type) return null;
  return {
    tier,
    type,
    loop: (b1 & 2) !== 0,
    signed: (b1 & 1) !== 0,
    streamId: b.slice(2, 6),
    sbn: b[6] as number,
    esi: ((b[7] as number) << 16) | ((b[8] as number) << 8) | (b[9] as number),
  };
}

/** True when the header's CRC matches `payload`. */
export function headerCrcMatches(header: Uint8Array, payload: Uint8Array): boolean {
  if (header.length < HEADER_BYTES) return false;
  const crc = crc16CcittFalse(header.subarray(0, 10), crcPayload(payload));
  return (header[10] as number) === crc >>> 8 && (header[11] as number) === (crc & 0xff);
}

const headerRs = new ReedSolomon(HEADER_RS_N, HEADER_BYTES);

/** Fixed whitening mask so header strips never show long uniform runs (aids thresholding). */
const WHITEN: Uint8Array = (() => {
  const r = new Xorshift32(seedFrom(new TextEncoder().encode("facet/v1/header-whiten")));
  const m = new Uint8Array(HEADER_RS_N);
  for (let i = 0; i < m.length; i++) m[i] = r.next() & 0xff;
  return m;
})();

/** The 160 header strip bits (MSB first) for an encoded 12-byte header. */
export function headerStripBits(header: Uint8Array): Uint8Array {
  const cw = headerRs.encode(header.subarray(0, HEADER_BYTES));
  const bits = new Uint8Array(HEADER_BITS);
  for (let i = 0; i < HEADER_RS_N; i++) {
    const v = (cw[i] as number) ^ (WHITEN[i] as number);
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (v >> (7 - b)) & 1;
  }
  return bits;
}

/**
 * Decode one strip's 160 hard bits (with optional per-bit confidence; least confident bytes are tried as
 * erasures). Returns the 12 header bytes or null.
 */
export function decodeHeaderStrip(bits: Uint8Array, confidence?: Float32Array): Uint8Array | null {
  if (bits.length < HEADER_BITS) return null;
  const cw = new Uint8Array(HEADER_RS_N);
  const byteConf = new Float32Array(HEADER_RS_N);
  for (let i = 0; i < HEADER_RS_N; i++) {
    let v = 0;
    let c = Infinity;
    for (let b = 0; b < 8; b++) {
      v = (v << 1) | ((bits[i * 8 + b] as number) & 1);
      if (confidence) c = Math.min(c, confidence[i * 8 + b] as number);
    }
    cw[i] = v ^ (WHITEN[i] as number);
    byteConf[i] = c;
  }
  const order = Array.from({ length: HEADER_RS_N }, (_, i) => i).sort((a, b) => (byteConf[a] as number) - (byteConf[b] as number));
  const attempts = confidence ? [0, 2, 4, 6, 8] : [0];
  for (const e of attempts) {
    const out = headerRs.decode(cw, order.slice(0, e));
    if (out && parseFrameHeader(out)) return out;
  }
  return null;
}
