//! Linear optical channel model for the Facet grid (receiver side). Port of `packages/core/src/facet/model.ts`.
//!
//! Every lit element on screen is an axis-aligned box in grid units: a glyph quadrant (`[-0.4, 0]` or
//! `[0, 0.4]` around the cell center on each axis) or a full cell (anchors, header bits, gray ramps). The
//! camera's point-spread function is modeled as an isotropic Gaussian of σ cells, so light at a sample point is a
//! separable sum of erf differences.
//!
//! The receiver samples each quadrant at 3 × 3 points (0.15-cell pitch around the quadrant center) and averages
//! them, giving one feature per quadrant and color channel. Each feature is a linear function of the source
//! excess of the cell and its neighbors within [`ISI_RADIUS`] cells, so inter-symbol interference can be predicted
//! exactly and cancelled.
//!
//! Storage mirrors the JavaScript typed arrays: `f32` where it uses `Float32Array`, `f64` where it uses
//! `Float64Array` or plain numbers, with every accumulation done in `f64` and rounded once on store.

use crate::glyphs::GLYPH_MARGIN;
use crate::parallel::{par_rows, parts_for};

/// Neighborhood radius in cells; Gaussian tails beyond 2 cells are < 0.1% for σ ≤ 0.6.
pub const ISI_RADIUS: usize = 2;
pub const SPAN: usize = 2 * ISI_RADIUS + 1;

/// Sample offsets (cells, from the cell center) for the low and high quadrant on one axis.
pub const SAMPLE_OFFSETS: [[f64; 3]; 2] = [[-0.4, -0.25, -0.1], [0.1, 0.25, 0.4]];

const QUAD_BOX: [[f64; 2]; 2] = [[GLYPH_MARGIN - 0.5, 0.0], [0.0, 0.5 - GLYPH_MARGIN]];

/// Number of distinct edge classes per axis.
pub const EDGE_CLASSES: usize = 2 * ISI_RADIUS + 1;

/// Returned when a buffer does not have the length the grid size implies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LengthMismatch;

impl std::fmt::Display for LengthMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("buffer length does not match the grid size")
    }
}

impl std::error::Error for LengthMismatch {}

/// erf with |error| < 1.5e-7 (Abramowitz & Stegun 7.1.26).
pub fn erf(x: f64) -> f64 {
    let s = if x < 0.0 { -1.0 } else { 1.0 };
    let a = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * a);
    let y = 1.0
        - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-a * a).exp();
    s * y
}

/// Standard normal CDF.
pub fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}

/// Light at point `x` from a unit box `[lo, hi]` blurred by `N(0, σ²)`.
pub fn box_response(x: f64, lo: f64, hi: f64, sigma: f64) -> f64 {
    if sigma < 1e-4 {
        return if x >= lo && x < hi { 1.0 } else { 0.0 };
    }
    norm_cdf((hi - x) / sigma) - norm_cdf((lo - x) / sigma)
}

/// 1-D and self responses of the blur model at one σ.
#[derive(Clone, Debug, PartialEq)]
pub struct ResponseModel {
    pub sigma: f64,
    /// `gq[(qa * SPAN + di) * 2 + qs]`: quadrant half `qs` of a neighbor at offset `di - R` → feature half `qa`
    /// (1-D).
    pub gq: [f64; 2 * SPAN * 2],
    /// `gf[qa * SPAN + di]`: full cell at offset `di - R` → feature half `qa` (1-D).
    pub gf: [f64; 2 * SPAN],
    /// Self response W0 (4 × 4, row = target quadrant, column = source quadrant).
    pub w0: [f64; 16],
    /// Self response of a full cell onto each quadrant feature.
    pub wf0: [f64; 4],
}

