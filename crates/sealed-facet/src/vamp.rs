//! Joint symbol detection for grid frames (spec §7.6 step 6) by vector approximate message passing (VAMP) over
//! the exact blur channel. Port of `packages/core/src/facet/vamp.ts`.
//!
//! Observation model (`model.rs`): every glyph quadrant is a box of half a cell, so the lit sources of an N × N
//! grid form an M × M array (M = 2N) of half-cell boxes per color channel, and the quadrant features form an
//! M × M array of samples. The Gaussian blur is separable, so per channel
//!     F = A X Aᵀ + noise,   A ∈ R^{M×M} (A[2t + qa][2s + qs] = 1-D response of half qs of cell s at half qa of t)
//! and the normal operator AᵀA ⊗ AᵀA has eigenvectors V ⊗ V from the eigendecomposition AᵀA = V Λ Vᵀ. The LMMSE
//! stage of VAMP — (γ_w (AᵀA ⊗ AᵀA) + γ I)⁻¹ — is therefore exact and costs four M × M matrix products per
//! channel.
//!
//! VAMP alternates
//!   1. a denoiser on the extrinsic estimate r₁ (precision γ₁): per data cell, the posterior over the K·16
//!      discrete symbols x = fill_s ⊗ c_k (12-vector: 4 quadrants × RGB);
//!   2. the exact LMMSE estimate given the denoiser's extrinsic output (r₂, γ₂),
//!
//! with damping of the denoiser output.
//!
//! Known cells (anchors, header strips, padding pilots, and cells already fixed by decoded codewords) are
//! subtracted from the observation beforehand; in the residual their sources are exactly zero.

use std::sync::{Arc, Mutex};

use crate::glyphs::glyph_fills;
use crate::model::{ISI_RADIUS, ResponseModel, SPAN};

/// Eigendecomposition of a symmetric matrix: eigenvalues and eigenvectors as columns (row-major `n × n`).
#[derive(Clone, Debug, PartialEq)]
pub struct SymmetricEigen {
    pub values: Vec<f64>,
    pub vectors: Vec<f64>,
}

