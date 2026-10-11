//! CPU fallback path (SIMD-ready) used as oracle and when WebGPU is unavailable.

use crate::types::{Anchors, CapabilityTier, DecodeProgress, RgbaImage};

/// Apply a 3x3 homography to warp `src` into a square `grid_px` x `grid_px` image.
pub fn rectify_cpu(src: &RgbaImage, anchors: &Anchors, grid_px: u32) -> RgbaImage {
    let h = homography_from_anchors(anchors, grid_px);
    let mut data = vec![0u8; (grid_px * grid_px * 4) as usize];
    for y in 0..grid_px {
        for x in 0..grid_px {
            let u = (x as f32 + 0.5) / grid_px as f32;
            let v = (y as f32 + 0.5) / grid_px as f32;
            let (sx, sy) = apply_h(&h, u, v);
            let px = sample_bilinear(src, sx, sy);
            let i = ((y * grid_px + x) * 4) as usize;
            data[i..i + 4].copy_from_slice(&px);
        }
    }
    RgbaImage {
        width: grid_px,
        height: grid_px,
        data,
    }
}

/// Sample cell centers and classify against palette centroids. Returns palette indices.
pub fn sample_cells(rectified: &RgbaImage, grid: u32, centroids: &[[f32; 3]]) -> Vec<u8> {
    let mut out = vec![0u8; (grid * grid) as usize];
    let cw = rectified.width as f32 / grid as f32;
    let ch = rectified.height as f32 / grid as f32;
    for gy in 0..grid {
        for gx in 0..grid {
            let cx = ((gx as f32 + 0.5) * cw) as u32;
            let cy = ((gy as f32 + 0.5) * ch) as u32;
            let i = ((cy.min(rectified.height - 1) * rectified.width + cx.min(rectified.width - 1)) * 4) as usize;
            let rgb = [
                rectified.data[i] as f32 / 255.0,
                rectified.data[i + 1] as f32 / 255.0,
                rectified.data[i + 2] as f32 / 255.0,
            ];
            let mut best = 0usize;
            let mut best_d = f32::MAX;
            for (ci, c) in centroids.iter().enumerate() {
                let d = (rgb[0] - c[0]).powi(2) + (rgb[1] - c[1]).powi(2) + (rgb[2] - c[2]).powi(2);
                if d < best_d {
                    best_d = d;
                    best = ci;
                }
            }
            out[(gy * grid + gx) as usize] = best as u8;
        }
    }
    out
}

fn homography_from_anchors(a: &Anchors, grid_px: u32) -> [f32; 9] {
    // Map unit square corners to anchors with a simplified affine-ish homography.
    // Full DLT can replace this; for bootstrap we use bilinear inverse mapping.
    let _ = grid_px;
    // Identity in normalized space; sampling uses bilinear from anchors via bilinear coords.
    // Store TL,TR,BR,BL deltas in a packed form used by apply_h.
    [
        a.points[0][0],
        a.points[1][0],
        a.points[2][0],
        a.points[0][1],
        a.points[1][1],
        a.points[2][1],
        a.points[3][0],
        a.points[3][1],
        1.0,
    ]
}

fn apply_h(h: &[f32; 9], u: f32, v: f32) -> (f32, f32) {
    // Bilinear interpolation of the four corners stored in h.
    let tl = [h[0], h[3]];
    let tr = [h[1], h[4]];
    let br = [h[2], h[5]];
    let bl = [h[6], h[7]];
    let top = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u];
    let bot = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u];
    (top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v)
}

fn sample_bilinear(img: &RgbaImage, x: f32, y: f32) -> [u8; 4] {
    let x = x.clamp(0.0, (img.width - 1) as f32);
    let y = y.clamp(0.0, (img.height - 1) as f32);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(img.width - 1);
    let y1 = (y0 + 1).min(img.height - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;
    let mut out = [0u8; 4];
    for c in 0..4 {
        let p00 = img.data[((y0 * img.width + x0) * 4 + c) as usize] as f32;
        let p10 = img.data[((y0 * img.width + x1) * 4 + c) as usize] as f32;
        let p01 = img.data[((y1 * img.width + x0) * 4 + c) as usize] as f32;
        let p11 = img.data[((y1 * img.width + x1) * 4 + c) as usize] as f32;
        let v = p00 * (1.0 - fx) * (1.0 - fy) + p10 * fx * (1.0 - fy) + p01 * (1.0 - fx) * fy + p11 * fx * fy;
        out[c as usize] = v.round().clamp(0.0, 255.0) as u8;
    }
    out
}

/// Minimal CPU decoder that advances progress when symbols are accumulated.
pub struct CpuDecoder {
    progress: DecodeProgress,
    symbols: Vec<u8>,
    needed: usize,
}

impl CpuDecoder {
    pub fn new(tier: CapabilityTier) -> Self {
        let grid = match tier {
            CapabilityTier::T0 => 0,
            CapabilityTier::T1 | CapabilityTier::T2 => 112,
            CapabilityTier::T3 => 144,
        };
        Self {
            progress: DecodeProgress {
                tier: Some(tier),
                ..Default::default()
            },
            symbols: Vec::new(),
            needed: (grid * grid) as usize,
        }
    }

    pub fn push_symbols(&mut self, symbols: &[u8]) -> DecodeProgress {
        self.progress.frames_seen += 1;
        self.progress.frames_decoded += 1;
        self.symbols.extend_from_slice(symbols);
        if self.needed > 0 {
            self.progress.fraction = (self.symbols.len() as f32 / self.needed as f32).min(1.0);
            self.progress.complete = self.symbols.len() >= self.needed;
        }
        self.progress.clone()
    }

    pub fn progress(&self) -> &DecodeProgress {
        &self.progress
    }
}