/// Builds the response model for `sigma`, quantized to 1e-4 cells and clamped at 0 (as the JavaScript model
/// cache key does). A NaN σ is treated as 0.
pub fn response_model(sigma: f64) -> ResponseModel {
    let key = (sigma * 1e4).round().max(0.0);
    let s = key / 1e4;
    let mut gq = [0f64; 2 * SPAN * 2];
    let mut gf = [0f64; 2 * SPAN];
    for qa in 0..2 {
        let xs = &SAMPLE_OFFSETS[qa];
        let mean = |lo: f64, hi: f64| -> f64 {
            xs.iter().fold(0.0, |a, &x| a + box_response(x, lo, hi, s)) / xs.len() as f64
        };
        for di in 0..SPAN {
            let d = di as f64 - ISI_RADIUS as f64;
            for qs in 0..2 {
                let [lo, hi] = QUAD_BOX[qs];
                gq[(qa * SPAN + di) * 2 + qs] = mean(d + lo, d + hi);
            }
            gf[qa * SPAN + di] = mean(d - 0.5, d + 0.5);
        }
    }
    let mut w0 = [0f64; 16];
    let mut wf0 = [0f64; 4];
    let c = ISI_RADIUS;
    for q in 0..4 {
        let qx = q & 1;
        let qy = q >> 1;
        wf0[q] = gf[qx * SPAN + c] * gf[qy * SPAN + c];
        for qs in 0..4 {
            w0[q * 4 + qs] =
                gq[(qx * SPAN + c) * 2 + (qs & 1)] * gq[(qy * SPAN + c) * 2 + (qs >> 1)];
        }
    }
    ResponseModel {
        sigma: s,
        gq,
        gf,
        w0,
        wf0,
    }
}

/// Screen sources of an N × N grid, as linear excess over the background.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceGrid {
    pub n: usize,
    /// Glyph sources: `[cell * 12 + q' * 3 + ch]` (zero for non-glyph cells).
    pub q: Vec<f32>,
    /// Full-cell sources: `[cell * 3 + ch]` (zero for non-full cells).
    pub f: Vec<f32>,
}

impl SourceGrid {
    fn check(&self) -> Result<(), LengthMismatch> {
        let cells = self.n * self.n;
        if self.q.len() == cells * 12 && self.f.len() == cells * 3 {
            Ok(())
        } else {
            Err(LengthMismatch)
        }
    }
}

pub fn new_source_grid(n: usize) -> SourceGrid {
    SourceGrid {
        n,
        q: vec![0.0; n * n * 12],
        f: vec![0.0; n * n * 3],
    }
}

/// Predicted features of every cell (`n² × 12`: `[cell * 12 + q * 3 + ch]`) including each cell's own
/// contribution. See [`predict_features_into`].
pub fn predict_features(
    model: &ResponseModel,
    src: &SourceGrid,
) -> Result<Vec<f32>, LengthMismatch> {
    let mut out = vec![0f32; src.n * src.n * 12];
    predict_features_into(model, src, &mut out)?;
    Ok(out)
}

/// Predicted features of every cell written to `out` (`n² × 12`, overwritten). Computed separably: a horizontal
/// pass mixes quadrant columns, then a vertical pass mixes quadrant rows. Both passes run row-parallel when
/// threads are available (rows are independent; every element is accumulated in the same order either way).
pub fn predict_features_into(
    model: &ResponseModel,
    src: &SourceGrid,
    out: &mut [f32],
) -> Result<(), LengthMismatch> {
    src.check()?;
    let n = src.n;
    if out.len() != n * n * 12 {
        return Err(LengthMismatch);
    }
    if n == 0 {
        return Ok(());
    }
    let r = ISI_RADIUS as isize;
    let gq = &model.gq;
    let gf = &model.gf;
    // Horizontal pass, per cell: A[qa][qsy][ch] (12 floats) for glyph sources, then Af[qa][ch] (6) for full
    // cells: `hp[cell * H + …]`.
    const H: usize = 18;
    let mut hp = vec![0f32; n * n * H];
    let sq = &src.q;
    let sf = &src.f;
    let parts = parts_for(n, 8);
    par_rows(&mut hp, n * H, 1, parts, |y0, rows| {
        for (yy, hrow) in rows.chunks_exact_mut(n * H).enumerate() {
            let y = y0 + yy;
            for (x, cell) in hrow.chunks_exact_mut(H).enumerate() {
                for dx in -r..=r {
                    let sx = x as isize + dx;
                    if sx < 0 || sx >= n as isize {
                        continue;
                    }
                    let s = y * n + sx as usize;
                    let di = (dx + r) as usize;
                    let so = s * 12;
                    let fo = s * 3;
                    for qa in 0..2 {
                        let g0 = gq[(qa * SPAN + di) * 2];
                        let g1 = gq[(qa * SPAN + di) * 2 + 1];
                        let gff = gf[qa * SPAN + di];
                        for qsy in 0..2 {
                            let b0 = so + (qsy * 2) * 3; // source quadrant (qsx = 0, qsy)
                            let b1 = so + (qsy * 2 + 1) * 3; // (qsx = 1, qsy)
                            let o = (qa * 2 + qsy) * 3;
                            for ch in 0..3 {
                                cell[o + ch] = (cell[o + ch] as f64
                                    + g0 * sq[b0 + ch] as f64
                                    + g1 * sq[b1 + ch] as f64)
                                    as f32;
                            }
                        }
                        let fo2 = 12 + qa * 3;
                        for ch in 0..3 {
                            cell[fo2 + ch] =
                                (cell[fo2 + ch] as f64 + gff * sf[fo + ch] as f64) as f32;
                        }
                    }
                }
            }
        }
    });
    let hp = &hp;
    par_rows(out, n * 12, 1, parts, |y0, rows| {
        for (yy, orow) in rows.chunks_exact_mut(n * 12).enumerate() {
            let y = y0 + yy;
            for (x, ocell) in orow.chunks_exact_mut(12).enumerate() {
                ocell.fill(0.0);
                for dy in -r..=r {
                    let sy = y as isize + dy;
                    if sy < 0 || sy >= n as isize {
                        continue;
                    }
                    let s = sy as usize * n + x;
                    let di = (dy + r) as usize;
                    let a = &hp[s * H..s * H + H];
                    for qb in 0..2 {
                        let g0 = gq[(qb * SPAN + di) * 2];
                        let g1 = gq[(qb * SPAN + di) * 2 + 1];
                        let gff = gf[qb * SPAN + di];
                        for qa in 0..2 {
                            let q = qb * 2 + qa;
                            let o = q * 3;
                            let a0 = (qa * 2) * 3; // qsy = 0
                            let a1 = (qa * 2 + 1) * 3; // qsy = 1
                            let afi = 12 + qa * 3;
                            for ch in 0..3 {
                                ocell[o + ch] = (ocell[o + ch] as f64
                                    + g0 * a[a0 + ch] as f64
                                    + g1 * a[a1 + ch] as f64
                                    + gff * a[afi + ch] as f64)
                                    as f32;
                            }
                        }
                    }
                }
            }
        }
    });
    Ok(())
}

