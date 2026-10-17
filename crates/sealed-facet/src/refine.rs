//! Model-based homography refinement (spec §7.6 step 2, "estimate homography"). Port of
//! `packages/core/src/facet/refine.ts`.
//!
//! The anchor detector localizes the four anchor centers to a fraction of a cell, but data cells need registration
//! well below 0.1 cell: at σ ≈ 0.6 cell blur the glyph quadrants are only 0.4 cell wide. This module aligns the
//! frame's *known* structure — the four anchors with their quiet-zone surround, and, once a header has decoded,
//! both header strips — to the camera luma by Gauss–Newton on the 8 homography parameters.
//!
//! Prediction: every known cell is a full-cell box of linear luma level ℓ (white = 1, background = 0) blurred by the
//! channel's Gaussian σ; unknown data cells contribute their expected glyph luma. The prediction at a grid point does
//! not depend on H, so it is computed once per (σ, structure). The camera's photometric response is fitted jointly as
//! a quadratic in the predicted level (absorbs gain, offset and tone-curve curvature); points whose prediction depends
//! noticeably on unknown data cells are left out.
//!
//! Negated comparisons (`!(x > y)`) are kept on purpose: they reject NaN like the reference.

#![allow(clippy::neg_cmp_op_on_partial_ord)]

use std::sync::{Arc, Mutex};

use crate::glyphs::{GLYPH_MARGIN, mean_fill};
use crate::header::HEADER_BITS;
use crate::homography::solve_linear;
use crate::layout::{CellKind, GridLayout, QUIET_CELLS};
use crate::model::box_response;
use crate::types::{Homography, LumaPlane};

/// Sample pitch in cells (4 samples per cell per axis, at cell offsets 0.125, 0.375, 0.625, 0.875).
const SUB: usize = 4;
const OFFSETS: [f64; SUB] = [0.125, 0.375, 0.625, 0.875];
/// Cells beyond this distance do not affect a sample (Gaussian tail < 0.1 % for σ ≤ 0.8).
const REACH: usize = 3;
const REACH_I: i64 = REACH as i64;
/// Points whose prediction has more than this much luma from unknown data cells are not used.
const MAX_DATA_INFLUENCE: f64 = 0.04;
const ITERATIONS: usize = 6;
/// Entries kept by the `anchor_points` cache.
const CACHE_ENTRIES: usize = 32;

/// Expected linear luma of a data cell relative to white, averaged over glyphs and the palette (≈ 0.6 luma).
fn mean_glyph_level() -> f64 {
    0.5 * (mean_fill(4) + mean_fill(8)) * 0.6
}

/// Sample points of the known structure with their predicted luma.
#[derive(Clone, Debug, PartialEq)]
pub struct RefinePoints {
    /// Grid coordinates of the sample points (x, y interleaved).
    pub xy: Vec<f64>,
    /// Predicted linear luma level (white = 1, background = 0).
    pub pred: Vec<f64>,
}

struct CellLevels {
    /// Level of each cell in [-1 = unknown data, 0 … 1 = known full-cell level]; index (y + Q) * M + (x + Q).
    level: Vec<f32>,
    m: usize,
}

/// 1-D responses: resp[sub][d + REACH] = mean response of a box at cell offset d to sample sub.
fn responses(sigma: f64, lo: f64, hi: f64) -> [[f64; 2 * REACH + 1]; SUB] {
    let mut out = [[0.0f64; 2 * REACH + 1]; SUB];
    for (r, &o) in out.iter_mut().zip(OFFSETS.iter()) {
        for d in -REACH_I..=REACH_I {
            r[(d + REACH_I) as usize] = box_response(o, d as f64 + lo, d as f64 + hi, sigma);
        }
    }
    out
}

fn levels(layout: &GridLayout, strips: Option<&[u8]>) -> CellLevels {
    let n = layout.n;
    let q = QUIET_CELLS + REACH;
    let m = n + 2 * q;
    let mut level = vec![0.0f32; m * m]; // quiet zone and beyond: background (0)
    for y in 0..n {
        for x in 0..n {
            let c = y * n + x;
            let mut v = -1.0f32;
            if layout.kind.get(c).copied() == Some(CellKind::Anchor as u8) {
                v = if layout.anchor_light.get(c).copied().unwrap_or(0) != 0 {
                    1.0
                } else {
                    0.0
                };
            }
            level[(y + q) * m + x + q] = v;
        }
    }
    if let Some(strips) = strips {
        for i in 0..layout.header_top.len() {
            // Missing strip bits read as 0 (the reference would read `undefined`).
            let bit = if i < HEADER_BITS {
                strips.get(i).copied().unwrap_or(0) as f32
            } else {
                (i & 1) as f32
            };
            for cells in [&layout.header_top, &layout.header_bottom] {
                let Some(&c) = cells.get(i) else {
                    continue;
                };
                let c = c as usize;
                if c >= n * n {
                    continue;
                }
                level[(c / n + q) * m + (c % n) + q] = bit;
            }
        }
    }
    CellLevels { level, m }
}