/// `Math.hypot(a, b)` as V8 computes it (normalize by the larger magnitude, Kahan-summed squares), so the
/// decomposition matches the JavaScript bit for bit.
fn js_hypot(a: f64, b: f64) -> f64 {
    let (aa, ab) = (a.abs(), b.abs());
    if aa == f64::INFINITY || ab == f64::INFINITY {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = aa.max(ab);
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0f64;
    let mut compensation = 0f64;
    for v in [aa, ab] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Eigendecomposition of a symmetric matrix (Householder tridiagonalization + implicit QL), row-major.
/// `None` if `a` holds fewer than `n²` values or the QL iteration does not converge (60 sweeps on one
/// eigenvalue). The algorithm is Numerical Recipes tred2/tqli in 0-based row-major storage; `vectors` ends up
/// holding the eigenvectors as columns.
pub fn symmetric_eigen(a: &[f64], n: usize) -> Option<SymmetricEigen> {
    if a.len() < n * n {
        return None;
    }
    let mut z = a[..n * n].to_vec();
    let mut d = vec![0f64; n];
    let mut e = vec![0f64; n];
    if n == 0 {
        return Some(SymmetricEigen {
            values: d,
            vectors: z,
        });
    }
    for i in (1..n).rev() {
        let l = i - 1;
        let mut h = 0f64;
        let mut scale = 0f64;
        if l > 0 {
            for k in 0..=l {
                scale += z[i * n + k].abs();
            }
            if scale == 0.0 {
                e[i] = z[i * n + l];
            } else {
                for k in 0..=l {
                    let v = z[i * n + k] / scale;
                    z[i * n + k] = v;
                    h += v * v;
                }
                let mut f = z[i * n + l];
                let g = if f >= 0.0 { -h.sqrt() } else { h.sqrt() };
                e[i] = scale * g;
                h -= f * g;
                z[i * n + l] = f - g;
                f = 0.0;
                for j in 0..=l {
                    z[j * n + i] = z[i * n + j] / h;
                    let mut gg = 0f64;
                    for k in 0..=j {
                        gg += z[j * n + k] * z[i * n + k];
                    }
                    for k in j + 1..=l {
                        gg += z[k * n + j] * z[i * n + k];
                    }
                    e[j] = gg / h;
                    f += e[j] * z[i * n + j];
                }
                let hh = f / (h + h);
                for j in 0..=l {
                    let fj = z[i * n + j];
                    let gj = e[j] - hh * fj;
                    e[j] = gj;
                    for k in 0..=j {
                        z[j * n + k] -= fj * e[k] + gj * z[i * n + k];
                    }
                }
            }
        } else {
            e[i] = z[i * n + l];
        }
        d[i] = h;
    }
    d[0] = 0.0;
    e[0] = 0.0;
    for i in 0..n {
        // `if (d[i])`: JavaScript truthiness (NaN and ±0 are false).
        if d[i] != 0.0 && !d[i].is_nan() {
            for j in 0..i {
                let mut g = 0f64;
                for k in 0..i {
                    g += z[i * n + k] * z[k * n + j];
                }
                for k in 0..i {
                    z[k * n + j] -= g * z[k * n + i];
                }
            }
        }
        d[i] = z[i * n + i];
        z[i * n + i] = 1.0;
        for j in 0..i {
            z[j * n + i] = 0.0;
            z[i * n + j] = 0.0;
        }
    }
    // QL with implicit shifts on the tridiagonal (d, e).
    for i in 1..n {
        e[i - 1] = e[i];
    }
    e[n - 1] = 0.0;
    for l in 0..n {
        let mut iter = 0usize;
        loop {
            let mut m = l;
            while m < n - 1 {
                let dd = d[m].abs() + d[m + 1].abs();
                if e[m].abs() <= f64::EPSILON * dd {
                    break;
                }
                m += 1;
            }
            if m == l {
                break;
            }
            if iter == 60 {
                return None;
            }
            iter += 1;
            let mut g = (d[l + 1] - d[l]) / (2.0 * e[l]);
            let mut r = js_hypot(g, 1.0);
            g = d[m] - d[l] + e[l] / (g + if g >= 0.0 { r.abs() } else { -r.abs() });
            let mut s = 1f64;
            let mut c = 1f64;
            let mut p = 0f64;
            let mut i = m as isize - 1;
            let mut underflow = false;
            while i >= l as isize {
                let iu = i as usize;
                let mut f = s * e[iu];
                let b = c * e[iu];
                r = js_hypot(f, g);
                e[iu + 1] = r;
                if r == 0.0 {
                    d[iu + 1] -= p;
                    e[m] = 0.0;
                    underflow = true;
                    break;
                }
                s = f / r;
                c = g / r;
                g = d[iu + 1] - p;
                r = (d[iu] - g) * s + 2.0 * c * b;
                p = s * r;
                d[iu + 1] = g + p;
                g = c * r - b;
                for k in 0..n {
                    f = z[k * n + iu + 1];
                    z[k * n + iu + 1] = s * z[k * n + iu] + c * f;
                    z[k * n + iu] = c * z[k * n + iu] - s * f;
                }
                i -= 1;
            }
            if underflow {
                continue;
            }
            d[l] -= p;
            e[l] = g;
            e[m] = 0.0;
        }
    }
    Some(SymmetricEigen {
        values: d,
        vectors: z,
    })
}

/// Half-cell blur operator of one axis and its normal-matrix eigendecomposition, cached per (σ, N).
#[derive(Clone, Debug, PartialEq)]
pub struct HalfCellOperator {
    /// Blur σ the operator was built for (the cache key, with `n`).
    pub sigma: f64,
    pub n: usize,
    pub m: usize,
    /// A (M × M, row-major): feature half-cell row → source half-cell column.
    pub a: Vec<f64>,
    /// Eigenvectors of AᵀA as columns (M × M, row-major) and the transpose.
    pub v: Vec<f64>,
    pub vt: Vec<f64>,
    pub lambda: Vec<f64>,
}

const OPERATOR_CACHE_SIZE: usize = 6;

/// Operators are pure functions of (σ, n); a few are kept (one per tier and calibration), oldest evicted.
static OPERATOR_CACHE: Mutex<Vec<Arc<HalfCellOperator>>> = Mutex::new(Vec::new());

fn build_half_cell_operator(model: &ResponseModel, n: usize) -> Option<HalfCellOperator> {
    let m = 2 * n;
    let r = ISI_RADIUS as isize;
    let mut a = vec![0f64; m * m];
    for t in 0..n {
        for d in -r..=r {
            let s = t as isize + d;
            if s < 0 || s >= n as isize {
                continue;
            }
            let s = s as usize;
            let di = (d + r) as usize;
            for qa in 0..2 {
                for qs in 0..2 {
                    a[(2 * t + qa) * m + 2 * s + qs] = model.gq[(qa * SPAN + di) * 2 + qs];
                }
            }
        }
    }
    let mut k = vec![0f64; m * m];
    for i in 0..m {
        for j in i..m {
            let mut s = 0f64;
            for row in 0..m {
                s += a[row * m + i] * a[row * m + j];
            }
            k[i * m + j] = s;
            k[j * m + i] = s;
        }
    }
    let SymmetricEigen {
        mut values,
        vectors,
    } = symmetric_eigen(&k, m)?;
    let mut vt = vec![0f64; m * m];
    for i in 0..m {
        for j in 0..m {
            vt[j * m + i] = vectors[i * m + j];
        }
    }
    for v in values.iter_mut() {
        *v = v.max(0.0);
    }
    Some(HalfCellOperator {
        sigma: model.sigma,
        n,
        m,
        a,
        v: vectors,
        vt,
        lambda: values,
    })
}

/// The half-cell operator for `model` and grid size `n`, shared through a small cache. `None` if the
/// eigendecomposition fails.
pub fn half_cell_operator(model: &ResponseModel, n: usize) -> Option<Arc<HalfCellOperator>> {
    let key = model.sigma.to_bits();
    {
        let cache = OPERATOR_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = cache
            .iter()
            .find(|op| op.n == n && op.sigma.to_bits() == key)
        {
            return Some(Arc::clone(hit));
        }
    }
    let op = Arc::new(build_half_cell_operator(model, n)?);
    let mut cache = OPERATOR_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.push(Arc::clone(&op));
    if cache.len() > OPERATOR_CACHE_SIZE {
        cache.remove(0);
    }
    Some(op)
}

/// `out = L · B · R` for M × M row-major matrices (i-k-j loop order for locality).
fn mul3(l: &[f64], b: &[f64], r: &[f64], m: usize, tmp: &mut [f64], out: &mut [f64]) {
    tmp.fill(0.0);
    for i in 0..m {
        let ro = i * m;
        let (lrow, trow) = (&l[ro..ro + m], &mut tmp[ro..ro + m]);
        for (k, &lik) in lrow.iter().enumerate() {
            if lik == 0.0 {
                continue;
            }
            let brow = &b[k * m..k * m + m];
            for (t, &bv) in trow.iter_mut().zip(brow) {
                *t += lik * bv;
            }
        }
    }
    out.fill(0.0);
    for i in 0..m {
        let ro = i * m;
        let (trow, orow) = (&tmp[ro..ro + m], &mut out[ro..ro + m]);
        for (k, &tik) in trow.iter().enumerate() {
            if tik == 0.0 {
                continue;
            }
            let rrow = &r[k * m..k * m + m];
            for (o, &rv) in orow.iter_mut().zip(rrow) {
                *o += tik * rv;
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct VampProblem<'a> {
    pub n: usize,
    pub model: &'a ResponseModel,
    /// Residual features after subtracting every known source (`[cell * 12 + q * 3 + ch]`), NaN-free.
    pub y: &'a [f32],
    /// Cells (grid indices) whose sources are unknown.
    pub cells: &'a [u32],
    /// Palette centroids (K × 3).
    pub centroids: &'a [f32],
    /// Noise variance per feature component.
    pub noise_variance: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VampOptions {
    pub iterations: usize,
    /// Weight of the new denoiser output (1 = no damping).
    pub damping: f64,
}

pub const DEFAULT_VAMP_OPTIONS: VampOptions = VampOptions {
    iterations: 12,
    damping: 0.5,
};

/// Called after each iteration with hard decisions and margins (indexed like `cells`); return true to stop
/// (for example once the inner code decodes).
pub type IterationCallback<'a> = dyn FnMut(usize, &[u8], &[f32]) -> bool + 'a;

#[derive(Clone, Debug, PartialEq)]
pub struct VampResult {
    /// Hard decisions (color · 16 + shape), indexed like `cells`.
    pub sym: Vec<u8>,
    /// Log-likelihood gap between the two best symbols.
    pub margin: Vec<f32>,
    pub iterations: usize,
}

/// Index of feature/source component (cell c, quadrant q) in the per-channel M × M array.
#[inline]
fn half_index(c: usize, q: usize, n: usize) -> usize {
    let x = c % n;
    let y = c / n;
    (2 * y + (q >> 1)) * 2 * n + 2 * x + (q & 1)
}

/// Runs VAMP detection. `None` if the problem's buffers disagree with `n`, a cell index is out of range, the
/// centroid table is empty, or the operator's eigendecomposition fails.
pub fn vamp_detect(
    problem: &VampProblem<'_>,
    opts: &VampOptions,
    mut on_iteration: Option<&mut IterationCallback<'_>>,
) -> Option<VampResult> {
    let n = problem.n;
    let total = n * n;
    let y = problem.y;
    let cells = problem.cells;
    let centroids = problem.centroids;
    let count = cells.len();
    let k_n = centroids.len() / 3;
    let s_n = k_n * 16;
    if y.len() != total * 12 || k_n == 0 || cells.iter().any(|&c| c as usize >= total) {
        return None;
    }
    let op = half_cell_operator(problem.model, n)?;
    let m = op.m;
    let mm = m * m;
    let fills = glyph_fills(k_n);
    let gw = 1.0 / problem.noise_variance.max(1e-12);

    // Symbol table X[sym][q * 3 + ch] and its squared norm.
    let mut x = vec![0f64; s_n * 12];
    let mut xx = vec![0f64; s_n];
    for sy in 0..s_n {
        let mut s2 = 0f64;
        for q in 0..4 {
            for ch in 0..3 {
                let v = fills[(sy & 15) * 4 + q] as f64 * centroids[(sy >> 4) * 3 + ch] as f64;
                x[sy * 12 + q * 3 + ch] = v;
                s2 += v * v;
            }
        }
        xx[sy] = s2;
    }
    // Per-cell index of each of its 4 quadrants in the channel arrays.
    let idx: Vec<usize> = cells
        .iter()
        .flat_map(|&c| (0..4).map(move |q| half_index(c as usize, q, n)))
        .collect();

    // Aᵀy per channel, rotated into the eigenbasis once: Vᵀ (Aᵀ Y A) V.
    let mut tmp = vec![0f64; mm];
    let mut at = vec![0f64; mm];
    for i in 0..m {
        for j in 0..m {
            at[j * m + i] = op.a[i * m + j];
        }
    }
    let mut aty_rot: Vec<Vec<f64>> = Vec::with_capacity(3);
    let mut big_y = vec![0f64; mm];
    let mut aty = vec![0f64; mm];
    for ch in 0..3 {
        big_y.fill(0.0);
        for c in 0..total {
            for q in 0..4 {
                big_y[half_index(c, q, n)] = y[c * 12 + q * 3 + ch] as f64;
            }
        }
        mul3(&at, &big_y, &op.a, m, &mut tmp, &mut aty);
        let mut rot = vec![0f64; mm];
        mul3(&op.vt, &aty, &op.v, m, &mut tmp, &mut rot);
        aty_rot.push(rot);
    }
    let lam = &op.lambda;

    // Prior moments of an unknown component (uniform over symbols).
    let mut mean0 = 0f64;
    let mut var0 = 0f64;
    {
        let mut mu = [0f64; 12];
        let mut sq = [0f64; 12];
        for sy in 0..s_n {
            for i in 0..12 {
                let v = x[sy * 12 + i];
                mu[i] += v / s_n as f64;
                sq[i] += (v * v) / s_n as f64;
            }
        }
        for i in 0..12 {
            mean0 += mu[i] / 12.0;
            var0 += (sq[i] - mu[i] * mu[i]) / 12.0;
        }
    }
    // r1 (per channel, M × M): extrinsic input to the LMMSE stage; known components are 0 and stay 0.
    let mut r1: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    for &p in &idx {
        for r in r1.iter_mut() {
            r[p] = mean0;
        }
    }
    let mut g1 = 1.0 / var0.max(1e-9);

    let mut sym = vec![0u8; count];
    let mut margin = vec![0f32; count];
    let mut x2: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut r2: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut x1: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut x1prev: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut a1prev = 0f64;
    let mut scores = vec![0f64; s_n];
    let mut rr = [0f64; 12];
    let mut brot = vec![0f64; mm];
    let mut iterations_run = 0usize;

    for it in 0..opts.iterations {
        iterations_run = it + 1;
        // LMMSE stage: x₂ = (γ_w AᵀA⊗AᵀA + γ₁ I)⁻¹ (γ_w Aᵀy + γ₁ r₁), via the eigenbasis.
        let mut trace = 0f64;
        for &li in lam.iter() {
            for &lj in lam.iter() {
                trace += 1.0 / (gw * li * lj + g1);
            }
        }
        for ch in 0..3 {
            mul3(&op.vt, &r1[ch], &op.v, m, &mut tmp, &mut brot);
            let ar = &aty_rot[ch];
            for (i, &lami) in lam.iter().enumerate() {
                let li = gw * lami;
                let row = i * m;
                for ((bv, &av), &lj) in brot[row..row + m]
                    .iter_mut()
                    .zip(&ar[row..row + m])
                    .zip(lam)
                {
                    *bv = (gw * av + g1 * *bv) / (li * lj + g1);
                }
            }
            mul3(&op.v, &brot, &op.vt, m, &mut tmp, &mut x2[ch]);
        }
        // Divergence of the LMMSE stage restricted to unknown components is ≈ the average over all components.
        let a2 = (g1 * trace) / mm as f64;
        let eta2 = g1 / a2;
        let g2 = (eta2 - g1).max(1e-9);
        for ch in 0..3 {
            let (x2c, r1c, r2c) = (&x2[ch], &r1[ch], &mut r2[ch]);
            for ((r2v, &x2v), &r1v) in r2c.iter_mut().zip(x2c).zip(r1c) {
                *r2v = (eta2 * x2v - g1 * r1v) / g2;
            }
        }
        // Denoiser: discrete posterior per unknown cell under r₂ ~ N(x, 1/γ₂).
        let mut vsum = 0f64;
        for x1c in x1.iter_mut() {
            x1c.fill(0.0);
        }
        for j in 0..count {
            let pj = &idx[j * 4..j * 4 + 4];
            for (q, &p) in pj.iter().enumerate() {
                for ch in 0..3 {
                    rr[q * 3 + ch] = r2[ch][p];
                }
            }
            let mut best = f64::INFINITY;
            let mut second = f64::INFINITY;
            let mut best_sym = 0usize;
            for (sy, xs) in x.chunks_exact(12).enumerate() {
                let mut dot = 0f64;
                for (xv, rv) in xs.iter().zip(&rr) {
                    dot += xv * rv;
                }
                let v = 0.5 * g2 * (xx[sy] - 2.0 * dot);
                scores[sy] = v;
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
            let mut z = 0f64;
            let mut m1 = [0f64; 12];
            let mut m2 = [0f64; 12];
            for (sy, xs) in x.chunks_exact(12).enumerate() {
                let d = scores[sy] - best;
                if d > 30.0 {
                    continue;
                }
                let w = (-d).exp();
                z += w;
                for i in 0..12 {
                    let v = xs[i];
                    m1[i] += w * v;
                    m2[i] += w * v * v;
                }
            }
            for i in 0..12 {
                let mmean = m1[i] / z;
                rr[i] = mmean;
                vsum += (m2[i] / z - mmean * mmean).max(0.0);
            }
            for (q, &p) in pj.iter().enumerate() {
                for ch in 0..3 {
                    x1[ch][p] = rr[q * 3 + ch];
                }
            }
        }
        if let Some(cb) = on_iteration.as_deref_mut()
            && cb(it, &sym, &margin)
        {
            break;
        }
        if it + 1 == opts.iterations {
            break;
        }
        // Average posterior variance over all components (known ones have zero variance).
        let mut a1 = ((g2 * vsum) / (mm as f64 * 3.0)).max(1e-6);
        if it > 0 {
            let d = opts.damping;
            for ch in 0..3 {
                let (x1c, xp) = (&mut x1[ch], &x1prev[ch]);
                for (xv, &pv) in x1c.iter_mut().zip(xp) {
                    *xv = d * *xv + (1.0 - d) * pv;
                }
            }
            a1 = d * a1 + (1.0 - d) * a1prev;
        }
        for ch in 0..3 {
            x1prev[ch].copy_from_slice(&x1[ch]);
        }
        a1prev = a1;
        let eta1 = g2 / a1;
        let g1n = (eta1 - g2).max(1e-6);
        for ch in 0..3 {
            let (x1c, r2c, r1c) = (&x1[ch], &r2[ch], &mut r1[ch]);
            for ((r1v, &x1v), &r2v) in r1c.iter_mut().zip(x1c).zip(r2c) {
                *r1v = (eta1 * x1v - g2 * r2v) / g1n;
            }
        }
        g1 = g1n;
    }
    Some(VampResult {
        sym,
        margin,
        iterations: iterations_run,
    })
}
