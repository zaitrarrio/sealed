/**
 * Model-based homography refinement (spec §7.6 step 2, "estimate homography").
 *
 * The anchor detector localizes the four anchor centers to a fraction of a cell, but data cells need registration
 * well below 0.1 cell: at σ ≈ 0.6 cell blur the glyph quadrants are only 0.4 cell wide. This module aligns the
 * frame's *known* structure — the four anchors with their quiet-zone surround, and, once a header has decoded,
 * both header strips — to the camera luma by Gauss–Newton on the 8 homography parameters.
 *
 * Prediction: every known cell is a full-cell box of linear luma level ℓ (white = 1, background = 0) blurred by the
 * channel's Gaussian σ; unknown data cells contribute their expected glyph luma. The prediction at a grid point does
 * not depend on H, so it is computed once per (σ, structure). The camera's photometric response is fitted jointly as
 * a quadratic in the predicted level (absorbs gain, offset and tone-curve curvature); points whose prediction depends
 * noticeably on unknown data cells are left out.
 */
import type { Homography } from "./homography";
import { solveLinear } from "./homography";
import type { LumaPlane } from "./detect";
import { CellKind, QUIET_CELLS, type GridLayout } from "./layout";
import { HEADER_BITS } from "./header";
import { boxResponse } from "./model";
import { GLYPH_MARGIN, meanFill } from "./glyphs";

/** Sample pitch in cells (4 samples per cell per axis, at cell offsets 0.125, 0.375, 0.625, 0.875). */
const SUB = 4;
const OFFSETS = [0.125, 0.375, 0.625, 0.875] as const;
/** Cells beyond this distance do not affect a sample (Gaussian tail < 0.1 % for σ ≤ 0.8). */
const REACH = 3;
/** Points whose prediction has more than this much luma from unknown data cells are not used. */
const MAX_DATA_INFLUENCE = 0.04;
/** Expected linear luma of a data cell relative to white, averaged over glyphs and the palette (≈ 0.6 luma). */
const MEAN_GLYPH_LEVEL = 0.5 * (meanFill(4) + meanFill(8)) * 0.6;
const ITERATIONS = 6;

export interface RefinePoints {
  /** Grid coordinates of the sample points (x, y interleaved). */
  readonly xy: Float64Array;
  /** Predicted linear luma level (white = 1, background = 0). */
  readonly pred: Float64Array;
}

interface CellLevels {
  /** Level of each cell in [-1 = unknown data, 0 … 1 = known full-cell level]; index (y + Q) * M + (x + Q). */
  readonly level: Float32Array;
  readonly m: number;
}

/** 1-D responses: resp[sub][d + REACH] = mean response of a box at cell offset d to sample sub. */
function responses(sigma: number, lo: number, hi: number): Float64Array[] {
  return OFFSETS.map((o) => {
    const r = new Float64Array(2 * REACH + 1);
    for (let d = -REACH; d <= REACH; d++) r[d + REACH] = boxResponse(o, d + lo, d + hi, sigma);
    return r;
  });
}

function levels(layout: GridLayout, strips: Uint8Array | null): CellLevels {
  const n = layout.n;
  const Q = QUIET_CELLS + REACH;
  const m = n + 2 * Q;
  const level = new Float32Array(m * m); // quiet zone and beyond: background (0)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = y * n + x;
      const k = layout.kind[c];
      let v = -1;
      if (k === CellKind.Anchor) v = layout.anchorLight[c] ? 1 : 0;
      level[(y + Q) * m + x + Q] = v;
    }
  }
  if (strips) {
    for (let i = 0; i < layout.headerTop.length; i++) {
      const bit = i < HEADER_BITS ? (strips[i] as number) : i & 1;
      for (const cells of [layout.headerTop, layout.headerBottom]) {
        const c = cells[i] as number;
        level[(Math.floor(c / n) + Q) * m + (c % n) + Q] = bit;
      }
    }
  }
  return { level, m };
}

/**
 * Sample points and predictions for the known structure. With `strips` (header strip bits, strip order), header
 * cells are known too.
 */
