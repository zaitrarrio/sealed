//! The 16 Facet glyphs (spec §7.4, 4 shape bits per cell). Port of `packages/core/src/facet/glyphs.ts`.
//!
//! A glyph divides its cell into four quadrants (TL, TR, BL, BR) and lights each with a fill level in [0, 1]
//! (linear light, multiplying the cell's palette color). Glyph s is the fill vector `GLYPH_FILLS[s·4 … s·4+3]`.
//!
//! Deviation from spec §7.4: under the receiver's blur (σ = 0.6 cell) everything above one cycle per cell is
//! gone, so the glyphs are optimized directly in the four-quadrant (2 × 2) low-frequency space: the fill vectors
//! below maximize the minimum blurred distance between any two *(glyph, color)* symbols jointly with the tier's
//! palette (offline, seeded, many restarts). Shape index s carries the 4 shape bits; colors are chosen
//! independently (spec §7.4 bit order: color bits most significant).
//!
//! Arithmetic mirrors the JavaScript: accumulation in f64, storage in f32.

/// Glyphs fill their whole cell (no margin): blur makes inner detail useless and a margin only costs energy.
pub const GLYPH_MARGIN: f64 = 0.0;

pub const GLYPH_COUNT: usize = 16;

/// Fill vectors [TL, TR, BL, BR] for the 4-color palette (T1), flattened `[s * 4 + q]`.
pub static FILLS_4: [f32; GLYPH_COUNT * 4] = [
    0.0, 0.0, 0.98, 0.0, //
    0.0, 0.0, 1.0, 0.72, //
    0.0, 0.142, 0.063, 1.0, //
    0.0, 0.501, 0.974, 1.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 1.0, //
    0.231, 1.0, 1.0, 1.0, //
    0.735, 1.0, 0.0, 1.0, //
    0.75, 1.0, 0.0, 0.0, //
    1.0, 0.0, 1.0, 0.0, //
    1.0, 0.0, 1.0, 0.753, //
    1.0, 0.019, 0.023, 1.0, //
    1.0, 0.07, 0.163, 0.0, //
    1.0, 0.948, 0.551, 0.0, //
    1.0, 1.0, 1.0, 0.261, //
    1.0, 1.0, 1.0, 1.0, //
];

/// Fill vectors [TL, TR, BL, BR] for the 8-color palette (T2, T3), flattened `[s * 4 + q]`.
pub static FILLS_8: [f32; GLYPH_COUNT * 4] = [
    0.0, 0.0, 1.0, 0.758, //
    0.0, 0.382, 1.0, 1.0, //
    0.0, 1.0, 0.277, 1.0, //
    0.053, 1.0, 1.0, 1.0, //
    0.271, 1.0, 0.0, 0.493, //
    0.344, 1.0, 0.884, 0.363, //
    0.775, 0.0, 1.0, 0.0, //
    0.893, 0.0, 1.0, 0.904, //
    0.959, 0.0, 0.1, 1.0, //
    1.0, 0.402, 1.0, 0.0, //
    1.0, 0.421, 1.0, 1.0, //
    1.0, 0.575, 0.197, 0.0, //
    1.0, 1.0, 0.0, 0.334, //
    1.0, 1.0, 0.062, 1.0, //
    1.0, 1.0, 1.0, 0.05, //
    1.0, 1.0, 1.0, 1.0, //
];

/// `fills[s * 4 + q]` = linear fill of quadrant q (0 TL, 1 TR, 2 BL, 3 BR; x = q & 1, y = q >> 1) of glyph s.
pub fn glyph_fills(colors: usize) -> &'static [f32; GLYPH_COUNT * 4] {
    if colors <= 4 { &FILLS_4 } else { &FILLS_8 }
}

pub fn glyph_fills_for_tier(tier: u8) -> &'static [f32; GLYPH_COUNT * 4] {
    glyph_fills(if tier == 1 { 4 } else { 8 })
}

/// Mean fill over glyphs and quadrants (expected level of an unknown data cell).
pub fn mean_fill(colors: usize) -> f64 {
    let f = glyph_fills(colors);
    let s: f64 = f.iter().map(|&v| v as f64).sum();
    s / f.len() as f64
}

/// Coverage tiles for rendering: for a cell of `cell_px` pixels, `tile[s][py * cell_px + px]` is the glyph's mean
/// linear fill over that pixel (exact box-filter coverage of the quadrant rectangles, so odd cell sizes stay
/// unbiased). `None` when `cell_px` is 0.
pub fn glyph_tiles(cell_px: usize, colors: usize) -> Option<Vec<Vec<f32>>> {
    if cell_px < 1 {
        return None;
    }
    let fills = glyph_fills(colors);
    let c = cell_px as f64;
    let lo = GLYPH_MARGIN * c;
    let mid = 0.5 * c;
    let hi = (1.0 - GLYPH_MARGIN) * c;
    let overlap = |a0: f64, a1: f64, b0: f64, b1: f64| (a1.min(b1) - a0.max(b0)).max(0.0);
    let mut cov_lo = vec![0f32; cell_px];
    let mut cov_hi = vec![0f32; cell_px];
    for p in 0..cell_px {
        let pf = p as f64;
        cov_lo[p] = overlap(pf, pf + 1.0, lo, mid) as f32;
        cov_hi[p] = overlap(pf, pf + 1.0, mid, hi) as f32;
    }
    let mut tiles = Vec::with_capacity(GLYPH_COUNT);
    for s in 0..GLYPH_COUNT {
        let mut t = vec![0f32; cell_px * cell_px];
        for py in 0..cell_px {
            let ys = [cov_lo[py] as f64, cov_hi[py] as f64];
            for px in 0..cell_px {
                let xs = [cov_lo[px] as f64, cov_hi[px] as f64];
                let mut v = 0f64;
                for q in 0..4 {
                    v += xs[q & 1] * ys[q >> 1] * fills[s * 4 + q] as f64;
                }
                t[py * cell_px + px] = v as f32;
            }
        }
        tiles.push(t);
    }
    Some(tiles)
}

