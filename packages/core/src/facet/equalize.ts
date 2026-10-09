/**
 * Joint symbol detection for grid frames (spec §7.6 step 6) by expectation propagation (EP) over the blur channel.
 *
 * Observation model (model.ts): features f = W x + n, where x holds every cell's quadrant sources (linear excess
 * over the background, 4 quadrants × RGB) and W is the separable Gaussian-blur operator. A data cell's source is
 * x_c = fill_s ⊗ c_k for glyph s and calibrated palette centroid k (spec §7.4). Under camera blur of σ ≈ 0.5 cell
 * most of a glyph's shape energy lands in its neighbors, so per-cell detection — even with decision-feedback
 * cancellation — is interference-limited and gets trapped by its own early mistakes. EP treats the frame jointly:
 *
 *   1. Gaussian stage: with a Gaussian prior N(m, diag v) per source component, the posterior mean
 *        μ = argmin ‖y − Wx‖²/σ² + Σ (x − m)²/v
 *      solves (WᵀW + σ² V⁻¹) μ = Wᵀy + σ² V⁻¹ m — a sparse SPD system, solved by Jacobi-preconditioned conjugate
 *      gradients with a warm start (a few iterations per EP round).
 *   2. Extrinsic per cell: removing the cell's own prior from the Gaussian posterior gives the matched-filter
 *      statistic b_c = M_c μ_c + σ² V_c⁻¹ (μ_c − m_c) (M_c = (WᵀW)_cc), whose likelihood for symbol x is
 *      exp(−(xᵀM_c x − 2xᵀb_c)/2σ²).
 *   3. Discrete posterior: score every symbol with that likelihood, decide, and moment-match the posterior into the
 *      next round's Gaussian prior (m, v), damped.
 *
 * The 4 × 4 quadrant coupling inside a cell is handled exactly in step 2; the Gaussian stage uses a diagonal prior
 * per component, the standard EP approximation.
 */
import { glyphFills } from "./glyphs";
import { adjointFeatures, NormalOperator, type ResponseModel } from "./model";

const operatorCache = new Map<string, NormalOperator>();
/** Normal operators are pure functions of (σ, n); cache a few (one per tier and calibration). */
function normalOperator(model: ResponseModel, n: number): NormalOperator {
  const key = `${model.sigma}/${n}`;
  let op = operatorCache.get(key);
  if (!op) {
    op = new NormalOperator(model, n);
    operatorCache.set(key, op);
    if (operatorCache.size > 8) {
      const first = operatorCache.keys().next().value;
      if (first !== undefined && first !== key) operatorCache.delete(first);
    }
  }
  return op;
}

export interface EpProblem {
  readonly n: number;
  readonly model: ResponseModel;
  /** Residual features after subtracting every known source (n² × 12), NaN-free. */
  readonly y: Float32Array;
  /** Cells (grid indices) whose sources are unknown. */
  readonly cells: Int32Array;
  /** Spread Gram matrices per edge class (classes × 16) and the class of every grid cell. */
  readonly grams: Float64Array;
  readonly classes: Uint8Array;
  /** Palette centroids (K × 3). */
  readonly centroids: Float32Array;
  /** Noise variance per feature component (units of y²). */
  readonly noiseVariance: number;
}

export interface EpOptions {
  readonly rounds: number;
  /** Conjugate-gradient iterations per round; the last entry repeats (round 0 needs the most: no warm start). */
  readonly cgIterations: readonly number[];
  /**
   * CG iteration counts within round 0 at which hard decisions are produced early (without updating the prior) and
   * offered to `onRound`; easy frames (low blur) decode at the first checkpoint.
   */
  readonly checkpoints?: readonly number[];
  /** Weight of the new moments when updating the prior (1 = no damping). */
  readonly damping: number;
  /** Floor of the per-component prior variance (keeps the system well conditioned once beliefs are sharp). */
  readonly minVariance: number;
  /**
   * Conjugate gradients stop once the preconditioned residual falls below this fraction of the first round's
   * initial residual (well-conditioned, low-blur frames converge in a few iterations).
   */
  readonly cgTolerance: number;
  /**
   * Called after each round (and at round-0 checkpoints, with round = −1) with the hard decisions and margins
   * (indexed like `cells`); return true to stop (for example once the inner code decodes).
   */
  readonly onRound?: (round: number, sym: Uint8Array, margin: Float32Array) => boolean;
}

