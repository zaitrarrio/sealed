import { crc16CcittFalse, encodeFrameHeader, parseFrameHeader, headerCrcMatches, headerStripBits, decodeHeaderStrip, type FrameHeader } from "../../src/facet/header";
import { Xorshift32 } from "../../src/facet/random";
import { bytes, print } from "./util";

const rng = new Xorshift32(99);
const rand = (n: number) => Uint8Array.from({ length: n }, () => rng.next() & 0xff);
const crcCheck = crc16CcittFalse(new TextEncoder().encode("123456789"));
const crcParts = crc16CcittFalse(new TextEncoder().encode("1234"), new TextEncoder().encode("56789"));
const crcEmpty = crc16CcittFalse();

const headers: FrameHeader[] = [
  { tier: 1, type: "data", loop: true, signed: false, streamId: Uint8Array.from([0xe1, 0xcb, 0x88, 0x16]), sbn: 0, esi: 0 },
  { tier: 3, type: "calibration", loop: false, signed: true, streamId: Uint8Array.from([1, 2, 3, 4]), sbn: 255, esi: 0xffffff },
  { tier: 2, type: "descriptor", loop: true, signed: true, streamId: Uint8Array.from([0, 0, 0, 0]), sbn: 7, esi: 0x012345 },
  { tier: 0, type: "end", loop: false, signed: false, streamId: Uint8Array.from([0xff, 0xff, 0xff, 0xff]), sbn: 1, esi: 300 },
];
const payloads = [new Uint8Array(0), rand(10), rand(64), rand(200)];

const enc = headers.map((h, i) => {
  const payload = payloads[i % payloads.length] as Uint8Array;
  const header = encodeFrameHeader(h, payload);
  const parsed = parseFrameHeader(header)!;
  const strip = headerStripBits(header);
  // Corruptions: flip bits in the strip; with and without confidence.
  const flips: { positions: number[]; conf: number[] | null; decoded: string | null }[] = [];
  const flipSets = [[], [3], [0, 9, 20], [1, 2, 3, 4], [5, 13, 21, 29, 37], [8, 16, 24, 32, 40, 48, 56, 64], [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80]];
  for (const positions of flipSets) {
    const b = Uint8Array.from(strip);
    for (const p of positions) b[p] ^= 1;
    flips.push({ positions, conf: null, decoded: (() => { const d = decodeHeaderStrip(b); return d ? bytes(d) : null; })() });
    // Confidence: flipped bits get low confidence (so their bytes are erased first), others 1.
    const conf = new Float32Array(strip.length).fill(1);
    for (const p of positions) conf[p] = 0.1 + 0.01 * p;
    const d = decodeHeaderStrip(b, conf);
    flips.push({ positions, conf: Array.from(conf), decoded: d ? bytes(d) : null });
  }
  // Misleading confidence: low confidence on correct bits.
  const conf2 = new Float32Array(strip.length).fill(0.5);
  for (let i = 0; i < 40; i++) conf2[i * 4] = 0.01;
  const d2 = decodeHeaderStrip(strip, conf2);
  flips.push({ positions: [], conf: Array.from(conf2), decoded: d2 ? bytes(d2) : null });
  return {
    header: { ...h, streamId: bytes(h.streamId) },
    payload: bytes(payload),
    encoded: bytes(header),
    parsed: { ...parsed, streamId: bytes(parsed.streamId) },
    crcMatches: headerCrcMatches(header, payload),
    crcMismatch: headerCrcMatches(header, Uint8Array.from(payload.length ? [payload[0]! ^ 1, ...payload.subarray(1)] : [1])),
    strip: Array.from(strip).join(""),
    flips,
  };
});
const badHeaders = [bytes(new Uint8Array(11)), bytes(Uint8Array.from([0xf0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), bytes(Uint8Array.from([0xe1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), bytes(Uint8Array.from([0xf1, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), bytes(Uint8Array.from([0xf1, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))].map((b) => ({ bytes: b, parsed: parseFrameHeader(Buffer.from(b, "base64")) !== null }));
print({ crcCheck, crcParts, crcEmpty, headers: enc, badHeaders });
