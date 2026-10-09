/**
 * Grid-frame content (T1–T3): header strips, anchors, and the data region produced from a payload via the inner
 * RS(255,207) code (spec §7.5) — shared by the sender (rendering) and the receiver (decoding).
 *
 * Data path for one frame:
 *   payload (T bytes) ∥ zero fill → C × 207 systematic bytes, byte j belongs to codeword j mod C
 *   → each codeword RS(255,207)-encoded → C × 255 stream bytes, same interleave
 *   → XOR whitening with a PRNG keyed by (stream_id, tier, type, SBN, ESI)
 *   → bits packed into cells (color bits most significant) in the tier's fixed cell permutation
 *   → remaining cells filled with the same PRNG (spec §7.2 padding).
 * Spec §7.2 seeds padding with "stream_id ∥ frame counter"; the frame counter is not in the header, so Facet uses
 * the header's (type, SBN, ESI), which identifies the frame content and lets receivers regenerate padding cells.
 */
import { ReedSolomon } from "../fec/index";
import type { FrameType } from "./types";
import { calibrationLayout, CellKind, gridLayout, streamToCells, cellsToStream, type GridLayout } from "./layout";
import { HEADER_BITS, headerStripBits } from "./header";
import { Xorshift32, seedFrom } from "./random";
import type { GridTier } from "./tiers";

/** Picture codes for one grid cell: ≥ 0 is a glyph symbol (color · 16 + shape). */
export const PIC_BG = -1;
export const PIC_WHITE = -2;
/** Gray ramp level l is encoded as PIC_GRAY_BASE - l. */
export const PIC_GRAY_BASE = -3;

const TYPE_INDEX: Record<FrameType, number> = { calibration: 0, descriptor: 1, data: 2, end: 3 };

export interface FrameIdentity {
  streamId: Uint8Array;
  tier: GridTier;
  type: FrameType;
  sbn: number;
  esi: number;
}

/** PRNG for whitening and padding of one frame. */
export function frameRng(id: FrameIdentity): Xorshift32 {
  return new Xorshift32(seedFrom(id.streamId, (id.tier << 24) | (TYPE_INDEX[id.type] << 16) | id.sbn, id.esi));
}

/** Whitening mask for the codeword stream, and the generator positioned at the padding bits. */
export function frameMask(layout: GridLayout, id: FrameIdentity): { mask: Uint8Array; padding: Xorshift32 } {
  const rng = frameRng(id);
  const mask = new Uint8Array(layout.streamBytes);
  for (let j = 0; j < mask.length; j++) mask[j] = rng.next() & 0xff;
  return { mask, padding: rng };
}

/**
 * Inner-code decoding policy: erase the least confident bytes in steps, and keep RS_SAFETY_MARGIN parity symbols
 * unused (2e + f ≤ n − k − margin). With 8 spare symbols a codeword that is not within reach decodes to a wrong
 * codeword with probability ≈ 256⁻⁸, so wrong symbols do not reach RaptorQ (the header CRC covers only 64 bytes).
 */
const ERASURE_LADDER: readonly number[] = [0, 8, 16, 24, 32, 40];
const RS_SAFETY_MARGIN = 8;

const rsCache = new Map<string, ReedSolomon>();
export function innerRs(n = 255, k = 207): ReedSolomon {
  const key = `${n}/${k}`;
  let rs = rsCache.get(key);
  if (!rs) {
    rs = new ReedSolomon(n, k);
    rsCache.set(key, rs);
  }
  return rs;
}

/** Encodes `payload` (≤ T bytes; zero-filled) into the whitened codeword stream. */
export function encodeStream(layout: GridLayout, payload: Uint8Array, mask: Uint8Array): Uint8Array {
  if (payload.length > layout.symbolSize) throw new RangeError(`payload exceeds T=${layout.symbolSize}`);
  const C = layout.codewords;
  const rs = innerRs();
  const stream = new Uint8Array(layout.streamBytes);
  const data = new Uint8Array(rs.k);
  for (let c = 0; c < C; c++) {
    for (let p = 0; p < rs.k; p++) {
      const j = p * C + c;
      data[p] = j < payload.length ? (payload[j] as number) : 0;
    }
    const cw = rs.encode(data);
    for (let p = 0; p < rs.n; p++) stream[p * C + c] = cw[p] as number;
  }
  for (let j = 0; j < stream.length; j++) stream[j] = (stream[j] as number) ^ (mask[j] as number);
  return stream;
}