/// Own contribution of cell `c` to its features (`[q * 3 + ch]`). `None` if `c` is outside the grid or the
/// grid's buffers are mis-sized.
pub fn self_features(model: &ResponseModel, src: &SourceGrid, c: usize) -> Option<[f32; 12]> {
    src.check().ok()?;
    if c >= src.n * src.n {
        return None;
    }
    let w0 = &model.w0;
    let wf0 = &model.wf0;
    let qo = c * 12;
    let fo = c * 3;
    let mut out = [0f32; 12];
    for q in 0..4 {
        for ch in 0..3 {
            let mut a = wf0[q] * src.f[fo + ch] as f64;
            for qs in 0..4 {
                a += w0[q * 4 + qs] * src.q[qo + qs * 3 + ch] as f64;
            }
            out[q * 3 + ch] = a as f32;
        }
    }
    Some(out)
}

/// Adjoint of [`predict_features`] restricted to glyph sources. See [`adjoint_features_into`].
pub fn adjoint_features(
    model: &ResponseModel,
    feat: &[f32],
    n: usize,
) -> Result<Vec<f32>, LengthMismatch> {
    let mut out = vec![0f32; n * n * 12];
    adjoint_features_into(model, feat, n, &mut out)?;
    Ok(out)
}

/// Adjoint of [`predict_features`] restricted to glyph sources, written to `out` (`n² × 12`, overwritten): for
/// every cell s, `out[s * 12 + q' * 3 + ch] = Σ_t Σ_q W(s − t)[q][q'] · feat[t * 12 + q * 3 + ch]`, i.e. the
/// matched filter of each source quadrant against the features of all cells it reaches. Features that are NaN
/// count as zero.
pub fn adjoint_features_into(
    model: &ResponseModel,
    feat: &[f32],
    n: usize,
    out: &mut [f32],
) -> Result<(), LengthMismatch> {
    if feat.len() != n * n * 12 || out.len() != n * n * 12 {
        return Err(LengthMismatch);
    }
    let r = ISI_RADIUS as isize;
    let gq = &model.gq;
    // Vertical adjoint: B[s][qa][qsy][ch] = Σ_dy Σ_qb g(qb, dy, qsy) · feat[s − dy·n][qb·2 + qa][ch].
    let mut b = vec![0f32; n * n * 12];
    for y in 0..n {
        for x in 0..n {
            let s = y * n + x;
            let bo = s * 12;
            for dy in -r..=r {
                let ty = y as isize - dy;
                if ty < 0 || ty >= n as isize {
                    continue;
                }
                let to = (ty as usize * n + x) * 12;
                let di = (dy + r) as usize;
                for qb in 0..2 {
                    let g0 = gq[(qb * SPAN + di) * 2];
                    let g1 = gq[(qb * SPAN + di) * 2 + 1];
                    for qa in 0..2 {
                        let fo = to + (qb * 2 + qa) * 3;
                        let f0 = feat[fo] as f64;
                        let f1 = feat[fo + 1] as f64;
                        let f2 = feat[fo + 2] as f64;
                        if f0.is_nan() || f1.is_nan() || f2.is_nan() {
                            continue;
                        }
                        let o0 = bo + (qa * 2) * 3;
                        let o1 = bo + (qa * 2 + 1) * 3;
                        b[o0] = (b[o0] as f64 + g0 * f0) as f32;
                        b[o0 + 1] = (b[o0 + 1] as f64 + g0 * f1) as f32;
                        b[o0 + 2] = (b[o0 + 2] as f64 + g0 * f2) as f32;
                        b[o1] = (b[o1] as f64 + g1 * f0) as f32;
                        b[o1 + 1] = (b[o1 + 1] as f64 + g1 * f1) as f32;
                        b[o1 + 2] = (b[o1 + 2] as f64 + g1 * f2) as f32;
                    }
                }
            }
        }
    }
    // Horizontal adjoint: out[s][qsy·2 + qsx][ch] = Σ_dx Σ_qa g(qa, dx, qsx) · B[s − dx][qa][qsy][ch].
    out.fill(0.0);
    for y in 0..n {
        for x in 0..n {
            let s = y * n + x;
            let oo = s * 12;
            for dx in -r..=r {
                let tx = x as isize - dx;
                if tx < 0 || tx >= n as isize {
                    continue;
                }
                let bo = (y * n + tx as usize) * 12;
                let di = (dx + r) as usize;
                for qa in 0..2 {
                    let g0 = gq[(qa * SPAN + di) * 2];
                    let g1 = gq[(qa * SPAN + di) * 2 + 1];
                    for qsy in 0..2 {
                        let bi = bo + (qa * 2 + qsy) * 3;
                        let b0 = b[bi] as f64;
                        let b1 = b[bi + 1] as f64;
                        let b2 = b[bi + 2] as f64;
                        let o0 = oo + (qsy * 2) * 3;
                        let o1 = oo + (qsy * 2 + 1) * 3;
                        out[o0] = (out[o0] as f64 + g0 * b0) as f32;
                        out[o0 + 1] = (out[o0 + 1] as f64 + g0 * b1) as f32;
                        out[o0 + 2] = (out[o0 + 2] as f64 + g0 * b2) as f32;
                        out[o1] = (out[o1] as f64 + g1 * b0) as f32;
                        out[o1 + 1] = (out[o1 + 1] as f64 + g1 * b1) as f32;
                        out[o1 + 2] = (out[o1 + 2] as f64 + g1 * b2) as f32;
                    }
                }
            }
        }
    }
    Ok(())
}

