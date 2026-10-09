/**
 * Grid-frame decoding (spec §7.6 steps 3–8) given a homography and a channel calibration.
 *
 * Header strips: full black/white cells, decided by decision feedback against the channel model (known anchors and
 * quiet zone, expected-mean data neighbors), then RS(20,12)-decoded with the least confident bytes as erasures.
 * Either strip is accepted.
 *
 * Data cells — joint color + shape maximum-likelihood detection with interference cancellation:
 *   r = observed − predicted(all other cells)  (12-vector: 4 quadrants × RGB, screen domain)
 *   (k*, s*) = argmin ‖r − (W0 · fill_s) ⊗ c_k‖²
 * where c_k are calibrated centroids and W0 the blur model's self response. This is the matched-filter form of
 * "color by nearest calibrated centroid, shape by template correlation" (spec §7.6 step 6) and remains exact when
 * neighbors bleed into the cell. Interference is cancelled iteratively (decision feedback, 3 passes), then
 * RS(255,207) decodes each codeword, erasing the least confident bytes (up to 48). Codewords that decode turn
 * their cells into known sources and the remaining cells are re-detected (turbo refinement, ≤ 2 rounds).
 *
 * Temporal fusion (spec §7.6 step 8): when a frame fails, the per-cell sufficient statistics of the ML metric
 * (b = W0ᵀ r / σ², plus the per-capture Gram matrix W0ᵀ W0 / σ²) are kept per (stream, tier, SBN, ESI).
 * Statistics from repeated captures add exactly, so a later capture of the same symbol is decoded from the joint
 * likelihood of all captures.
 *
 * Torn frames: when the two header strips decode to different headers, both headers are tried; the CRC binds the
 * header to the payload, so only the matching interpretation is accepted. (Region-split salvage of a frame torn
 * between two data frames is not implemented: with the spatial interleave every codeword spans the tear.)
 */
import type { RgbaImage } from "./types";
import type { Homography } from "./homography";
import { sampleCells } from "./sample";
import { correctFeatures, setSource, WHITE_EXCESS, type ChannelCalibration } from "./calibrate";
import { cellsOfByte, cellsToStream, CellKind, type GridLayout } from "./layout";
import { HEADER_BITS, decodeHeaderStrip, headerCrcMatches, parseFrameHeader, type FrameHeader } from "./header";
import { decodeStream, frameMask, paddingCells, PIC_BG, PIC_WHITE, streamCells, stripBits } from "./grid";
import { GLYPH_FILLS } from "./glyphs";
import { newSourceGrid, predictFeatures, responseModel, selfFeatures, type ResponseModel, type SourceGrid } from "./model";
import type { GridTier } from "./tiers";

const WHITE_NORM2 = WHITE_EXCESS[0] * WHITE_EXCESS[0] + WHITE_EXCESS[1] * WHITE_EXCESS[1] + WHITE_EXCESS[2] * WHITE_EXCESS[2];
const DFE_PASSES = 3;
const TURBO_ROUNDS = 2;

/** Observed frame: corrected features + the model they were corrected for. */
export interface Observation {
  readonly layout: GridLayout;
  readonly feat: Float32Array;
  readonly valid: Uint8Array;
  readonly model: ResponseModel;
  readonly centroids: Float32Array;
}

export function observe(img: RgbaImage, h: Homography, layout: GridLayout, cal: ChannelCalibration, centroids: Float32Array): Observation | null {
  const s = sampleCells(img, h, layout.n, cal.lut);
  let valid = 0;
  for (let i = 0; i < s.valid.length; i++) valid += s.valid[i] as number;
  if (valid < s.valid.length * 0.98) return null;
  return { layout, feat: correctFeatures(s, cal.x), valid: s.valid, model: responseModel(cal.sigma), centroids };
}

/** Known structure: anchors light/dark, everything else background (zero). */
function baseSource(layout: GridLayout, centroids: Float32Array): SourceGrid {
  const n = layout.n;
  const src = newSourceGrid(n);
  for (let c = 0; c < n * n; c++) {
    if (layout.kind[c] === CellKind.Anchor && layout.anchorLight[c]) setSource(src, c, PIC_WHITE, centroids);
  }
  return src;
}

