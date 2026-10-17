//! Channel calibration (spec §7.5 calibration frame, §7.6 step 5). Port of `packages/core/src/facet/calibrate.ts`.
//!
//! The receiver models the camera as: screen linear light → optical blur (Gaussian, σ cells) → 3 × 3 color mixing
//! → per-channel tone curve → code values. Calibration recovers, in order:
//!   1. a per-channel tone LUT (code → value affine in the camera's linear input) from the gray ramps: a
//!      monotone (pool-adjacent-violators) piecewise-linear map from sRGB-decoded codes to ramp levels, so any
//!      tone curve — not only a power law — is linearized;
//!   2. the blur σ and an affine 3 × 4 color-correction matrix X mapping LUT values to screen-domain excess,
//!      fitted jointly by least squares over every quadrant feature of the frame (all cells are known), with σ
//!      chosen by a 1-D search minimizing the residual;
//!   3. calibrated palette centroids (screen-domain excess per color), estimated from the glyph cells after
//!      cancelling inter-symbol interference.
//!
//! Solvers run in `f64`; feature, LUT and centroid storage is `f32`, exactly as the JavaScript typed arrays.

use std::sync::LazyLock;

use crate::glyphs::glyph_fills;
use crate::grid::{PIC_BG, PIC_GRAY_BASE, PIC_WHITE};
use crate::homography::solve_linear;
use crate::layout::{CellKind, GridLayout, calibration_layout};
use crate::model::{SourceGrid, new_source_grid, predict_features, response_model};
use crate::palette::{
    GRAY_RAMP, linear_background, linear_white, palette_excess, srgb_to_linear_8,
};
use crate::sample::{CellSamples, ChannelLut, LUT_LEN, code_lut, linear_lut, sample_cells};
use crate::types::{Homography, RgbaImage};

/// Linear-light excess of a white cell over the background, per channel (`f64`, as the JavaScript computes it
/// from the `f32` palette values).
pub static WHITE_EXCESS: LazyLock<[f64; 3]> = LazyLock::new(|| {
    let w = linear_white();
    let bg = linear_background();
    [
        w[0] as f64 - bg[0] as f64,
        w[1] as f64 - bg[1] as f64,
        w[2] as f64 - bg[2] as f64,
    ]
});

pub const DEFAULT_SIGMA: f64 = 0.35;
const SIGMA_MIN: f64 = 0.1;
const SIGMA_MAX: f64 = 0.8;

#[derive(Clone, Debug, PartialEq)]
pub struct ChannelCalibration {
    /// Code → tone-linearized value per channel.
    pub lut: ChannelLut,
    /// 3 × 4 row-major affine map from LUT values to screen-domain excess.
    pub x: [f64; 12],
    /// Effective blur in cells.
    pub sigma: f64,
    /// True when fitted from a calibration (or fully decoded) frame.
    pub fitted: bool,
    /// RMS residual of the fit, in units of the white excess (NaN until fitted).
    pub rms: f64,
}

pub fn default_calibration() -> ChannelCalibration {
    let mut x = [0f64; 12];
    let bg = linear_background();
    for ch in 0..3 {
        x[ch * 4 + ch] = 1.0;
        x[ch * 4 + 3] = -(bg[ch] as f64);
    }
    ChannelCalibration {
        lut: *linear_lut(),
        x,
        sigma: DEFAULT_SIGMA,
        fitted: false,
        rms: f64::NAN,
    }
}

/// Applies X to sampled features (into a new array). NaN stays NaN. Trailing features that do not form a whole
/// RGB triple are left zero.
pub fn correct_features(s: &CellSamples, x: &[f64; 12]) -> Vec<f32> {
    let f = &s.feat;
    let mut out = vec![0f32; f.len()];
    for (o, v) in out.chunks_exact_mut(3).zip(f.chunks_exact(3)) {
        let a = v[0] as f64;
        let b = v[1] as f64;
        let c = v[2] as f64;
        o[0] = (x[0] * a + x[1] * b + x[2] * c + x[3]) as f32;
        o[1] = (x[4] * a + x[5] * b + x[6] * c + x[7]) as f32;
        o[2] = (x[8] * a + x[9] * b + x[10] * c + x[11]) as f32;
    }
    out
}

/// Why a cell source could not be set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceError {
    /// A picture code that is neither a glyph symbol nor one of the `PIC_*` codes.
    UnknownPictureCode(i16),
    /// The cell index is outside the source grid.
    CellOutOfRange,
    /// The symbol's color index is beyond the centroid table.
    ColorOutOfRange,
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownPictureCode(v) => write!(f, "unknown picture code {v}"),
            Self::CellOutOfRange => f.write_str("cell index outside the grid"),
            Self::ColorOutOfRange => f.write_str("color index beyond the centroid table"),
        }
    }
}