/** Data-cell values (in permutation order) for a frame. */
export function encodeDataCells(layout: GridLayout, id: FrameIdentity, payload: Uint8Array): Uint8Array {
  const { mask, padding } = frameMask(layout, id);
  return streamToCells(encodeStream(layout, payload, mask), layout, padding);
}

/**
 * Expected values of the pure padding cells (permutation positions ≥ cellsUsed). The receiver regenerates them
 * from the header so they serve as known pilots for inter-symbol-interference cancellation.
 */
export function paddingCells(layout: GridLayout, id: FrameIdentity): Uint8Array {
  const { padding } = frameMask(layout, id);
  const bpc = layout.bitsPerCell;
  const totalBits = layout.streamBytes * 8;
  const partialBits = layout.cellsUsed * bpc - totalBits; // padding bits inside the last used cell
  for (let i = 0; i < partialBits; i++) padding.next();
  const out = new Uint8Array(layout.dataOrder.length - layout.cellsUsed);
  for (let c = 0; c < out.length; c++) {
    let v = 0;
    for (let b = 0; b < bpc; b++) v = (v << 1) | (padding.next() & 1);
    out[c] = v;
  }
  return out;
}

/** Header strip bits: 160 RS(20,12) bits followed by an alternating filler in the remaining strip cells. */
export function stripBits(layout: GridLayout, header: Uint8Array): Uint8Array {
  const bits = headerStripBits(header);
  const out = new Uint8Array(layout.headerTop.length);
  out.set(bits);
  for (let i = HEADER_BITS; i < out.length; i++) out[i] = i & 1;
  return out;
}

/** Fills anchors and header strips into a picture. */
function frame(layout: GridLayout, header: Uint8Array): Int16Array {
  const n = layout.n;
  const pic = new Int16Array(n * n).fill(PIC_BG);
  for (let i = 0; i < n * n; i++) if (layout.kind[i] === CellKind.Anchor && layout.anchorLight[i]) pic[i] = PIC_WHITE;
  const bits = stripBits(layout, header);
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? PIC_WHITE : PIC_BG;
    pic[layout.headerTop[i] as number] = v;
    pic[layout.headerBottom[i] as number] = v;
  }
  return pic;
}

/** The full cell picture (index y · N + x) of a data, descriptor or end frame. */
export function dataPicture(layout: GridLayout, header: Uint8Array, id: FrameIdentity, payload: Uint8Array): Int16Array {
  const pic = frame(layout, header);
  const cells = encodeDataCells(layout, id, payload);
  for (let i = 0; i < cells.length; i++) pic[layout.dataOrder[i] as number] = cells[i] as number;
  return pic;
}

/** The cell picture of a calibration frame: palette × shape tiling plus gray ramps. */
export function calibrationPicture(layout: GridLayout, header: Uint8Array): Int16Array {
  const pic = frame(layout, header);
  const cal = calibrationLayout(layout.tier);
  for (let i = 0; i < pic.length; i++) {
    const s = cal.symbols[i] as number;
    const r = cal.ramp[i] as number;
    if (r >= 0) pic[i] = PIC_GRAY_BASE - r;
    else if (s >= 0) pic[i] = s;
  }
  return pic;
}

export interface StreamDecodeResult {
  payload: Uint8Array | null;
  /** Codewords that decoded (for decision feedback). */
  ok: Uint8Array;
  /** Corrected, re-whitened stream bytes for decoded codewords (others hold the received bytes). */
  stream: Uint8Array;
  failed: number;
}

/** Codewords already decoded in an earlier pass, with their corrected (whitened) stream bytes. */
export interface DecodedCodewords {
  readonly ok: Uint8Array;
  readonly stream: Uint8Array;
}