/** Sets cell c to the expected source of an unknown data cell. */
function setMeanSource(src: SourceGrid, c: number, meanFill: number, meanColor: Float32Array): void {
  const qo = c * 12;
  for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) src.q[qo + q * 3 + ch] = meanFill * (meanColor[ch] as number);
  src.f[c * 3] = 0;
  src.f[c * 3 + 1] = 0;
  src.f[c * 3 + 2] = 0;
}

function meanOf(centroids: Float32Array): Float32Array {
  const k = centroids.length / 3;
  const m = new Float32Array(3);
  for (let i = 0; i < k; i++) for (let ch = 0; ch < 3; ch++) m[ch] = (m[ch] as number) + (centroids[i * 3 + ch] as number) / k;
  return m;
}

let MEAN_FILL = 0;
for (let i = 0; i < GLYPH_FILLS.length; i++) MEAN_FILL += (GLYPH_FILLS[i] as number) / GLYPH_FILLS.length;

export interface HeaderCandidate {
  readonly bytes: Uint8Array;
  readonly header: FrameHeader;
  readonly strip: "top" | "bottom";
}

/** Decodes both header strips. Returns the distinct valid headers (top first). */
export function decodeHeaders(obs: Observation): HeaderCandidate[] {
  const layout = obs.layout;
  const n = layout.n;
  const src = baseSource(layout, obs.centroids);
  const meanColor = meanOf(obs.centroids);
  for (let c = 0; c < n * n; c++) if (layout.kind[c] === CellKind.Data) setMeanSource(src, c, MEAN_FILL, meanColor);
  const strips = [layout.headerTop, layout.headerBottom];
  const bits = strips.map((s) => new Uint8Array(s.length));
  const conf = strips.map((s) => new Float32Array(s.length));
  const self = new Float32Array(12);
  const whiteSelf = (obs.model.wf0[0] as number + (obs.model.wf0[1] as number) + (obs.model.wf0[2] as number) + (obs.model.wf0[3] as number)) / 4;
  const fixedFiller = (i: number): number => i & 1;
  for (let pass = 0; pass < 3; pass++) {
    const pred = pass === 0 ? null : predictFeatures(obs.model, src);
    strips.forEach((cells, si) => {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i] as number;
        let acc = 0;
        if (pred) selfFeatures(obs.model, src, c, self);
        for (let q = 0; q < 4; q++) {
          for (let ch = 0; ch < 3; ch++) {
            const o = c * 12 + q * 3 + ch;
            const r = (obs.feat[o] as number) - (pred ? (pred[o] as number) - (self[q * 3 + ch] as number) : 0);
            acc += r * (WHITE_EXCESS[ch] as number);
          }
        }
        const level = acc / 4 / WHITE_NORM2; // fraction of a fully lit, isolated cell
        const thr = pred ? whiteSelf / 2 : 0.5 * whiteSelf;
        const bit = i >= HEADER_BITS ? fixedFiller(i) : level > thr ? 1 : 0;
        (bits[si] as Uint8Array)[i] = bit;
        (conf[si] as Float32Array)[i] = i >= HEADER_BITS ? Infinity : Math.abs(level - thr);
      }
      for (let i = 0; i < cells.length; i++) setSource(src, cells[i] as number, (bits[si] as Uint8Array)[i] ? PIC_WHITE : PIC_BG, obs.centroids);
    });
  }
  const out: HeaderCandidate[] = [];
  (["top", "bottom"] as const).forEach((name, si) => {
    const b = decodeHeaderStrip(bits[si] as Uint8Array, conf[si] as Float32Array);
    if (!b) return;
    const header = parseFrameHeader(b);
    if (!header) return;
    if (out.some((o) => o.bytes.every((v, i) => v === b[i]))) return;
    out.push({ bytes: b, header, strip: name });
  });
  return out;
}

/** Sufficient statistics of one or more captures of the same frame (for temporal fusion). */
export interface FusionStats {
  /** Σ W0ᵀ r / σ² per used data cell (permutation order): [p * 12 + q * 3 + ch]. */
  readonly b: Float32Array;
  /** Σ W0ᵀ W0 / σ² (4 × 4). */
  readonly m: Float64Array;
  captures: number;
}

