/**
 * Linear optical channel model for the Facet grid (receiver side).
 *
 * Every lit element on screen is an axis-aligned box in grid units: a glyph quadrant ([-0.4, 0] or [0, 0.4]
 * around the cell center on each axis) or a full cell (anchors, header bits, gray ramps). The camera's
 * point-spread function (optics, defocus, sensor integration, residual registration error) is modeled as an
 * isotropic Gaussian of σ cells. Light at a sample point is then a separable sum of erf differences.
 *
 * The receiver samples each quadrant at 3 × 3 points (0.15-cell pitch around the quadrant center) and averages
 * them, giving one feature per quadrant and color channel (close to the quadrant's area mean). Each
 * feature is a linear function of the source excess (screen light above the background) of the cell and its
 * neighbors within ISI_RADIUS cells, so inter-symbol interference can be predicted exactly and cancelled.
 */

import { GLYPH_MARGIN } from "./glyphs";

/** Neighborhood radius in cells; Gaussian tails beyond 2 cells are < 0.1% for σ ≤ 0.6. */
export const ISI_RADIUS = 2;
export const SPAN = 2 * ISI_RADIUS + 1;

/** Sample offsets (cells, from the cell center) for the low and high quadrant on one axis. */
export const SAMPLE_OFFSETS: readonly (readonly number[])[] = [
  [-0.4, -0.25, -0.1],
  [0.1, 0.25, 0.4],
];
const QUAD_BOX: readonly (readonly [number, number])[] = [
  [GLYPH_MARGIN - 0.5, 0],
  [0, 0.5 - GLYPH_MARGIN],
];

/** erf with |error| < 1.5e-7 (Abramowitz & Stegun 7.1.26). */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Light at point x from a unit box [lo, hi] blurred by N(0, σ²). */
export function boxResponse(x: number, lo: number, hi: number, sigma: number): number {
  if (sigma < 1e-4) return x >= lo && x < hi ? 1 : 0;
  return normCdf((hi - x) / sigma) - normCdf((lo - x) / sigma);
}

export interface ResponseModel {
  readonly sigma: number;
  /** gq[(qa * SPAN + di) * 2 + qs]: quadrant half qs of a neighbor at offset di - R → feature half qa (1-D). */
  readonly gq: Float64Array;
  /** gf[qa * SPAN + di]: full cell at offset di - R → feature half qa (1-D). */
  readonly gf: Float64Array;
  /** Self response W0 (4 × 4, row = target quadrant, column = source quadrant). */
  readonly w0: Float64Array;
  /** Self response of a full cell onto each quadrant feature. */
  readonly wf0: Float64Array;
}

const modelCache = new Map<number, ResponseModel>();

export function responseModel(sigma: number): ResponseModel {
  const key = Math.max(0, Math.round(sigma * 1e4));
  const hit = modelCache.get(key);
  if (hit) return hit;
  const s = key / 1e4;
  const gq = new Float64Array(2 * SPAN * 2);
  const gf = new Float64Array(2 * SPAN);
  for (let qa = 0; qa < 2; qa++) {
    const xs = SAMPLE_OFFSETS[qa] as readonly number[];
    const mean = (lo: number, hi: number): number => xs.reduce((a, x) => a + boxResponse(x, lo, hi, s), 0) / xs.length;
    for (let di = 0; di < SPAN; di++) {
      const d = di - ISI_RADIUS;
      for (let qs = 0; qs < 2; qs++) {
        const [lo, hi] = QUAD_BOX[qs] as readonly [number, number];
        gq[(qa * SPAN + di) * 2 + qs] = mean(d + lo, d + hi);
      }
      gf[qa * SPAN + di] = mean(d - 0.5, d + 0.5);
    }
  }
  const w0 = new Float64Array(16);
  const wf0 = new Float64Array(4);
  const c = ISI_RADIUS;
  for (let q = 0; q < 4; q++) {
    const qx = q & 1;
    const qy = q >> 1;
    wf0[q] = (gf[qx * SPAN + c] as number) * (gf[qy * SPAN + c] as number);
    for (let qs = 0; qs < 4; qs++) {
      w0[q * 4 + qs] = (gq[(qx * SPAN + c) * 2 + (qs & 1)] as number) * (gq[(qy * SPAN + c) * 2 + (qs >> 1)] as number);
    }
  }
  const m: ResponseModel = { sigma: s, gq, gf, w0, wf0 };
  modelCache.set(key, m);
  if (modelCache.size > 64) {
    const first = modelCache.keys().next().value;
    if (first !== undefined && first !== key) modelCache.delete(first);
  }
  return m;
}

