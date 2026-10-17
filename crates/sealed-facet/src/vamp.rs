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
//!
//! Implementation notes (the arithmetic is the reference's; only its arrangement differs):
//! - Aᵀ Y A uses the band of A, and the LMMSE input γ_w Aᵀy + γ₁ r₁ is rotated into the eigenbasis as one
//!   matrix per channel per iteration (the reference rotates Aᵀ Y A separately up front), so a frame that
//!   decodes after the first iteration costs 12 dense products instead of 24.
//! - The dense products run a register-tiled kernel that accumulates every element over k in the reference
//!   order (bitwise the plain triple loop) and split their rows across worker threads (`parallel.rs`).
//! - The denoiser factors xᵀr through the 4 × K colour projections and the posterior moments through the fills
//!   and centroids (as `equalize.rs` does), and runs cells in parallel; its per-cell variance sums are added
//!   in cell order so the result does not depend on the thread count.

use std::sync::{Arc, Mutex};

use crate::glyphs::glyph_fills;
use crate::model::{ISI_RADIUS, ResponseModel, SPAN};
use crate::parallel::{par_rows, parts_for};

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
/// eigenvalue). The algorithm is Numerical Recipes tred2/tqli in 0-based storage; `vectors` ends up holding the
/// eigenvectors as columns.
///
/// Only the lower triangle of `a` is read. Every sum runs in the reference order, so the result is bitwise the
/// result of the plain row-major formulation; the storage differs for locality: the Householder stage keeps its
/// active block symmetric (so column reads become row reads) and the accumulation and QL stages work on the
/// transpose (so each Givens rotation sweeps two contiguous rows).
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
    // Mirror the lower triangle into the upper one: the reduction below reads z[j][k] for the value the
    // reference reads at z[k][j] (k > j) and keeps the active block symmetric after each update.
    for k in 0..n {
        for j in 0..k {
            z[j * n + k] = z[k * n + j];
        }
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
                let (upper, row_i) = z.split_at_mut(i * n);
                let row_i = &row_i[..=l];
                for j in 0..=l {
                    upper[j * n + i] = row_i[j] / h;
                    let mut gg = 0f64;
                    // Σ_{k ≤ j} z[j][k] z[i][k] + Σ_{k > j} z[k][j] z[i][k], the latter read from the mirror z[j][k].
                    for (&zjk, &zik) in upper[j * n..j * n + l + 1].iter().zip(row_i) {
                        gg += zjk * zik;
                    }
                    e[j] = gg / h;
                    f += e[j] * row_i[j];
                }
                let hh = f / (h + h);
                for j in 0..=l {
                    let fj = row_i[j];
                    let gj = e[j] - hh * fj;
                    e[j] = gj;
                    for k in 0..=j {
                        upper[j * n + k] -= fj * e[k] + gj * row_i[k];
                    }
                    // Keep the active block symmetric.
                    for k in 0..j {
                        upper[k * n + j] = upper[j * n + k];
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
    // From here on `zt` is the transpose of the reference matrix: zt[c][r] = z[r][c].
    let mut zt = vec![0f64; n * n];
    for r in 0..n {
        for c in 0..n {
            zt[c * n + r] = z[r * n + c];
        }
    }
    drop(z);
    let mut u = vec![0f64; n];
    for i in 0..n {
        // `if (d[i])`: JavaScript truthiness (NaN and ±0 are false).
        if d[i] != 0.0 && !d[i].is_nan() {
            // u = z[i][0..i] (column i of zt).
            for k in 0..i {
                u[k] = zt[k * n + i];
            }
            let (rows_j, rest) = zt.split_at_mut(i * n);
            let row_i = &rest[..i];
            for j in 0..i {
                let row_j = &mut rows_j[j * n..j * n + i];
                let mut g = 0f64;
                for (&uk, &zkj) in u[..i].iter().zip(row_j.iter()) {
                    g += uk * zkj;
                }
                for (zkj, &zki) in row_j.iter_mut().zip(row_i) {
                    *zkj -= g * zki;
                }
            }
        }
        d[i] = zt[i * n + i];
        zt[i * n + i] = 1.0;
        for j in 0..i {
            zt[i * n + j] = 0.0;
            zt[j * n + i] = 0.0;
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
                // Rotate columns iu and iu + 1 of the reference matrix: rows iu and iu + 1 of zt.
                let (lo, hi) = zt.split_at_mut((iu + 1) * n);
                let row0 = &mut lo[iu * n..iu * n + n];
                let row1 = &mut hi[..n];
                for (z0, z1) in row0.iter_mut().zip(row1.iter_mut()) {
                    f = *z1;
                    *z1 = s * *z0 + c * f;
                    *z0 = c * *z0 - s * f;
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
    let mut vectors = vec![0f64; n * n];
    for r in 0..n {
        for c in 0..n {
            vectors[r * n + c] = zt[c * n + r];
        }
    }
    Some(SymmetricEigen { values: d, vectors })
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
    /// Band of A per column: rows `band[j][0] .. band[j][1]` hold every non-zero of column j (A is a blur
    /// operator: each source half-cell reaches only the feature half-cells within [`ISI_RADIUS`] cells).
    pub band: Vec<[usize; 2]>,
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
    // Non-zero rows of each column of A (a blur: a narrow band).
    let band: Vec<[usize; 2]> = (0..m)
        .map(|j| {
            let lo = (0..m).find(|&i| a[i * m + j] != 0.0).unwrap_or(m);
            let hi = (lo..m)
                .rev()
                .find(|&i| a[i * m + j] != 0.0)
                .map_or(lo, |i| i + 1);
            [lo, hi]
        })
        .collect();
    // AᵀA over the rows where both columns are non-zero (every other term is an exact zero, so the sums are
    // those of the dense product).
    let mut k = vec![0f64; m * m];
    for i in 0..m {
        for j in i..m {
            let lo = band[i][0].max(band[j][0]);
            let hi = band[i][1].min(band[j][1]);
            let mut s = 0f64;
            for row in lo..hi {
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
        band,
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

/// Row-tile height and column-tile width of the GEMM micro-kernel: 2 × 8 accumulators fit the 16 two-lane
/// vector registers of baseline x86-64 (SSE2) and wasm simd128, and let LLVM vectorise the column axis.
const TILE_ROWS: usize = 2;
const TILE_COLS: usize = 8;
/// Rows per thread part of a GEMM (keeps the per-part work well above the thread start-up cost).
const GEMM_MIN_ROWS: usize = 32;

/// `out_rows = l_rows · b` for row-major matrices with `m` columns: `l_rows` and `out_rows` hold the same number
/// of rows, `b` is `m × m`. Every output element accumulates over k in ascending order from zero, exactly like
/// the plain triple loop, so the result is bitwise the same whatever the tiling or thread split.
fn gemm_rows(l_rows: &[f64], b: &[f64], m: usize, out_rows: &mut [f64]) {
    let rows = out_rows.len() / m;
    let l_rows = &l_rows[..rows * m];
    let b = &b[..m * m];
    let out_rows = &mut out_rows[..rows * m];
    let mut j0 = 0;
    while j0 < m {
        let cb = TILE_COLS.min(m - j0);
        let mut i0 = 0;
        while i0 < rows {
            let rb = TILE_ROWS.min(rows - i0);
            let mut acc = [[0f64; TILE_COLS]; TILE_ROWS];
            if rb == TILE_ROWS && cb == TILE_COLS {
                for k in 0..m {
                    let bk: &[f64; TILE_COLS] = b[k * m + j0..k * m + j0 + TILE_COLS]
                        .try_into()
                        .expect("tile width");
                    for (r, accr) in acc.iter_mut().enumerate() {
                        let lv = l_rows[(i0 + r) * m + k];
                        for (a, &bv) in accr.iter_mut().zip(bk) {
                            *a += lv * bv;
                        }
                    }
                }
            } else {
                for k in 0..m {
                    let bk = &b[k * m + j0..k * m + j0 + cb];
                    for (r, accr) in acc.iter_mut().enumerate().take(rb) {
                        let lv = l_rows[(i0 + r) * m + k];
                        for (a, &bv) in accr[..cb].iter_mut().zip(bk) {
                            *a += lv * bv;
                        }
                    }
                }
            }
            for (r, accr) in acc.iter().enumerate().take(rb) {
                let o = (i0 + r) * m + j0;
                out_rows[o..o + cb].copy_from_slice(&accr[..cb]);
            }
            i0 += TILE_ROWS;
        }
        j0 += TILE_COLS;
    }
}

/// `out = l · b` (M × M), split by rows across the worker threads when available.
fn gemm(l: &[f64], b: &[f64], m: usize, out: &mut [f64]) {
    let parts = parts_for(m, GEMM_MIN_ROWS);
    par_rows(out, m, TILE_ROWS, parts, |row0, rows| {
        let n_rows = rows.len() / m;
        gemm_rows(&l[row0 * m..(row0 + n_rows) * m], b, m, rows);
    });
}

/// `out = L · B · R` for M × M row-major matrices.
fn mul3(l: &[f64], b: &[f64], r: &[f64], m: usize, tmp: &mut [f64], out: &mut [f64]) {
    gemm(l, b, m, tmp);
    gemm(tmp, r, m, out);
}

/// `out = Aᵀ · Y · A` using the band of A (the triple loop over the zeros of A, skipped): bitwise the same sums
/// as the dense product, since every term it leaves out is an exact zero.
fn aty_banded(op: &HalfCellOperator, y: &[f64], tmp: &mut [f64], out: &mut [f64]) {
    let m = op.m;
    let a = &op.a[..m * m];
    // tmp = Aᵀ Y: row i of Aᵀ is column i of A, non-zero on rows band[i].
    for i in 0..m {
        let trow = &mut tmp[i * m..i * m + m];
        trow.fill(0.0);
        let [lo, hi] = op.band[i];
        for k in lo..hi {
            let lik = a[k * m + i];
            if lik == 0.0 {
                continue;
            }
            let yrow = &y[k * m..k * m + m];
            for (t, &yv) in trow.iter_mut().zip(yrow) {
                *t += lik * yv;
            }
        }
    }
    // out = tmp · A: column j of A is non-zero on rows band[j].
    for i in 0..m {
        let trow = &tmp[i * m..i * m + m];
        let orow = &mut out[i * m..i * m + m];
        for (j, o) in orow.iter_mut().enumerate() {
            let [lo, hi] = op.band[j];
            let mut acc = 0f64;
            for k in lo..hi {
                acc += trow[k] * a[k * m + j];
            }
            *o = acc;
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

/// Cells per thread part of the denoiser.
const DENOISE_MIN_CELLS: usize = 256;
/// Per-cell denoiser output: posterior mean (12), the cell's summed posterior variance, the hard decision and
/// its margin.
const DENOISE_OUT: usize = 15;

/// Symbol table of the denoiser: the 16 K symbols `x = fill_s ⊗ c_k` with their squared norms, and the prior
/// moments of a component under the uniform symbol prior.
struct SymbolTable {
    k_n: usize,
    s_n: usize,
    /// `fills[s * 4 + q]` (f64).
    fills: [f64; 64],
    /// `cent[k * 3 + ch]` (f64).
    cent: Vec<f64>,
    /// Σ_i x[sy][i]² per symbol.
    xx: Vec<f64>,
    mean0: f64,
    var0: f64,
}

impl SymbolTable {
    fn new(centroids: &[f32]) -> Self {
        let k_n = centroids.len() / 3;
        let s_n = k_n * 16;
        let fills32 = glyph_fills(k_n);
        let fills: [f64; 64] = std::array::from_fn(|i| fills32[i] as f64);
        let cent: Vec<f64> = centroids[..k_n * 3].iter().map(|&c| c as f64).collect();
        let mut xx = vec![0f64; s_n];
        let mut mu = [0f64; 12];
        let mut sq = [0f64; 12];
        for sy in 0..s_n {
            let mut s2 = 0f64;
            for q in 0..4 {
                for ch in 0..3 {
                    // fill · centroid is exact in f64 (two f32 factors), as in the reference table.
                    let v = fills[(sy & 15) * 4 + q] * cent[(sy >> 4) * 3 + ch];
                    s2 += v * v;
                    mu[q * 3 + ch] += v / s_n as f64;
                    sq[q * 3 + ch] += (v * v) / s_n as f64;
                }
            }
            xx[sy] = s2;
        }
        let mut mean0 = 0f64;
        let mut var0 = 0f64;
        for i in 0..12 {
            mean0 += mu[i] / 12.0;
            var0 += (sq[i] - mu[i] * mu[i]) / 12.0;
        }
        Self {
            k_n,
            s_n,
            fills,
            cent,
            xx,
            mean0,
            var0,
        }
    }

    /// Discrete posterior of one cell under `r ~ N(x, 1/g2)` (`rr[q * 3 + ch]`), into `out`: the posterior mean
    /// per component, the summed posterior variance, the hard decision and its margin.
    ///
    /// Scores are `½ g2 (‖x‖² − 2 xᵀr)`; the inner product factors as Σ_q fill_q · (c_k · r_q), and the moments as
    /// Σ_k c_k,ch · Σ_s w_ks fill_s,q (same sums as the direct 12-vector form, associated differently).
    fn posterior(
        &self,
        g2: f64,
        rr: &[f64; 12],
        scores: &mut [f64],
        proj: &mut [f64],
        wf: &mut [f64],
        wf2: &mut [f64],
        out: &mut [f64],
    ) {
        let k_n = self.k_n;
        // proj[q * K + k] = c_k · r_q.
        for q in 0..4 {
            let (r0, r1, r2) = (rr[q * 3], rr[q * 3 + 1], rr[q * 3 + 2]);
            for k in 0..k_n {
                proj[q * k_n + k] =
                    self.cent[k * 3] * r0 + self.cent[k * 3 + 1] * r1 + self.cent[k * 3 + 2] * r2;
            }
        }
        let mut best = f64::INFINITY;
        let mut second = f64::INFINITY;
        let mut best_sym = 0usize;
        for k in 0..k_n {
            let (p0, p1, p2, p3) = (proj[k], proj[k_n + k], proj[2 * k_n + k], proj[3 * k_n + k]);
            for sh in 0..16 {
                let f = &self.fills[sh * 4..sh * 4 + 4];
                let dot = f[0] * p0 + f[1] * p1 + f[2] * p2 + f[3] * p3;
                let sy = k * 16 + sh;
                let v = 0.5 * g2 * (self.xx[sy] - 2.0 * dot);
                scores[sy] = v;
                if v < best {
                    second = best;
                    best = v;
                    best_sym = sy;
                } else if v < second {
                    second = v;
                }
            }
        }
        // Posterior weights; moments factor through the fills (per color) and the centroids (per channel).
        wf[..4 * k_n].fill(0.0);
        wf2[..4 * k_n].fill(0.0);
        let mut z = 0f64;
        for k in 0..k_n {
            for sh in 0..16 {
                let d = scores[k * 16 + sh] - best;
                if d > 30.0 {
                    continue;
                }
                let w = (-d).exp();
                z += w;
                let f = &self.fills[sh * 4..sh * 4 + 4];
                for q in 0..4 {
                    wf[q * k_n + k] += w * f[q];
                    wf2[q * k_n + k] += w * f[q] * f[q];
                }
            }
        }
        let mut vsum = 0f64;
        for q in 0..4 {
            for ch in 0..3 {
                let mut m1 = 0f64;
                let mut m2 = 0f64;
                for k in 0..k_n {
                    let c = self.cent[k * 3 + ch];
                    m1 += c * wf[q * k_n + k];
                    m2 += c * c * wf2[q * k_n + k];
                }
                let mmean = m1 / z;
                out[q * 3 + ch] = mmean;
                vsum += (m2 / z - mmean * mmean).max(0.0);
            }
        }
        out[12] = vsum;
        out[13] = best_sym as f64;
        out[14] = (second - best) as f32 as f64;
    }
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
    if y.len() != total * 12 || k_n == 0 || cells.iter().any(|&c| c as usize >= total) {
        return None;
    }
    let op = half_cell_operator(problem.model, n)?;
    let m = op.m;
    let mm = m * m;
    let table = SymbolTable::new(centroids);
    let s_n = table.s_n;
    let gw = 1.0 / problem.noise_variance.max(1e-12);

    // Per-cell index of each of its 4 quadrants in the channel arrays.
    let idx: Vec<usize> = cells
        .iter()
        .flat_map(|&c| (0..4).map(move |q| half_index(c as usize, q, n)))
        .collect();

    // Aᵀy per channel (spatial domain; A is banded so this is cheap). It is rotated into the eigenbasis together
    // with the extrinsic input every iteration: Vᵀ (γ_w Aᵀy + γ₁ r₁) V.
    let mut tmp = vec![0f64; mm];
    let mut aty: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut big_y = vec![0f64; mm];
    for (ch, aty_ch) in aty.iter_mut().enumerate() {
        big_y.fill(0.0);
        for c in 0..total {
            for q in 0..4 {
                big_y[half_index(c, q, n)] = y[c * 12 + q * 3 + ch] as f64;
            }
        }
        aty_banded(&op, &big_y, &mut tmp, aty_ch);
    }
    drop(big_y);
    let lam = &op.lambda;

    // r1 (per channel, M × M): extrinsic input to the LMMSE stage; known components are 0 and stay 0.
    let mean0 = table.mean0;
    let mut r1: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    for &p in &idx {
        for r in r1.iter_mut() {
            r[p] = mean0;
        }
    }
    let mut g1 = 1.0 / table.var0.max(1e-9);

    let mut sym = vec![0u8; count];
    let mut margin = vec![0f32; count];
    let mut x2: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut r2: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut x1: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut x1prev: [Vec<f64>; 3] = std::array::from_fn(|_| vec![0f64; mm]);
    let mut a1prev = 0f64;
    let mut comb = vec![0f64; mm];
    let mut brot = vec![0f64; mm];
    // Denoiser output per cell (posterior mean, variance sum, decision, margin), filled in parallel over cells.
    let mut denoised = vec![0f64; count * DENOISE_OUT];
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
            for ((cv, &av), &rv) in comb.iter_mut().zip(&aty[ch]).zip(&r1[ch]) {
                *cv = gw * av + g1 * rv;
            }
            mul3(&op.vt, &comb, &op.v, m, &mut tmp, &mut brot);
            for (i, &lami) in lam.iter().enumerate() {
                let li = gw * lami;
                let row = i * m;
                for (bv, &lj) in brot[row..row + m].iter_mut().zip(lam) {
                    *bv /= li * lj + g1;
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
        // Denoiser: discrete posterior per unknown cell under r₂ ~ N(x, 1/γ₂), cells split across threads.
        {
            let (r2, idx, table) = (&r2, &idx, &table);
            let parts = parts_for(count, DENOISE_MIN_CELLS);
            par_rows(&mut denoised, DENOISE_OUT, 1, parts, |cell0, rows| {
                let mut scores = vec![0f64; s_n];
                let mut proj = vec![0f64; 4 * k_n];
                let mut wf = vec![0f64; 4 * k_n];
                let mut wf2 = vec![0f64; 4 * k_n];
                let mut rr = [0f64; 12];
                for (jj, out) in rows.chunks_exact_mut(DENOISE_OUT).enumerate() {
                    let j = cell0 + jj;
                    let pj = &idx[j * 4..j * 4 + 4];
                    for (q, &p) in pj.iter().enumerate() {
                        for ch in 0..3 {
                            rr[q * 3 + ch] = r2[ch][p];
                        }
                    }
                    table.posterior(g2, &rr, &mut scores, &mut proj, &mut wf, &mut wf2, out);
                }
            });
        }
        let mut vsum = 0f64;
        for x1c in x1.iter_mut() {
            x1c.fill(0.0);
        }
        for (j, out) in denoised.chunks_exact(DENOISE_OUT).enumerate() {
            sym[j] = out[13] as u8;
            margin[j] = out[14] as f32;
            vsum += out[12];
            let pj = &idx[j * 4..j * 4 + 4];
            for (q, &p) in pj.iter().enumerate() {
                for ch in 0..3 {
                    x1[ch][p] = out[q * 3 + ch];
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
