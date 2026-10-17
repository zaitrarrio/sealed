//! Rectified sampling of the grid (spec §7.6 step 4). Port of `packages/core/src/facet/sample.ts`.
//!
//! For every cell, every quadrant feature is the mean of 3 × 3 bilinear samples around the quadrant center
//! ([`SAMPLE_OFFSETS`]). Pixel codes are mapped through a per-channel lookup table *before* interpolation so
//! tone-curve correction acts per pixel.

use std::sync::OnceLock;

use crate::homography::project;
use crate::model::SAMPLE_OFFSETS;
use crate::palette::srgb_to_linear_8;
use crate::types::{Homography, RgbaImage};

/// Length of a [`ChannelLut`]: three channels × 256 codes.
pub const LUT_LEN: usize = 3 * 256;

/// Per-channel code → value table: `lut[ch * 256 + code]`.
pub type ChannelLut = [f32; LUT_LEN];

/// sRGB EOTF for all three channels.
pub fn linear_lut() -> &'static ChannelLut {
    static T: OnceLock<ChannelLut> = OnceLock::new();
    T.get_or_init(|| {
        let s = srgb_to_linear_8();
        let mut t = [0f32; LUT_LEN];
        for ch in 0..3 {
            t[ch * 256..ch * 256 + 256].copy_from_slice(s);
        }
        t
    })
}

/// Code values scaled to `[0, 1]` (used to measure tone curves).
pub fn code_lut() -> &'static ChannelLut {
    static T: OnceLock<ChannelLut> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0f32; LUT_LEN];
        for ch in 0..3 {
            for i in 0..256 {
                t[ch * 256 + i] = (i as f64 / 255.0) as f32;
            }
        }
        t
    })
}

/// Sampled quadrant features of an N × N grid.
#[derive(Clone, Debug, PartialEq)]
pub struct CellSamples {
    pub n: usize,
    /// `[cell * 12 + q * 3 + ch]`; NaN where a sample fell outside the image.
    pub feat: Vec<f32>,
    /// 1 where all of the cell's samples were inside the image.
    pub valid: Vec<u8>,
}

/// Per axis: quadrant half, sub-sample index → offset from the cell center.
const PER_HALF: usize = SAMPLE_OFFSETS[0].len();
const NSUB: usize = 2 * PER_HALF;
const SUB: [f64; NSUB] = {
    let mut out = [0f64; NSUB];
    let mut i = 0;
    while i < NSUB {
        out[i] = SAMPLE_OFFSETS[i / PER_HALF][i % PER_HALF];
        i += 1;
    }
    out
};

/// Samples all N × N cells through homography `h` (grid units → image pixels; pixel i spans `[i, i + 1]`).
/// `cells` optionally restricts sampling to a subset (others are left NaN / invalid).
///
/// `None` if the image buffer is shorter than its dimensions imply or a cell index in `cells` is outside the
/// grid.
pub fn sample_cells(
    img: &RgbaImage<'_>,
    h: &Homography,
    n: usize,
    lut: &ChannelLut,
    cells: Option<&[u32]>,
) -> Option<CellSamples> {
    let total = n * n;
    let mut feat = vec![f32::NAN; total * 12];
    let mut valid = vec![0u8; total];
    let w_px = img.width;
    let h_px = img.height;
    let stride = img.stride;
    let d = img.data;
    if w_px > 0 && h_px > 0 && (stride < w_px * 4 || d.len() < (h_px - 1) * stride + w_px * 4) {
        return None;
    }
    if let Some(cells) = cells
        && cells.iter().any(|&c| c as usize >= total)
    {
        return None;
    }
    let wf = w_px as f64;
    let hf = h_px as f64;
    let [h0, h1, h2, h3, h4, h5, h6, h7, h8] = *h;
    let count = cells.map_or(total, <[u32]>::len);
    for k in 0..count {
        let c = cells.map_or(k, |cells| cells[k] as usize);
        let cx = c % n;
        let cy = c / n;
        let mut acc = [0f64; 12];
        let mut ok = true;
        'rows: for (sy, &oy) in SUB.iter().enumerate() {
            let gy = cy as f64 + 0.5 + oy;
            let qy = if sy < PER_HALF { 0 } else { 1 };
            for (sx, &ox) in SUB.iter().enumerate() {
                let gx = cx as f64 + 0.5 + ox;
                let qx = if sx < PER_HALF { 0 } else { 1 };
                let w = h6 * gx + h7 * gy + h8;
                if w.is_nan() || w <= 1e-12 {
                    ok = false;
                    break 'rows;
                }
                let x = (h0 * gx + h1 * gy + h2) / w - 0.5;
                let y = (h3 * gx + h4 * gy + h5) / w - 0.5;
                let inside = x >= 0.0 && y >= 0.0 && x < wf - 1.0 && y < hf - 1.0;
                if !inside {
                    ok = false;
                    break 'rows;
                }
                let x0 = x as usize;
                let y0 = y as usize;
                let fx = x - x0 as f64;
                let fy = y - y0 as f64;
                let w00 = (1.0 - fx) * (1.0 - fy);
                let w10 = fx * (1.0 - fy);
                let w01 = (1.0 - fx) * fy;
                let w11 = fx * fy;
                let p00 = y0 * stride + x0 * 4;
                let p10 = p00 + 4;
                let p01 = p00 + stride;
                let p11 = p01 + 4;
                let o = (qy * 2 + qx) * 3;
                for ch in 0..3 {
                    let base = ch * 256;
                    acc[o + ch] = acc[o + ch]
                        + w00 * lut[base + d[p00 + ch] as usize] as f64
                        + w10 * lut[base + d[p10 + ch] as usize] as f64
                        + w01 * lut[base + d[p01 + ch] as usize] as f64
                        + w11 * lut[base + d[p11 + ch] as usize] as f64;
                }
            }
        }
        if !ok {
            continue;
        }
        valid[c] = 1;
        let fo = c * 12;
        for (i, a) in acc.iter().enumerate() {
            feat[fo + i] = (a / (PER_HALF * PER_HALF) as f64) as f32;
        }
    }
    Some(CellSamples { n, feat, valid })
}

/// Image position of a grid point (convenience re-export for UIs drawing overlays).
pub fn grid_to_image(h: &Homography, x: f64, y: f64) -> [f64; 2] {
    project(h, x, y)
}
