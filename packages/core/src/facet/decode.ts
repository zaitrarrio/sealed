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
import { decodeStream, frameMask, paddingCells, PIC_BG, PIC_WHITE, streamCells, stripBits, type DecodedCodewords, type StreamDecodeResult } from "./grid";
import { meanFill } from "./glyphs";
import { adjointFeatures, edgeClass, EDGE_CLASSES, newSourceGrid, predictFeatures, responseModel, spreadGrams, type ResponseModel, type SourceGrid } from "./model";
import type { GridTier } from "./tiers";
import { detectFromStats, epDetect } from "./equalize";
import { vampDetect } from "./vamp";
const VAMP_ITERATIONS = Number((globalThis as any).process?.env?.VIT ?? 12);
const VAMP_DAMPING = Number((globalThis as any).process?.env?.VD ?? 0.5);

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
  /** Per-component noise variance of the corrected features (from the calibration fit residual). */
  readonly noiseVariance: number;
}

/** Noise variance assumed before a calibration frame has measured it (≈ σ 6 code values on mid-gray). */
const DEFAULT_NOISE_VARIANCE = 1e-4;

export function observe(img: RgbaImage, h: Homography, layout: GridLayout, cal: ChannelCalibration, centroids: Float32Array): Observation | null {
  const s = sampleCells(img, h, layout.n, cal.lut);
  let valid = 0;
  for (let i = 0; i < s.valid.length; i++) valid += s.valid[i] as number;
  if (valid < s.valid.length * 0.98) return null;
  const noiseVariance = Number.isFinite(cal.rms) && cal.rms > 0 ? Math.max((cal.rms * cal.rms * WHITE_NORM2) / 3, 1e-6) : DEFAULT_NOISE_VARIANCE;
  return { layout, feat: correctFeatures(s, cal.x), valid: s.valid, model: responseModel(cal.sigma), centroids, noiseVariance };
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


export interface HeaderCandidate {
  readonly bytes: Uint8Array;
  readonly header: FrameHeader;
  readonly strip: "top" | "bottom";
}

export interface StripDecisions {
  /** Hard bits per strip (top, bottom), strip bit order. */
  readonly bits: readonly Uint8Array[];
  /** Per-bit reliability (distance of the matched-filter level from the threshold, in white-cell units). */
  readonly conf: readonly Float32Array[];
}

const HEADER_PASSES = 4;

/**
 * Soft decision-feedback detection of both header strips (spec §7.6 step 3).
 *
 * Every strip cell is a full black/white cell. The observation of cell c is predicted from all known sources
 * (anchors; filler bits; data cells at their expected mean) plus the current soft estimates of the other strip
 * cells; the residual is matched-filtered against the cell's own response and gives its level ℓ ∈ ≈[0, 1]. The
 * soft estimate fed back is a clipped ℓ (soft values stop a wrong early decision from propagating), and the last
 * pass makes the hard decisions. The two strips are detected jointly because they are far apart (no interaction),
 * which keeps one prediction per pass.
 */
export function headerStripDecisions(obs: Observation): StripDecisions {
  const layout = obs.layout;
  const n = layout.n;
  const src = baseSource(layout, obs.centroids);
  const meanColor = meanOf(obs.centroids);
  const fillMean = meanFill(obs.centroids.length / 3);
  for (let c = 0; c < n * n; c++) if (layout.kind[c] === CellKind.Data) setMeanSource(src, c, fillMean, meanColor);
  const strips = [layout.headerTop, layout.headerBottom];
  const len = layout.headerTop.length;
  const bits = strips.map(() => new Uint8Array(len));
  const conf = strips.map(() => new Float32Array(len));
  const soft = strips.map(() => new Float32Array(len).fill(0.5));
  // Filler bits after the RS codeword are known.
  for (const sv of soft) for (let i = HEADER_BITS; i < len; i++) sv[i] = i & 1;
  const wf0 = obs.model.wf0;
  let wNorm = 0;
  for (let q = 0; q < 4; q++) wNorm += (wf0[q] as number) * (wf0[q] as number);
  const setLevel = (c: number, level: number): void => {
    for (let ch = 0; ch < 3; ch++) src.f[c * 3 + ch] = level * (WHITE_EXCESS[ch] as number);
  };
  strips.forEach((cells, si) => {
    for (let i = 0; i < len; i++) setLevel(cells[i] as number, (soft[si] as Float32Array)[i] as number);
  });
  const pred = new Float32Array(n * n * 12);
  for (let pass = 0; pass < HEADER_PASSES; pass++) {
    predictFeatures(obs.model, src, pred);
    const last = pass === HEADER_PASSES - 1;
    const newSoft = strips.map(() => new Float32Array(len));
    strips.forEach((cells, si) => {
      const sv = soft[si] as Float32Array;
      const ns = newSoft[si] as Float32Array;
      for (let i = 0; i < len; i++) {
        if (i >= HEADER_BITS) {
          ns[i] = i & 1;
          continue;
        }
        const c = cells[i] as number;
        const own = sv[i] as number;
        let acc = 0;
        for (let q = 0; q < 4; q++) {
          let dot = 0;
          for (let ch = 0; ch < 3; ch++) {
            const o = c * 12 + q * 3 + ch;
            const r = (obs.feat[o] as number) - (pred[o] as number) + (wf0[q] as number) * own * (WHITE_EXCESS[ch] as number);
            dot += r * (WHITE_EXCESS[ch] as number);
          }
          acc += (wf0[q] as number) * dot;
        }
        const level = acc / (wNorm * WHITE_NORM2);
        ns[i] = Math.min(1, Math.max(0, level));
        if (last) {
          (bits[si] as Uint8Array)[i] = level > 0.5 ? 1 : 0;
          (conf[si] as Float32Array)[i] = Math.abs(level - 0.5);
        }
      }
    });
    if (last) break;
    // Sharpen the soft estimates progressively toward hard decisions.
    const gain = 1 + pass;
    strips.forEach((cells, si) => {
      const ns = newSoft[si] as Float32Array;
      const sv = soft[si] as Float32Array;
      for (let i = 0; i < len; i++) {
        const v = i >= HEADER_BITS ? (ns[i] as number) : Math.min(1, Math.max(0, 0.5 + gain * ((ns[i] as number) - 0.5)));
        sv[i] = v;
        setLevel(cells[i] as number, v);
      }
    });
  }
  for (const b of bits) for (let i = HEADER_BITS; i < len; i++) b[i] = i & 1;
  for (const cf of conf) for (let i = HEADER_BITS; i < len; i++) cf[i] = Infinity;
  return { bits, conf };
}

/** Decodes both header strips. Returns the distinct valid headers (top first). */
export function decodeHeaders(obs: Observation): HeaderCandidate[] {
  const { bits, conf } = headerStripDecisions(obs);
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
  /** Σ Wᵀ r / σ² per used data cell (permutation order): [p * 12 + q * 3 + ch]. */
  readonly b: Float32Array;
  /** Σ WᵀW / σ² per edge class (EDGE_CLASSES² × 16). */
  readonly m: Float64Array;
  captures: number;
}

export interface DataDecodeResult {
  readonly payload: Uint8Array | null;
  readonly stats: FusionStats | null;
  /** Fraction of codewords that decoded. */
  readonly codewordFraction: number;
}

/** Edge class index (cy * EDGE_CLASSES + cx) of every grid cell. */
const classCache = new Map<number, Uint8Array>();
function cellClasses(n: number): Uint8Array {
  let c = classCache.get(n);
  if (!c) {
    c = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) c[y * n + x] = edgeClass(y, n) * EDGE_CLASSES + edgeClass(x, n);
    classCache.set(n, c);
  }
  return c;
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

/** EP detection schedule (equalize.ts). */
const EP_ROUNDS = 6;
const EP_CG_ITERATIONS: readonly number[] = [24, 10];
const EP_DAMPING = 0.5;
const EP_CG_TOLERANCE = 1e-6;
/** Early decode attempts within the first round (CG iterations). */
const EP_CHECKPOINTS: readonly number[] = [6, 10, 14, 18];

/**
 * Decodes the data region of a frame (data, descriptor or end) under `header`. `prior` holds fusion statistics
 * from earlier failed captures of the same frame.
 */
export function decodeData(obs: Observation, candidate: HeaderCandidate, prior: FusionStats | null): DataDecodeResult {
  const layout = obs.layout;
  const n = layout.n;
  const h = candidate.header;
  const tier = h.tier as GridTier;
  const id = { streamId: h.streamId, tier, type: h.type, sbn: h.sbn, esi: h.esi };
  const { mask } = frameMask(layout, id);
  const used = layout.cellsUsed;
  const order = layout.dataOrder;

  // Known sources: anchors, both header strips (from the decoded header), padding pilots. Unknown cells are zero.
  const src = baseSource(layout, obs.centroids);
  const stripBitsTop = stripBits(layout, candidate.bytes);
  for (let i = 0; i < layout.headerTop.length; i++) {
    const v = stripBitsTop[i] ? PIC_WHITE : PIC_BG;
    setSource(src, layout.headerTop[i] as number, v, obs.centroids);
    setSource(src, layout.headerBottom[i] as number, v, obs.centroids);
  }
  const pad = paddingCells(layout, id);
  for (let p = used; p < order.length; p++) setSource(src, order[p] as number, pad[p - used] as number, obs.centroids);

  const grams = spreadGrams(obs.model, n);
  const classes = cellClasses(n);
  const s2 = obs.noiseVariance;
  const known = new Uint8Array(used);
  const sym = new Uint8Array(used);
  const margin = new Float32Array(used);
  let lastStats: FusionStats | null = null;
  let okFraction = 0;
  let decoded: DecodedCodewords | null = null;
  let payload: Uint8Array | null = null;

  for (let round = 0; round <= TURBO_ROUNDS; round++) {
    const positions: number[] = [];
    for (let p = 0; p < used; p++) if (!known[p]) positions.push(p);
    const cells = Int32Array.from(positions, (p) => order[p] as number);
    const pred = predictFeatures(obs.model, src);
    const y = new Float32Array(pred.length);
    for (let i = 0; i < y.length; i++) {
      const v = (obs.feat[i] as number) - (pred[i] as number);
      y[i] = v === v ? v : 0;
    }
    let res: StreamDecodeResult | null = null;
    const tryDecode = (aSym: Uint8Array, aMargin: Float32Array, maxFailures: number): StreamDecodeResult => {
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i] as number;
        sym[p] = aSym[i] as number;
        margin[p] = aMargin[i] as number;
      }
      const { stream, conf } = cellsToStreamWithConf(layout, sym, knownMargins(margin, known));
      return decodeStream(layout, stream, mask, conf, undefined, decoded ?? undefined, maxFailures);
    };
    const ep = vampDetect(
      { n, model: obs.model, y, cells, centroids: obs.centroids, noiseVariance: s2 },
      {
        iterations: VAMP_ITERATIONS,
        damping: VAMP_DAMPING,
        onIteration: (r, aSym, aMargin) => {
          const last = r === VAMP_ITERATIONS - 1;
          const attempt = tryDecode(aSym, aMargin, last ? Infinity : 1);
          if (attempt.payload || last) res = attempt;
          return attempt.payload !== null;
        },
      },
    );
    if (!res) res = tryDecode(ep.sym, ep.margin, Infinity);
    const result: StreamDecodeResult = res;
    okFraction = result.ok.reduce((a, v) => a + v, 0) / layout.codewords;
    if (result.payload) {
      payload = result.payload;
      break;
    }

    // Fusion statistics (first round: every used cell is in the problem).
    if (round === 0) {
      const b = new Float32Array(used * 12);
      for (let i = 0; i < positions.length; i++) void i;
      const m = new Float64Array(grams.length);
      for (let i = 0; i < m.length; i++) m[i] = (grams[i] as number) / s2;
      lastStats = { b, m, captures: 1 };
      if (prior && prior.b.length === b.length && prior.m.length === m.length) {
        const fused = fuseStats(prior, lastStats);
        const out = decodeFromStats(layout, fused, obs.centroids, mask);
        if (out) return { payload: out, stats: null, codewordFraction: 1 };
        lastStats = fused;
      }
    }
    if (okFraction === 0 || round === TURBO_ROUNDS) break;
    // Turbo: cells whose bits come only from decoded codewords become known sources.
    const cellsNow = streamCells(layout, result.stream);
    let gained = 0;
    for (let p = 0; p < used; p++) {
      if (known[p] || !cellFromDecodedCodewords(p, layout, result.ok)) continue;
      known[p] = 1;
      sym[p] = cellsNow[p] as number;
      setSource(src, order[p] as number, sym[p] as number, obs.centroids);
      gained++;
    }
    decoded = { ok: result.ok, stream: result.stream };
    if (gained === 0) break;
  }
  if (payload) return { payload, stats: null, codewordFraction: 1 };
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