/// Sample points and predictions for the known structure. With `strips` (header strip bits, strip order), header
/// cells are known too.
pub fn refine_points(layout: &GridLayout, sigma: f64, strips: Option<&[u8]>) -> RefinePoints {
    let n = layout.n as i64;
    let q_i = (QUIET_CELLS + REACH) as i64;
    let CellLevels { level, m } = levels(layout, strips);
    let m_i = m as i64;
    let full = responses(sigma, 0.0, 1.0);
    let glyph = responses(sigma, GLYPH_MARGIN, 1.0 - GLYPH_MARGIN);
    let mean_glyph = mean_glyph_level();
    let mut xs: Vec<f64> = Vec::new();
    let mut preds: Vec<f64> = Vec::new();
    let mut visit = |cx: i64, cy: i64| {
        for sy in 0..SUB {
            for sx in 0..SUB {
                let mut p = 0.0;
                let mut data = 0.0;
                for dy in -REACH_I..=REACH_I {
                    let yy = cy + dy;
                    let ry = full[sy][(REACH_I - dy) as usize];
                    let gy = glyph[sy][(REACH_I - dy) as usize];
                    for dx in -REACH_I..=REACH_I {
                        let xx = cx + dx;
                        let idx = (yy + q_i) * m_i + xx + q_i;
                        let v = if idx >= 0 {
                            level.get(idx as usize).copied().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        if v == 0.0 {
                            continue;
                        }
                        if v < 0.0 {
                            let w = mean_glyph * glyph[sx][(REACH_I - dx) as usize] * gy;
                            p += w;
                            data += w;
                        } else {
                            p += v as f64 * full[sx][(REACH_I - dx) as usize] * ry;
                        }
                    }
                }
                if data > MAX_DATA_INFLUENCE {
                    continue;
                }
                xs.push(cx as f64 + OFFSETS[sx]);
                xs.push(cy as f64 + OFFSETS[sy]);
                preds.push(p);
            }
        }
    };
    let a = 8i64;
    let q = QUIET_CELLS as i64;
    // Anchors with the quiet zone on their two outer sides.
    let mut regions: Vec<[i64; 4]> = vec![
        [-q, -q, a, a],
        [n - a, -q, n + q, a],
        [n - a, n - a, n + q, n + q],
        [-q, n - a, a, n + q],
    ];
    if strips.is_some() {
        regions.push([a, -q, n - a, 2]);
        regions.push([a, n - 2, n - a, n + q]);
    }
    for [x0, y0, x1, y1] in regions {
        for y in y0..y1 {
            for x in x0..x1 {
                visit(x, y);
            }
        }
    }
    RefinePoints {
        xy: xs,
        pred: preds,
    }
}

type PointCache = Vec<((usize, u64), Arc<RefinePoints>)>;

fn point_cache() -> &'static Mutex<PointCache> {
    static CACHE: Mutex<PointCache> = Mutex::new(Vec::new());
    &CACHE
}

/// `Math.round`: half rounds toward +∞.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// Anchor-only points, cached per (grid, σ rounded to 1/50).
pub fn anchor_points(layout: &GridLayout, sigma: f64) -> Arc<RefinePoints> {
    let rounded = js_round(sigma * 50.0);
    let key = (layout.n, rounded.to_bits());
    let mut cache = point_cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, p)) = cache.iter().find(|(k, _)| *k == key) {
        return Arc::clone(p);
    }
    let p = Arc::new(refine_points(layout, rounded / 50.0, None));
    cache.push((key, Arc::clone(&p)));
    if cache.len() > CACHE_ENTRIES {
        cache.remove(0);
    }
    p
}

/// Bilinear sample with gradient (pixel i spans [i, i + 1]); `None` outside.
#[inline]
fn sample_grad(l: &LumaPlane, u: f64, v: f64) -> Option<[f64; 3]> {
    let x = u - 0.5;
    let y = v - 0.5;
    let wf = l.width as f64;
    let hf = l.height as f64;
    if !(x >= 0.0 && y >= 0.0 && x < wf - 1.0 && y < hf - 1.0) {
        return None;
    }
    let x0 = x as usize;
    let y0 = y as usize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let w = l.width;
    let d = &l.data;
    let i = y0 * w + x0;
    let a = d[i] as f64;
    let b = d[i + 1] as f64;
    let c = d[i + w] as f64;
    let e = d[i + w + 1] as f64;
    Some([
        a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy,
        (b - a) + (a - b - c + e) * fy,
        (c - a) + (a - b - c + e) * fx,
    ])
}

#[derive(Clone, Debug, PartialEq)]
pub struct RefineResult {
    pub h: Homography,
    /// RMS residual relative to the fitted white-to-background luma span.
    pub rms: f64,
    /// Number of points used in the final iteration.
    pub used: usize,
}

