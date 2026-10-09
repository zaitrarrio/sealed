/**
 * Joint symbol detection for grid frames (spec §7.6 step 6) by vector approximate message passing (VAMP) over the
 * exact blur channel.
 *
 * Observation model (model.ts): every glyph quadrant is a box of half a cell, so the lit sources of an N × N grid
 * form an M × M array (M = 2N) of half-cell boxes per color channel, and the quadrant features form an M × M array
 * of samples. The Gaussian blur is separable, so per channel
 *     F = A X Aᵀ + noise,   A ∈ R^{M×M} (A[2t + qa][2s + qs] = 1-D response of half qs of cell s at half qa of t)
 * and the normal operator AᵀA ⊗ AᵀA has eigenvectors V ⊗ V from the eigendecomposition AᵀA = V Λ Vᵀ. The LMMSE stage
 * of VAMP — (γ_w (AᵀA ⊗ AᵀA) + γ I)⁻¹ — is therefore exact and costs four M × M matrix products per channel.
 *
 * VAMP alternates
 *   1. a denoiser on the extrinsic estimate r₁ (precision γ₁): per data cell, the posterior over the K·16 discrete
 *      symbols x = fill_s ⊗ c_k (12-vector: 4 quadrants × RGB) — this is where the constellation's structure (a
 *      shared color across a cell's quadrants) enters exactly;
 *   2. the exact LMMSE estimate given the denoiser's extrinsic output (r₂, γ₂),
 * with damping of the denoiser output. Under heavy blur (σ ≈ 0.6 cell) most of a glyph's energy lands in its
 * neighbors and per-cell or diagonal-approximation detectors (EP with a Jacobi-preconditioned Gaussian stage) fail
 * to converge; VAMP's Onsager-corrected extrinsic messages keep the iteration stable.
 *
 * Known cells (anchors, header strips, padding pilots, and cells already fixed by decoded codewords) are subtracted
 * from the observation beforehand; in the residual their sources are exactly zero.
 */
import { glyphFills } from "./glyphs";
import type { ResponseModel } from "./model";
import { ISI_RADIUS, SPAN } from "./model";