export interface DataDecodeResult {
  readonly payload: Uint8Array | null;
  readonly stats: FusionStats | null;
  /** Fraction of codewords that decoded. */
  readonly codewordFraction: number;
}

interface Detector {
  /** e[s * K + k] = fill_sᵀ M fill_s · |c_k|². */
  readonly e: Float32Array;
  readonly centroids: Float32Array;
  readonly k: number;
}

function makeDetector(m: Float64Array, centroids: Float32Array, colors: number): Detector {
  const e = new Float32Array(16 * colors);
  for (let s = 0; s < 16; s++) {
    let quad = 0;
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) quad += (GLYPH_FILLS[s * 4 + a] as number) * (m[a * 4 + b] as number) * (GLYPH_FILLS[s * 4 + b] as number);
    }
    for (let k = 0; k < colors; k++) {
      const c0 = centroids[k * 3] as number;
      const c1 = centroids[k * 3 + 1] as number;
      const c2 = centroids[k * 3 + 2] as number;
      e[s * colors + k] = quad * (c0 * c0 + c1 * c1 + c2 * c2);
    }
  }
  return { e, centroids, k: colors };
}

/** ML decision from statistic b (12 floats at offset). Returns symbol and margin (2nd best − best score). */
function detect(det: Detector, b: Float32Array, off: number, dots: Float32Array): { sym: number; margin: number; best: number } {
  const K = det.k;
  const c = det.centroids;
  for (let q = 0; q < 4; q++) {
    const b0 = b[off + q * 3] as number;
    const b1 = b[off + q * 3 + 1] as number;
    const b2 = b[off + q * 3 + 2] as number;
    for (let k = 0; k < K; k++) dots[q * K + k] = b0 * (c[k * 3] as number) + b1 * (c[k * 3 + 1] as number) + b2 * (c[k * 3 + 2] as number);
  }
  let best = Infinity;
  let second = Infinity;
  let sym = 0;
  for (let s = 0; s < 16; s++) {
    const f0 = GLYPH_FILLS[s * 4] as number;
    const f1 = GLYPH_FILLS[s * 4 + 1] as number;
    const f2 = GLYPH_FILLS[s * 4 + 2] as number;
    const f3 = GLYPH_FILLS[s * 4 + 3] as number;
    for (let k = 0; k < K; k++) {
      const score = (det.e[s * K + k] as number) - 2 * (f0 * (dots[k] as number) + f1 * (dots[K + k] as number) + f2 * (dots[2 * K + k] as number) + f3 * (dots[3 * K + k] as number));
      if (score < best) {
        second = best;
        best = score;
        sym = k * 16 + s;
      } else if (score < second) {
        second = score;
      }
    }
  }
  return { sym, margin: second - best, best };
}

/** W0ᵀ r for one cell's residual (12 floats) into out at offset. */
function projectResidual(w0: Float64Array, r: Float32Array, out: Float32Array, off: number, scale: number): void {
  for (let a = 0; a < 4; a++) {
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (let q = 0; q < 4; q++) acc += (w0[q * 4 + a] as number) * (r[q * 3 + ch] as number);
      out[off + a * 3 + ch] = acc * scale;
    }
  }
}

function gram(w0: Float64Array, scale: number): Float64Array {
  const m = new Float64Array(16);
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      let acc = 0;
      for (let q = 0; q < 4; q++) acc += (w0[q * 4 + a] as number) * (w0[q * 4 + b] as number);
      m[a * 4 + b] = acc * scale;
    }
  }
  return m;
}

/** Bits → whitened stream and per-byte confidence from per-cell margins (permutation order). */
function cellsToStreamWithConf(layout: GridLayout, sym: Uint8Array, margin: Float32Array): { stream: Uint8Array; conf: Float32Array } {
  const stream = cellsToStream(sym, layout);
  const conf = new Float32Array(layout.streamBytes);
  const bpc = layout.bitsPerCell;
  for (let j = 0; j < conf.length; j++) {
    const [a, b] = cellsOfByte(j, bpc);
    conf[j] = Math.min(margin[a] as number, margin[b] as number);
  }
  return { stream, conf };
}

