//! Joint symbol detection for grid frames (spec §7.6 step 6) by expectation propagation (EP) over the blur
//! channel. Port of `packages/core/src/facet/equalize.ts`.
//!
//! Observation model (`model.rs`): features f = W x + n, where x holds every cell's quadrant sources (linear
//! excess over the background, 4 quadrants × RGB) and W is the separable Gaussian-blur operator. A data cell's
//! source is x_c = fill_s ⊗ c_k for glyph s and calibrated palette centroid k (spec §7.4). EP treats the frame
//! jointly:
//!
//!   1. Gaussian stage: with a Gaussian prior N(m, diag v) per source component, the posterior mean solves
//!      (WᵀW + σ² V⁻¹) μ = Wᵀy + σ² V⁻¹ m — a sparse SPD system, solved by block-Jacobi-preconditioned
//!      conjugate gradients with a warm start (a few iterations per EP round).
//!   2. Extrinsic per cell: removing the cell's own prior from the Gaussian posterior gives the matched-filter
//!      statistic b_c = M_c μ_c + σ² V_c⁻¹ (μ_c − m_c) (M_c = (WᵀW)_cc), whose likelihood for symbol x is
//!      exp(−(xᵀM_c x − 2xᵀb_c)/2σ²).
//!   3. Discrete posterior: score every symbol with that likelihood, decide, and moment-match the posterior into
//!      the next round's Gaussian prior (m, v), damped.
//!
//! Storage mirrors the JavaScript typed arrays (`f32` iterates, `f64` accumulators) so results stay identical.

use crate::glyphs::glyph_fills;
use crate::model::{NormalOperator, ResponseModel, adjoint_features};

/// One EP detection problem over the residual features of a frame.
#[derive(Clone, Copy, Debug)]
pub struct EpProblem<'a> {
    pub n: usize,
    pub model: &'a ResponseModel,
    /// Residual features after subtracting every known source (`n² × 12`), NaN-free.
    pub y: &'a [f32],
    /// Cells (grid indices) whose sources are unknown.
    pub cells: &'a [u32],
    /// Spread Gram matrices per edge class (classes × 16) and the class of every grid cell.
    pub grams: &'a [f64],
    pub classes: &'a [u8],
    /// Palette centroids (K × 3).
    pub centroids: &'a [f32],
    /// Noise variance per feature component (units of y²).
    pub noise_variance: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EpOptions<'a> {
    pub rounds: usize,
    /// Conjugate-gradient iterations per round; the last entry repeats (round 0 needs the most: no warm start).
    /// An empty list means 8 per round.
    pub cg_iterations: &'a [usize],
    /// CG iteration counts within round 0 at which hard decisions are produced early (without updating the
    /// prior) and offered to the round callback; easy frames (low blur) decode at the first checkpoint.
    pub checkpoints: &'a [usize],
    /// Weight of the new moments when updating the prior (1 = no damping).
    pub damping: f64,
    /// Floor of the per-component prior variance (keeps the system well conditioned once beliefs are sharp).
    pub min_variance: f64,
    /// Conjugate gradients stop once the preconditioned residual falls below this fraction of the first round's
    /// initial residual (well-conditioned, low-blur frames converge in a few iterations).
    pub cg_tolerance: f64,
}

pub const DEFAULT_EP_OPTIONS: EpOptions<'static> = EpOptions {
    rounds: 6,
    cg_iterations: &[24, 10],
    checkpoints: &[],
    damping: 0.5,
    min_variance: 1e-6,
    cg_tolerance: 1e-6,
};

/// Called after each round (and at round-0 checkpoints, with round = −1) with the hard decisions and margins
/// (indexed like `cells`); return true to stop (for example once the inner code decodes).
pub type RoundCallback<'a> = dyn FnMut(i32, &[u8], &[f32]) -> bool + 'a;

#[derive(Clone, Debug, PartialEq)]
pub struct EpResult {
    /// Hard decisions (color · 16 + shape), indexed like `cells`.
    pub sym: Vec<u8>,
    /// Score gap between the two best symbols (log-likelihood units).
    pub margin: Vec<f32>,
    /// Extrinsic matched-filter statistics of the last round, b / σ² (count × 12): the per-capture sufficient
    /// statistic for temporal fusion.
    pub stats: Vec<f32>,
    pub rounds: usize,
}