/** Eigendecomposition of a symmetric matrix (Householder tridiagonalization + implicit QL), row-major. */
export function symmetricEigen(a: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  // Numerical Recipes tred2/tqli, adapted to 0-based row-major storage; `z` ends up holding eigenvectors as columns.
  const z = Float64Array.from(a);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  for (let i = n - 1; i > 0; i--) {
    const l = i - 1;
    let h = 0;
    let scale = 0;
    if (l > 0) {
      for (let k = 0; k <= l; k++) scale += Math.abs(z[i * n + k] as number);
      if (scale === 0) {
        e[i] = z[i * n + l] as number;
      } else {
        for (let k = 0; k <= l; k++) {
          const v = (z[i * n + k] as number) / scale;
          z[i * n + k] = v;
          h += v * v;
        }
        let f = z[i * n + l] as number;
        const g = f >= 0 ? -Math.sqrt(h) : Math.sqrt(h);
        e[i] = scale * g;
        h -= f * g;
        z[i * n + l] = f - g;
        f = 0;
        for (let j = 0; j <= l; j++) {
          z[j * n + i] = (z[i * n + j] as number) / h;
          let gg = 0;
          for (let k = 0; k <= j; k++) gg += (z[j * n + k] as number) * (z[i * n + k] as number);
          for (let k = j + 1; k <= l; k++) gg += (z[k * n + j] as number) * (z[i * n + k] as number);
          e[j] = gg / h;
          f += (e[j] as number) * (z[i * n + j] as number);
        }
        const hh = f / (h + h);
        for (let j = 0; j <= l; j++) {
          const fj = z[i * n + j] as number;
          const gj = (e[j] as number) - hh * fj;
          e[j] = gj;
          for (let k = 0; k <= j; k++) z[j * n + k] = (z[j * n + k] as number) - (fj * (e[k] as number) + gj * (z[i * n + k] as number));
        }
      }
    } else {
      e[i] = z[i * n + l] as number;
    }
    d[i] = h;
  }
  d[0] = 0;
  e[0] = 0;
  for (let i = 0; i < n; i++) {
    const l = i - 1;
    if (d[i]) {
      for (let j = 0; j <= l; j++) {
        let g = 0;
        for (let k = 0; k <= l; k++) g += (z[i * n + k] as number) * (z[k * n + j] as number);
        for (let k = 0; k <= l; k++) z[k * n + j] = (z[k * n + j] as number) - g * (z[k * n + i] as number);
      }
    }
    d[i] = z[i * n + i] as number;
    z[i * n + i] = 1;
    for (let j = 0; j <= l; j++) {
      z[j * n + i] = 0;
      z[i * n + j] = 0;
    }
  }
  // QL with implicit shifts on the tridiagonal (d, e).
  for (let i = 1; i < n; i++) e[i - 1] = e[i] as number;
  e[n - 1] = 0;
  for (let l = 0; l < n; l++) {
    let iter = 0;
    let m: number;
    do {
      for (m = l; m < n - 1; m++) {
        const dd = Math.abs(d[m] as number) + Math.abs(d[m + 1] as number);
        if (Math.abs(e[m] as number) <= Number.EPSILON * dd) break;
      }
      if (m !== l) {
        if (iter++ === 60) throw new Error("eigendecomposition did not converge");
        let g = ((d[l + 1] as number) - (d[l] as number)) / (2 * (e[l] as number));
        let r = Math.hypot(g, 1);
        g = (d[m] as number) - (d[l] as number) + (e[l] as number) / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
        let s = 1;
        let c = 1;
        let p = 0;
        let i: number;
        for (i = m - 1; i >= l; i--) {
          let f = s * (e[i] as number);
          const b = c * (e[i] as number);
          r = Math.hypot(f, g);
          e[i + 1] = r;
          if (r === 0) {
            d[i + 1] = (d[i + 1] as number) - p;
            e[m] = 0;
            break;
          }
          s = f / r;
          c = g / r;
          g = (d[i + 1] as number) - p;
          r = ((d[i] as number) - g) * s + 2 * c * b;
          p = s * r;
          d[i + 1] = g + p;
          g = c * r - b;
          for (let k = 0; k < n; k++) {
            f = z[k * n + i + 1] as number;
            z[k * n + i + 1] = s * (z[k * n + i] as number) + c * f;
            z[k * n + i] = c * (z[k * n + i] as number) - s * f;
          }
        }
        if (r === 0 && i >= l) continue;
        d[l] = (d[l] as number) - p;
        e[l] = g;
        e[m] = 0;
      }
    } while (m !== l);
  }
  return { values: d, vectors: z };
}

/** Half-cell blur operator of one axis and its normal-matrix eigendecomposition, cached per (σ, N). */
export interface HalfCellOperator {
  readonly n: number;
  readonly m: number;
  /** A (M × M, row-major): feature half-cell row → source half-cell column. */
  readonly a: Float64Array;
  /** Eigenvectors of AᵀA as columns (M × M, row-major) and the transpose. */
  readonly v: Float64Array;
  readonly vt: Float64Array;
  readonly lambda: Float64Array;
}

const operatorCache = new Map<string, HalfCellOperator>();

export function halfCellOperator(model: ResponseModel, n: number): HalfCellOperator {
  const key = `${model.sigma}/${n}`;
  const hit = operatorCache.get(key);
  if (hit) return hit;
  const m = 2 * n;
  const R = ISI_RADIUS;
  const a = new Float64Array(m * m);
  for (let t = 0; t < n; t++) {
    for (let d = -R; d <= R; d++) {
      const s = t + d;
      if (s < 0 || s >= n) continue;
      for (let qa = 0; qa < 2; qa++) {
        for (let qs = 0; qs < 2; qs++) a[(2 * t + qa) * m + 2 * s + qs] = model.gq[(qa * SPAN + d + R) * 2 + qs] as number;
      }
    }
  }
  const k = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      let s = 0;
      for (let r = 0; r < m; r++) s += (a[r * m + i] as number) * (a[r * m + j] as number);
      k[i * m + j] = s;
      k[j * m + i] = s;
    }
  }
  const { values, vectors } = symmetricEigen(k, m);
  const vt = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) vt[j * m + i] = vectors[i * m + j] as number;
  for (let i = 0; i < m; i++) values[i] = Math.max(0, values[i] as number);
  const op: HalfCellOperator = { n, m, a, v: vectors, vt, lambda: values };
  operatorCache.set(key, op);
  if (operatorCache.size > 6) {
    const first = operatorCache.keys().next().value;
    if (first !== undefined && first !== key) operatorCache.delete(first);
  }
  return op;
}