/// Gauss–Newton refinement of `h0` (grid → image) so the camera luma matches the predicted known structure.
/// Returns `None` when the fit is degenerate (too few points inside the image, no contrast, divergence) or the
/// luma plane's buffer is shorter than its dimensions.
pub fn refine_homography(
    luma: &LumaPlane,
    h0: &Homography,
    pts: &RefinePoints,
) -> Option<RefineResult> {
    if luma.data.len() < luma.width * luma.height {
        return None;
    }
    let mut h = *h0;
    let n = pts.pred.len();
    if n < 64 || pts.xy.len() < 2 * n {
        return None;
    }
    let mut obs = vec![0.0f64; n];
    let mut gu = vec![0.0f64; n];
    let mut gv = vec![0.0f64; n];
    let mut inside = vec![false; n];
    let mut rms = f64::INFINITY;
    let mut used = 0usize;
    for _ in 0..ITERATIONS {
        // Sample at the current pose.
        used = 0;
        for i in 0..n {
            let x = pts.xy[2 * i];
            let y = pts.xy[2 * i + 1];
            let w = h[6] * x + h[7] * y + h[8];
            inside[i] = false;
            if !(w > 1e-12) {
                continue;
            }
            let u = (h[0] * x + h[1] * y + h[2]) / w;
            let v = (h[3] * x + h[4] * y + h[5]) / w;
            let Some(g) = sample_grad(luma, u, v) else {
                continue;
            };
            obs[i] = g[0];
            gu[i] = g[1];
            gv[i] = g[2];
            inside[i] = true;
            used += 1;
        }
        if (used as f64) < 64f64.max(0.6 * n as f64) {
            return None;
        }
        // Photometric fit: obs ≈ p0 + p1·pred + p2·pred².
        let photo = {
            let mut gm = [0.0f64; 9];
            let mut bv = [0.0f64; 3];
            for i in 0..n {
                if !inside[i] {
                    continue;
                }
                let p = pts.pred[i];
                let f = [1.0, p, p * p];
                for a in 0..3 {
                    bv[a] += f[a] * obs[i];
                    for b in 0..3 {
                        gm[a * 3 + b] += f[a] * f[b];
                    }
                }
            }
            let sol = solve_linear(&gm, &bv, 3)?;
            [sol[0], sol[1], sol[2]]
        };
        let span = photo[1] + photo[2];
        if !(span > 0.02) || !(photo[1] > 0.0) {
            return None;
        }
        // Normal equations for the 8 homography parameters.
        let mut jtj = [0.0f64; 64];
        let mut jtr = [0.0f64; 8];
        let mut jac = [0.0f64; 8];
        let mut se = 0.0;
        for i in 0..n {
            if !inside[i] {
                continue;
            }
            let x = pts.xy[2 * i];
            let y = pts.xy[2 * i + 1];
            let p = pts.pred[i];
            let r = obs[i] - (photo[0] + photo[1] * p + photo[2] * p * p);
            se += r * r;
            let w = h[6] * x + h[7] * y + h[8];
            let u = (h[0] * x + h[1] * y + h[2]) / w;
            let v = (h[3] * x + h[4] * y + h[5]) / w;
            let a = gu[i];
            let b = gv[i];
            // d(obs)/dh_k = a·du/dh_k + b·dv/dh_k.
            jac[0] = (a * x) / w;
            jac[1] = (a * y) / w;
            jac[2] = a / w;
            jac[3] = (b * x) / w;
            jac[4] = (b * y) / w;
            jac[5] = b / w;
            jac[6] = (-(a * u + b * v) * x) / w;
            jac[7] = (-(a * u + b * v) * y) / w;
            for k in 0..8 {
                let jk = jac[k];
                jtr[k] += jk * r;
                for l in k..8 {
                    jtj[k * 8 + l] += jk * jac[l];
                }
            }
        }
        rms = (se / used as f64).sqrt() / span;
        for k in 0..8 {
            for l in 0..k {
                jtj[k * 8 + l] = jtj[l * 8 + k];
            }
        }
        // Jacobi scaling plus light Levenberg damping.
        let mut scale = [0.0f64; 8];
        for (k, s) in scale.iter_mut().enumerate() {
            *s = 1.0 / jtj[k * 8 + k].max(1e-30).sqrt();
        }
        let mut amat = [0.0f64; 64];
        let mut rhs = [0.0f64; 8];
        for k in 0..8 {
            rhs[k] = jtr[k] * scale[k];
            for l in 0..8 {
                amat[k * 8 + l] = jtj[k * 8 + l] * scale[k] * scale[l];
            }
            amat[k * 8 + k] *= 1.001;
        }
        let step = solve_linear(&amat, &rhs, 8)?;
        // r = obs − model and obs(h + δ) ≈ obs + Jδ, so the step that zeroes the residual is δ = −(JᵀJ)⁻¹ Jᵀr.
        for k in 0..8 {
            h[k] -= step[k] * scale[k];
        }
        if h[..8].iter().any(|v| !v.is_finite()) {
            return None;
        }
        // Converged when the normalized step is tiny (well below 0.01 pixel at the grid's extent).
        if step_size(&step) < 1e-3 {
            break;
        }
    }
    Some(RefineResult { h, rms, used })
}

/// Largest component of a Jacobi-scaled step (≈ residual-weighted parameter change).
fn step_size(step: &[f64]) -> f64 {
    step.iter().take(8).fold(0.0f64, |m, v| m.max(v.abs()))
}
