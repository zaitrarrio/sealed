//! Anchor detection and homography estimation for Facet grid frames (spec §7.6 step 2). Port of
//! `packages/core/src/facet/detect.ts`.
//!
//! 1. Linear-light luma of the camera image, binarized against a local mean (integral image) with an absolute
//!    floor relative to the image's white level, so blurred one-cell dark bands stay dark.
//! 2. Every row is run-length encoded and searched for "light, interior, light" where the interior matches one of
//!    the four anchor interiors (`layout`) by run ratios. Each row hit is cross-checked with a vertical scan
//!    through its center and a second horizontal scan through the vertical center, which rejects lines that do
//!    not pass through the anchor's central 2 × 2 cells. Verified hits are clustered per corner type.
//! 3. Candidate corner sets (one cluster per corner) are ranked by hit count and checked for convex geometry and
//!    consistent cell size; the grid size N is inferred from anchor spacing (and confirmed by the header later).
//! 4. Homography from the four anchor centers (DLT), then refined: along lines through each anchor center the
//!    receiver finds the band-1 → band-0 edges at ±3 cells with sub-pixel interpolation and re-centers the anchor.
//!
//! Every ordering, tie-break, early exit and bound of the JavaScript detector is preserved: the fixtures record
//! its output. Negated comparisons (`!(x > y)`) are kept on purpose: they reject NaN like the reference.

#![allow(clippy::neg_cmp_op_on_partial_ord)]

use crate::homography::{homography_from_4, project};
use crate::layout::{ANCHOR_CELLS, ANCHOR_INTERIOR_RUNS, Corner};
use crate::palette::srgb_to_linear_8;
use crate::types::{Homography, LumaPlane, RgbaImage, TIERS};

/// A candidate set of the four anchor centers.
#[derive(Clone, Debug, PartialEq)]
pub struct CornerSet {
    /// Image positions of the TL, TR, BR, BL anchor centers.
    pub points: [[f64; 2]; 4],
    /// Mean cell size in pixels estimated from the anchors' run lengths.
    pub unit: f64,
    pub score: f64,
}

#[derive(Clone, Copy, Debug)]
struct Match {
    a: i32,
    b: i32,
    corner: Corner,
    unit: f64,
}

#[derive(Clone, Copy, Debug)]
struct Cluster {
    corner: Corner,
    sx: f64,
    sy: f64,
    su: f64,
    w: f64,
}

const MIN_UNIT_PX: f64 = 2.5;
/// Largest per-run deviation (in cells) from an anchor template after fitting unit and erosion.
const MAX_RUN_ERROR: f64 = 0.5;
/// Binarization windows as divisors of the shorter image side (radius = side / divisor), tried in order.
const BIN_WINDOW_DIVISORS: [f64; 2] = [64.0, 20.0];
/// Bounds the work on adversarial images (each row hit costs up to four line scans).
const MAX_ROW_HITS: usize = 60000;
const MAX_CLUSTERS: usize = 4096;
/// Hits after which an anchor cluster stops accepting more (its center is already well averaged).
const SATURATED_HITS: f64 = 24.0;