/// Symbol table `X[sym][q * 3 + ch]` for K colors (S = 16 K symbols).
fn symbol_table(centroids: &[f32], fills: &[f32]) -> Vec<f32> {
    let k_n = centroids.len() / 3;
    let s_n = k_n * 16;
    let mut x = vec![0f32; s_n * 12];
    for sy in 0..s_n {
        let k = sy >> 4;
        let sh = sy & 15;
        for q in 0..4 {
            for ch in 0..3 {
                x[sy * 12 + q * 3 + ch] =
                    (fills[sh * 4 + q] as f64 * centroids[k * 3 + ch] as f64) as f32;
            }
        }
    }
    x
}

/// Per-class quadratic terms `xᵀ M x` for every symbol: `quad[cls * S + sy]`.
fn quadratic_terms(grams: &[f64], x: &[f32], s_n: usize) -> Vec<f64> {
    let class_count = grams.len() / 16;
    let mut quad = vec![0f64; class_count * s_n];
    for cls in 0..class_count {
        for sy in 0..s_n {
            let xs = &x[sy * 12..sy * 12 + 12];
            let mut v = 0f64;
            for a in 0..4 {
                for b2 in 0..4 {
                    let g = grams[cls * 16 + a * 4 + b2];
                    for ch in 0..3 {
                        v += xs[a * 3 + ch] as f64 * g * xs[b2 * 3 + ch] as f64;
                    }
                }
            }
            quad[cls * s_n + sy] = v;
        }
    }
    quad
}