/// Luminance template of glyph `s` at `res` × `res` resolution after a Gaussian blur of `sigma_cells`, with
/// background neighbors. Used by tests to report separability in the spec's own terms.
pub fn blurred_template(
    s: usize,
    colors: usize,
    res: usize,
    sigma_cells: f64,
    oversample: usize,
) -> Vec<f32> {
    let fills = glyph_fills(colors);
    let n = res * oversample;
    let mut img = vec![0f32; n * n];
    for y in 0..n {
        for x in 0..n {
            let u = (x as f64 + 0.5) / n as f64;
            let v = (y as f64 + 0.5) / n as f64;
            let inside = GLYPH_MARGIN..1.0 - GLYPH_MARGIN;
            if !inside.contains(&u) || !inside.contains(&v) {
                continue;
            }
            let q = (if u < 0.5 { 0 } else { 1 }) | (if v < 0.5 { 0 } else { 2 });
            img[y * n + x] = fills[(s % GLYPH_COUNT) * 4 + q];
        }
    }
    downsample_blurred(&img, n, res, sigma_cells)
}

/// Blurs an n × n single-cell image (zero outside) and box-downsamples the cell area to res × res.
/// `n` must be a multiple of `res` (as produced by `blurred_template`).
pub fn downsample_blurred(img: &[f32], n: usize, res: usize, sigma_cells: f64) -> Vec<f32> {
    if res == 0 || n == 0 || img.len() < n * n {
        return Vec::new();
    }
    let pad = (3.0 * sigma_cells * n as f64).ceil() as usize + 1;
    let m = n + 2 * pad;
    let mut buf = vec![0f32; m * m];
    for y in 0..n {
        for x in 0..n {
            buf[(y + pad) * m + x + pad] = img[y * n + x];
        }
    }
    if sigma_cells > 0.0 {
        buf = gaussian_blur(&buf, m, m, sigma_cells * n as f64);
    }
    let mut out = vec![0f32; res * res];
    let step = n / res;
    for y in 0..res {
        for x in 0..res {
            let mut acc = 0f64;
            for dy in 0..step {
                for dx in 0..step {
                    acc += buf[(pad + y * step + dy) * m + pad + x * step + dx] as f64;
                }
            }
            out[y * res + x] = (acc / (step * step) as f64) as f32;
        }
    }
    out
}

/// Separable Gaussian blur with clamped edges. `src.len()` must be at least `w * h`.
pub fn gaussian_blur(src: &[f32], w: usize, h: usize, sigma: f64) -> Vec<f32> {
    if src.len() < w * h {
        return Vec::new();
    }
    let r = ((3.0 * sigma).ceil() as isize).max(1);
    let mut k = vec![0f32; (2 * r + 1) as usize];
    let mut sum = 0f64;
    for i in -r..=r {
        let v = (-((i * i) as f64) / (2.0 * sigma * sigma)).exp();
        k[(i + r) as usize] = v as f32;
        sum += v;
    }
    for v in k.iter_mut() {
        *v = (*v as f64 / sum) as f32;
    }
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    let wi = w as isize;
    let hi = h as isize;
    for y in 0..h {
        for x in 0..w {
            let mut a = 0f64;
            for i in -r..=r {
                let xx = (x as isize + i).clamp(0, wi - 1) as usize;
                a += k[(i + r) as usize] as f64 * src[y * w + xx] as f64;
            }
            tmp[y * w + x] = a as f32;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut a = 0f64;
            for i in -r..=r {
                let yy = (y as isize + i).clamp(0, hi - 1) as usize;
                a += k[(i + r) as usize] as f64 * tmp[yy * w + x] as f64;
            }
            out[y * w + x] = a as f32;
        }
    }
    out
}

/// Euclidean distance between two templates (over the shorter length).
pub fn template_distance(a: &[f32], b: &[f32]) -> f64 {
    let mut d = 0f64;
    for (&x, &y) in a.iter().zip(b) {
        let e = x as f64 - y as f64;
        d += e * e;
    }
    d.sqrt()
}

/// Minimum pairwise distance of a template set (`INFINITY` for fewer than two templates).
pub fn min_pairwise_distance(templates: &[Vec<f32>]) -> f64 {
    let mut best = f64::INFINITY;
    for i in 0..templates.len() {
        for j in i + 1..templates.len() {
            best = best.min(template_distance(&templates[i], &templates[j]));
        }
    }
    best
}