impl std::error::Error for SourceError {}

/// Source grid for a fully known cell picture (`PIC_*` codes / glyph symbols). `None` if `pic` is shorter than
/// `n²` or holds an unknown code.
pub fn source_from_picture(pic: &[i16], n: usize, centroids: &[f32]) -> Option<SourceGrid> {
    let cells = n * n;
    if pic.len() < cells {
        return None;
    }
    let mut src = new_source_grid(n);
    for (c, &v) in pic[..cells].iter().enumerate() {
        set_source(&mut src, c, v, centroids).ok()?;
    }
    Some(src)
}

/// Sets the source of cell `c` from a picture code.
pub fn set_source(
    src: &mut SourceGrid,
    c: usize,
    v: i16,
    centroids: &[f32],
) -> Result<(), SourceError> {
    if c >= src.n * src.n || src.q.len() < (c + 1) * 12 || src.f.len() < (c + 1) * 3 {
        return Err(SourceError::CellOutOfRange);
    }
    let qo = c * 12;
    let fo = c * 3;
    if v >= 0 {
        let k = (v >> 4) as usize;
        let s = (v & 15) as usize;
        if centroids.len() < (k + 1) * 3 {
            return Err(SourceError::ColorOutOfRange);
        }
        let fills = glyph_fills(centroids.len() / 3);
        for q in 0..4 {
            let fill = fills[s * 4 + q] as f64;
            for ch in 0..3 {
                src.q[qo + q * 3 + ch] = (fill * centroids[k * 3 + ch] as f64) as f32;
            }
        }
        src.f[fo..fo + 3].fill(0.0);
        return Ok(());
    }
    src.q[qo..qo + 12].fill(0.0);
    let level = if v == PIC_WHITE {
        1.0
    } else if v <= PIC_GRAY_BASE {
        GRAY_RAMP
            .get((PIC_GRAY_BASE - v) as usize)
            .copied()
            .unwrap_or(0.0)
    } else if v == PIC_BG {
        0.0
    } else {
        return Err(SourceError::UnknownPictureCode(v));
    };
    for (dst, &we) in src.f[fo..fo + 3].iter_mut().zip(WHITE_EXCESS.iter()) {
        *dst = (level * we) as f32;
    }
    Ok(())
}

struct AffineFit {
    x: [f64; 12],
    mse: f64,
}

/// Least-squares X (3 × 4) mapping observations to predictions over valid cells; returns X and the mean squared
/// residual.
fn fit_affine(obs: &[f32], pred: &[f32], valid: &[u8], cells: &[usize]) -> Option<AffineFit> {
    let mut g = [0f64; 16];
    let mut b = [0f64; 12]; // 4 × 3
    let mut count = 0usize;
    for &c in cells {
        if valid.get(c).copied().unwrap_or(0) == 0 {
            continue;
        }
        let base = c * 12;
        let (o_cell, p_cell) = (obs.get(base..base + 12)?, pred.get(base..base + 12)?);
        for (ov, pv) in o_cell.chunks_exact(3).zip(p_cell.chunks_exact(3)) {
            let vv = [ov[0] as f64, ov[1] as f64, ov[2] as f64, 1.0];
            for i in 0..4 {
                let vi = vv[i];
                for j in 0..4 {
                    g[i * 4 + j] += vi * vv[j];
                }
                for ch in 0..3 {
                    b[i * 3 + ch] += vi * pv[ch] as f64;
                }
            }
            count += 1;
        }
    }
    if count < 64 {
        return None;
    }
    let mut x = [0f64; 12];
    for ch in 0..3 {
        let rhs = [b[ch], b[3 + ch], b[6 + ch], b[9 + ch]];
        let sol = solve_linear(&g, &rhs, 4)?;
        x[ch * 4..ch * 4 + 4].copy_from_slice(&sol[..4]);
    }
    let mut se = 0f64;
    for &c in cells {
        if valid[c] == 0 {
            continue;
        }
        let base = c * 12;
        for (ov, pv) in obs[base..base + 12]
            .chunks_exact(3)
            .zip(pred[base..base + 12].chunks_exact(3))
        {
            let v0 = ov[0] as f64;
            let v1 = ov[1] as f64;
            let v2 = ov[2] as f64;
            for ch in 0..3 {
                let e = x[ch * 4] * v0 + x[ch * 4 + 1] * v1 + x[ch * 4 + 2] * v2 + x[ch * 4 + 3]
                    - pv[ch] as f64;
                se += e * e;
            }
        }
    }
    Some(AffineFit {
        x,
        mse: se / (count * 3) as f64,
    })
}