/// Runs EP detection. `None` if the problem's buffers disagree with `n` or a cell/class index is out of range.
pub fn ep_detect(
    problem: &EpProblem<'_>,
    opts: &EpOptions<'_>,
    mut on_round: Option<&mut RoundCallback<'_>>,
) -> Option<EpResult> {
    let n = problem.n;
    let total = n * n;
    let big_n = total * 12;
    let y = problem.y;
    let cells = problem.cells;
    let grams = problem.grams;
    let classes = problem.classes;
    let centroids = problem.centroids;
    let count = cells.len();
    let k_n = centroids.len() / 3;
    let s_n = k_n * 16;
    let class_count = grams.len() / 16;
    if y.len() != big_n || classes.len() < total || k_n == 0 {
        return None;
    }
    if cells.iter().any(|&c| {
        let c = c as usize;
        c >= total || classes[c] as usize >= class_count
    }) {
        return None;
    }
    let s2 = problem.noise_variance.max(1e-12);
    let fills = glyph_fills(k_n);
    let x = symbol_table(centroids, fills);
    let quad = quadratic_terms(grams, &x, s_n);

    // Uniform symbol prior moments on unknown cells; the Gaussian system is restricted to those cells.
    let mut mask = vec![0u8; big_n];
    for &c in cells {
        let c = c as usize;
        mask[c * 12..c * 12 + 12].fill(1);
    }
    let mut m_pri = vec![0f32; big_n];
    let mut v_pri = vec![1f32; big_n];
    {
        let mut m0 = [0f64; 12];
        let mut q0 = [0f64; 12];
        for sy in 0..s_n {
            for i in 0..12 {
                let v = x[sy * 12 + i] as f64;
                m0[i] += v / s_n as f64;
                q0[i] += (v * v) / s_n as f64;
            }
        }
        for &c in cells {
            let c = c as usize;
            for i in 0..12 {
                m_pri[c * 12 + i] = m0[i] as f32;
                v_pri[c * 12 + i] = (q0[i] - m0[i] * m0[i]).max(opts.min_variance) as f32;
            }
        }
    }
    // Block-Jacobi preconditioner: per unknown cell and channel, the inverse of the 4 × 4 diagonal block
    // M_c + diag(reg) of the normal matrix (intra-cell quadrant coupling is the worst-conditioned part of WᵀW).
    let mut block_inv = vec![0f32; count * 3 * 16];
    let mut reg = vec![0f32; big_n];
    let mut wtw = NormalOperator::new(problem.model, n);
    let mut adj_buf = vec![0f32; big_n];
    let mut aty = adjoint_features(problem.model, y, n).ok()?;
    for (a, &m) in aty.iter_mut().zip(&mask) {
        if m == 0 {
            *a = 0.0;
        }
    }

    // μ starts at the prior mean on unknown cells and zero elsewhere.
    let mut mu = m_pri.clone();
    let mut rhs = vec![0f32; big_n];
    let mut r = vec![0f32; big_n];
    let mut z = vec![0f32; big_n];
    let mut p = vec![0f32; big_n];
    let mut ap = vec![0f32; big_n];
    let mut sym = vec![0u8; count];
    let mut margin = vec![0f32; count];
    let mut stats = vec![0f32; count * 12];
    let mut scores = vec![0f64; s_n];
    let mut rounds_run = 0usize;
    let mut rz_ref = 0f64;
    let mut dots = vec![0f64; 4 * k_n];
    let mut wf = vec![0f64; 4 * k_n];
    let mut wf2 = vec![0f64; 4 * k_n];

    for round in 0..opts.rounds {
        rounds_run = round + 1;
        // 1. Gaussian stage.
        for i in 0..big_n {
            if mask[i] == 0 {
                continue;
            }
            reg[i] = (s2 / v_pri[i] as f64) as f32;
            rhs[i] = (aty[i] as f64 + reg[i] as f64 * m_pri[i] as f64) as f32;
        }
        build_preconditioner(cells, classes, grams, &reg, &mut block_inv);
        normal_op(&mut wtw, &mask, &reg, &mu, &mut adj_buf, &mut ap)?;
        for i in 0..big_n {
            r[i] = if mask[i] != 0 {
                (rhs[i] as f64 - ap[i] as f64) as f32
            } else {
                0.0
            };
        }
        apply_preconditioner(cells, &block_inv, &r, &mut z);
        let mut rz = 0f64;
        for i in 0..big_n {
            p[i] = z[i];
            rz += r[i] as f64 * z[i] as f64;
        }
        if round == 0 {
            rz_ref = rz;
        }
        let stop = (rz_ref * opts.cg_tolerance).max(1e-30);
        let cg_iterations = opts
            .cg_iterations
            .get(round.min(opts.cg_iterations.len().saturating_sub(1)))
            .copied()
            .unwrap_or(8);
        let checkpoints: &[usize] = if round == 0 { opts.checkpoints } else { &[] };
        let mut stopped = false;
        let mut it = 0usize;
        while it < cg_iterations && rz > stop {
            if checkpoints.contains(&it)
                && let Some(cb) = on_round.as_deref_mut()
            {
                score(
                    &ScoreInputs {
                        cells,
                        classes,
                        grams,
                        reg: &reg,
                        mu: &mu,
                        fills,
                        centroids,
                        quad: &quad,
                        s2,
                        min_variance: opts.min_variance,
                    },
                    1.0,
                    false,
                    &mut ScoreState {
                        m_pri: &mut m_pri,
                        v_pri: &mut v_pri,
                        sym: &mut sym,
                        margin: &mut margin,
                        stats: &mut stats,
                        scores: &mut scores,
                        dots: &mut dots,
                        wf: &mut wf,
                        wf2: &mut wf2,
                    },
                );
                if cb(-1, &sym, &margin) {
                    stopped = true;
                    break;
                }
            }
            normal_op(&mut wtw, &mask, &reg, &p, &mut adj_buf, &mut ap)?;
            let mut pap = 0f64;
            for i in 0..big_n {
                pap += p[i] as f64 * ap[i] as f64;
            }
            if pap.is_nan() || pap <= 0.0 {
                break;
            }
            let alpha = rz / pap;
            for i in 0..big_n {
                mu[i] = (mu[i] as f64 + alpha * p[i] as f64) as f32;
                r[i] = (r[i] as f64 - alpha * ap[i] as f64) as f32;
            }
            apply_preconditioner(cells, &block_inv, &r, &mut z);
            let mut rz_new = 0f64;
            for i in 0..big_n {
                rz_new += r[i] as f64 * z[i] as f64;
            }
            let beta = rz_new / rz;
            rz = rz_new;
            for i in 0..big_n {
                p[i] = (z[i] as f64 + beta * p[i] as f64) as f32;
            }
            it += 1;
        }
        if stopped {
            break;
        }
        // 2–3. Extrinsic statistic, symbol posterior, moment matching.
        score(
            &ScoreInputs {
                cells,
                classes,
                grams,
                reg: &reg,
                mu: &mu,
                fills,
                centroids,
                quad: &quad,
                s2,
                min_variance: opts.min_variance,
            },
            if round == 0 { 1.0 } else { opts.damping },
            true,
            &mut ScoreState {
                m_pri: &mut m_pri,
                v_pri: &mut v_pri,
                sym: &mut sym,
                margin: &mut margin,
                stats: &mut stats,
                scores: &mut scores,
                dots: &mut dots,
                wf: &mut wf,
                wf2: &mut wf2,
            },
        );
        if let Some(cb) = on_round.as_deref_mut()
            && cb(round as i32, &sym, &margin)
        {
            break;
        }
    }
    Some(EpResult {
        sym,
        margin,
        stats,
        rounds: rounds_run,
    })
}