export const DEFAULT_EP_OPTIONS: EpOptions = { rounds: 6, cgIterations: [24, 10], damping: 0.5, minVariance: 1e-6, cgTolerance: 1e-6 };

export interface EpResult {
  /** Hard decisions (color · 16 + shape), indexed like `cells`. */
  readonly sym: Uint8Array;
  /** Score gap between the two best symbols (log-likelihood units). */
  readonly margin: Float32Array;
  /**
   * Extrinsic matched-filter statistics of the last round, b / σ² (count × 12): the per-capture sufficient
   * statistic for temporal fusion.
   */
  readonly stats: Float32Array;
  readonly rounds: number;
}

export function epDetect(problem: EpProblem, opts: EpOptions = DEFAULT_EP_OPTIONS): EpResult {
  const { n, model, y, cells, grams, classes, centroids } = problem;
  const count = cells.length;
  const K = centroids.length / 3;
  const S = K * 16;
  const s2 = Math.max(problem.noiseVariance, 1e-12);
  const N = n * n * 12;
  const fills = glyphFills(K);

  // Symbol table X[sym][q * 3 + ch] and per-class quadratic terms xᵀ M x.
  const X = new Float32Array(S * 12);
  for (let sy = 0; sy < S; sy++) {
    const k = sy >> 4;
    const sh = sy & 15;
    for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) X[sy * 12 + q * 3 + ch] = (fills[sh * 4 + q] as number) * (centroids[k * 3 + ch] as number);
  }
  const classCount = grams.length / 16;
  const quad = new Float64Array(classCount * S);
  for (let cls = 0; cls < classCount; cls++) {
    for (let sy = 0; sy < S; sy++) {
      let v = 0;
      for (let a = 0; a < 4; a++) {
        for (let b2 = 0; b2 < 4; b2++) {
          const g = grams[cls * 16 + a * 4 + b2] as number;
          for (let ch = 0; ch < 3; ch++) v += (X[sy * 12 + a * 3 + ch] as number) * g * (X[sy * 12 + b2 * 3 + ch] as number);
        }
      }
      quad[cls * S + sy] = v;
    }
  }

  // Uniform symbol prior moments on unknown cells; the Gaussian system is restricted to those cells.
  const unknown = new Uint8Array(n * n);
  for (let i = 0; i < count; i++) unknown[cells[i] as number] = 1;
  const mask = new Uint8Array(N);
  for (let c = 0; c < n * n; c++) if (unknown[c]) mask.fill(1, c * 12, c * 12 + 12);
  const mPri = new Float32Array(N);
  const vPri = new Float32Array(N).fill(1);
  {
    const m0 = new Float64Array(12);
    const q0 = new Float64Array(12);
    for (let sy = 0; sy < S; sy++) {
      for (let i = 0; i < 12; i++) {
        const v = X[sy * 12 + i] as number;
        m0[i] = (m0[i] as number) + v / S;
        q0[i] = (q0[i] as number) + (v * v) / S;
      }
    }
    for (let j = 0; j < count; j++) {
      const c = cells[j] as number;
      for (let i = 0; i < 12; i++) {
        mPri[c * 12 + i] = m0[i] as number;
        vPri[c * 12 + i] = Math.max((q0[i] as number) - (m0[i] as number) * (m0[i] as number), opts.minVariance);
      }
    }
  }
  /**
   * Block-Jacobi preconditioner: per unknown cell and channel, the inverse of the 4 × 4 diagonal block
   * M_c + diag(reg) of the normal matrix (intra-cell quadrant coupling is the worst-conditioned part of WᵀW).
   */
  const blockInv = new Float32Array(count * 3 * 16);
  const blk = new Float64Array(16);
  const inv = new Float64Array(16);
  const buildPreconditioner = (): void => {
    for (let j = 0; j < count; j++) {
      const c = cells[j] as number;
      const mo = (classes[c] as number) * 16;
      for (let ch = 0; ch < 3; ch++) {
        for (let a = 0; a < 16; a++) blk[a] = grams[mo + a] as number;
        for (let q = 0; q < 4; q++) blk[q * 5] = (blk[q * 5] as number) + (reg[c * 12 + q * 3 + ch] as number);
        invert4(blk, inv);
        const o = (j * 3 + ch) * 16;
        for (let a = 0; a < 16; a++) blockInv[o + a] = inv[a] as number;
      }
    }
  };
  const applyPreconditioner = (rv: Float32Array, out: Float32Array): void => {
    for (let j = 0; j < count; j++) {
      const co = (cells[j] as number) * 12;
      for (let ch = 0; ch < 3; ch++) {
        const o = (j * 3 + ch) * 16;
        const r0 = rv[co + ch] as number;
        const r1 = rv[co + 3 + ch] as number;
        const r2 = rv[co + 6 + ch] as number;
        const r3 = rv[co + 9 + ch] as number;
        for (let a = 0; a < 4; a++) {
          out[co + a * 3 + ch] = (blockInv[o + a * 4] as number) * r0 + (blockInv[o + a * 4 + 1] as number) * r1 + (blockInv[o + a * 4 + 2] as number) * r2 + (blockInv[o + a * 4 + 3] as number) * r3;
        }
      }
    }
  };

  const wtw = normalOperator(model, n);
  const adjBuf = new Float32Array(N);
  const reg = new Float32Array(N);
  // x is zero outside unknown cells (all CG iterates are), so WᵀW x restricted to them is the normal operator.
  const normalOp = (x: Float32Array, out: Float32Array): void => {
    wtw.apply(x, adjBuf);
    for (let i = 0; i < N; i++) out[i] = mask[i] ? (adjBuf[i] as number) + (reg[i] as number) * (x[i] as number) : 0;
  };
  const aty = adjointFeatures(model, y, n);
  for (let i = 0; i < N; i++) if (!mask[i]) aty[i] = 0;

  // μ starts at the prior mean on unknown cells and zero elsewhere.
  const mu = mPri.slice();
  const rhs = new Float32Array(N);
  const r = new Float32Array(N);
  const z = new Float32Array(N);
  const p = new Float32Array(N);
  const ap = new Float32Array(N);
  const sym = new Uint8Array(count);
  const margin = new Float32Array(count);
  const stats = new Float32Array(count * 12);
  const scores = new Float64Array(S);
  const b = new Float64Array(12);
  let roundsRun = 0;
  let rzRef = 0;

  const dots = new Float64Array(4 * K);
  const wf = new Float64Array(4 * K);
  const wf2 = new Float64Array(4 * K);
  /** Extrinsic statistics and hard decisions from the current μ; with `update`, moment-matches the prior. */
  const score = (damp: number, update: boolean): void => {
    const inv2s2 = 1 / (2 * s2);
    for (let j = 0; j < count; j++) {
      const c = cells[j] as number;
      const mo = (classes[c] as number) * 16;
      const co = c * 12;
      for (let a = 0; a < 4; a++) {
        for (let ch = 0; ch < 3; ch++) {
          let acc = 0;
          for (let k = 0; k < 4; k++) acc += (grams[mo + a * 4 + k] as number) * (mu[co + k * 3 + ch] as number);
          const i = co + a * 3 + ch;
          const v = acc + (reg[i] as number) * ((mu[i] as number) - (mPri[i] as number));
          b[a * 3 + ch] = v;
          stats[j * 12 + a * 3 + ch] = v / s2;
        }
      }
      // xᵀb for x = f ⊗ c_k is Σ_q f[q] · (c_k · b_q): precompute the 4 × K color projections.
      for (let q = 0; q < 4; q++) {
        const b0 = b[q * 3] as number;
        const b1 = b[q * 3 + 1] as number;
        const b2 = b[q * 3 + 2] as number;
        for (let k = 0; k < K; k++) dots[q * K + k] = b0 * (centroids[k * 3] as number) + b1 * (centroids[k * 3 + 1] as number) + b2 * (centroids[k * 3 + 2] as number);
      }
      let best = Infinity;
      let second = Infinity;
      let bestSym = 0;
      const qo = (classes[c] as number) * S;
      for (let sh = 0; sh < 16; sh++) {
        const f0 = fills[sh * 4] as number;
        const f1 = fills[sh * 4 + 1] as number;
        const f2 = fills[sh * 4 + 2] as number;
        const f3 = fills[sh * 4 + 3] as number;
        for (let k = 0; k < K; k++) {
          const sy = k * 16 + sh;
          const cross = f0 * (dots[k] as number) + f1 * (dots[K + k] as number) + f2 * (dots[2 * K + k] as number) + f3 * (dots[3 * K + k] as number);
          const v = ((quad[qo + sy] as number) - 2 * cross) * inv2s2;
          scores[sy] = v;
          if (v < best) {
            second = best;
            best = v;
            bestSym = sy;
          } else if (v < second) {
            second = v;
          }
        }
      }
      sym[j] = bestSym;
      margin[j] = second - best;
      if (!update) continue;
      // Posterior moments of x = f ⊗ c_k: E[x_q,ch] = Σ_k c_k,ch Σ_s w f_s,q, E[x²] = Σ_k c_k,ch² Σ_s w f_s,q².
      wf.fill(0);
      wf2.fill(0);
      let zsum = 0;
      for (let sy = 0; sy < S; sy++) {
        const d = (scores[sy] as number) - best;
        if (d > 25) continue;
        const w = Math.exp(-d);
        zsum += w;
        const k = sy >> 4;
        const fo = (sy & 15) * 4;
        for (let q = 0; q < 4; q++) {
          const f = fills[fo + q] as number;
          wf[q * K + k] = (wf[q * K + k] as number) + w * f;
          wf2[q * K + k] = (wf2[q * K + k] as number) + w * f * f;
        }
      }
      const iz = 1 / zsum;
      for (let q = 0; q < 4; q++) {
        for (let ch = 0; ch < 3; ch++) {
          let m = 0;
          let m2 = 0;
          for (let k = 0; k < K; k++) {
            const ck = centroids[k * 3 + ch] as number;
            m += ck * (wf[q * K + k] as number);
            m2 += ck * ck * (wf2[q * K + k] as number);
          }
          m *= iz;
          const v = Math.max(m2 * iz - m * m, opts.minVariance);
          const idx = co + q * 3 + ch;
          mPri[idx] = damp * m + (1 - damp) * (mPri[idx] as number);
          vPri[idx] = damp * v + (1 - damp) * (vPri[idx] as number);
        }
      }
    }
  };

  for (let round = 0; round < opts.rounds; round++) {
    roundsRun = round + 1;
    // 1. Gaussian stage.
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      reg[i] = s2 / (vPri[i] as number);
      rhs[i] = (aty[i] as number) + (reg[i] as number) * (mPri[i] as number);
    }
    buildPreconditioner();
    normalOp(mu, ap);
    for (let i = 0; i < N; i++) r[i] = mask[i] ? (rhs[i] as number) - (ap[i] as number) : 0;
    applyPreconditioner(r, z);
    let rz = 0;
    for (let i = 0; i < N; i++) {
      p[i] = z[i] as number;
      rz += (r[i] as number) * (z[i] as number);
    }
    if (round === 0) rzRef = rz;
    const stop = Math.max(rzRef * opts.cgTolerance, 1e-30);
    const cgIterations = opts.cgIterations[Math.min(round, opts.cgIterations.length - 1)] ?? 8;
    const checkpoints = round === 0 ? (opts.checkpoints ?? []) : [];
    let stopped = false;
    for (let it = 0; it < cgIterations && rz > stop; it++) {
      if (checkpoints.includes(it) && opts.onRound) {
        score(1, false);
        if (opts.onRound(-1, sym, margin)) {
          stopped = true;
          break;
        }
      }
      normalOp(p, ap);
      let pap = 0;
      for (let i = 0; i < N; i++) pap += (p[i] as number) * (ap[i] as number);
      if (!(pap > 0)) break;
      const alpha = rz / pap;
      for (let i = 0; i < N; i++) {
        mu[i] = (mu[i] as number) + alpha * (p[i] as number);
        r[i] = (r[i] as number) - alpha * (ap[i] as number);
      }
      applyPreconditioner(r, z);
      let rzNew = 0;
      for (let i = 0; i < N; i++) rzNew += (r[i] as number) * (z[i] as number);
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < N; i++) p[i] = (z[i] as number) + beta * (p[i] as number);
    }

    if (stopped) break;
    // 2–3. Extrinsic statistic, symbol posterior, moment matching.
    score(round === 0 ? 1 : opts.damping, true);
    if (opts.onRound && opts.onRound(round, sym, margin)) break;
  }
  return { sym, margin, stats, rounds: roundsRun };
}

