/**
 * Channel calibration (spec §7.5 calibration frame, §7.6 step 5).
 *
 * The receiver models the camera as: screen linear light → optical blur (Gaussian, σ cells) → 3 × 3 color mixing
 * → per-channel tone curve → code values. Calibration recovers, in order:
 *   1. a per-channel tone LUT (code → value affine in the camera's linear input) from the gray ramps: a
 *      monotone (pool-adjacent-violators) piecewise-linear map from sRGB-decoded codes to ramp levels, so any
 *      tone curve — not only a power law — is linearized;
 *   2. the blur σ and an affine 3 × 4 color-correction matrix X mapping LUT values to screen-domain excess,
 *      fitted jointly by least squares over every quadrant feature of the frame (all cells are known), with σ
 *      chosen by a 1-D search minimizing the residual;
 *   3. calibrated palette centroids (screen-domain excess per color), estimated from the glyph cells after
 *      cancelling inter-symbol interference.
 * Classification then happens in the corrected linear domain (not CIE Lab): with ISI cancelled, Euclidean
 * distance there is the matched-filter metric for additive sensor noise.
 */
import type { RgbaImage } from "./types";
import type { Homography } from "./homography";
import { CODE_LUT, LINEAR_LUT, sampleCells, type ChannelLut, type CellSamples } from "./sample";
import { GRAY_RAMP, LINEAR_BACKGROUND, LINEAR_WHITE, SRGB_TO_LINEAR_8, paletteExcess } from "./palette";
import { glyphFills } from "./glyphs";
import { calibrationLayout, CellKind, type GridLayout } from "./layout";
import { PIC_BG, PIC_GRAY_BASE, PIC_WHITE } from "./grid";
import { newSourceGrid, predictFeatures, responseModel, type SourceGrid } from "./model";
import { solveLinear } from "./homography";
import type { GridTier } from "./tiers";

export const WHITE_EXCESS: readonly [number, number, number] = [
  (LINEAR_WHITE[0] as number) - (LINEAR_BACKGROUND[0] as number),
  (LINEAR_WHITE[1] as number) - (LINEAR_BACKGROUND[1] as number),
  (LINEAR_WHITE[2] as number) - (LINEAR_BACKGROUND[2] as number),
];

export const DEFAULT_SIGMA = 0.35;
const SIGMA_MIN = 0.1;
const SIGMA_MAX = 0.8;

export interface ChannelCalibration {
  /** Code → tone-linearized value per channel. */
  readonly lut: ChannelLut;
  /** 3 × 4 row-major affine map from LUT values to screen-domain excess. */
  readonly x: Float64Array;
  /** Effective blur in cells. */
  readonly sigma: number;
  /** True when fitted from a calibration (or fully decoded) frame. */
  readonly fitted: boolean;
  /** RMS residual of the fit, in units of the white excess. */
  readonly rms: number;
}

export function defaultCalibration(): ChannelCalibration {
  const x = new Float64Array(12);
  for (let ch = 0; ch < 3; ch++) {
    x[ch * 4 + ch] = 1;
    x[ch * 4 + 3] = -(LINEAR_BACKGROUND[ch] as number);
  }
  return { lut: LINEAR_LUT, x, sigma: DEFAULT_SIGMA, fitted: false, rms: NaN };
}

/** Applies X to sampled features (in place into a new array). NaN stays NaN. */
export function correctFeatures(s: CellSamples, x: Float64Array): Float32Array {
  const f = s.feat;
  const out = new Float32Array(f.length);
  const [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11] = Array.from(x) as number[];
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] as number;
    const b = f[i + 1] as number;
    const c = f[i + 2] as number;
    out[i] = (x0 as number) * a + (x1 as number) * b + (x2 as number) * c + (x3 as number);
    out[i + 1] = (x4 as number) * a + (x5 as number) * b + (x6 as number) * c + (x7 as number);
    out[i + 2] = (x8 as number) * a + (x9 as number) * b + (x10 as number) * c + (x11 as number);
  }
  return out;
}