/// `out = (WᵀW + diag(reg)) x` on unknown components, zero elsewhere (x is zero outside unknown cells, so WᵀW x
/// restricted to them is the normal operator).
fn normal_op(
    wtw: &mut NormalOperator,
    mask: &[u8],
    reg: &[f32],
    x: &[f32],
    adj_buf: &mut [f32],
    out: &mut [f32],
) -> Option<()> {
    wtw.apply(x, adj_buf).ok()?;
    for i in 0..out.len() {
        out[i] = if mask[i] != 0 {
            (adj_buf[i] as f64 + reg[i] as f64 * x[i] as f64) as f32
        } else {
            0.0
        };
    }
    Some(())
}

fn build_preconditioner(
    cells: &[u32],
    classes: &[u8],
    grams: &[f64],
    reg: &[f32],
    block_inv: &mut [f32],
) {
    let mut blk = [0f64; 16];
    let mut inv = [0f64; 16];
    for (j, &c) in cells.iter().enumerate() {
        let c = c as usize;
        let mo = classes[c] as usize * 16;
        for ch in 0..3 {
            blk.copy_from_slice(&grams[mo..mo + 16]);
            for q in 0..4 {
                blk[q * 5] += reg[c * 12 + q * 3 + ch] as f64;
            }
            invert4(&blk, &mut inv);
            let o = (j * 3 + ch) * 16;
            for (dst, &v) in block_inv[o..o + 16].iter_mut().zip(&inv) {
                *dst = v as f32;
            }
        }
    }
}

fn apply_preconditioner(cells: &[u32], block_inv: &[f32], rv: &[f32], out: &mut [f32]) {
    for (j, &c) in cells.iter().enumerate() {
        let co = c as usize * 12;
        for ch in 0..3 {
            let b = &block_inv[(j * 3 + ch) * 16..(j * 3 + ch) * 16 + 16];
            let r0 = rv[co + ch] as f64;
            let r1 = rv[co + 3 + ch] as f64;
            let r2 = rv[co + 6 + ch] as f64;
            let r3 = rv[co + 9 + ch] as f64;
            for a in 0..4 {
                out[co + a * 3 + ch] = (b[a * 4] as f64 * r0
                    + b[a * 4 + 1] as f64 * r1
                    + b[a * 4 + 2] as f64 * r2
                    + b[a * 4 + 3] as f64 * r3) as f32;
            }
        }
    }
}

struct ScoreInputs<'a> {
    cells: &'a [u32],
    classes: &'a [u8],
    grams: &'a [f64],
    reg: &'a [f32],
    mu: &'a [f32],
    fills: &'a [f32],
    centroids: &'a [f32],
    quad: &'a [f64],
    s2: f64,
    min_variance: f64,
}