/**
 * Decodes the data region of a frame (data, descriptor or end) under `header`. `prior` holds fusion statistics
 * from earlier failed captures of the same frame.
 */
export function decodeData(obs: Observation, candidate: HeaderCandidate, prior: FusionStats | null): DataDecodeResult {
  const layout = obs.layout;
  const n = layout.n;
  const h = candidate.header;
  const tier = h.tier as GridTier;
  const colors = obs.centroids.length / 3;
  const id = { streamId: h.streamId, tier, type: h.type, sbn: h.sbn, esi: h.esi };
  const { mask } = frameMask(layout, id);
  const used = layout.cellsUsed;
  const order = layout.dataOrder;

  // Known sources: anchors, both header strips (from the decoded header), padding pilots.
  const src = baseSource(layout, obs.centroids);
  const meanColor = meanOf(obs.centroids);
  const stripBitsTop = stripBits(layout, candidate.bytes);
  for (let i = 0; i < layout.headerTop.length; i++) {
    const v = stripBitsTop[i] ? PIC_WHITE : PIC_BG;
    setSource(src, layout.headerTop[i] as number, v, obs.centroids);
    setSource(src, layout.headerBottom[i] as number, v, obs.centroids);
  }
  const pad = paddingCells(layout, id);
  for (let p = used; p < order.length; p++) setSource(src, order[p] as number, pad[p - used] as number, obs.centroids);
  const known = new Uint8Array(used);
  for (let p = 0; p < used; p++) setMeanSource(src, order[p] as number, MEAN_FILL, meanColor);

  const w0 = obs.model.w0;
  const det = makeDetector(gram(w0, 1), obs.centroids, colors);
  const sym = new Uint8Array(used);
  const margin = new Float32Array(used);
  const best = new Float32Array(used);
  const dots = new Float32Array(4 * colors);
  const r = new Float32Array(12);
  const self = new Float32Array(12);
  const bstat = new Float32Array(used * 12);
  let lastStats: FusionStats | null = null;
  let okFraction = 0;
  let decodedMask: Uint8Array | null = null;

  for (let round = 0; round <= TURBO_ROUNDS; round++) {
    for (let pass = 0; pass < DFE_PASSES; pass++) {
      const pred = predictFeatures(obs.model, src);
      for (let p = 0; p < used; p++) {
        if (known[p]) continue;
        const c = order[p] as number;
        selfFeatures(obs.model, src, c, self);
        for (let i = 0; i < 12; i++) r[i] = (obs.feat[c * 12 + i] as number) - (pred[c * 12 + i] as number) + (self[i] as number);
        projectResidual(w0, r, bstat, p * 12, 1);
        const d = detect(det, bstat, p * 12, dots);
        sym[p] = d.sym;
        margin[p] = d.margin;
        best[p] = d.best;
      }
      // Feed decisions back: confident cells hard in the first pass, all cells afterwards.
      let medianMargin = 0;
      if (pass === 0) medianMargin = median(margin, known);
      for (let p = 0; p < used; p++) {
        if (known[p]) continue;
        const c = order[p] as number;
        if (pass === 0 && (margin[p] as number) < medianMargin * 0.5) setMeanSource(src, c, MEAN_FILL, meanColor);
        else setSource(src, c, sym[p] as number, obs.centroids);
      }
    }
    // Inner code.
    const { stream, conf } = cellsToStreamWithConf(layout, sym, knownMargins(margin, known));
    const res = decodeStream(layout, stream, mask, conf, undefined, decodedMask ?? undefined);
    okFraction = res.ok.reduce((a, v) => a + v, 0) / layout.codewords;
    if (res.payload) return { payload: res.payload, stats: null, codewordFraction: 1 };

    // Fusion statistics are normalized by this capture's noise variance (median squared model residual).
    if (round === 0) {
      const sigma2 = estimateNoise(obs, src, order, used, known);
      const scale = 1 / Math.max(sigma2, 1e-8);
      const b = new Float32Array(used * 12);
      for (let i = 0; i < b.length; i++) b[i] = (bstat[i] as number) * scale;
      lastStats = { b, m: gram(w0, scale), captures: 1 };
      if (prior && prior.b.length === b.length) {
        const fused = fuseStats(prior, lastStats);
        const out = decodeFromStats(layout, fused, obs.centroids, mask);
        if (out) return { payload: out, stats: null, codewordFraction: 1 };
        lastStats = fused;
      }
    }
    if (okFraction === 0 || round === TURBO_ROUNDS) break;
    // Turbo: cells whose bits come only from decoded codewords become known sources.
    const cellsNow = streamCells(layout, res.stream);
    const cwOk = res.ok;
    let gained = 0;
    for (let p = 0; p < used; p++) {
      if (known[p]) continue;
      if (cellFromDecodedCodewords(p, layout, cwOk)) {
        known[p] = 1;
        sym[p] = cellsNow[p] as number;
        setSource(src, order[p] as number, sym[p] as number, obs.centroids);
        gained++;
      }
    }
    decodedMask = cwOk;
    if (gained === 0) break;
  }
  return { payload: null, stats: lastStats, codewordFraction: okFraction };
}