/// 1-D Gram factor of a glyph source at grid position `p` (0 … n−1) along one axis:
/// `G[a][b] = Σ_{d: 0 ≤ p − d < n} Σ_qa g(qa, d, a) · g(qa, d, b)`, `a, b ∈ {0, 1}` (source quadrant half).
fn gram1d(model: &ResponseModel, p: isize, n: usize) -> [f64; 4] {
    let r = ISI_RADIUS as isize;
    let gq = &model.gq;
    let mut g00 = 0.0;
    let mut g01 = 0.0;
    let mut g11 = 0.0;
    for d in -r..=r {
        let t = p - d;
        if t < 0 || t >= n as isize {
            continue;
        }
        let di = (d + r) as usize;
        for qa in 0..2 {
            let a = gq[(qa * SPAN + di) * 2];
            let b = gq[(qa * SPAN + di) * 2 + 1];
            g00 += a * a;
            g01 += a * b;
            g11 += b * b;
        }
    }
    [g00, g01, g01, g11]
}

/// Edge class of a grid position: `0…R−1` from the low edge, `R` interior, `R+1…` from the high edge.
pub fn edge_class(p: usize, n: usize) -> usize {
    let (p, n, r) = (p as isize, n as isize, ISI_RADIUS as isize);
    let c = if p < r {
        p
    } else if p >= n - r {
        2 * r - (n - 1 - p)
    } else {
        r
    };
    c.max(0) as usize
}