/** Screen sources of an N × N grid, as linear excess over the background. */
export interface SourceGrid {
  readonly n: number;
  /** Glyph sources: [cell * 12 + q' * 3 + ch] (zero for non-glyph cells). */
  readonly q: Float32Array;
  /** Full-cell sources: [cell * 3 + ch] (zero for non-full cells). */
  readonly f: Float32Array;
}

export function newSourceGrid(n: number): SourceGrid {
  return { n, q: new Float32Array(n * n * 12), f: new Float32Array(n * n * 3) };
}

/**
 * Predicted features of every cell (n² × 12: [cell * 12 + q * 3 + ch]) including each cell's own contribution.
 * Computed separably: a horizontal pass mixes quadrant columns, then a vertical pass mixes quadrant rows.
 */
export function predictFeatures(model: ResponseModel, src: SourceGrid, out?: Float32Array): Float32Array {
  const n = src.n;
  const R = ISI_RADIUS;
  const gq = model.gq;
  const gf = model.gf;
  // Horizontal pass: A[cell][qa][qsy][ch] (12 floats) for glyph sources, Af[cell][qa][ch] (6) for full cells.
  const A = new Float32Array(n * n * 12);
  const Af = new Float32Array(n * n * 6);
  const sq = src.q;
  const sf = src.f;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const t = y * n + x;
      const ao = t * 12;
      const afo = t * 6;
      for (let dx = -R; dx <= R; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= n) continue;
        const s = y * n + sx;
        const di = dx + R;
        const so = s * 12;
        const fo = s * 3;
        for (let qa = 0; qa < 2; qa++) {
          const g0 = gq[(qa * SPAN + di) * 2] as number;
          const g1 = gq[(qa * SPAN + di) * 2 + 1] as number;
          const gff = gf[qa * SPAN + di] as number;
          for (let qsy = 0; qsy < 2; qsy++) {
            const b0 = so + (qsy * 2) * 3; // source quadrant (qsx = 0, qsy)
            const b1 = so + (qsy * 2 + 1) * 3; // (qsx = 1, qsy)
            const o = ao + (qa * 2 + qsy) * 3;
            A[o] = (A[o] as number) + g0 * (sq[b0] as number) + g1 * (sq[b1] as number);
            A[o + 1] = (A[o + 1] as number) + g0 * (sq[b0 + 1] as number) + g1 * (sq[b1 + 1] as number);
            A[o + 2] = (A[o + 2] as number) + g0 * (sq[b0 + 2] as number) + g1 * (sq[b1 + 2] as number);
          }
          const fo2 = afo + qa * 3;
          Af[fo2] = (Af[fo2] as number) + gff * (sf[fo] as number);
          Af[fo2 + 1] = (Af[fo2 + 1] as number) + gff * (sf[fo + 1] as number);
          Af[fo2 + 2] = (Af[fo2 + 2] as number) + gff * (sf[fo + 2] as number);
        }
      }
    }
  }
  const F = out && out.length === n * n * 12 ? out.fill(0) : new Float32Array(n * n * 12);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const t = y * n + x;
      const fo = t * 12;
      for (let dy = -R; dy <= R; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= n) continue;
        const s = sy * n + x;
        const di = dy + R;
        const ao = s * 12;
        const afo = s * 6;
        for (let qb = 0; qb < 2; qb++) {
          const g0 = gq[(qb * SPAN + di) * 2] as number;
          const g1 = gq[(qb * SPAN + di) * 2 + 1] as number;
          const gff = gf[qb * SPAN + di] as number;
          for (let qa = 0; qa < 2; qa++) {
            const q = qb * 2 + qa;
            const o = fo + q * 3;
            const a0 = ao + (qa * 2) * 3; // qsy = 0
            const a1 = ao + (qa * 2 + 1) * 3; // qsy = 1
            const af = afo + qa * 3;
            F[o] = (F[o] as number) + g0 * (A[a0] as number) + g1 * (A[a1] as number) + gff * (Af[af] as number);
            F[o + 1] = (F[o + 1] as number) + g0 * (A[a0 + 1] as number) + g1 * (A[a1 + 1] as number) + gff * (Af[af + 1] as number);
            F[o + 2] = (F[o + 2] as number) + g0 * (A[a0 + 2] as number) + g1 * (A[a1 + 2] as number) + gff * (Af[af + 2] as number);
          }
        }
      }
    }
  }
  return F;
}