/// Grid sizes of the grid tiers, ascending and without duplicates (`GRID_SIZES` in detect.ts).
fn grid_sizes() -> Vec<usize> {
    let mut v: Vec<usize> = TIERS.iter().map(|t| t.grid).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// `Math.round`: half rounds toward +∞.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `Math.hypot(a, b)` as V8 computes it (values scaled by the larger magnitude, Kahan-summed squares), so
/// threshold comparisons on distances round exactly as in the reference.
fn js_hypot(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return if a.is_infinite() || b.is_infinite() {
            f64::INFINITY
        } else {
            f64::NAN
        };
    }
    let aa = a.abs();
    let ab = b.abs();
    let max = aa.max(ab);
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in [aa, ab] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// Whether `img`'s buffer covers its dimensions at its stride.
fn image_fits(img: &RgbaImage<'_>) -> bool {
    let (w, h) = (img.width, img.height);
    if w == 0 || h == 0 {
        return true;
    }
    img.stride >= w * 4 && img.data.len() >= (h - 1) * img.stride + w * 4
}

/// Linear luma of an RGBA image into `out` (resized to width × height). `false` (and `out` untouched) when the
/// buffer is shorter than its dimensions and stride imply.
pub fn linear_luma_into(img: &RgbaImage<'_>, out: &mut Vec<f32>) -> bool {
    if !image_fits(img) {
        return false;
    }
    let (w, h) = (img.width, img.height);
    out.resize(w * h, 0.0);
    let t = srgb_to_linear_8();
    for y in 0..h {
        let row = &img.data[y * img.stride..y * img.stride + w * 4];
        let dst = &mut out[y * w..(y + 1) * w];
        for (o, p) in dst.iter_mut().zip(row.chunks_exact(4)) {
            *o = (0.2126 * t[p[0] as usize] as f64
                + 0.7152 * t[p[1] as usize] as f64
                + 0.0722 * t[p[2] as usize] as f64) as f32;
        }
    }
    true
}

/// Linear luma of an RGBA image (honours `stride`). `None` when the buffer is shorter than its dimensions imply.
pub fn linear_luma(img: &RgbaImage<'_>) -> Option<LumaPlane> {
    let mut data = Vec::new();
    linear_luma_into(img, &mut data).then_some(LumaPlane {
        width: img.width,
        height: img.height,
        data,
    })
}

/// Bilinear luma sample at continuous pixel coordinates (pixel i spans [i, i + 1]). NaN outside, or when the plane's
/// buffer is shorter than its dimensions.
pub fn sample_luma(l: &LumaPlane, u: f64, v: f64) -> f64 {
    let wf = l.width as f64;
    let hf = l.height as f64;
    let x = u - 0.5;
    let y = v - 0.5;
    if !(x >= 0.0 && y >= 0.0 && x <= wf - 1.0 && y <= hf - 1.0)
        || l.data.len() < l.width * l.height
    {
        return f64::NAN;
    }
    let x0 = (x.floor() as usize).min(l.width.saturating_sub(2));
    let y0 = (y.floor() as usize).min(l.height.saturating_sub(2));
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let w = l.width;
    let i = y0 * w + x0;
    let d = &l.data;
    let x1 = if l.width > 1 { 1 } else { 0 };
    let y1 = if l.height > 1 { w } else { 0 };
    let a = d[i] as f64;
    let b = d[i + x1] as f64;
    let c = d[i + y1] as f64;
    let e = d[i + y1 + x1] as f64;
    a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy
}

/// Run-length encoding of a binary line.
struct Runs {
    start: Vec<i32>,
    len: Vec<i32>,
    val: Vec<u8>,
    count: usize,
}

impl Runs {
    fn new(cap: usize) -> Self {
        Self {
            start: vec![0; cap],
            len: vec![0; cap],
            val: vec![0; cap],
            count: 0,
        }
    }

    /// Encodes `n` samples `bin[offset + i * stride]`.
    fn encode(&mut self, bin: &[u8], offset: usize, stride: usize, n: usize) {
        if self.start.len() < n + 1 {
            self.start = vec![0; n + 1];
            self.len = vec![0; n + 1];
            self.val = vec![0; n + 1];
        }
        let mut c = 0usize;
        let mut prev: Option<u8> = None;
        for i in 0..n {
            let v = bin[offset + i * stride];
            if prev != Some(v) {
                self.start[c] = i as i32;
                self.len[c] = 1;
                self.val[c] = v;
                c += 1;
                prev = Some(v);
            } else {
                self.len[c - 1] += 1;
            }
        }
        self.count = c;
    }
}

struct Fit {
    u: f64,
    err: f64,
    sum: f64,
}

/// Fits the interior runs x_j (alternating dark, light, …, dark) to template t: x_j = t_j·u + s_j·2e, where s_j is
/// −1 for dark and +1 for light runs. `e` is the binarization erosion of dark bands (blur turns one-cell dark bands
/// into shallow dips that a local threshold cuts narrower; |2e| ≤ 0.7u). Returns the unit and the worst relative
/// residual, or `None`.
fn fit_interior(r: &Runs, first: usize, t: &[u32]) -> Option<Fit> {
    let m = t.len();
    let sign = |j: usize| if j.is_multiple_of(2) { -1.0 } else { 1.0 };
    let mut u: f64;
    let mut e2 = 0.0;
    if m == 1 {
        u = r.len[first] as f64 / t[0] as f64;
    } else {
        // Least squares in (u, 2e).
        let mut suu = 0.0;
        let mut sue = 0.0;
        let mut see = 0.0;
        let mut bu = 0.0;
        let mut be = 0.0;
        for (j, &tj) in t.iter().enumerate() {
            let tj = tj as f64;
            let sj = sign(j);
            let x = r.len[first + j] as f64;
            suu += tj * tj;
            sue += tj * sj;
            see += 1.0;
            bu += tj * x;
            be += sj * x;
        }
        let det = suu * see - sue * sue;
        if !(det > 1e-9) {
            return None;
        }
        u = (bu * see - be * sue) / det;
        e2 = (suu * be - sue * bu) / det;
        if !(u > 0.0) {
            return None;
        }
        let lim = 0.7 * u;
        if e2 > lim || e2 < -lim {
            // Clamp the erosion and refit the unit alone.
            e2 = e2.clamp(-lim, lim);
            let mut num = 0.0;
            for (j, &tj) in t.iter().enumerate() {
                num += tj as f64 * (r.len[first + j] as f64 - sign(j) * e2);
            }
            u = num / suu;
        }
    }
    if !(u > 0.0) {
        return None;
    }
    let mut max = 0.0f64;
    let mut sum = 0.0;
    for (j, &tj) in t.iter().enumerate() {
        let pred = tj as f64 * u + sign(j) * e2;
        let err = (r.len[first + j] as f64 - pred).abs() / u;
        sum += err;
        if err > max {
            max = err;
        }
    }
    Some(Fit { u, err: max, sum })
}

/// Finds anchor-interior patterns in a run-length encoded line. `luma` is the line's luma (indexed like the runs).
fn find_matches(r: &Runs, luma: &[f32], white: f64, max_unit: f64, out: &mut Vec<Match>) {
    let cnt = r.count;
    let mut i = 0usize;
    while i + 2 < cnt {
        if r.val[i] != 1 {
            i += 1;
            continue;
        }
        for m in [1usize, 3, 5] {
            let last = i + m + 1;
            if last >= cnt {
                break;
            }
            let a = r.start[i + 1];
            let b = r.start[last];
            let span = (b - a) as f64;
            if span < 6.0 * MIN_UNIT_PX * 0.7 || span > 6.0 * max_unit {
                continue;
            }
            let mut best: Option<Corner> = None;
            let mut best_err = f64::INFINITY;
            let mut best_u = 0.0;
            for (c, t) in ANCHOR_INTERIOR_RUNS.iter().enumerate() {
                if t.len() != m {
                    continue;
                }
                let Some(f) = fit_interior(r, i + 1, t) else {
                    continue;
                };
                if f.err > MAX_RUN_ERROR || f.sum >= best_err {
                    continue;
                }
                best_err = f.sum;
                best = Some(c);
                best_u = f.u;
            }
            let Some(corner) = best else {
                continue;
            };
            let u = best_u;
            if u < MIN_UNIT_PX || u > max_unit {
                continue;
            }
            let la = r.len[i] as f64;
            let lb = r.len[last] as f64;
            if la < 0.45 * u || lb < 0.45 * u || la.min(lb) > 2.6 * u {
                continue;
            }
            // Wide dark runs must be genuinely dark (rejects dim glyph areas in the data region).
            let mut ok = true;
            let mut j = 0;
            while j < m && ok {
                let s = r.start[i + 1 + j] as usize;
                let l = r.len[i + 1 + j] as usize;
                if (l as f64) < 2.0 * u {
                    j += 2;
                    continue;
                }
                let mut acc = 0.0f64;
                for &v in luma.iter().skip(s).take(l) {
                    acc += v as f64;
                }
                if acc / l as f64 > 0.3 * white {
                    ok = false;
                }
                j += 2;
            }
            if !ok {
                continue;
            }
            out.push(Match {
                a,
                b,
                corner,
                unit: u,
            });
        }
        i += 1;
    }
}

/// Scratch buffers of the line cross-checks.
struct LineScratch {
    runs: Runs,
    bin: Vec<u8>,
    luma: Vec<f32>,
    matches: Vec<Match>,
}

struct LineHit {
    offset: f64,
    unit: f64,
}

/// Samples the binarized image along the line through (x, y) with direction (dx, dy) ∈ {(1,0), (0,1), (1,±1)},
/// one sample per step, and returns the offset (in steps from (x, y)) of the center of the matching pattern of the
/// same corner type whose interior contains (x, y). Along a diagonal, one step changes the Chebyshev distance
/// from an axis-aligned anchor's center by one pixel, so run lengths in steps compare directly with `unit`.
fn cross_check(
    sc: &mut LineScratch,
    bin: &[u8],
    luma: &[f32],
    w: usize,
    h: usize,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    unit: f64,
    corner: Corner,
    white: f64,
    max_unit: f64,
) -> Option<LineHit> {
    let span = (9.0 * unit).ceil();
    if !(0.0..1e9).contains(&span) {
        return None;
    }
    let span_i = span as i64;
    let len = (2 * span_i + 1) as usize;
    if sc.bin.len() < len {
        sc.bin = vec![0; len];
        sc.luma = vec![0.0; len];
    }
    let mut first: Option<usize> = None;
    let mut count = 0usize;
    for i in 0..len {
        let t = (i as i64 - span_i) as f64;
        let px = (x + dx * t).floor();
        let py = (y + dy * t).floor();
        if !(px >= 0.0 && py >= 0.0 && px < w as f64 && py < h as f64) {
            if first.is_some() {
                break;
            }
            continue;
        }
        if first.is_none() {
            first = Some(i);
        }
        let idx = py as usize * w + px as usize;
        sc.bin[count] = bin[idx];
        sc.luma[count] = luma[idx];
        count += 1;
    }
    let first = first?;
    if count < 8 {
        return None;
    }
    sc.runs.encode(&sc.bin, 0, 1, count);
    sc.matches.clear();
    find_matches(
        &sc.runs,
        &sc.luma[..count],
        white,
        max_unit,
        &mut sc.matches,
    );
    let mut best: Option<Match> = None;
    let mut best_d = f64::INFINITY;
    let rel = span - first as f64 + 0.5;
    for m in &sc.matches {
        if m.corner != corner || rel < m.a as f64 || rel > m.b as f64 {
            continue;
        }
        if m.unit < unit / 1.8 || m.unit > unit * 1.8 {
            continue;
        }
        let d = ((m.a + m.b) as f64 / 2.0 - rel).abs();
        if d < best_d {
            best_d = d;
            best = Some(*m);
        }
    }
    let best = best?;
    if best_d > 1.5 * best.unit {
        return None;
    }
    Some(LineHit {
        offset: (best.a + best.b) as f64 / 2.0 - rel,
        unit: best.unit,
    })
}

/// The anchor detector. Keeps its working buffers between frames; `luma` is the luma plane of the most recent
/// `detect` call (its buffer is reused by the next call).
pub struct GridDetector {
    bin_buf: Vec<u8>,
    integral: Vec<f64>,
    row_runs: Runs,
    line: LineScratch,
    row_matches: Vec<Match>,
    /// Luma plane of the most recent `detect` call.
    pub luma: Option<LumaPlane>,
}

impl Default for GridDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl GridDetector {
    pub fn new() -> Self {
        Self {
            bin_buf: Vec::new(),
            integral: Vec::new(),
            row_runs: Runs::new(2048),
            line: LineScratch {
                runs: Runs::new(512),
                bin: vec![0; 512],
                luma: vec![0.0; 512],
                matches: Vec::new(),
            },
            row_matches: Vec::new(),
            luma: None,
        }
    }

    /// Candidate corner sets of `img`, best first (at most three). Empty when the image is smaller than 32 × 32, its
    /// buffer is short, it has no white level, or no anchors are found.
    pub fn detect(&mut self, img: &RgbaImage<'_>) -> Vec<CornerSet> {
        let w = img.width;
        let h = img.height;
        if !(w >= 32 && h >= 32) || !image_fits(img) {
            return Vec::new();
        }
        let n = w * h;
        // Reuse the previous plane's buffer when the size is unchanged (as the JavaScript detector does).
        let mut data = self.luma.take().map(|l| l.data).unwrap_or_default();
        if data.len() != n {
            data = Vec::with_capacity(n);
            self.bin_buf = vec![0; n];
        }
        if self.bin_buf.len() != n {
            self.bin_buf.resize(n, 0);
        }
        if self.integral.len() != (w + 1) * (h + 1) {
            self.integral = vec![0.0; (w + 1) * (h + 1)];
        }
        if !linear_luma_into(img, &mut data) {
            return Vec::new();
        }
        let white = white_level(&data);
        self.luma = Some(LumaPlane {
            width: w,
            height: h,
            data,
        });
        if !(white > 0.05) {
            return Vec::new();
        }
        self.integrate();
        // Binarization window radii, smallest first: a window about two cells wide keeps the anchors' one-cell dark
        // band dark under heavy blur; the wider window serves large codes whose cells exceed the small window.
        let min_side = w.min(h) as f64;
        let mut radii: Vec<usize> = Vec::new();
        for d in BIN_WINDOW_DIVISORS {
            let r = js_round(min_side / d).max(4.0) as usize;
            if !radii.contains(&r) {
                radii.push(r);
            }
        }
        for radius in radii {
            self.binarize(radius, white);
            let sets = self.scan(white);
            if !sets.is_empty() {
                return sets;
            }
        }
        Vec::new()
    }

    fn scan(&mut self, white: f64) -> Vec<CornerSet> {
        let Some(luma) = self.luma.as_ref() else {
            return Vec::new();
        };
        let w = luma.width;
        let h = luma.height;
        let ld = &luma.data[..];
        let bin = &self.bin_buf[..];
        let max_unit = w.max(h) as f64 / 80.0;
        let mut clusters: Vec<Cluster> = Vec::new();
        let mut processed = 0usize;
        let row_runs = &mut self.row_runs;
        let row_matches = &mut self.row_matches;
        let line = &mut self.line;
        let mut y = 0usize;
        while y < h && processed < MAX_ROW_HITS {
            row_runs.encode(bin, y * w, 1, w);
            row_matches.clear();
            let row_off = y * w;
            find_matches(
                row_runs,
                &ld[row_off..row_off + w],
                white,
                max_unit,
                row_matches,
            );
            for m in row_matches.iter() {
                processed += 1;
                if processed > MAX_ROW_HITS {
                    break;
                }
                let cx = (m.a + m.b) as f64 / 2.0;
                let yc = y as f64 + 0.5;
                // Skip rows through an anchor that is already well established (saves the cross-checks).
                if near_saturated(&clusters, m.corner, cx, yc) {
                    continue;
                }
                let Some(v) = cross_check(
                    line, bin, ld, w, h, cx, yc, 0.0, 1.0, m.unit, m.corner, white, max_unit,
                ) else {
                    continue;
                };
                let cy = yc + v.offset;
                let Some(h2) = cross_check(
                    line, bin, ld, w, h, cx, cy, 1.0, 0.0, m.unit, m.corner, white, max_unit,
                ) else {
                    continue;
                };
                let fx = cx + h2.offset;
                // Both diagonals through the center: along any line through the center of concentric squares the run
                // ratios hold, while glyph data almost never repeats the pattern in all four directions.
                if cross_check(
                    line, bin, ld, w, h, fx, cy, 1.0, 1.0, m.unit, m.corner, white, max_unit,
                )
                .is_none()
                {
                    continue;
                }
                if cross_check(
                    line, bin, ld, w, h, fx, cy, 1.0, -1.0, m.unit, m.corner, white, max_unit,
                )
                .is_none()
                {
                    continue;
                }
                add_hit(
                    &mut clusters,
                    m.corner,
                    fx,
                    cy,
                    (m.unit + v.unit + h2.unit) / 3.0,
                );
            }
            y += 1;
        }
        select_corner_sets(&clusters)
    }

    /// Summed-area table of the luma plane.
    fn integrate(&mut self) {
        let Some(l) = self.luma.as_ref() else {
            return;
        };
        let w = l.width;
        let h = l.height;
        let d = &l.data;
        let s = &mut self.integral;
        let w1 = w + 1;
        for v in s.iter_mut().take(w1) {
            *v = 0.0;
        }
        for y in 1..=h {
            let mut row = 0.0f64;
            s[y * w1] = 0.0;
            for x in 1..=w {
                row += d[(y - 1) * w + x - 1] as f64;
                s[y * w1 + x] = s[(y - 1) * w1 + x] + row;
            }
        }
    }

    /// Binarizes luma against the local mean over a (2R+1)² window, with an absolute floor relative to the white
    /// level (uniform dark areas stay dark) and a small bias below the mean (uniform light areas stay light under
    /// noise).
    fn binarize(&mut self, r: usize, white: f64) {
        let Some(l) = self.luma.as_ref() else {
            return;
        };
        let w = l.width;
        let h = l.height;
        let d = &l.data;
        let s = &self.integral;
        let bin = &mut self.bin_buf;
        let w1 = w + 1;
        let floor = 0.12 * white;
        let bias = 0.04 * white;
        for y in 0..h {
            let y0 = y.saturating_sub(r);
            let y1 = h.min(y + r + 1);
            for x in 0..w {
                let x0 = x.saturating_sub(r);
                let x1 = w.min(x + r + 1);
                let sum = s[y1 * w1 + x1] - s[y0 * w1 + x1] - s[y1 * w1 + x0] + s[y0 * w1 + x0];
                let mean = sum / ((x1 - x0) * (y1 - y0)) as f64;
                let v = d[y * w + x] as f64;
                bin[y * w + x] = u8::from(v > mean - bias && v > floor);
            }
        }
    }
}

/// Image white level: 99.5th percentile of luma (subsampled).
fn white_level(d: &[f32]) -> f64 {
    let mut hist = [0u32; 1024];
    let mut total = 0u64;
    for &v in d.iter().step_by(3) {
        let b = ((v as f64 * 1023.0).floor()).clamp(0.0, 1023.0) as usize;
        hist[b] += 1;
        total += 1;
    }
    let mut acc = 0u64;
    for b in (0..1024).rev() {
        acc += hist[b] as u64;
        if acc as f64 >= total as f64 * 0.005 {
            return b as f64 / 1023.0;
        }
    }
    1.0
}

/// True when a cluster of this corner near (x, y) already holds enough hits to be certain.
fn near_saturated(clusters: &[Cluster], corner: Corner, x: f64, y: f64) -> bool {
    for c in clusters {
        if c.corner != corner || c.w < SATURATED_HITS {
            continue;
        }
        let cu = c.su / c.w;
        let dx = c.sx / c.w - x;
        let dy = c.sy / c.w - y;
        if dx * dx + dy * dy <= 4.0 * cu * cu {
            return true;
        }
    }
    false
}

fn add_hit(clusters: &mut Vec<Cluster>, corner: Corner, x: f64, y: f64, u: f64) {
    for c in clusters.iter_mut() {
        if c.corner != corner {
            continue;
        }
        let cu = c.su / c.w;
        let dx = c.sx / c.w - x;
        let dy = c.sy / c.w - y;
        if dx * dx + dy * dy <= (2.0 * cu) * (2.0 * cu) {
            c.sx += x;
            c.sy += y;
            c.su += u;
            c.w += 1.0;
            return;
        }
    }
    if clusters.len() < MAX_CLUSTERS {
        clusters.push(Cluster {
            corner,
            sx: x,
            sy: y,
            su: u,
            w: 1.0,
        });
    }
}

fn cross(o: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// `Math.sign` as a small integer; `None` for NaN (which never equals anything, so such a set is rejected).
fn sign(v: f64) -> Option<i8> {
    if v.is_nan() {
        None
    } else if v > 0.0 {
        Some(1)
    } else if v < 0.0 {
        Some(-1)
    } else {
        Some(0)
    }
}

fn select_corner_sets(clusters: &[Cluster]) -> Vec<CornerSet> {
    let mut per: [Vec<Cluster>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for c in clusters {
        if c.w >= 2.0 {
            per[c.corner % 4].push(*c);
        }
    }
    for p in per.iter_mut() {
        // Stable, descending by hit count (JavaScript's sort is stable).
        p.sort_by(|a, b| b.w.partial_cmp(&a.w).unwrap_or(std::cmp::Ordering::Equal));
        p.truncate(3);
    }
    if per.iter().any(Vec::is_empty) {
        return Vec::new();
    }
    let sizes = grid_sizes();
    let (Some(&smallest), Some(&largest)) = (sizes.first(), sizes.last()) else {
        return Vec::new();
    };
    let min_side = (smallest - ANCHOR_CELLS) as f64;
    let max_side = (largest - ANCHOR_CELLS) as f64;
    let mut out: Vec<CornerSet> = Vec::new();
    for a in &per[0] {
        for b in &per[1] {
            for c in &per[2] {
                for d in &per[3] {
                    let cs = [a, b, c, d];
                    let pts: [[f64; 2]; 4] = [
                        [a.sx / a.w, a.sy / a.w],
                        [b.sx / b.w, b.sy / b.w],
                        [c.sx / c.w, c.sy / c.w],
                        [d.sx / d.w, d.sy / d.w],
                    ];
                    let units = [a.su / a.w, b.su / b.w, c.su / c.w, d.su / d.w];
                    let umin = units.iter().copied().fold(f64::INFINITY, f64::min);
                    let umax = units.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    if umax > 1.8 * umin {
                        continue;
                    }
                    let u = units.iter().sum::<f64>() / 4.0;
                    let mut sides = [0.0f64; 4];
                    for (i, s) in sides.iter_mut().enumerate() {
                        let p = pts[i];
                        let q = pts[(i + 1) % 4];
                        *s = js_hypot(q[0] - p[0], q[1] - p[1]);
                    }
                    let mean = sides.iter().sum::<f64>() / 4.0;
                    if sides.iter().any(|&s| s < 0.6 * mean || s > 1.6 * mean) {
                        continue;
                    }
                    if mean / u < 0.6 * min_side || mean / u > 1.5 * max_side {
                        continue;
                    }
                    let signs: [Option<i8>; 4] = std::array::from_fn(|i| {
                        sign(cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]))
                    });
                    if signs
                        .iter()
                        .any(|&s| s.is_none() || s == Some(0) || s != signs[0])
                    {
                        continue;
                    }
                    out.push(CornerSet {
                        points: pts,
                        unit: u,
                        score: cs.iter().map(|k| k.w).sum(),
                    });
                }
            }
        }
    }
    out.sort_by(|x, y| {
        y.score
            .partial_cmp(&x.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(3);
    out
}

/// Grid sizes to try for a corner set, most plausible first.
pub fn grid_sizes_for(set: &CornerSet) -> Vec<usize> {
    let p = &set.points;
    let mut sum = 0.0;
    for i in 0..4 {
        let a = p[i];
        let b = p[(i + 1) % 4];
        sum += js_hypot(b[0] - a[0], b[1] - a[1]);
    }
    let cells = sum / 4.0 / set.unit + ANCHOR_CELLS as f64;
    let mut sizes = grid_sizes();
    sizes.sort_by(|&a, &b| {
        let da = (a as f64 - cells).abs();
        let db = (b as f64 - cells).abs();
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
    });
    sizes
}

/// Anchor centers in grid units for an N-cell grid (TL, TR, BR, BL).
pub fn anchor_center_points(n: usize) -> [[f64; 2]; 4] {
    let h = ANCHOR_CELLS as f64 / 2.0;
    let nf = n as f64;
    [[h, h], [nf - h, h], [nf - h, nf - h], [h, nf - h]]
}

/// Homography for an N-cell grid from a corner set, refined on the anchors' band edges. `None` if degenerate.
pub fn grid_homography(set: &CornerSet, n: usize, luma: &LumaPlane) -> Option<Homography> {
    let centers = anchor_center_points(n);
    let mut h = homography_from_4(&centers, &set.points)?;
    for _ in 0..2 {
        let Some(refined) = refine_anchors(&h, n, luma) else {
            break;
        };
        let Some(h2) = homography_from_4(&centers, &refined) else {
            break;
        };
        h = h2;
    }
    Some(h)
}

fn mean_luma(h: &Homography, luma: &LumaPlane, cx: f64, cy: f64, r: f64) -> f64 {
    let mut acc = 0.0;
    let mut cnt = 0u32;
    let step = r / 2.0;
    let mut dy = -r;
    while dy <= r + 1e-9 {
        let mut dx = -r;
        while dx <= r + 1e-9 {
            let [u, v] = project(h, cx + dx, cy + dy);
            let s = sample_luma(luma, u, v);
            if s.is_finite() {
                acc += s;
                cnt += 1;
            }
            dx += step;
        }
        dy += step;
    }
    if cnt > 0 { acc / cnt as f64 } else { f64::NAN }
}

fn refine_anchors(h: &Homography, n: usize, luma: &LumaPlane) -> Option<[[f64; 2]; 4]> {
    let centers = anchor_center_points(n);
    let tl = centers[0];
    let bl = centers[3];
    let white = mean_luma(h, luma, tl[0], tl[1], 0.6);
    let dark = mean_luma(h, luma, bl[0], bl[1], 1.2);
    if !(white > dark + 0.05) {
        return None;
    }
    let min_step = 0.1 * (white - dark);
    let mut out = [[0.0f64; 2]; 4];
    for (o, &[cx, cy]) in out.iter_mut().zip(centers.iter()) {
        let dx = axis_shift(h, luma, cx, cy, 0, min_step).unwrap_or(0.0);
        let dy = axis_shift(h, luma, cx, cy, 1, min_step).unwrap_or(0.0);
        *o = project(h, cx + dx, cy + dy);
    }
    if out.iter().any(|[u, v]| !u.is_finite() || !v.is_finite()) {
        return None;
    }
    Some(out)
}

const PROFILE_STEP: f64 = 0.05;
const PROFILE_FROM: f64 = 2.3;
const PROFILE_SAMPLES: usize = 29; // 2.3 … 3.7 cells

/// Center correction (grid units) along one axis. On every line through an anchor within ±1.5 cells of its
/// center, band 1 (dark) meets band 0 (light) exactly 3 cells from the center on both sides.
fn axis_shift(
    h: &Homography,
    luma: &LumaPlane,
    cx: f64,
    cy: f64,
    axis: u8,
    min_step: f64,
) -> Option<f64> {
    let mut shifts: Vec<f64> = Vec::with_capacity(4);
    for o in [-1.5, -0.5, 0.5, 1.5] {
        let plus = rising_edge(h, luma, cx, cy, axis, o, 1.0, min_step);
        let minus = rising_edge(h, luma, cx, cy, axis, o, -1.0, min_step);
        if let (Some(p), Some(m)) = (plus, minus) {
            shifts.push((p - m) / 2.0);
        }
    }
    if shifts.is_empty() {
        return None;
    }
    shifts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = shifts.len() >> 1;
    let med = if shifts.len() % 2 == 1 {
        shifts[mid]
    } else {
        (shifts[mid - 1] + shifts[mid]) / 2.0
    };
    if med.abs() <= 0.6 { Some(med) } else { None }
}

/// Distance from the center (cells) of the steepest outward rising edge in 2.3…3.7 cells; sub-sample accurate.
fn rising_edge(
    h: &Homography,
    luma: &LumaPlane,
    cx: f64,
    cy: f64,
    axis: u8,
    o: f64,
    dir: f64,
    min_step: f64,
) -> Option<f64> {
    let mut prof = [0.0f64; PROFILE_SAMPLES];
    for (i, p) in prof.iter_mut().enumerate() {
        let t = PROFILE_FROM + i as f64 * PROFILE_STEP;
        let x = if axis == 0 { cx + dir * t } else { cx + o };
        let y = if axis == 0 { cy + o } else { cy + dir * t };
        let [u, v] = project(h, x, y);
        let s = sample_luma(luma, u, v);
        if !s.is_finite() {
            return None;
        }
        *p = s;
    }
    let mut best: usize = 0;
    let mut found = false;
    let mut best_g = f64::NEG_INFINITY;
    for i in 1..PROFILE_SAMPLES - 1 {
        let g = prof[i + 1] - prof[i - 1];
        if g > best_g {
            best_g = g;
            best = i;
            found = true;
        }
    }
    if !found || !(2..=PROFILE_SAMPLES - 3).contains(&best) || best_g < min_step {
        return None;
    }
    let gm = prof[best] - prof[best - 2];
    let gp = prof[best + 2] - prof[best];
    let den = gm - 2.0 * best_g + gp;
    let frac = if den < 0.0 {
        ((0.5 * (gm - gp)) / den).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some(PROFILE_FROM + (best as f64 + frac) * PROFILE_STEP)
}

/// Mean anchor-to-anchor distance divided by its length in cells: sensor pixels per grid cell.
pub fn pixels_per_cell(h: &Homography, n: usize) -> f64 {
    let c: [[f64; 2]; 4] = anchor_center_points(n).map(|[x, y]| project(h, x, y));
    let mut sum = 0.0;
    for i in 0..4 {
        let a = c[i];
        let b = c[(i + 1) % 4];
        sum += js_hypot(b[0] - a[0], b[1] - a[1]);
    }
    sum / 4.0 / (n as f64 - ANCHOR_CELLS as f64)
}
