/**
 * Descriptor frame payload (spec §7.5): deterministic CBOR
 *   {1: stream_id, 2: OTI, 3: tier, 4: sender_pub?, 5: wrap | cek, 6: encrypted manifest?, 7: signature?,
 *    9: publisher fingerprint?, 10: publisher signing key?, 11: manifest digest?, 12: sender label?}
 * Key 8 (chain head) is reserved for sigchain-backed publishers. Key 5 holds the HPKE wrap (a CBOR map, ≥ 100
 * bytes) in Air-gap and the 32-byte CEK in Broadcast; the length disambiguates.
 *
 * Framing decision: the strict CBOR decoder rejects trailing bytes, so the payload is
 * u16be(cbor length) ∥ cbor ∥ deterministic filler up to T bytes (filler keeps color statistics uniform).
 * Field 6 (the Envelope's header ∥ sealed manifest) is included only when it fits in the frame; receivers
 * always also get it from the Envelope itself.
 */
import { asMap, decodeCbor, encodeCbor, getBytes, getOptBytes, getOptText, getUint, type CborValue } from "../cbor";
import { decodeOti } from "../fec/index";
import type { StreamDescriptor, Tier } from "./types";
import { isTier } from "./tiers";
import { Xorshift32, seedFrom } from "./random";

const CEK_BYTES = 32;

function cborFields(d: StreamDescriptor, includeManifest: boolean): Record<string, CborValue | undefined> {
  return {
    1: d.streamId,
    2: d.oti,
    3: d.tier,
    4: d.senderPublicKey,
    5: d.cek ?? d.wrap,
    6: includeManifest ? d.manifestPart : undefined,
    7: d.signature,
    9: d.publisherFingerprint,
    10: d.publisherSigningKey,
    11: d.manifestDigest,
    12: d.senderLabel,
  };
}

/** Serializes a descriptor into exactly `size` bytes. Throws if the mandatory fields do not fit. */
export function encodeDescriptorPayload(d: StreamDescriptor, size: number): Uint8Array {
  if (d.cek && d.wrap) throw new Error("descriptor carries either a wrap (Air-gap) or a CEK (Broadcast), not both");
  if (d.cek && d.cek.length !== CEK_BYTES) throw new Error("CEK must be 32 bytes");
  if (d.wrap && d.wrap.length === CEK_BYTES) throw new Error("wrap has an invalid length");
  let body = encodeCbor(cborFields(d, d.manifestPart !== undefined));
  if (body.length + 2 > size && d.manifestPart) body = encodeCbor(cborFields(d, false));
  if (body.length + 2 > size || body.length > 0xffff) throw new Error(`descriptor (${body.length} bytes) does not fit a ${size}-byte frame`);
  const out = new Uint8Array(size);
  out[0] = body.length >>> 8;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  const r = new Xorshift32(seedFrom(d.streamId, d.tier, 0xde5c));
  for (let i = 2 + body.length; i < size; i++) out[i] = r.next() & 0xff;
  return out;
}

/** Parses a descriptor payload; null if malformed. */
export function decodeDescriptorPayload(payload: Uint8Array): StreamDescriptor | null {
  if (payload.length < 2) return null;
  const len = ((payload[0] as number) << 8) | (payload[1] as number);
  if (len === 0 || len + 2 > payload.length) return null;
  try {
    const m = asMap(decodeCbor(payload.subarray(2, 2 + len)), "descriptor");
    const streamId = getBytes(m, 1, "descriptor", 4);
    const oti = getBytes(m, 2, "descriptor", 12);
    decodeOti(oti);
    const tier = getUint(m, 3, "descriptor");
    if (!isTier(tier)) return null;
    const key5 = getOptBytes(m, 5, "descriptor");
    const d: StreamDescriptor = { streamId: streamId.slice(), tier: tier as Tier, oti: oti.slice() };
    const senderPublicKey = getOptBytes(m, 4, "descriptor");
    if (senderPublicKey) d.senderPublicKey = senderPublicKey.slice();
    if (key5) {
      if (key5.length === CEK_BYTES) d.cek = key5.slice();
      else d.wrap = key5.slice();
    }
    const manifestPart = getOptBytes(m, 6, "descriptor");
    if (manifestPart) d.manifestPart = manifestPart.slice();
    const signature = getOptBytes(m, 7, "descriptor");
    if (signature) d.signature = signature.slice();
    const fp = getOptBytes(m, 9, "descriptor");
    if (fp) d.publisherFingerprint = fp.slice();
    const sk = getOptBytes(m, 10, "descriptor");
    if (sk) d.publisherSigningKey = sk.slice();
    const md = getOptBytes(m, 11, "descriptor");
    if (md) d.manifestDigest = md.slice();
    const label = getOptText(m, 12, "descriptor");
    if (label !== undefined) d.senderLabel = label;
    return d;
  } catch {
    return null;
  }
}