export function refinePoints(layout: GridLayout, sigma: number, strips: Uint8Array | null): RefinePoints {
  const n = layout.n;
  const Q = QUIET_CELLS + REACH;
  const { level, m } = levels(layout, strips);
  const full = responses(sigma, 0, 1);
  const glyph = responses(sigma, GLYPH_MARGIN, 1 - GLYPH_MARGIN);
  const xs: number[] = [];
  const preds: number[] = [];
  const visit = (cx: number, cy: number): void => {
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        let p = 0;
        let data = 0;
        for (let dy = -REACH; dy <= REACH; dy++) {
          const yy = cy + dy;
          const ry = (full[sy] as Float64Array)[REACH - dy] as number;
          const gy = (glyph[sy] as Float64Array)[REACH - dy] as number;
          for (let dx = -REACH; dx <= REACH; dx++) {
            const xx = cx + dx;
            const v = level[(yy + Q) * m + xx + Q] as number;
            if (v === 0) continue;
            if (v < 0) {
              const w = MEAN_GLYPH_LEVEL * ((glyph[sx] as Float64Array)[REACH - dx] as number) * gy;
              p += w;
              data += w;
            } else {
              p += v * ((full[sx] as Float64Array)[REACH - dx] as number) * ry;
            }
          }
        }
        if (data > MAX_DATA_INFLUENCE) continue;
        xs.push(cx + (OFFSETS[sx] as number), cy + (OFFSETS[sy] as number));
        preds.push(p);
      }
    }
  };
  const A = 8;
  const q = QUIET_CELLS;
  // Anchors with the quiet zone on their two outer sides.
  const regions: [number, number, number, number][] = [
    [-q, -q, A, A],
    [n - A, -q, n + q, A],
    [n - A, n - A, n + q, n + q],
    [-q, n - A, A, n + q],
  ];
  if (strips) {
    regions.push([A, -q, n - A, 2], [A, n - 2, n - A, n + q]);
  }
  for (const [x0, y0, x1, y1] of regions) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) visit(x, y);
  return { xy: Float64Array.from(xs), pred: Float64Array.from(preds) };
}

const pointCache = new Map<string, RefinePoints>();

/** Anchor-only points, cached per (grid, σ). */
export function anchorPoints(layout: GridLayout, sigma: number): RefinePoints {
  const key = `${layout.n}/${Math.round(sigma * 50)}`;
  let p = pointCache.get(key);
  if (!p) {
    p = refinePoints(layout, Math.round(sigma * 50) / 50, null);
    pointCache.set(key, p);
    if (pointCache.size > 32) {
      const first = pointCache.keys().next().value;
      if (first !== undefined) pointCache.delete(first);
    }
  }
  return p;
}

/** Bilinear sample with gradient (pixel i spans [i, i + 1]); null outside. */
function sampleGrad(l: LumaPlane, u: number, v: number, out: Float64Array): boolean {
  const x = u - 0.5;
  const y = v - 0.5;
  const W = l.width;
  const H = l.height;
  if (!(x >= 0 && y >= 0 && x < W - 1 && y < H - 1)) return false;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const d = l.data;
  const i = y0 * W + x0;
  const a = d[i] as number;
  const b = d[i + 1] as number;
  const c = d[i + W] as number;
  const e = d[i + W + 1] as number;
  out[0] = a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
  out[1] = (b - a) + (a - b - c + e) * fy;
  out[2] = (c - a) + (a - b - c + e) * fx;
  return true;
}

export interface RefineResult {
  readonly h: Homography;
  /** RMS residual relative to the fitted white-to-background luma span. */
  readonly rms: number;
  /** Number of points used in the final iteration. */
  readonly used: number;
}

/**
 * Gauss–Newton refinement of `h` (grid → image) so the camera luma matches the predicted known structure.
 * Returns null when the fit is degenerate (too few points inside the image, no contrast, divergence).
 */