/** Per-feature noise variance from residuals against the current decisions (median: robust to wrong decisions). */
function estimateNoise(obs: Observation, src: SourceGrid, order: Int32Array, used: number): number {
  const pred = predictFeatures(obs.model, src);
  const errs: number[] = [];
  for (let p = 0; p < used; p += 5) {
    const c = order[p] as number;
    let e = 0;
    for (let i = 0; i < 12; i++) {
      const d = (obs.feat[c * 12 + i] as number) - (pred[c * 12 + i] as number);
      e += d * d;
    }
    if (Number.isFinite(e)) errs.push(e / 12);
  }
  if (errs.length === 0) return 1e-4;
  errs.sort((a, b) => a - b);
  return Math.max(1e-7, errs[errs.length >> 1] as number);
}

export function fuseStats(a: FusionStats, b: FusionStats): FusionStats {
  const out = new Float32Array(a.b.length);
  for (let i = 0; i < out.length; i++) out[i] = (a.b[i] as number) + (b.b[i] as number);
  const m = new Float64Array(a.m.length);
  for (let i = 0; i < m.length; i++) m[i] = (a.m[i] as number) + (b.m[i] as number);
  return { b: out, m, captures: a.captures + b.captures };
}

/** Decodes a payload from (fused) sufficient statistics without interference re-estimation. */
function decodeFromStats(layout: GridLayout, stats: FusionStats, centroids: Float32Array, mask: Uint8Array): Uint8Array | null {
  const used = layout.cellsUsed;
  const classes = cellClasses(layout.n);
  const entryClasses = new Uint8Array(used);
  for (let p = 0; p < used; p++) entryClasses[p] = classes[layout.dataOrder[p] as number] as number;
  const { sym, margin } = detectFromStats(stats.b, stats.m, entryClasses, centroids);
  const { stream, conf } = cellsToStreamWithConf(layout, sym, margin);
  return decodeStream(layout, stream, mask, conf).payload;
}

/** CRC check of a decoded payload against its header. */
export function payloadMatchesHeader(candidate: HeaderCandidate, payload: Uint8Array): boolean {
  return headerCrcMatches(candidate.bytes, payload);
}