function knownMargins(margin: Float32Array, known: Uint8Array): Float32Array {
  const out = new Float32Array(margin.length);
  for (let i = 0; i < margin.length; i++) out[i] = known[i] ? Infinity : (margin[i] as number);
  return out;
}

function cellFromDecodedCodewords(p: number, layout: GridLayout, ok: Uint8Array): boolean {
  const bpc = layout.bitsPerCell;
  const first = Math.floor((p * bpc) / 8);
  const last = Math.min(layout.streamBytes - 1, Math.floor((p * bpc + bpc - 1) / 8));
  const C = layout.codewords;
  for (let j = first; j <= last; j++) if (!ok[j % C]) return false;
  return true;
}

function median(values: Float32Array, skip: Uint8Array): number {
  const v: number[] = [];
  for (let i = 0; i < values.length; i += 7) if (!skip[i]) v.push(values[i] as number);
  if (v.length === 0) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1] as number;
}

/** Per-feature noise variance from residuals against the current decisions. */
function estimateNoise(obs: Observation, src: SourceGrid, order: Int32Array, used: number, known: Uint8Array): number {
  const pred = predictFeatures(obs.model, src);
  const errs: number[] = [];
  for (let p = 0; p < used; p += 5) {
    if (known[p]) continue;
    const c = order[p] as number;
    let e = 0;
    for (let i = 0; i < 12; i++) {
      const d = (obs.feat[c * 12 + i] as number) - (pred[c * 12 + i] as number);
      e += d * d;
    }
    errs.push(e / 12);
  }
  if (errs.length === 0) return 1e-4;
  errs.sort((a, b) => a - b);
  // Median is robust to the minority of wrong decisions.
  return Math.max(1e-7, errs[errs.length >> 1] as number);
}

export function fuseStats(a: FusionStats, b: FusionStats): FusionStats {
  const out = new Float32Array(a.b.length);
  for (let i = 0; i < out.length; i++) out[i] = (a.b[i] as number) + (b.b[i] as number);
  const m = new Float64Array(16);
  for (let i = 0; i < 16; i++) m[i] = (a.m[i] as number) + (b.m[i] as number);
  return { b: out, m, captures: a.captures + b.captures };
}

/** Decodes a payload from (fused) sufficient statistics without interference re-estimation. */
function decodeFromStats(layout: GridLayout, stats: FusionStats, centroids: Float32Array, mask: Uint8Array): Uint8Array | null {
  const used = layout.cellsUsed;
  const colors = centroids.length / 3;
  const det = makeDetector(stats.m, centroids, colors);
  const sym = new Uint8Array(used);
  const margin = new Float32Array(used);
  const dots = new Float32Array(4 * colors);
  for (let p = 0; p < used; p++) {
    const d = detect(det, stats.b, p * 12, dots);
    sym[p] = d.sym;
    margin[p] = d.margin;
  }
  const { stream, conf } = cellsToStreamWithConf(layout, sym, margin);
  return decodeStream(layout, stream, mask, conf).payload;
}

/** CRC check of a decoded payload against its header. */
export function payloadMatchesHeader(candidate: HeaderCandidate, payload: Uint8Array): boolean {
  return headerCrcMatches(candidate.bytes, payload);
}