/// Pool-adjacent-violators: non-decreasing fit of `ys` (sorted by their abscissae) with weights `ws`.
fn isotonic(ys: &[f64], ws: &[f64]) -> Vec<f64> {
    let mut vals: Vec<f64> = Vec::with_capacity(ys.len());
    let mut wts: Vec<f64> = Vec::with_capacity(ys.len());
    let mut lens: Vec<usize> = Vec::with_capacity(ys.len());
    for (&y, &w) in ys.iter().zip(ws) {
        vals.push(y);
        wts.push(w);
        lens.push(1);
        while vals.len() > 1 && vals[vals.len() - 2] > vals[vals.len() - 1] {
            let k = vals.len() - 2;
            let w = wts[k] + wts[k + 1];
            let v = (vals[k] * wts[k] + vals[k + 1] * wts[k + 1]) / w;
            let l = lens[k] + lens[k + 1];
            vals.truncate(k);
            wts.truncate(k);
            lens.truncate(k);
            vals.push(v);
            wts.push(w);
            lens.push(l);
        }
    }
    let mut out = Vec::with_capacity(ys.len());
    for (v, &l) in vals.iter().zip(&lens) {
        out.extend(std::iter::repeat_n(*v, l));
    }
    out
}

/// One gray-ramp observation: mean sampled code fraction per channel and the predicted screen-domain target.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TonePoint {
    pub code: [f64; 3],
    pub target: [f64; 3],
}