/// Representative position of an edge class for a grid of size `n`.
fn class_position(cls: usize, n: usize) -> isize {
    let (cls, n, r) = (cls as isize, n as isize, ISI_RADIUS as isize);
    if cls < r {
        cls
    } else if cls > r {
        n - 1 - (2 * r - cls)
    } else {
        n / 2
    }
}

/// Full-spread Gram matrices `M = WᵀW` (4 × 4, row-major, quadrant index `qy·2 + qx`) for every
/// (x class, y class): `out[(cy * EDGE_CLASSES + cx) * 16 + a * 4 + b]`.
pub fn spread_grams(model: &ResponseModel, n: usize) -> Vec<f64> {
    let mut out = vec![0f64; EDGE_CLASSES * EDGE_CLASSES * 16];
    let g1: Vec<[f64; 4]> = (0..EDGE_CLASSES)
        .map(|c| gram1d(model, class_position(c, n), n))
        .collect();
    for cy in 0..EDGE_CLASSES {
        for cx in 0..EDGE_CLASSES {
            let gx = &g1[cx];
            let gy = &g1[cy];
            for a in 0..4 {
                for b in 0..4 {
                    out[(cy * EDGE_CLASSES + cx) * 16 + a * 4 + b] =
                        gx[(a & 1) * 2 + (b & 1)] * gy[(a >> 1) * 2 + (b >> 1)];
                }
            }
        }
    }
    out
}

/// The normal operator `WᵀW` restricted to glyph sources, applied directly: `WᵀW` is separable too (it is the 2-D
/// blur Gram), with 1-D kernel `K[d][a][b] = Σ_t Σ_qa g(qa, t, a)·g(qa, t − d, b)`, `d ∈ [−2R, 2R]`, truncated at
/// the grid edges exactly like the forward model. Two 1-D passes of 5 taps × 2 × 2 replace
/// [`predict_features`] + [`adjoint_features`] (four passes); edge rows/columns use per-position kernels.
#[derive(Clone, Debug)]
pub struct NormalOperator {
    n: usize,
    /// `kx[pos][d][a][b]` flattened: per-position kernels for the first and last 2R positions and one interior
    /// kernel.
    kernels: Vec<f64>,
    kernel_index: Vec<usize>,
    tmp: Vec<f32>,
}

impl NormalOperator {
    const R2: usize = 2 * ISI_RADIUS;
    const TAPS: usize = 4 * ISI_RADIUS + 1;