/** Own contribution of cell `c` to its features, written to out[0..12). */
export function selfFeatures(model: ResponseModel, src: SourceGrid, c: number, out: Float32Array): void {
  const w0 = model.w0;
  const wf0 = model.wf0;
  const qo = c * 12;
  const fo = c * 3;
  for (let q = 0; q < 4; q++) {
    for (let ch = 0; ch < 3; ch++) {
      let a = (wf0[q] as number) * (src.f[fo + ch] as number);
      for (let qs = 0; qs < 4; qs++) a += (w0[q * 4 + qs] as number) * (src.q[qo + qs * 3 + ch] as number);
      out[q * 3 + ch] = a;
    }
  }
}

/**
 * Adjoint of `predictFeatures` restricted to glyph sources: for every cell s,
 *   out[s * 12 + q' * 3 + ch] = Σ_t Σ_q W(s − t)[q][q'] · feat[t * 12 + q * 3 + ch],
 * i.e. the matched filter of each source quadrant against the features of all cells it reaches. Applied to a
 * residual it collects the whole spread of a glyph's light, not only the part that stays inside its own cell — at
 * σ ≈ 0.6 cell most of a glyph's shape energy lands in its neighbors. Features that are NaN count as zero.
 */
export function adjointFeatures(model: ResponseModel, feat: Float32Array, n: number, out?: Float32Array): Float32Array {
  const R = ISI_RADIUS;
  const gq = model.gq;
  // Vertical adjoint: B[s][qa][qsy][ch] = Σ_dy Σ_qb g(qb, dy, qsy) · feat[s − dy·n][qb·2 + qa][ch].
  const B = new Float32Array(n * n * 12);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const s = y * n + x;
      const bo = s * 12;
      for (let dy = -R; dy <= R; dy++) {
        const ty = y - dy;
        if (ty < 0 || ty >= n) continue;
        const to = (ty * n + x) * 12;
        const di = dy + R;
        for (let qb = 0; qb < 2; qb++) {
          const g0 = gq[(qb * SPAN + di) * 2] as number;
          const g1 = gq[(qb * SPAN + di) * 2 + 1] as number;
          for (let qa = 0; qa < 2; qa++) {
            const fo = to + (qb * 2 + qa) * 3;
            const f0 = feat[fo] as number;
            const f1 = feat[fo + 1] as number;
            const f2 = feat[fo + 2] as number;
            if (!(f0 === f0 && f1 === f1 && f2 === f2)) continue; // NaN
            const o0 = bo + (qa * 2) * 3;
            const o1 = bo + (qa * 2 + 1) * 3;
            B[o0] = (B[o0] as number) + g0 * f0;
            B[o0 + 1] = (B[o0 + 1] as number) + g0 * f1;
            B[o0 + 2] = (B[o0 + 2] as number) + g0 * f2;
            B[o1] = (B[o1] as number) + g1 * f0;
            B[o1 + 1] = (B[o1 + 1] as number) + g1 * f1;
            B[o1 + 2] = (B[o1 + 2] as number) + g1 * f2;
          }
        }
      }
    }
  }
  // Horizontal adjoint: out[s][qsy·2 + qsx][ch] = Σ_dx Σ_qa g(qa, dx, qsx) · B[s − dx][qa][qsy][ch].
  const O = out && out.length === n * n * 12 ? out.fill(0) : new Float32Array(n * n * 12);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const s = y * n + x;
      const oo = s * 12;
      for (let dx = -R; dx <= R; dx++) {
        const tx = x - dx;
        if (tx < 0 || tx >= n) continue;
        const bo = (y * n + tx) * 12;
        const di = dx + R;
        for (let qa = 0; qa < 2; qa++) {
          const g0 = gq[(qa * SPAN + di) * 2] as number;
          const g1 = gq[(qa * SPAN + di) * 2 + 1] as number;
          for (let qsy = 0; qsy < 2; qsy++) {
            const bi = bo + (qa * 2 + qsy) * 3;
            const b0 = B[bi] as number;
            const b1 = B[bi + 1] as number;
            const b2 = B[bi + 2] as number;
            const o0 = oo + (qsy * 2) * 3;
            const o1 = oo + (qsy * 2 + 1) * 3;
            O[o0] = (O[o0] as number) + g0 * b0;
            O[o0 + 1] = (O[o0 + 1] as number) + g0 * b1;
            O[o0 + 2] = (O[o0 + 2] as number) + g0 * b2;
            O[o1] = (O[o1] as number) + g1 * b0;
            O[o1 + 1] = (O[o1 + 1] as number) + g1 * b1;
            O[o1 + 2] = (O[o1 + 2] as number) + g1 * b2;
          }
        }
      }
    }
  }
  return O;
}