/**
 * Hard decisions from fused sufficient statistics (temporal fusion, spec §7.6 step 8): Σ b/σ² over captures and the
 * per-class Gram sums Σ M/σ². Indexed like the statistics (count × 12) with `cellClasses[j]` the edge class of entry j.
 */
export function detectFromStats(stats: Float32Array, gramSums: Float64Array, entryClasses: Uint8Array, centroids: Float32Array): { sym: Uint8Array; margin: Float32Array } {
  const count = entryClasses.length;
  const K = centroids.length / 3;
  const S = K * 16;
  const fills = glyphFills(K);
  const X = new Float32Array(S * 12);
  for (let sy = 0; sy < S; sy++) {
    for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) X[sy * 12 + q * 3 + ch] = (fills[(sy & 15) * 4 + q] as number) * (centroids[(sy >> 4) * 3 + ch] as number);
  }
  const classCount = gramSums.length / 16;
  const quad = new Float64Array(classCount * S);
  for (let cls = 0; cls < classCount; cls++) {
    for (let sy = 0; sy < S; sy++) {
      let v = 0;
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const g = gramSums[cls * 16 + a * 4 + b] as number;
          for (let ch = 0; ch < 3; ch++) v += (X[sy * 12 + a * 3 + ch] as number) * g * (X[sy * 12 + b * 3 + ch] as number);
        }
      }
      quad[cls * S + sy] = v;
    }
  }
  const sym = new Uint8Array(count);
  const margin = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    let best = Infinity;
    let second = Infinity;
    let bestSym = 0;
    const qo = (entryClasses[j] as number) * S;
    for (let sy = 0; sy < S; sy++) {
      let cross = 0;
      for (let i = 0; i < 12; i++) cross += (X[sy * 12 + i] as number) * (stats[j * 12 + i] as number);
      const v = 0.5 * (quad[qo + sy] as number) - cross;
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
  }
  return { sym, margin };
}

/** Inverse of a symmetric positive-definite 4 × 4 matrix (Gauss–Jordan; the blocks here are well conditioned). */
const invertScratch = new Float64Array(32);
function invert4(m: Float64Array, out: Float64Array): void {
  const a = invertScratch;
  a.fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) a[r * 8 + c] = m[r * 4 + c] as number;
    a[r * 8 + 4 + r] = 1;
  }
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r * 8 + col] as number) > Math.abs(a[piv * 8 + col] as number)) piv = r;
    if (piv !== col) {
      for (let c = 0; c < 8; c++) {
        const t = a[col * 8 + c] as number;
        a[col * 8 + c] = a[piv * 8 + c] as number;
        a[piv * 8 + c] = t;
      }
    }
    const d = a[col * 8 + col] as number;
    const inv = Math.abs(d) > 1e-300 ? 1 / d : 0;
    for (let c = 0; c < 8; c++) a[col * 8 + c] = (a[col * 8 + c] as number) * inv;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r * 8 + col] as number;
      if (f === 0) continue;
      for (let c = 0; c < 8; c++) a[r * 8 + c] = (a[r * 8 + c] as number) - f * (a[col * 8 + c] as number);
    }
  }
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = a[r * 8 + 4 + c] as number;
}