export function refineHomography(luma: LumaPlane, h0: Homography, pts: RefinePoints): RefineResult | null {
  const h = Float64Array.from(h0);
  const N = pts.pred.length;
  if (N < 64) return null;
  const g = new Float64Array(3);
  const obs = new Float64Array(N);
  const gu = new Float64Array(N);
  const gv = new Float64Array(N);
  const inside = new Uint8Array(N);
  let photo = [0, 1, 0];
  let rms = Infinity;
  let used = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Sample at the current pose.
    used = 0;
    for (let i = 0; i < N; i++) {
      const x = pts.xy[2 * i] as number;
      const y = pts.xy[2 * i + 1] as number;
      const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
      inside[i] = 0;
      if (!(w > 1e-12)) continue;
      const u = ((h[0] as number) * x + (h[1] as number) * y + (h[2] as number)) / w;
      const v = ((h[3] as number) * x + (h[4] as number) * y + (h[5] as number)) / w;
      if (!sampleGrad(luma, u, v, g)) continue;
      obs[i] = g[0] as number;
      gu[i] = g[1] as number;
      gv[i] = g[2] as number;
      inside[i] = 1;
      used++;
    }
    if (used < Math.max(64, 0.6 * N)) return null;
    // Photometric fit: obs ≈ p0 + p1·pred + p2·pred².
    {
      const G = new Float64Array(9);
      const B = new Float64Array(3);
      for (let i = 0; i < N; i++) {
        if (!inside[i]) continue;
        const p = pts.pred[i] as number;
        const f = [1, p, p * p];
        for (let a = 0; a < 3; a++) {
          B[a] = (B[a] as number) + (f[a] as number) * (obs[i] as number);
          for (let b = 0; b < 3; b++) G[a * 3 + b] = (G[a * 3 + b] as number) + (f[a] as number) * (f[b] as number);
        }
      }
      const sol = solveLinear(G, B, 3);
      if (!sol) return null;
      photo = [sol[0] as number, sol[1] as number, sol[2] as number];
    }
    const span = (photo[1] as number) + (photo[2] as number);
    if (!(span > 0.02) || !((photo[1] as number) > 0)) return null;
    // Normal equations for the 8 homography parameters.
    const JtJ = new Float64Array(64);
    const Jtr = new Float64Array(8);
    const J = new Float64Array(8);
    let se = 0;
    for (let i = 0; i < N; i++) {
      if (!inside[i]) continue;
      const x = pts.xy[2 * i] as number;
      const y = pts.xy[2 * i + 1] as number;
      const p = pts.pred[i] as number;
      const r = (obs[i] as number) - ((photo[0] as number) + (photo[1] as number) * p + (photo[2] as number) * p * p);
      se += r * r;
      const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
      const u = ((h[0] as number) * x + (h[1] as number) * y + (h[2] as number)) / w;
      const v = ((h[3] as number) * x + (h[4] as number) * y + (h[5] as number)) / w;
      const a = gu[i] as number;
      const b = gv[i] as number;
      // d(obs)/dh_k = a·du/dh_k + b·dv/dh_k.
      J[0] = (a * x) / w;
      J[1] = (a * y) / w;
      J[2] = a / w;
      J[3] = (b * x) / w;
      J[4] = (b * y) / w;
      J[5] = b / w;
      J[6] = (-(a * u + b * v) * x) / w;
      J[7] = (-(a * u + b * v) * y) / w;
      for (let k = 0; k < 8; k++) {
        const jk = J[k] as number;
        Jtr[k] = (Jtr[k] as number) + jk * r;
        for (let l = k; l < 8; l++) JtJ[k * 8 + l] = (JtJ[k * 8 + l] as number) + jk * (J[l] as number);
      }
    }
    rms = Math.sqrt(se / used) / span;
    for (let k = 0; k < 8; k++) for (let l = 0; l < k; l++) JtJ[k * 8 + l] = JtJ[l * 8 + k] as number;
    // Jacobi scaling plus light Levenberg damping.
    const scale = new Float64Array(8);
    for (let k = 0; k < 8; k++) scale[k] = 1 / Math.sqrt(Math.max(1e-30, JtJ[k * 8 + k] as number));
    const A = new Float64Array(64);
    const rhs = new Float64Array(8);
    for (let k = 0; k < 8; k++) {
      rhs[k] = (Jtr[k] as number) * (scale[k] as number);
      for (let l = 0; l < 8; l++) A[k * 8 + l] = (JtJ[k * 8 + l] as number) * (scale[k] as number) * (scale[l] as number);
      A[k * 8 + k] = (A[k * 8 + k] as number) * 1.001;
    }
    const step = solveLinear(A, rhs, 8);
    if (!step) return null;
    // r = obs − model and obs(h + δ) ≈ obs + Jδ, so the step that zeroes the residual is δ = −(JᵀJ)⁻¹ Jᵀr.
    for (let k = 0; k < 8; k++) h[k] = (h[k] as number) - (step[k] as number) * (scale[k] as number);
    for (let k = 0; k < 8; k++) if (!Number.isFinite(h[k] as number)) return null;
    // Converged when the normalized step is tiny (well below 0.01 pixel at the grid's extent).
    if (stepSize(step) < 1e-3) break;
  }
  return { h, rms, used };
}

/** Largest component of a Jacobi-scaled step (≈ residual-weighted parameter change). */
function stepSize(step: Float64Array): number {
  let m = 0;
  for (let k = 0; k < 8; k++) m = Math.max(m, Math.abs(step[k] as number));
  return m;
}