struct ScoreState<'a> {
    m_pri: &'a mut [f32],
    v_pri: &'a mut [f32],
    sym: &'a mut [u8],
    margin: &'a mut [f32],
    stats: &'a mut [f32],
    scores: &'a mut [f64],
    dots: &'a mut [f64],
    wf: &'a mut [f64],
    wf2: &'a mut [f64],
}

/// Extrinsic statistics and hard decisions from the current μ; with `update`, moment-matches the prior.
fn score(inp: &ScoreInputs<'_>, damp: f64, update: bool, st: &mut ScoreState<'_>) {
    let k_n = inp.centroids.len() / 3;
    let s_n = k_n * 16;
    let inv2s2 = 1.0 / (2.0 * inp.s2);
    let mut b = [0f64; 12];
    for (j, &c) in inp.cells.iter().enumerate() {
        let c = c as usize;
        let mo = inp.classes[c] as usize * 16;
        let co = c * 12;
        for a in 0..4 {
            for ch in 0..3 {
                let mut acc = 0f64;
                for k in 0..4 {
                    acc += inp.grams[mo + a * 4 + k] * inp.mu[co + k * 3 + ch] as f64;
                }
                let i = co + a * 3 + ch;
                let v = acc + inp.reg[i] as f64 * (inp.mu[i] as f64 - st.m_pri[i] as f64);
                b[a * 3 + ch] = v;
                st.stats[j * 12 + a * 3 + ch] = (v / inp.s2) as f32;
            }
        }
        // xᵀb for x = f ⊗ c_k is Σ_q f[q] · (c_k · b_q): precompute the 4 × K color projections.
        for q in 0..4 {
            let b0 = b[q * 3];
            let b1 = b[q * 3 + 1];
            let b2 = b[q * 3 + 2];
            for k in 0..k_n {
                st.dots[q * k_n + k] = b0 * inp.centroids[k * 3] as f64
                    + b1 * inp.centroids[k * 3 + 1] as f64
                    + b2 * inp.centroids[k * 3 + 2] as f64;
            }
        }
        let mut best = f64::INFINITY;
        let mut second = f64::INFINITY;
        let mut best_sym = 0usize;
        let qo = inp.classes[c] as usize * s_n;
        for sh in 0..16 {
            let f0 = inp.fills[sh * 4] as f64;
            let f1 = inp.fills[sh * 4 + 1] as f64;
            let f2 = inp.fills[sh * 4 + 2] as f64;
            let f3 = inp.fills[sh * 4 + 3] as f64;
            for k in 0..k_n {
                let sy = k * 16 + sh;
                let cross = f0 * st.dots[k]
                    + f1 * st.dots[k_n + k]
                    + f2 * st.dots[2 * k_n + k]
                    + f3 * st.dots[3 * k_n + k];
                let v = (inp.quad[qo + sy] - 2.0 * cross) * inv2s2;
                st.scores[sy] = v;
                if v < best {
                    second = best;
                    best = v;
                    best_sym = sy;
                } else if v < second {
                    second = v;
                }
            }
        }
        st.sym[j] = best_sym as u8;
        st.margin[j] = (second - best) as f32;
        if !update {
            continue;
        }
        // Posterior moments of x = f ⊗ c_k: E[x_q,ch] = Σ_k c_k,ch Σ_s w f_s,q, E[x²] = Σ_k c_k,ch² Σ_s w f_s,q².
        st.wf.fill(0.0);
        st.wf2.fill(0.0);
        let mut zsum = 0f64;
        for sy in 0..s_n {
            let d = st.scores[sy] - best;
            if d > 25.0 {
                continue;
            }
            let w = (-d).exp();
            zsum += w;
            let k = sy >> 4;
            let fo = (sy & 15) * 4;
            for q in 0..4 {
                let f = inp.fills[fo + q] as f64;
                st.wf[q * k_n + k] += w * f;
                st.wf2[q * k_n + k] += w * f * f;
            }
        }
        let iz = 1.0 / zsum;
        for q in 0..4 {
            for ch in 0..3 {
                let mut m = 0f64;
                let mut m2 = 0f64;
                for k in 0..k_n {
                    let ck = inp.centroids[k * 3 + ch] as f64;
                    m += ck * st.wf[q * k_n + k];
                    m2 += ck * ck * st.wf2[q * k_n + k];
                }
                m *= iz;
                let v = (m2 * iz - m * m).max(inp.min_variance);
                let idx = co + q * 3 + ch;
                st.m_pri[idx] = (damp * m + (1.0 - damp) * st.m_pri[idx] as f64) as f32;
                st.v_pri[idx] = (damp * v + (1.0 - damp) * st.v_pri[idx] as f64) as f32;
            }
        }
    }
}