/** Source grid for a fully known cell picture (PIC_* codes / glyph symbols). */
export function sourceFromPicture(pic: Int16Array, n: number, centroids: Float32Array): SourceGrid {
  const src = newSourceGrid(n);
  for (let c = 0; c < n * n; c++) setSource(src, c, pic[c] as number, centroids);
  return src;
}

/** Sets the source of cell c from a picture code. */
export function setSource(src: SourceGrid, c: number, v: number, centroids: Float32Array): void {
  const qo = c * 12;
  const fo = c * 3;
  if (v >= 0) {
    const k = v >> 4;
    const s = v & 15;
    const fills = glyphFills(centroids.length / 3);
    for (let q = 0; q < 4; q++) {
      const fill = fills[s * 4 + q] as number;
      for (let ch = 0; ch < 3; ch++) src.q[qo + q * 3 + ch] = fill * (centroids[k * 3 + ch] as number);
    }
    src.f[fo] = 0;
    src.f[fo + 1] = 0;
    src.f[fo + 2] = 0;
    return;
  }
  for (let i = 0; i < 12; i++) src.q[qo + i] = 0;
  let level = 0;
  if (v === PIC_WHITE) level = 1;
  else if (v <= PIC_GRAY_BASE) level = GRAY_RAMP[PIC_GRAY_BASE - v] ?? 0;
  else if (v !== PIC_BG) throw new RangeError(`unknown picture code ${v}`);
  for (let ch = 0; ch < 3; ch++) src.f[fo + ch] = level * (WHITE_EXCESS[ch] as number);
}

/** Least-squares X (3 × 4) mapping observations to predictions over valid cells; returns X and the mean squared residual. */
function fitAffine(obs: Float32Array, pred: Float32Array, valid: Uint8Array, cells: Int32Array): { x: Float64Array; mse: number } | null {
  const G = new Float64Array(16);
  const B = new Float64Array(12); // 4 × 3
  let count = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k] as number;
    if (!valid[c]) continue;
    const base = c * 12;
    for (let q = 0; q < 4; q++) {
      const o = base + q * 3;
      const v0 = obs[o] as number;
      const v1 = obs[o + 1] as number;
      const v2 = obs[o + 2] as number;
      const vv = [v0, v1, v2, 1];
      for (let i = 0; i < 4; i++) {
        const vi = vv[i] as number;
        for (let j = 0; j < 4; j++) G[i * 4 + j] = (G[i * 4 + j] as number) + vi * (vv[j] as number);
        for (let ch = 0; ch < 3; ch++) B[i * 3 + ch] = (B[i * 3 + ch] as number) + vi * (pred[o + ch] as number);
      }
      count++;
    }
  }
  if (count < 64) return null;
  const x = new Float64Array(12);
  for (let ch = 0; ch < 3; ch++) {
    const rhs = new Float64Array([B[ch] as number, B[3 + ch] as number, B[6 + ch] as number, B[9 + ch] as number]);
    const sol = solveLinear(G, rhs, 4);
    if (!sol) return null;
    for (let i = 0; i < 4; i++) x[ch * 4 + i] = sol[i] as number;
  }
  let se = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k] as number;
    if (!valid[c]) continue;
    const base = c * 12;
    for (let q = 0; q < 4; q++) {
      const o = base + q * 3;
      const v0 = obs[o] as number;
      const v1 = obs[o + 1] as number;
      const v2 = obs[o + 2] as number;
      for (let ch = 0; ch < 3; ch++) {
        const e = (x[ch * 4] as number) * v0 + (x[ch * 4 + 1] as number) * v1 + (x[ch * 4 + 2] as number) * v2 + (x[ch * 4 + 3] as number) - (pred[o + ch] as number);
        se += e * e;
      }
    }
  }
  return { x, mse: se / (count * 3) };
}