/**
 * 1-D Gram factor of a glyph source at grid position p (0 … n−1) along one axis:
 *   G[a][b] = Σ_{d: 0 ≤ p − d < n} Σ_qa g(qa, d, a) · g(qa, d, b),  a, b ∈ {0, 1} (source quadrant half).
 * The 4 × 4 Gram matrix of a cell's quadrant sources against every feature they reach is Gx ⊗ Gy.
 */
function gram1d(model: ResponseModel, p: number, n: number): [number, number, number, number] {
  const R = ISI_RADIUS;
  const gq = model.gq;
  let g00 = 0;
  let g01 = 0;
  let g11 = 0;
  for (let d = -R; d <= R; d++) {
    const t = p - d;
    if (t < 0 || t >= n) continue;
    const di = d + R;
    for (let qa = 0; qa < 2; qa++) {
      const a = gq[(qa * SPAN + di) * 2] as number;
      const b = gq[(qa * SPAN + di) * 2 + 1] as number;
      g00 += a * a;
      g01 += a * b;
      g11 += b * b;
    }
  }
  return [g00, g01, g01, g11];
}

/** Edge class of a grid position: 0…R−1 from the low edge, R interior, R+1… from the high edge. */
export function edgeClass(p: number, n: number): number {
  if (p < ISI_RADIUS) return p;
  if (p >= n - ISI_RADIUS) return 2 * ISI_RADIUS - (n - 1 - p);
  return ISI_RADIUS;
}

/** Number of distinct edge classes per axis. */
export const EDGE_CLASSES = 2 * ISI_RADIUS + 1;

/** Representative position of an edge class for a grid of size n. */
function classPosition(cls: number, n: number): number {
  if (cls < ISI_RADIUS) return cls;
  if (cls > ISI_RADIUS) return n - 1 - (2 * ISI_RADIUS - cls);
  return Math.floor(n / 2);
}

/**
 * Full-spread Gram matrices M = WᵀW (4 × 4, row-major, quadrant index qy·2 + qx) for every (x class, y class):
 * out[(cy * EDGE_CLASSES + cx) * 16 + a * 4 + b].
 */
export function spreadGrams(model: ResponseModel, n: number): Float64Array {
  const out = new Float64Array(EDGE_CLASSES * EDGE_CLASSES * 16);
  const g1 = Array.from({ length: EDGE_CLASSES }, (_, c) => gram1d(model, classPosition(c, n), n));
  for (let cy = 0; cy < EDGE_CLASSES; cy++) {
    for (let cx = 0; cx < EDGE_CLASSES; cx++) {
      const gx = g1[cx] as [number, number, number, number];
      const gy = g1[cy] as [number, number, number, number];
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          out[(cy * EDGE_CLASSES + cx) * 16 + a * 4 + b] = (gx[(a & 1) * 2 + (b & 1)] as number) * (gy[(a >> 1) * 2 + (b >> 1)] as number);
        }
      }
    }
  }
  return out;
}

