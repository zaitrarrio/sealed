/**
 * Acoustic packet framing. The speaker only ever carries ciphertext Envelope bytes (and RaptorQ symbols /
 * descriptor CBOR that wraps the CEK). Claim secrets and safety codes never enter a packet.
 */
import { crc32 } from "./crc32";
import type { AcousticProfileId } from "./profiles";

export const ACOUSTIC_MAGIC = 0x53414c41; // "SALA"
export const ACOUSTIC_VERSION = 1;

/** Fixed header before the variable payload: magic(4) ver(1) profile(1) type(1) flags(1) stream(4) sbn(1) esi(3) len(2) = 18. */
export const PACKET_HEADER_BYTES = 18;
export const PACKET_CRC_BYTES = 4;

export type AcousticPacketType = "sync" | "descriptor" | "data" | "end";

const TYPE_CODE: Record<AcousticPacketType, number> = { sync: 0, descriptor: 1, data: 2, end: 3 };
const TYPE_FROM: Record<number, AcousticPacketType> = { 0: "sync", 1: "descriptor", 2: "data", 3: "end" };

export interface AcousticPacket {
  profile: AcousticProfileId;
  type: AcousticPacketType;
  flags: number;
  streamId: Uint8Array; // 4
  sbn: number;
  esi: number;
  payload: Uint8Array;
}

export function encodePacket(p: AcousticPacket): Uint8Array {
  if (p.streamId.length !== 4) throw new RangeError("streamId must be 4 bytes");
  if (p.payload.length > 0xffff) throw new RangeError("payload too large");
  if (p.esi < 0 || p.esi > 0xffffff) throw new RangeError("esi out of range");
  if (p.sbn < 0 || p.sbn > 0xff) throw new RangeError("sbn out of range");
  const out = new Uint8Array(PACKET_HEADER_BYTES + p.payload.length + PACKET_CRC_BYTES);
  out[0] = (ACOUSTIC_MAGIC >>> 24) & 0xff;
  out[1] = (ACOUSTIC_MAGIC >>> 16) & 0xff;
  out[2] = (ACOUSTIC_MAGIC >>> 8) & 0xff;
  out[3] = ACOUSTIC_MAGIC & 0xff;
  out[4] = ACOUSTIC_VERSION;
  out[5] = p.profile;
  out[6] = TYPE_CODE[p.type];
  out[7] = p.flags & 0xff;
  out.set(p.streamId, 8);
  out[12] = p.sbn & 0xff;
  out[13] = (p.esi >>> 16) & 0xff;
  out[14] = (p.esi >>> 8) & 0xff;
  out[15] = p.esi & 0xff;
  out[16] = (p.payload.length >>> 8) & 0xff;
  out[17] = p.payload.length & 0xff;
  out.set(p.payload, PACKET_HEADER_BYTES);
  const c = crc32(out.subarray(0, PACKET_HEADER_BYTES + p.payload.length));
  const off = PACKET_HEADER_BYTES + p.payload.length;
  out[off] = (c >>> 24) & 0xff;
  out[off + 1] = (c >>> 16) & 0xff;
  out[off + 2] = (c >>> 8) & 0xff;
  out[off + 3] = c & 0xff;
  return out;
}

/** Parses one packet starting at `offset`. Returns null if magic/CRC/type fail. */
export function decodePacket(buf: Uint8Array, offset = 0): { packet: AcousticPacket; bytes: number } | null {
  if (offset + PACKET_HEADER_BYTES + PACKET_CRC_BYTES > buf.length) return null;
  const magic = ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
  if (magic !== ACOUSTIC_MAGIC) return null;
  if (buf[offset + 4] !== ACOUSTIC_VERSION) return null;
  const profile = buf[offset + 5] as AcousticProfileId;
  if (profile !== 0 && profile !== 1) return null;
  const type = TYPE_FROM[buf[offset + 6]!];
  if (!type) return null;
  const flags = buf[offset + 7]!;
  const streamId = buf.subarray(offset + 8, offset + 12).slice();
  const sbn = buf[offset + 12]!;
  const esi = (buf[offset + 13]! << 16) | (buf[offset + 14]! << 8) | buf[offset + 15]!;
  const len = (buf[offset + 16]! << 8) | buf[offset + 17]!;
  const total = PACKET_HEADER_BYTES + len + PACKET_CRC_BYTES;
  if (offset + total > buf.length) return null;
  const body = buf.subarray(offset, offset + PACKET_HEADER_BYTES + len);
  const expect =
    ((buf[offset + PACKET_HEADER_BYTES + len]! << 24) |
      (buf[offset + PACKET_HEADER_BYTES + len + 1]! << 16) |
      (buf[offset + PACKET_HEADER_BYTES + len + 2]! << 8) |
      buf[offset + PACKET_HEADER_BYTES + len + 3]!) >>>
    0;
  if (crc32(body) !== expect) return null;
  return {
    packet: {
      profile,
      type,
      flags,
      streamId,
      sbn,
      esi,
      payload: buf.subarray(offset + PACKET_HEADER_BYTES, offset + PACKET_HEADER_BYTES + len).slice(),
    },
    bytes: total,
  };
}

/** Splits a descriptor blob into fixed-size fragments; flags carry fragIndex/fragCount in the high nibble pair. */
export function fragmentPayload(data: Uint8Array, maxPayload: number): { payload: Uint8Array; fragIndex: number; fragCount: number }[] {
  if (maxPayload < 4) throw new RangeError("maxPayload too small");
  const bodyMax = maxPayload - 2;
  const fragCount = Math.max(1, Math.ceil(data.length / bodyMax));
  const out: { payload: Uint8Array; fragIndex: number; fragCount: number }[] = [];
  for (let i = 0; i < fragCount; i++) {
    const slice = data.subarray(i * bodyMax, Math.min(data.length, (i + 1) * bodyMax));
    const payload = new Uint8Array(2 + slice.length);
    payload[0] = i;
    payload[1] = fragCount;
    payload.set(slice, 2);
    out.push({ payload, fragIndex: i, fragCount });
  }
  return out;
}

export function defragmentPayload(frags: Map<number, Uint8Array>, fragCount: number): Uint8Array | null {
  if (frags.size < fragCount) return null;
  let total = 0;
  for (let i = 0; i < fragCount; i++) {
    const f = frags.get(i);
    if (!f) return null;
    total += f.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < fragCount; i++) {
    const f = frags.get(i)!;
    out.set(f, off);
    off += f.length;
  }
  return out;
}