/// Hard decisions from fused sufficient statistics.
#[derive(Clone, Debug, PartialEq)]
pub struct StatsDecisions {
    pub sym: Vec<u8>,
    pub margin: Vec<f32>,
}

/// Hard decisions from fused sufficient statistics (temporal fusion, spec §7.6 step 8): Σ b/σ² over captures
/// and the per-class Gram sums Σ M/σ². Indexed like the statistics (count × 12) with `entry_classes[j]` the edge
/// class of entry j. `None` if `stats` is shorter than `12 × count` or a class index is out of range.
pub fn detect_from_stats(
    stats: &[f32],
    gram_sums: &[f64],
    entry_classes: &[u8],
    centroids: &[f32],
) -> Option<StatsDecisions> {
    let count = entry_classes.len();
    let k_n = centroids.len() / 3;
    let s_n = k_n * 16;
    let class_count = gram_sums.len() / 16;
    if stats.len() < count * 12 || entry_classes.iter().any(|&c| c as usize >= class_count) {
        return None;
    }
    let fills = glyph_fills(k_n);
    let x = symbol_table(centroids, fills);
    let quad = quadratic_terms(gram_sums, &x, s_n);
    let mut sym = vec![0u8; count];
    let mut margin = vec![0f32; count];
    for (j, &cls) in entry_classes.iter().enumerate() {
        let mut best = f64::INFINITY;
        let mut second = f64::INFINITY;
        let mut best_sym = 0usize;
        let qo = cls as usize * s_n;
        let sj = &stats[j * 12..j * 12 + 12];
        for sy in 0..s_n {
            let mut cross = 0f64;
            for (xv, sv) in x[sy * 12..sy * 12 + 12].iter().zip(sj) {
                cross += *xv as f64 * *sv as f64;
            }
            let v = 0.5 * quad[qo + sy] - cross;
            if v < best {
                second = best;
                best = v;
                best_sym = sy;
            } else if v < second {
                second = v;
            }
        }
        sym[j] = best_sym as u8;
        margin[j] = (second - best) as f32;
    }
    Some(StatsDecisions { sym, margin })
}

/// Inverse of a symmetric positive-definite 4 × 4 matrix (Gauss–Jordan; the blocks here are well conditioned).
fn invert4(m: &[f64; 16], out: &mut [f64; 16]) {
    let mut a = [0f64; 32];
    for r in 0..4 {
        a[r * 8..r * 8 + 4].copy_from_slice(&m[r * 4..r * 4 + 4]);
        a[r * 8 + 4 + r] = 1.0;
    }
    for col in 0..4 {
        let mut piv = col;
        for r in col + 1..4 {
            if a[r * 8 + col].abs() > a[piv * 8 + col].abs() {
                piv = r;
            }
        }
        if piv != col {
            for c in 0..8 {
                a.swap(col * 8 + c, piv * 8 + c);
            }
        }
        let d = a[col * 8 + col];
        let inv = if d.abs() > 1e-300 { 1.0 / d } else { 0.0 };
        for c in 0..8 {
            a[col * 8 + c] *= inv;
        }
        for r in 0..4 {
            if r == col {
                continue;
            }
            let f = a[r * 8 + col];
            if f == 0.0 {
                continue;
            }
            for c in 0..8 {
                a[r * 8 + c] -= f * a[col * 8 + c];
            }
        }
    }
    for r in 0..4 {
        out[r * 4..r * 4 + 4].copy_from_slice(&a[r * 8 + 4..r * 8 + 8]);
    }
}