/**
 * The normal operator WᵀW restricted to glyph sources, applied directly: WᵀW is separable too (it is the 2-D blur
 * Gram), with 1-D kernel K[d][a][b] = Σ_t Σ_qa g(qa, t, a)·g(qa, t − d, b), d ∈ [−2R, 2R], truncated at the grid
 * edges exactly like the forward model. Two 1-D passes of 5 taps × 2 × 2 replace predictFeatures + adjointFeatures
 * (four passes); edge rows/columns use per-position kernels.
 */
export class NormalOperator {
  readonly n: number;
  /** kx[pos][d][a][b] flattened: per-position kernels for the first and last 2R positions and one interior kernel. */
  private readonly kernels: Float64Array;
  private readonly kernelIndex: Int32Array;
  private readonly tmp: Float32Array;
  private static readonly R2 = 2 * ISI_RADIUS;
  private static readonly TAPS = 4 * ISI_RADIUS + 1;

  constructor(model: ResponseModel, n: number) {
    this.n = n;
    const R = ISI_RADIUS;
    const R2 = NormalOperator.R2;
    const TAPS = NormalOperator.TAPS;
    const gq = model.gq;
    const g = (qa: number, d: number, a: number): number => (d < -R || d > R ? 0 : (gq[(qa * SPAN + d + R) * 2 + a] as number));
    // Distinct position classes: 0 … 2R−1 (low edge), 2R (interior), and n−2R … n−1 (high edge).
    const classes = 2 * R2 + 1;
    this.kernels = new Float64Array(classes * TAPS * 4);
    this.kernelIndex = new Int32Array(n);
    for (let p = 0; p < n; p++) this.kernelIndex[p] = p < R2 ? p : p >= n - R2 ? 2 * R2 - (n - 1 - p) : R2;
    for (let cls = 0; cls < classes; cls++) {
      // Representative output position s (source index whose statistic we compute) and input positions s' = s + d.
      const s = cls < R2 ? cls : cls > R2 ? n - 1 - (2 * R2 - cls) : Math.floor(n / 2);
      for (let d = -R2; d <= R2; d++) {
        const sp = s + d;
        if (sp < 0 || sp >= n) continue;
        for (let a = 0; a < 2; a++) {
          for (let b = 0; b < 2; b++) {
            let acc = 0;
            // Feature positions t within reach of both s and s'.
            for (let t = Math.max(0, s - R, sp - R); t <= Math.min(n - 1, s + R, sp + R); t++) {
              for (let qa = 0; qa < 2; qa++) acc += g(qa, s - t, a) * g(qa, sp - t, b);
            }
            this.kernels[((cls * TAPS + d + R2) * 2 + a) * 2 + b] = acc;
          }
        }
      }
    }
    this.tmp = new Float32Array(n * n * 12);
  }