/**
 * RS-decodes the whitened stream read from the cells. `byteConf` ranks byte reliability (low = erase first);
 * `forcedErasures` marks bytes that must be erased (torn-frame salvage). Known zero-fill bytes are restored.
 * Codewords marked in `known.ok` are taken from `known.stream` instead of being decoded again. Decoding stops after
 * `maxFailures` failed codewords (the payload is then null; remaining codewords are reported as not ok).
 */
export function decodeStream(
  layout: GridLayout,
  received: Uint8Array,
  mask: Uint8Array,
  byteConf: Float32Array,
  forcedErasures?: Uint8Array,
  known?: DecodedCodewords,
  maxFailures = Infinity,
): StreamDecodeResult {
  const C = layout.codewords;
  const rs = innerRs();
  const T = layout.symbolSize;
  const ok = new Uint8Array(C);
  const stream = received.slice();
  const payload = new Uint8Array(T);
  const cw = new Uint8Array(rs.n);
  const conf = new Float32Array(rs.n);
  const idx = new Int32Array(rs.n);
  const maxErasures = rs.n - rs.k;
  let failed = 0;
  for (let c = 0; c < C; c++) {
    if (known && known.ok[c]) {
      ok[c] = 1;
      for (let p = 0; p < rs.n; p++) {
        const j = p * C + c;
        stream[j] = known.stream[j] as number;
        if (p < rs.k && j < T) payload[j] = (stream[j] as number) ^ (mask[j] as number);
      }
      continue;
    }
    const forced: number[] = [];
    for (let p = 0; p < rs.n; p++) {
      const j = p * C + c;
      let v = (received[j] as number) ^ (mask[j] as number);
      let cf = byteConf[j] as number;
      if (p < rs.k && j >= T) {
        v = 0; // known zero fill
        cf = Infinity;
      } else if (forcedErasures && forcedErasures[j]) {
        forced.push(p);
      }
      cw[p] = v;
      conf[p] = cf;
      idx[p] = p;
    }
    if (forced.length > maxErasures) {
      failed++;
      if (failed >= maxFailures) return { payload: null, ok, stream, failed };
      continue;
    }
    const forcedSet = new Set(forced);
    const order = Array.from(idx).filter((p) => !forcedSet.has(p)).sort((a, b) => (conf[a] as number) - (conf[b] as number));
    let out: Uint8Array | null = null;
    let full: Uint8Array | null = null;
    for (const extra of ERASURE_LADDER) {
      const erased = extra === 0 ? forced : forced.concat(order.slice(0, extra));
      if (erased.length > maxErasures - RS_SAFETY_MARGIN) break;
      const cand = rs.decode(cw, erased);
      if (!cand) continue;
      // Miscorrection guard: accept only when 2e + f leaves RS_SAFETY_MARGIN parity symbols unused, where e counts
      // corrected positions outside the erasures. Decoding at the full radius n − k would "correct" any word.
      const enc = rs.encode(cand);
      const erasedSet = new Set(erased);
      let errors = 0;
      for (let p = 0; p < rs.n; p++) if (!erasedSet.has(p) && enc[p] !== cw[p]) errors++;
      if (2 * errors + erased.length > maxErasures - RS_SAFETY_MARGIN) continue;
      out = cand;
      full = enc;
      break;
    }
    if (!out || !full) {
      failed++;
      if (failed >= maxFailures) return { payload: null, ok, stream, failed };
      continue;
    }
    ok[c] = 1;
    for (let p = 0; p < rs.n; p++) {
      const j = p * C + c;
      stream[j] = (full[p] as number) ^ (mask[j] as number);
      if (p < rs.k && j < T) payload[j] = out[p] as number;
    }
  }
  return { payload: failed === 0 ? payload : null, ok, stream, failed };
}

/** Cell values (permutation order, used cells) implied by a stream. */
export function streamCells(layout: GridLayout, stream: Uint8Array): Uint8Array {
  return streamToCells(stream, layout, new Xorshift32(1)).subarray(0, layout.cellsUsed);
}

/** Reads the whitened stream from decided cell values (permutation order). */
export function cellsStream(layout: GridLayout, cells: Uint8Array): Uint8Array {
  return cellsToStream(cells, layout);
}

export { gridLayout };
