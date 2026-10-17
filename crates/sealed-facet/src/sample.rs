//! Rectified sampling of the grid (spec §7.6 step 4). Port of `packages/core/src/facet/sample.ts`.
//!
//! For every cell, every quadrant feature is the mean of 3 × 3 bilinear samples around the quadrant center
//! ([`SAMPLE_OFFSETS`]). Pixel codes are mapped through a per-channel lookup table *before* interpolation so
//! tone-curve correction acts per pixel.

use std::sync::OnceLock;

use crate::homography::project;
use crate::model::SAMPLE_OFFSETS;
use crate::palette::srgb_to_linear_8;
use crate::parallel::{par_rows_pair, parts_for};
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
    let sampler = CellSampler { img, h: *h, n, lut };
    match cells {
        Some(cells) => {
            for &c in cells {
                let c = c as usize;
                let mut acc = [0f64; 12];
                if sampler.sample(c, &mut acc) {
                    valid[c] = 1;
                    store(&mut feat[c * 12..c * 12 + 12], &acc);
                }
            }
        }
        None => {
            // Whole grid: cell rows are independent, so they are split across the worker threads.
            let parts = parts_for(n, 4);
            par_rows_pair(
                &mut feat,
                n * 12,
                &mut valid,
                n,
                1,
                parts,
                |y0, frows, vrows| {
                    for (k, (f, v)) in frows.chunks_exact_mut(12).zip(vrows.iter_mut()).enumerate()
                    {
                        let c = y0 * n + k;
                        let mut acc = [0f64; 12];
                        if sampler.sample(c, &mut acc) {
                            *v = 1;
                            store(f, &acc);
                        }
                    }
                },
            );
        }
    }
    Some(CellSamples { n, feat, valid })
}

#[inline]
fn store(feat: &mut [f32], acc: &[f64; 12]) {
    for (f, a) in feat.iter_mut().zip(acc) {
        *f = (a / (PER_HALF * PER_HALF) as f64) as f32;
    }
}

struct CellSampler<'a> {
    img: &'a RgbaImage<'a>,
    h: Homography,
    n: usize,
    lut: &'a ChannelLut,
}

impl CellSampler<'_> {
    /// Accumulates the 3 × 3 samples of every quadrant of cell `c` into `acc` (`[q * 3 + ch]`); false when a
    /// sample fell outside the image (the cell is then invalid).
    #[inline]
    fn sample(&self, c: usize, acc: &mut [f64; 12]) -> bool {
        let n = self.n;
        let img = self.img;
        let (wf, hf) = (img.width as f64, img.height as f64);
        let stride = img.stride;
        let d = img.data;
        // One 256-entry table per channel: a u8 code then indexes it without a bounds check.
        let luts: [&[f32; 256]; 3] = std::array::from_fn(|ch| {
            self.lut[ch * 256..ch * 256 + 256]
                .try_into()
                .expect("256 codes per channel")
        });
        let [h0, h1, h2, h3, h4, h5, h6, h7, h8] = self.h;
        let cx = c % n;
        let cy = c / n;
        for (sy, &oy) in SUB.iter().enumerate() {
            let gy = cy as f64 + 0.5 + oy;
            let qy = if sy < PER_HALF { 0 } else { 1 };
            for (sx, &ox) in SUB.iter().enumerate() {
                let gx = cx as f64 + 0.5 + ox;
                let qx = if sx < PER_HALF { 0 } else { 1 };
                let w = h6 * gx + h7 * gy + h8;
                if w.is_nan() || w <= 1e-12 {
                    return false;
                }
                let x = (h0 * gx + h1 * gy + h2) / w - 0.5;
                let y = (h3 * gx + h4 * gy + h5) / w - 0.5;
                let inside = x >= 0.0 && y >= 0.0 && x < wf - 1.0 && y < hf - 1.0;
                if !inside {
                    return false;
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
                let (q00, q10) = (&d[p00..p00 + 3], &d[p10..p10 + 3]);
                let (q01, q11) = (&d[p01..p01 + 3], &d[p11..p11 + 3]);
                for (ch, lut) in luts.iter().enumerate() {
                    acc[o + ch] = acc[o + ch]
                        + w00 * lut[q00[ch] as usize] as f64
                        + w10 * lut[q10[ch] as usize] as f64
                        + w01 * lut[q01[ch] as usize] as f64
                        + w11 * lut[q11[ch] as usize] as f64;
                }
            }
        }
        true
    }
}

/// Image position of a grid point (convenience re-export for UIs drawing overlays).
pub fn grid_to_image(h: &Homography, x: f64, y: f64) -> [f64; 2] {
    project(h, x, y)
}