/** Pool-adjacent-violators: non-decreasing fit of ys (sorted by xs). */
function isotonic(ys: number[], ws: number[]): number[] {
  const vals: number[] = [];
  const wts: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    vals.push(ys[i] as number);
    wts.push(ws[i] as number);
    lens.push(1);
    while (vals.length > 1 && (vals[vals.length - 2] as number) > (vals[vals.length - 1] as number)) {
      const w = (wts[wts.length - 2] as number) + (wts[wts.length - 1] as number);
      const v = ((vals[vals.length - 2] as number) * (wts[wts.length - 2] as number) + (vals[vals.length - 1] as number) * (wts[wts.length - 1] as number)) / w;
      const l = (lens[lens.length - 2] as number) + (lens[lens.length - 1] as number);
      vals.splice(-2, 2, v);
      wts.splice(-2, 2, w);
      lens.splice(-2, 2, l);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) for (let j = 0; j < (lens[i] as number); j++) out.push(vals[i] as number);
  return out;
}

/**
 * Builds the tone LUT from gray-ramp observations: per channel, points (sRGB-decoded mean code, target level).
 * Targets are the predicted screen-domain values (ramp level × white excess plus blur leakage).
 */
export function fitToneLut(points: readonly { code: readonly [number, number, number]; target: readonly [number, number, number] }[]): ChannelLut | null {
  if (points.length < 6) return null;
  const lut = new Float32Array(768);
  for (let ch = 0; ch < 3; ch++) {
    const pts = points.map((p) => ({ s: srgbDecodeContinuous(p.code[ch] as number), t: p.target[ch] as number })).sort((a, b) => a.s - b.s);
    // Merge near-identical abscissae to avoid zero-length segments.
    const xs: number[] = [];
    const ys: number[] = [];
    const ws: number[] = [];
    for (const p of pts) {
      const last = xs.length - 1;
      if (last >= 0 && p.s - (xs[last] as number) < 1e-4) {
        const w = (ws[last] as number) + 1;
        xs[last] = ((xs[last] as number) * (ws[last] as number) + p.s) / w;
        ys[last] = ((ys[last] as number) * (ws[last] as number) + p.t) / w;
        ws[last] = w;
      } else {
        xs.push(p.s);
        ys.push(p.t);
        ws.push(1);
      }
    }
    if (xs.length < 4) return null;
    const mono = isotonic(ys, ws);
    const lastIdx = xs.length - 1;
    const span = (xs[lastIdx] as number) - (xs[0] as number);
    if (!(span > 0.05) || !((mono[lastIdx] as number) > (mono[0] as number))) return null;
    for (let code = 0; code < 256; code++) {
      const s = SRGB_TO_LINEAR_8[code] as number;
      let i = 0;
      while (i < lastIdx - 1 && s > (xs[i + 1] as number)) i++;
      const x0 = xs[i] as number;
      const x1 = xs[i + 1] as number;
      const y0 = mono[i] as number;
      const y1 = mono[i + 1] as number;
      const slope = x1 > x0 ? (y1 - y0) / (x1 - x0) : 0;
      lut[ch * 256 + code] = y0 + slope * (s - x0);
    }
  }
  return lut;
}