/// `(a, b) => a - b` under a stable sort: NaN differences compare as equal.
fn js_cmp_f64(a: f64, b: f64) -> std::cmp::Ordering {
    let d = a - b;
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// Builds the tone LUT from gray-ramp observations: per channel, points (sRGB-decoded mean code, target level).
/// Targets are the predicted screen-domain values (ramp level × white excess plus blur leakage). `None` when
/// the points cannot support a monotone fit (too few, too narrow, or not increasing).
pub fn fit_tone_lut(points: &[TonePoint]) -> Option<ChannelLut> {
    if points.len() < 6 {
        return None;
    }
    let s8 = srgb_to_linear_8();
    let mut lut = [0f32; LUT_LEN];
    for ch in 0..3 {
        let mut pts: Vec<(f64, f64)> = points
            .iter()
            .map(|p| (srgb_decode_continuous(p.code[ch]), p.target[ch]))
            .collect();
        pts.sort_by(|a, b| js_cmp_f64(a.0, b.0));
        // Merge near-identical abscissae to avoid zero-length segments.
        let mut xs: Vec<f64> = Vec::new();
        let mut ys: Vec<f64> = Vec::new();
        let mut ws: Vec<f64> = Vec::new();
        for (s, t) in pts {
            match xs.len().checked_sub(1) {
                Some(last) if s - xs[last] < 1e-4 => {
                    let w = ws[last] + 1.0;
                    xs[last] = (xs[last] * ws[last] + s) / w;
                    ys[last] = (ys[last] * ws[last] + t) / w;
                    ws[last] = w;
                }
                _ => {
                    xs.push(s);
                    ys.push(t);
                    ws.push(1.0);
                }
            }
        }
        if xs.len() < 4 {
            return None;
        }
        let mono = isotonic(&ys, &ws);
        let last_idx = xs.len() - 1;
        let span = xs[last_idx] - xs[0];
        if span.is_nan()
            || span <= 0.05
            || mono[last_idx].is_nan()
            || mono[0].is_nan()
            || mono[last_idx] <= mono[0]
        {
            return None;
        }
        for code in 0..256 {
            let s = s8[code] as f64;
            let mut i = 0;
            while i < last_idx - 1 && s > xs[i + 1] {
                i += 1;
            }
            let x0 = xs[i];
            let x1 = xs[i + 1];
            let y0 = mono[i];
            let y1 = mono[i + 1];
            let slope = if x1 > x0 { (y1 - y0) / (x1 - x0) } else { 0.0 };
            lut[ch * 256 + code] = (y0 + slope * (s - x0)) as f32;
        }
    }
    Some(lut)
}

/// sRGB EOTF of a code fraction, clamped to [0, 1] (NaN stays NaN, as `Math.min`/`Math.max` propagate it).
fn srgb_decode_continuous(code_fraction: f64) -> f64 {
    let v = if code_fraction.is_nan() {
        f64::NAN
    } else {
        code_fraction.clamp(0.0, 1.0)
    };
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CalibrationFit {
    pub channel: ChannelCalibration,
    /// Calibrated palette centroids (`K × 3`).
    pub centroids: Vec<f32>,
}

/// Fits the channel from a frame whose every cell is known (`pic`). `is_calibration_frame` enables the tone fit
/// from the gray ramps; otherwise the existing LUT is kept (decision-directed refresh from a decoded frame).
///
/// `None` when sampling fails, too few cells are valid, the tone fit is unsupported or the least-squares system
/// is singular.
pub fn fit_channel(
    img: &RgbaImage<'_>,
    h: &Homography,
    layout: &GridLayout,
    pic: &[i16],
    prev: &ChannelCalibration,
    prev_centroids: &[f32],
    is_calibration_frame: bool,
) -> Option<CalibrationFit> {
    let n = layout.n;
    if pic.len() < n * n || layout.kind.len() < n * n {
        return None;
    }
    let tier = layout.tier;
    let nominal = palette_excess(tier as u8);
    let cells: Vec<usize> = (0..n * n).collect();
    let mut lut = prev.lut;
    let sigma0 = if prev.fitted {
        prev.sigma
    } else {
        DEFAULT_SIGMA
    };
    if is_calibration_frame {
        let cal = calibration_layout(tier);
        let centers: Vec<u32> = cal.ramp_centers.iter().map(|r| r.cell as u32).collect();
        let codes = sample_cells(img, h, n, code_lut(), Some(&centers))?;
        let src = source_from_picture(pic, n, &nominal)?;
        let pred = predict_features(&response_model(sigma0), &src).ok()?;
        let mut pts: Vec<TonePoint> = Vec::with_capacity(centers.len());
        for &c in &centers {
            let c = c as usize;
            if codes.valid[c] == 0 {
                continue;
            }
            let mut code = [0f64; 3];
            let mut target = [0f64; 3];
            for q in 0..4 {
                for ch in 0..3 {
                    let o = c * 12 + q * 3 + ch;
                    code[ch] += codes.feat[o] as f64 / 4.0;
                    target[ch] += pred[o] as f64 / 4.0;
                }
            }
            pts.push(TonePoint { code, target });
        }
        lut = fit_tone_lut(&pts)?;
    }
    let samples = sample_cells(img, h, n, &lut, None)?;
    let valid_count: usize = samples.valid.iter().map(|&v| v as usize).sum();
    if (valid_count as f64) < (n * n) as f64 * 0.9 {
        return None;
    }

    let mut centroids: Vec<f32> = if prev_centroids.len() == nominal.len() {
        prev_centroids.to_vec()
    } else {
        nominal.clone()
    };
    let eval_sigma = |sigma: f64, centroids: &[f32]| -> Option<AffineFit> {
        let src = source_from_picture(pic, n, centroids)?;
        let pred = predict_features(&response_model(sigma), &src).ok()?;
        fit_affine(&samples.feat, &pred, &samples.valid, &cells)
    };
    // Coarse-to-fine search for σ.
    let lo = if prev.fitted {
        SIGMA_MIN.max(sigma0 - 0.15)
    } else {
        SIGMA_MIN
    };
    let hi = if prev.fitted {
        SIGMA_MAX.min(sigma0 + 0.15)
    } else {
        SIGMA_MAX
    };
    let mut best_sigma = sigma0;
    let mut best: Option<AffineFit> = None;
    let mut s = lo;
    while s <= hi + 1e-9 {
        if let Some(r) = eval_sigma(s, &centroids)
            && best.as_ref().is_none_or(|b| r.mse < b.mse)
        {
            best = Some(r);
            best_sigma = s;
        }
        s += 0.05;
    }
    let mut best = best?;
    for step in [0.02, 0.01] {
        for s in [best_sigma - step, best_sigma + step] {
            if !(SIGMA_MIN..=SIGMA_MAX).contains(&s) {
                continue;
            }
            if let Some(r) = eval_sigma(s, &centroids)
                && r.mse < best.mse
            {
                best = r;
                best_sigma = s;
            }
        }
    }
    // Calibrated centroids: per color, least squares of the ISI-cancelled residual against the glyph's self
    // response.
    let corrected = correct_features(&samples, &best.x);
    let model = response_model(best_sigma);
    let src = source_from_picture(pic, n, &centroids)?;
    let pred = predict_features(&model, &src).ok()?;
    let colors = nominal.len() / 3;
    let tier_fills = glyph_fills(colors);
    let mut num = vec![0f64; colors * 3];
    let mut den = vec![0f64; colors];
    let mut a = [0f64; 4];
    for (c, &v) in pic[..n * n].iter().enumerate() {
        if v < 0 || layout.kind[c] != CellKind::Data as u8 || samples.valid[c] == 0 {
            continue;
        }
        let k = (v >> 4) as usize;
        let s = (v & 15) as usize;
        if k >= colors {
            return None;
        }
        for (q, aq) in a.iter_mut().enumerate() {
            let mut acc = 0f64;
            for qs in 0..4 {
                acc += model.w0[q * 4 + qs] * tier_fills[s * 4 + qs] as f64;
            }
            *aq = acc;
        }
        for (q, &aq) in a.iter().enumerate() {
            den[k] += aq * aq;
            for ch in 0..3 {
                let o = c * 12 + q * 3 + ch;
                let own = aq * centroids[k * 3 + ch] as f64;
                let r = corrected[o] as f64 - pred[o] as f64 + own;
                num[k * 3 + ch] += aq * r;
            }
        }
    }
    let mut refined = vec![0f32; colors * 3];
    for k in 0..colors {
        let mut dev = 0f64;
        let mut mag = 0f64;
        for ch in 0..3 {
            let est = if den[k] > 0.0 {
                num[k * 3 + ch] / den[k]
            } else {
                nominal[k * 3 + ch] as f64
            };
            refined[k * 3 + ch] = est as f32;
            dev += (est - nominal[k * 3 + ch] as f64).powi(2);
            mag += (nominal[k * 3 + ch] as f64).powi(2);
        }
        // A centroid far from its nominal color means a broken fit; keep the nominal one.
        if dev > 0.25 * mag {
            refined[k * 3..k * 3 + 3].copy_from_slice(&nominal[k * 3..k * 3 + 3]);
        }
    }
    centroids = refined;
    let we = &*WHITE_EXCESS;
    let white_norm = we[0] * we[0] + we[1] * we[1] + we[2] * we[2];
    Some(CalibrationFit {
        channel: ChannelCalibration {
            lut,
            x: best.x,
            sigma: best_sigma,
            fitted: true,
            rms: ((best.mse * 3.0) / white_norm).sqrt(),
        },
        centroids,
    })
}

/// Per-frame fallback before any calibration: per-channel gain/offset from the TL anchor's light center and the
/// BL anchor's dark interior, with the sRGB EOTF as tone curve. `None` if either reference is not visible or
/// the two are not separated.
pub fn anchor_calibration(
    img: &RgbaImage<'_>,
    h: &Homography,
    layout: &GridLayout,
    base: &ChannelCalibration,
) -> Option<ChannelCalibration> {
    let n = layout.n;
    if n < 5 {
        return None;
    }
    // Inner 2 × 2 of TL's 4 × 4 light center (≥ 1 cell from any edge), and the center of BL's 6 × 6 dark interior.
    let light = [3 * n + 3, 3 * n + 4, 4 * n + 3, 4 * n + 4];
    let dark = [
        (n - 5) * n + 3,
        (n - 5) * n + 4,
        (n - 4) * n + 3,
        (n - 4) * n + 4,
    ];
    let subset: Vec<u32> = light.iter().chain(&dark).map(|&c| c as u32).collect();
    let s = sample_cells(img, h, n, &base.lut, Some(&subset))?;
    let mean = |cells: &[usize; 4]| -> Option<[f64; 3]> {
        let mut m = [0f64; 3];
        let mut cnt = 0usize;
        for &c in cells {
            if s.valid[c] == 0 {
                continue;
            }
            for q in s.feat[c * 12..c * 12 + 12].chunks_exact(3) {
                for (dst, &f) in m.iter_mut().zip(q) {
                    *dst += f as f64;
                }
            }
            cnt += 4;
        }
        if cnt == 0 {
            return None;
        }
        let cf = cnt as f64;
        Some([m[0] / cf, m[1] / cf, m[2] / cf])
    };
    let w = mean(&light)?;
    let d = mean(&dark)?;
    // Expected screen-domain values: the light center is fully lit (white excess), the dark interior is
    // background.
    let we = &*WHITE_EXCESS;
    let mut x = [0f64; 12];
    for ch in 0..3 {
        let span = w[ch] - d[ch];
        if span.is_nan() || span <= 1e-3 {
            return None;
        }
        let gain = we[ch] / span;
        x[ch * 4 + ch] = gain;
        x[ch * 4 + 3] = -gain * d[ch];
    }
    Some(ChannelCalibration {
        lut: base.lut,
        x,
        sigma: base.sigma,
        fitted: false,
        rms: f64::NAN,
    })
}