/** out = L · B · R for M × M row-major matrices (i-k-j loop order for locality). */
function mul3(l: Float64Array, b: Float64Array, r: Float64Array, m: number, tmp: Float64Array, out: Float64Array): void {
  tmp.fill(0);
  for (let i = 0; i < m; i++) {
    const ro = i * m;
    for (let k = 0; k < m; k++) {
      const lik = l[ro + k] as number;
      if (lik === 0) continue;
      const bo = k * m;
      for (let j = 0; j < m; j++) tmp[ro + j] = (tmp[ro + j] as number) + lik * (b[bo + j] as number);
    }
  }
  out.fill(0);
  for (let i = 0; i < m; i++) {
    const ro = i * m;
    for (let k = 0; k < m; k++) {
      const tik = tmp[ro + k] as number;
      if (tik === 0) continue;
      const bo = k * m;
      for (let j = 0; j < m; j++) out[ro + j] = (out[ro + j] as number) + tik * (r[bo + j] as number);
    }
  }
}

export interface VampProblem {
  readonly n: number;
  readonly model: ResponseModel;
  /** Residual features after subtracting every known source ([cell * 12 + q * 3 + ch]), NaN-free. */
  readonly y: Float32Array;
  /** Cells (grid indices) whose sources are unknown. */
  readonly cells: Int32Array;
  /** Palette centroids (K × 3). */
  readonly centroids: Float32Array;
  /** Noise variance per feature component. */
  readonly noiseVariance: number;
}

export interface VampOptions {
  readonly iterations: number;
  /** Weight of the new denoiser output (1 = no damping). */
  readonly damping: number;
  /**
   * Called after each iteration with hard decisions and margins (indexed like `cells`); return true to stop
   * (for example once the inner code decodes).
   */
  readonly onIteration?: (iteration: number, sym: Uint8Array, margin: Float32Array) => boolean;
}

export const DEFAULT_VAMP_OPTIONS: VampOptions = { iterations: 12, damping: 0.5 };

export interface VampResult {
  /** Hard decisions (color · 16 + shape), indexed like `cells`. */
  readonly sym: Uint8Array;
  /** Log-likelihood gap between the two best symbols. */
  readonly margin: Float32Array;
  readonly iterations: number;
}

/** Index of feature/source component (cell c, quadrant q, channel ch) in the per-channel M × M array. */
function halfIndex(c: number, q: number, n: number): number {
  const x = c % n;
  const y = (c - x) / n;
  return (2 * y + (q >> 1)) * 2 * n + 2 * x + (q & 1);
}