  /** out = WᵀW x (glyph sources, n² × 12). */
  apply(x: Float32Array, out: Float32Array): void {
    const n = this.n;
    const R2 = NormalOperator.R2;
    const TAPS = NormalOperator.TAPS;
    const K = this.kernels;
    const ki = this.kernelIndex;
    const tmp = this.tmp;
    // Pass 1 (x): tmp[y][x][qy][a][ch] = Σ_d Σ_b Kx[x][d][a][b] · x[y][x+d][qy][b][ch].
    for (let y = 0; y < n; y++) {
      for (let xx = 0; xx < n; xx++) {
        const o = (y * n + xx) * 12;
        const kb = (ki[xx] as number) * TAPS;
        let t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0;
        const d0 = Math.max(-R2, -xx);
        const d1 = Math.min(R2, n - 1 - xx);
        for (let d = d0; d <= d1; d++) {
          const k = (kb + d + R2) * 4;
          const k00 = K[k] as number;
          const k01 = K[k + 1] as number;
          const k10 = K[k + 2] as number;
          const k11 = K[k + 3] as number;
          const i = o + d * 12;
          // quadrant index q = qy·2 + qx; channels interleaved: [q*3 + ch].
          const a0 = x[i] as number, a1 = x[i + 1] as number, a2 = x[i + 2] as number; // q0 (qy0, b0)
          const b0 = x[i + 3] as number, b1 = x[i + 4] as number, b2 = x[i + 5] as number; // q1 (qy0, b1)
          const c0 = x[i + 6] as number, c1 = x[i + 7] as number, c2 = x[i + 8] as number; // q2 (qy1, b0)
          const e0 = x[i + 9] as number, e1 = x[i + 10] as number, e2 = x[i + 11] as number; // q3 (qy1, b1)
          t0 += k00 * a0 + k01 * b0;
          t1 += k00 * a1 + k01 * b1;
          t2 += k00 * a2 + k01 * b2;
          t3 += k10 * a0 + k11 * b0;
          t4 += k10 * a1 + k11 * b1;
          t5 += k10 * a2 + k11 * b2;
          t6 += k00 * c0 + k01 * e0;
          t7 += k00 * c1 + k01 * e1;
          t8 += k00 * c2 + k01 * e2;
          t9 += k10 * c0 + k11 * e0;
          t10 += k10 * c1 + k11 * e1;
          t11 += k10 * c2 + k11 * e2;
        }
        tmp[o] = t0;
        tmp[o + 1] = t1;
        tmp[o + 2] = t2;
        tmp[o + 3] = t3;
        tmp[o + 4] = t4;
        tmp[o + 5] = t5;
        tmp[o + 6] = t6;
        tmp[o + 7] = t7;
        tmp[o + 8] = t8;
        tmp[o + 9] = t9;
        tmp[o + 10] = t10;
        tmp[o + 11] = t11;
      }
    }
    // Pass 2 (y): out[y][x][a_y][qx][ch] = Σ_d Σ_b Ky[y][d][a_y][b] · tmp[y+d][x][b][qx][ch].
    const row = n * 12;
    for (let y = 0; y < n; y++) {
      const kb = (ki[y] as number) * TAPS;
      const d0 = Math.max(-R2, -y);
      const d1 = Math.min(R2, n - 1 - y);
      for (let xx = 0; xx < n; xx++) {
        const o = (y * n + xx) * 12;
        let t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0;
        for (let d = d0; d <= d1; d++) {
          const k = (kb + d + R2) * 4;
          const k00 = K[k] as number;
          const k01 = K[k + 1] as number;
          const k10 = K[k + 2] as number;
          const k11 = K[k + 3] as number;
          const i = o + d * row;
          // Row half b = 0 holds quadrants 0, 1 (offsets 0–5); b = 1 holds quadrants 2, 3 (offsets 6–11).
          const u0 = tmp[i] as number, u1 = tmp[i + 1] as number, u2 = tmp[i + 2] as number;
          const u3 = tmp[i + 3] as number, u4 = tmp[i + 4] as number, u5 = tmp[i + 5] as number;
          const v0 = tmp[i + 6] as number, v1 = tmp[i + 7] as number, v2 = tmp[i + 8] as number;
          const v3 = tmp[i + 9] as number, v4 = tmp[i + 10] as number, v5 = tmp[i + 11] as number;
          t0 += k00 * u0 + k01 * v0;
          t1 += k00 * u1 + k01 * v1;
          t2 += k00 * u2 + k01 * v2;
          t3 += k00 * u3 + k01 * v3;
          t4 += k00 * u4 + k01 * v4;
          t5 += k00 * u5 + k01 * v5;
          t6 += k10 * u0 + k11 * v0;
          t7 += k10 * u1 + k11 * v1;
          t8 += k10 * u2 + k11 * v2;
          t9 += k10 * u3 + k11 * v3;
          t10 += k10 * u4 + k11 * v4;
          t11 += k10 * u5 + k11 * v5;
        }
        out[o] = t0;
        out[o + 1] = t1;
        out[o + 2] = t2;
        out[o + 3] = t3;
        out[o + 4] = t4;
        out[o + 5] = t5;
        out[o + 6] = t6;
        out[o + 7] = t7;
        out[o + 8] = t8;
        out[o + 9] = t9;
        out[o + 10] = t10;
        out[o + 11] = t11;
      }
    }
  }
}