function srgbDecodeContinuous(codeFraction: number): number {
  const v = Math.max(0, Math.min(1, codeFraction));
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export interface CalibrationFit {
  readonly channel: ChannelCalibration;
  readonly centroids: Float32Array;
}

/**
 * Fits the channel from a frame whose every cell is known (`pic`). `isCalibrationFrame` enables the tone fit
 * from the gray ramps; otherwise the existing LUT is kept (decision-directed refresh from a decoded frame).
 */
export function fitChannel(
  img: RgbaImage,
  h: Homography,
  layout: GridLayout,
  pic: Int16Array,
  prev: ChannelCalibration,
  prevCentroids: Float32Array,
  isCalibrationFrame: boolean,
): CalibrationFit | null {
  const n = layout.n;
  const tier = layout.tier as GridTier;
  const nominal = paletteExcess(tier);
  const cells = Int32Array.from({ length: n * n }, (_, i) => i);
  let lut = prev.lut;
  let sigma0 = prev.fitted ? prev.sigma : DEFAULT_SIGMA;
  if (isCalibrationFrame) {
    const cal = calibrationLayout(tier);
    const centers = cal.rampCenters.map((r) => r.cell);
    const codes = sampleCells(img, h, n, CODE_LUT, centers);
    const src = sourceFromPicture(pic, n, nominal);
    const pred = predictFeatures(responseModel(sigma0), src);
    const pts: { code: [number, number, number]; target: [number, number, number] }[] = [];
    for (const c of centers) {
      if (!codes.valid[c]) continue;
      const code = new Float64Array(3);
      const target = new Float64Array(3);
      for (let q = 0; q < 4; q++) {
        for (let ch = 0; ch < 3; ch++) {
          code[ch] = (code[ch] as number) + (codes.feat[c * 12 + q * 3 + ch] as number) / 4;
          target[ch] = (target[ch] as number) + (pred[c * 12 + q * 3 + ch] as number) / 4;
        }
      }
      pts.push({ code: [code[0] as number, code[1] as number, code[2] as number], target: [target[0] as number, target[1] as number, target[2] as number] });
    }
    const fitted = fitToneLut(pts);
    if (!fitted) return null;
    lut = fitted;
  }
  const samples = sampleCells(img, h, n, lut);
  let validCount = 0;
  for (let i = 0; i < samples.valid.length; i++) validCount += samples.valid[i] as number;
  if (validCount < n * n * 0.9) return null;

  let centroids = prevCentroids.length === nominal.length ? prevCentroids : nominal;
  const evalSigma = (sigma: number): { x: Float64Array; mse: number } | null => {
    const src = sourceFromPicture(pic, n, centroids);
    const pred = predictFeatures(responseModel(sigma), src);
    return fitAffine(samples.feat, pred, samples.valid, cells);
  };
  // Coarse-to-fine search for σ.
  const lo = prev.fitted ? Math.max(SIGMA_MIN, sigma0 - 0.15) : SIGMA_MIN;
  const hi = prev.fitted ? Math.min(SIGMA_MAX, sigma0 + 0.15) : SIGMA_MAX;
  let bestSigma = sigma0;
  let best: { x: Float64Array; mse: number } | null = null;
  for (let s = lo; s <= hi + 1e-9; s += 0.05) {
    const r = evalSigma(s);
    if (r && (!best || r.mse < best.mse)) {
      best = r;
      bestSigma = s;
    }
  }
  if (!best) return null;
  for (const step of [0.02, 0.01]) {
    for (const s of [bestSigma - step, bestSigma + step]) {
      if (s < SIGMA_MIN || s > SIGMA_MAX) continue;
      const r = evalSigma(s);
      if (r && r.mse < best.mse) {
        best = r;
        bestSigma = s;
      }
    }
  }
  // Calibrated centroids: per color, least squares of the ISI-cancelled residual against the glyph's self response.
  const corrected = correctFeatures(samples, best.x);
  const model = responseModel(bestSigma);
  const src = sourceFromPicture(pic, n, centroids);
  const pred = predictFeatures(model, src);
  const colors = nominal.length / 3;
  const tierFills = glyphFills(colors);
  const num = new Float64Array(colors * 3);
  const den = new Float64Array(colors);
  const a = new Float64Array(4);
  for (let c = 0; c < n * n; c++) {
    const v = pic[c] as number;
    if (v < 0 || layout.kind[c] !== CellKind.Data || !samples.valid[c]) continue;
    const k = v >> 4;
    const s = v & 15;
    for (let q = 0; q < 4; q++) {
      let acc = 0;
      for (let qs = 0; qs < 4; qs++) acc += (model.w0[q * 4 + qs] as number) * (tierFills[s * 4 + qs] as number);
      a[q] = acc;
    }
    for (let q = 0; q < 4; q++) {
      const aq = a[q] as number;
      den[k] = (den[k] as number) + aq * aq;
      for (let ch = 0; ch < 3; ch++) {
        const o = c * 12 + q * 3 + ch;
        const self = aq * (centroids[k * 3 + ch] as number);
        const r = (corrected[o] as number) - (pred[o] as number) + self;
        num[k * 3 + ch] = (num[k * 3 + ch] as number) + aq * r;
      }
    }
  }
  const refined = new Float32Array(colors * 3);
  for (let k = 0; k < colors; k++) {
    let dev = 0;
    let mag = 0;
    for (let ch = 0; ch < 3; ch++) {
      const est = (den[k] as number) > 0 ? (num[k * 3 + ch] as number) / (den[k] as number) : (nominal[k * 3 + ch] as number);
      refined[k * 3 + ch] = est;
      dev += (est - (nominal[k * 3 + ch] as number)) ** 2;
      mag += (nominal[k * 3 + ch] as number) ** 2;
    }
    // A centroid far from its nominal color means a broken fit; keep the nominal one.
    if (dev > 0.25 * mag) for (let ch = 0; ch < 3; ch++) refined[k * 3 + ch] = nominal[k * 3 + ch] as number;
  }
  centroids = refined;
  const whiteNorm = WHITE_EXCESS[0] * WHITE_EXCESS[0] + WHITE_EXCESS[1] * WHITE_EXCESS[1] + WHITE_EXCESS[2] * WHITE_EXCESS[2];
  return {
    channel: { lut, x: best.x, sigma: bestSigma, fitted: true, rms: Math.sqrt((best.mse * 3) / whiteNorm) },
    centroids,
  };
}

/**
 * Per-frame fallback before any calibration: per-channel gain/offset from the TL anchor's light center and the
 * BL anchor's dark interior, with the sRGB EOTF as tone curve.
 */
export function anchorCalibration(img: RgbaImage, h: Homography, layout: GridLayout, base: ChannelCalibration): ChannelCalibration | null {
  const n = layout.n;
  // Inner 2 × 2 of TL's 4 × 4 light center (≥ 1 cell from any edge), and the center of BL's 6 × 6 dark interior.
  const light = [3 * n + 3, 3 * n + 4, 4 * n + 3, 4 * n + 4];
  const dark = [(n - 5) * n + 3, (n - 5) * n + 4, (n - 4) * n + 3, (n - 4) * n + 4];
  const s = sampleCells(img, h, n, base.lut, light.concat(dark));
  const mean = (cells: number[]): [number, number, number] | null => {
    const m = new Float64Array(3);
    let cnt = 0;
    for (const c of cells) {
      if (!s.valid[c]) continue;
      for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) m[ch] = (m[ch] as number) + (s.feat[c * 12 + q * 3 + ch] as number);
      cnt += 4;
    }
    if (!cnt) return null;
    return [(m[0] as number) / cnt, (m[1] as number) / cnt, (m[2] as number) / cnt];
  };
  const w = mean(light);
  const d = mean(dark);
  if (!w || !d) return null;
  // Expected screen-domain values: the light center is fully lit (white excess), the dark interior is background.
  const x = new Float64Array(12);
  for (let ch = 0; ch < 3; ch++) {
    const span = (w[ch] as number) - (d[ch] as number);
    if (!(span > 1e-3)) return null;
    const gain = (WHITE_EXCESS[ch] as number) / span;
    x[ch * 4 + ch] = gain;
    x[ch * 4 + 3] = -gain * (d[ch] as number);
  }
  return { lut: base.lut, x, sigma: base.sigma, fitted: false, rms: NaN };
}
