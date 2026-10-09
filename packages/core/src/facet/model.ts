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

/** Neighborhood radius in cells; Gaussian tails beyond 2 cells are < 0.1% for σ ≤ 0.6. */
export const ISI_RADIUS = 2;
export const SPAN = 2 * ISI_RADIUS + 1;

/** Sample offsets (cells, from the cell center) for the low and high quadrant on one axis. */
export const SAMPLE_OFFSETS: readonly (readonly number[])[] = [
  [-0.35, -0.2, -0.05],
  [0.05, 0.2, 0.35],
];
const QUAD_BOX: readonly (readonly [number, number])[] = [
  [-0.4, 0],
  [0, 0.4],
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