    pub fn new(model: &ResponseModel, n: usize) -> Self {
        let r = ISI_RADIUS as isize;
        let r2 = Self::R2 as isize;
        let taps = Self::TAPS;
        let gq = &model.gq;
        let g = |qa: usize, d: isize, a: usize| -> f64 {
            if d < -r || d > r {
                0.0
            } else {
                gq[(qa * SPAN + (d + r) as usize) * 2 + a]
            }
        };
        // Distinct position classes: 0 … 2R−1 (low edge), 2R (interior), and n−2R … n−1 (high edge).
        let classes = 2 * Self::R2 + 1;
        let mut kernels = vec![0f64; classes * taps * 4];
        let ni = n as isize;
        let kernel_index = (0..ni)
            .map(|p| {
                let c = if p < r2 {
                    p
                } else if p >= ni - r2 {
                    2 * r2 - (ni - 1 - p)
                } else {
                    r2
                };
                c.max(0) as usize
            })
            .collect();
        for cls in 0..classes {
            let cl = cls as isize;
            // Representative output position s (source index whose statistic we compute) and input positions
            // s' = s + d.
            let s = if cl < r2 {
                cl
            } else if cl > r2 {
                ni - 1 - (2 * r2 - cl)
            } else {
                ni / 2
            };
            for d in -r2..=r2 {
                let sp = s + d;
                if sp < 0 || sp >= ni {
                    continue;
                }
                for a in 0..2 {
                    for b in 0..2 {
                        let mut acc = 0.0;
                        // Feature positions t within reach of both s and s'.
                        let t0 = 0.max(s - r).max(sp - r);
                        let t1 = (ni - 1).min(s + r).min(sp + r);
                        for t in t0..=t1 {
                            for qa in 0..2 {
                                acc += g(qa, s - t, a) * g(qa, sp - t, b);
                            }
                        }
                        kernels[((cls * taps + (d + r2) as usize) * 2 + a) * 2 + b] = acc;
                    }
                }
            }
        }
        Self {
            n,
            kernels,
            kernel_index,
            tmp: vec![0f32; n * n * 12],
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    /// `out = WᵀW x` (glyph sources, `n² × 12`).
    pub fn apply(&mut self, x: &[f32], out: &mut [f32]) -> Result<(), LengthMismatch> {
        let n = self.n;
        if x.len() != n * n * 12 || out.len() != n * n * 12 {
            return Err(LengthMismatch);
        }
        let r2 = Self::R2 as isize;
        let taps = Self::TAPS;
        let k = &self.kernels;
        let ki = &self.kernel_index;
        let tmp = &mut self.tmp;
        let ni = n as isize;
        // Pass 1 (x): tmp[y][x][qy][a][ch] = Σ_d Σ_b Kx[x][d][a][b] · x[y][x+d][qy][b][ch].
        for y in 0..n {
            for (xx, &kix) in ki.iter().enumerate() {
                let o = (y * n + xx) * 12;
                let kb = kix * taps;
                let mut t = [0f64; 12];
                let d0 = (-r2).max(-(xx as isize));
                let d1 = r2.min(ni - 1 - xx as isize);
                for d in d0..=d1 {
                    let kk = (kb + (d + r2) as usize) * 4;
                    let k00 = k[kk];
                    let k01 = k[kk + 1];
                    let k10 = k[kk + 2];
                    let k11 = k[kk + 3];
                    let i = (y * n + (xx as isize + d) as usize) * 12;
                    // quadrant index q = qy·2 + qx; channels interleaved: [q*3 + ch].
                    let (a0, a1, a2) = (x[i] as f64, x[i + 1] as f64, x[i + 2] as f64); // q0 (qy0, b0)
                    let (b0, b1, b2) = (x[i + 3] as f64, x[i + 4] as f64, x[i + 5] as f64); // q1 (qy0, b1)
                    let (c0, c1, c2) = (x[i + 6] as f64, x[i + 7] as f64, x[i + 8] as f64); // q2 (qy1, b0)
                    let (e0, e1, e2) = (x[i + 9] as f64, x[i + 10] as f64, x[i + 11] as f64); // q3 (qy1, b1)
                    t[0] += k00 * a0 + k01 * b0;
                    t[1] += k00 * a1 + k01 * b1;
                    t[2] += k00 * a2 + k01 * b2;
                    t[3] += k10 * a0 + k11 * b0;
                    t[4] += k10 * a1 + k11 * b1;
                    t[5] += k10 * a2 + k11 * b2;
                    t[6] += k00 * c0 + k01 * e0;
                    t[7] += k00 * c1 + k01 * e1;
                    t[8] += k00 * c2 + k01 * e2;
                    t[9] += k10 * c0 + k11 * e0;
                    t[10] += k10 * c1 + k11 * e1;
                    t[11] += k10 * c2 + k11 * e2;
                }
                for (dst, v) in tmp[o..o + 12].iter_mut().zip(t) {
                    *dst = v as f32;
                }
            }
        }
        // Pass 2 (y): out[y][x][a_y][qx][ch] = Σ_d Σ_b Ky[y][d][a_y][b] · tmp[y+d][x][b][qx][ch].
        for (y, &kiy) in ki.iter().enumerate() {
            let kb = kiy * taps;
            let d0 = (-r2).max(-(y as isize));
            let d1 = r2.min(ni - 1 - y as isize);
            for xx in 0..n {
                let o = (y * n + xx) * 12;
                let mut t = [0f64; 12];
                for d in d0..=d1 {
                    let kk = (kb + (d + r2) as usize) * 4;
                    let k00 = k[kk];
                    let k01 = k[kk + 1];
                    let k10 = k[kk + 2];
                    let k11 = k[kk + 3];
                    let i = ((y as isize + d) as usize * n + xx) * 12;
                    // Row half b = 0 holds quadrants 0, 1 (offsets 0–5); b = 1 holds quadrants 2, 3 (offsets 6–11).
                    let u: [f64; 6] = std::array::from_fn(|j| tmp[i + j] as f64);
                    let v: [f64; 6] = std::array::from_fn(|j| tmp[i + 6 + j] as f64);
                    for j in 0..6 {
                        t[j] += k00 * u[j] + k01 * v[j];
                        t[6 + j] += k10 * u[j] + k11 * v[j];
                    }
                }
                for (dst, v) in out[o..o + 12].iter_mut().zip(t) {
                    *dst = v as f32;
                }
            }
        }
        Ok(())
    }
}