export function vampDetect(problem: VampProblem, opts: VampOptions = DEFAULT_VAMP_OPTIONS): VampResult {
  const { n, model, y, cells, centroids } = problem;
  const op = halfCellOperator(model, n);
  const m = op.m;
  const MM = m * m;
  const count = cells.length;
  const K = centroids.length / 3;
  const S = K * 16;
  const fills = glyphFills(K);
  const gw = 1 / Math.max(problem.noiseVariance, 1e-12);

  // Symbol table X[sym][q * 3 + ch] and its squared norm.
  const X = new Float64Array(S * 12);
  const xx = new Float64Array(S);
  for (let sy = 0; sy < S; sy++) {
    let s2 = 0;
    for (let q = 0; q < 4; q++) {
      for (let ch = 0; ch < 3; ch++) {
        const v = (fills[(sy & 15) * 4 + q] as number) * (centroids[(sy >> 4) * 3 + ch] as number);
        X[sy * 12 + q * 3 + ch] = v;
        s2 += v * v;
      }
    }
    xx[sy] = s2;
  }
  // Per-cell index of each of its 12 components in the channel arrays.
  const idx = new Int32Array(count * 4);
  for (let j = 0; j < count; j++) for (let q = 0; q < 4; q++) idx[j * 4 + q] = halfIndex(cells[j] as number, q, n);

  // Aᵀy per channel, rotated into the eigenbasis once: Vᵀ (Aᵀ Y A) V.
  const tmp = new Float64Array(MM);
  const work = new Float64Array(MM);
  const at = new Float64Array(MM);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) at[j * m + i] = op.a[i * m + j] as number;
  const atyRot: Float64Array[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const Y = new Float64Array(MM);
    for (let c = 0; c < n * n; c++) for (let q = 0; q < 4; q++) Y[halfIndex(c, q, n)] = y[c * 12 + q * 3 + ch] as number;
    const aty = new Float64Array(MM);
    mul3(at, Y, op.a, m, tmp, aty);
    const rot = new Float64Array(MM);
    mul3(op.vt, aty, op.v, m, tmp, rot);
    atyRot.push(rot);
  }
  const lam = op.lambda;

  // Prior moments of an unknown component (uniform over symbols).
  let mean0 = 0;
  let var0 = 0;
  {
    const mu = new Float64Array(12);
    const sq = new Float64Array(12);
    for (let sy = 0; sy < S; sy++) {
      for (let i = 0; i < 12; i++) {
        const v = X[sy * 12 + i] as number;
        mu[i] = (mu[i] as number) + v / S;
        sq[i] = (sq[i] as number) + (v * v) / S;
      }
    }
    for (let i = 0; i < 12; i++) {
      mean0 += (mu[i] as number) / 12;
      var0 += ((sq[i] as number) - (mu[i] as number) * (mu[i] as number)) / 12;
    }
  }
  // r1 (per channel, M × M): extrinsic input to the LMMSE stage; known components are 0 and stay 0.
  const r1 = [0, 1, 2].map(() => new Float64Array(MM));
  for (let j = 0; j < count; j++) for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) (r1[ch] as Float64Array)[idx[j * 4 + q] as number] = mean0;
  let g1 = 1 / Math.max(var0, 1e-9);
  const knownFraction = 1 - (count * 4) / MM;

  const sym = new Uint8Array(count);
  const margin = new Float32Array(count);
  const x2 = [0, 1, 2].map(() => new Float64Array(MM));
  const r2 = [0, 1, 2].map(() => new Float64Array(MM));
  const x1 = [0, 1, 2].map(() => new Float64Array(MM));
  const x1prev = [0, 1, 2].map(() => new Float64Array(MM));
  let a1prev = 0;
  const scores = new Float64Array(S);
  const rr = new Float64Array(12);
  const brot = new Float64Array(MM);
  let iterationsRun = 0;

  for (let it = 0; it < opts.iterations; it++) {
    iterationsRun = it + 1;
    // LMMSE stage: x₂ = (γ_w AᵀA⊗AᵀA + γ₁ I)⁻¹ (γ_w Aᵀy + γ₁ r₁), via the eigenbasis.
    let trace = 0;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) trace += 1 / (gw * (lam[i] as number) * (lam[j] as number) + g1);
    for (let ch = 0; ch < 3; ch++) {
      const r1c = r1[ch] as Float64Array;
      mul3(op.vt, r1c, op.v, m, tmp, brot);
      const ar = atyRot[ch] as Float64Array;
      for (let i = 0; i < m; i++) {
        const li = gw * (lam[i] as number);
        for (let j = 0; j < m; j++) {
          const o = i * m + j;
          brot[o] = (gw * (ar[o] as number) + g1 * (brot[o] as number)) / (li * (lam[j] as number) + g1);
        }
      }
      mul3(op.v, brot, op.vt, m, tmp, x2[ch] as Float64Array);
    }
    // Divergence of the LMMSE stage restricted to unknown components is ≈ the average over all components.
    const a2 = (g1 * trace) / MM;
    const eta2 = g1 / a2;
    const g2 = Math.max(eta2 - g1, 1e-9);
    for (let ch = 0; ch < 3; ch++) {
      const x2c = x2[ch] as Float64Array;
      const r1c = r1[ch] as Float64Array;
      const r2c = r2[ch] as Float64Array;
      for (let i = 0; i < MM; i++) r2c[i] = (eta2 * (x2c[i] as number) - g1 * (r1c[i] as number)) / g2;
    }
    // Denoiser: discrete posterior per unknown cell under r₂ ~ N(x, 1/γ₂).
    let vsum = 0;
    for (let ch = 0; ch < 3; ch++) (x1[ch] as Float64Array).fill(0);
    for (let j = 0; j < count; j++) {
      for (let q = 0; q < 4; q++) {
        const p = idx[j * 4 + q] as number;
        for (let ch = 0; ch < 3; ch++) rr[q * 3 + ch] = (r2[ch] as Float64Array)[p] as number;
      }
      let best = Infinity;
      let second = Infinity;
      let bestSym = 0;
      for (let sy = 0; sy < S; sy++) {
        let dot = 0;
        const xo = sy * 12;
        for (let i = 0; i < 12; i++) dot += (X[xo + i] as number) * (rr[i] as number);
        const v = 0.5 * g2 * ((xx[sy] as number) - 2 * dot);
        scores[sy] = v;
        if (v < best) {
          second = best;
          best = v;
          bestSym = sy;
        } else if (v < second) {
          second = v;
        }
      }
      sym[j] = bestSym;
      margin[j] = second - best;
      let z = 0;
      const mu = rr; // reuse as accumulator after reading
      const m1 = new Float64Array(12);
      const m2 = new Float64Array(12);
      for (let sy = 0; sy < S; sy++) {
        const d = (scores[sy] as number) - best;
        if (d > 30) continue;
        const w = Math.exp(-d);
        z += w;
        const xo = sy * 12;
        for (let i = 0; i < 12; i++) {
          const v = X[xo + i] as number;
          m1[i] = (m1[i] as number) + w * v;
          m2[i] = (m2[i] as number) + w * v * v;
        }
      }
      for (let i = 0; i < 12; i++) {
        const mm = (m1[i] as number) / z;
        mu[i] = mm;
        vsum += Math.max((m2[i] as number) / z - mm * mm, 0);
      }
      for (let q = 0; q < 4; q++) {
        const p = idx[j * 4 + q] as number;
        for (let ch = 0; ch < 3; ch++) (x1[ch] as Float64Array)[p] = mu[q * 3 + ch] as number;
      }
    }
    if (opts.onIteration && opts.onIteration(it, sym, margin)) break;
    if (it === opts.iterations - 1) break;
    // Average posterior variance over all components (known ones have zero variance).
    let a1 = Math.max(1e-6, (g2 * vsum) / (MM * 3));
    void knownFraction;
    if (it > 0) {
      const d = opts.damping;
      for (let ch = 0; ch < 3; ch++) {
        const x1c = x1[ch] as Float64Array;
        const xp = x1prev[ch] as Float64Array;
        for (let i = 0; i < MM; i++) x1c[i] = d * (x1c[i] as number) + (1 - d) * (xp[i] as number);
      }
      a1 = d * a1 + (1 - d) * a1prev;
    }
    for (let ch = 0; ch < 3; ch++) (x1prev[ch] as Float64Array).set(x1[ch] as Float64Array);
    a1prev = a1;
    const eta1 = g2 / a1;
    const g1n = Math.max(eta1 - g2, 1e-6);
    for (let ch = 0; ch < 3; ch++) {
      const x1c = x1[ch] as Float64Array;
      const r2c = r2[ch] as Float64Array;
      const r1c = r1[ch] as Float64Array;
      for (let i = 0; i < MM; i++) r1c[i] = (eta1 * (x1c[i] as number) - g2 * (r2c[i] as number)) / g1n;
    }
    g1 = g1n;
  }
  void work;
  return { sym, margin, iterations: iterationsRun };
}
