//! Parity tests for `detect` and `refine` against vectors produced by the TypeScript codec
//! (`packages/core/bench/vectors/{detect,detect-e2e,refine}.ts`, written to `tests/vectors/`), plus stage parity
//! over the end-to-end fixtures under `fixtures/` (made by `pnpm fixtures:grid`; skipped when absent).

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sealed_facet::detect::{
    CornerSet, GridDetector, anchor_center_points, grid_homography, grid_sizes_for, linear_luma,
    pixels_per_cell, sample_luma,
};
use sealed_facet::layout::grid_layout;
use sealed_facet::refine::{
    RefinePoints, RefineResult, anchor_points, refine_homography, refine_points,
};
use sealed_facet::types::{GridTier, Homography, LumaPlane, RgbaImage};
use serde::Deserialize;

fn vectors_dir() -> String {
    format!("{}/tests/vectors", env!("CARGO_MANIFEST_DIR"))
}

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = format!("{}/{name}.json", vectors_dir());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {name}.json: {e}"))
}

fn b64(s: &str) -> Vec<u8> {
    STANDARD.decode(s).expect("valid base64")
}

fn b64_f32(s: &str) -> Vec<f32> {
    b64(s)
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn b64_f64(s: &str) -> Vec<f64> {
    b64(s)
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().expect("8 bytes")))
        .collect()
}

fn b64_i16(s: &str) -> Vec<i16> {
    b64(s)
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

fn h9(v: &[f64]) -> Homography {
    v.try_into().expect("homography has 9 entries")
}

/// Relative comparison (floored at absolute 1), NaN equals NaN.
fn assert_rel(a: &[f64], b: &[f64], rel: f64, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        if x.is_nan() && y.is_nan() {
            continue;
        }
        let tol = rel * x.abs().max(y.abs()).max(1.0);
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

fn assert_abs(a: &[f64], b: &[f64], tol: f64, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        if x.is_nan() && y.is_nan() {
            continue;
        }
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

fn flat_points(p: &[[f64; 2]; 4]) -> Vec<f64> {
    p.iter().flat_map(|q| q.iter().copied()).collect()
}

fn assert_corner_set(got: &CornerSet, points: &[[f64; 2]], unit: f64, score: f64, what: &str) {
    let want: Vec<f64> = points.iter().flat_map(|q| q.iter().copied()).collect();
    assert_abs(
        &flat_points(&got.points),
        &want,
        1e-6,
        &format!("{what} points"),
    );
    assert_rel(&[got.unit], &[unit], 1e-9, &format!("{what} unit"));
    assert_rel(&[got.score], &[score], 1e-9, &format!("{what} score"));
}

fn opt_nan(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::NAN)
}

mod unit {
    use super::*;

    #[derive(Deserialize)]
    struct Image {
        width: usize,
        height: usize,
        rgba: String,
    }
    #[derive(Deserialize)]
    struct Thin {
        width: usize,
        height: usize,
        data: Vec<f32>,
        probes: Vec<[f64; 2]>,
        samples: Vec<Option<f64>>,
    }
    #[derive(Deserialize)]
    struct Set {
        points: Vec<[f64; 2]>,
        unit: f64,
        score: f64,
    }
    #[derive(Deserialize)]
    struct Ppc {
        h: Vec<f64>,
        n: usize,
        ppc: Option<f64>,
    }
    #[derive(Deserialize)]
    struct Vectors {
        image: Image,
        luma: String,
        probes: Vec<[f64; 2]>,
        samples: Vec<Option<f64>>,
        thin: Vec<Thin>,
        sets: Vec<Set>,
        sizes: Vec<Vec<usize>>,
        centers: Vec<Vec<[f64; 2]>>,
        ppc: Vec<Ppc>,
    }

    fn set_of(s: &Set) -> CornerSet {
        CornerSet {
            points: s.points.as_slice().try_into().expect("four points"),
            unit: s.unit,
            score: s.score,
        }
    }

    #[test]
    fn linear_luma_exact() {
        let v: Vectors = load("detect");
        let rgba = b64(&v.image.rgba);
        let img = RgbaImage::new(v.image.width, v.image.height, &rgba);
        let luma = linear_luma(&img).expect("buffer fits");
        let want = b64_f32(&v.luma);
        assert_eq!(luma.width, v.image.width);
        assert_eq!(luma.height, v.image.height);
        assert_eq!(luma.data.len(), want.len());
        for (i, (a, b)) in luma.data.iter().zip(&want).enumerate() {
            assert!(a.to_bits() == b.to_bits(), "luma[{i}]: {a} vs {b}");
        }
        // Stride: the same image with a padded row pitch gives the same plane.
        let stride = v.image.width * 4 + 12;
        let mut padded = vec![0u8; stride * v.image.height];
        for y in 0..v.image.height {
            padded[y * stride..y * stride + v.image.width * 4]
                .copy_from_slice(&rgba[y * v.image.width * 4..(y + 1) * v.image.width * 4]);
        }
        let img2 = RgbaImage {
            width: v.image.width,
            height: v.image.height,
            stride,
            data: &padded,
        };
        let luma2 = linear_luma(&img2).expect("buffer fits");
        assert_eq!(luma2.data, luma.data);
        // Short buffers are refused, not read out of bounds.
        let short = RgbaImage::new(v.image.width, v.image.height, &rgba[..rgba.len() - 1]);
        assert!(linear_luma(&short).is_none());
    }

    #[test]
    fn sample_luma_exact() {
        let v: Vectors = load("detect");
        let luma = LumaPlane {
            width: v.image.width,
            height: v.image.height,
            data: b64_f32(&v.luma),
        };
        let got: Vec<f64> = v
            .probes
            .iter()
            .map(|&[u, w]| sample_luma(&luma, u, w))
            .collect();
        let want: Vec<f64> = v.samples.iter().map(|&s| opt_nan(s)).collect();
        assert_abs(&got, &want, 0.0, "sampleLuma");
        for (k, t) in v.thin.iter().enumerate() {
            let plane = LumaPlane {
                width: t.width,
                height: t.height,
                data: t.data.clone(),
            };
            let got: Vec<f64> = t
                .probes
                .iter()
                .map(|&[u, w]| sample_luma(&plane, u, w))
                .collect();
            let want: Vec<f64> = t.samples.iter().map(|&s| opt_nan(s)).collect();
            assert_abs(&got, &want, 0.0, &format!("thin[{k}] sampleLuma"));
        }
        // A plane whose buffer is shorter than its dimensions samples NaN instead of panicking.
        let bad = LumaPlane {
            width: 10,
            height: 10,
            data: vec![0.5; 50],
        };
        assert!(sample_luma(&bad, 5.0, 5.0).is_nan());
    }

    #[test]
    fn grid_sizes_centers_pixels_per_cell() {
        let v: Vectors = load("detect");
        for (i, (s, want)) in v.sets.iter().zip(&v.sizes).enumerate() {
            assert_eq!(&grid_sizes_for(&set_of(s)), want, "gridSizesFor[{i}]");
        }
        for (n, want) in [112usize, 144, 7, 0].iter().zip(&v.centers) {
            let got = anchor_center_points(*n);
            let want: Vec<f64> = want.iter().flat_map(|q| q.iter().copied()).collect();
            assert_abs(
                &flat_points(&got),
                &want,
                0.0,
                &format!("anchorCenterPoints({n})"),
            );
        }
        for (i, p) in v.ppc.iter().enumerate() {
            let got = pixels_per_cell(&h9(&p.h), p.n);
            assert_rel(
                &[got],
                &[opt_nan(p.ppc)],
                1e-9,
                &format!("pixelsPerCell[{i}]"),
            );
        }
    }
}

mod refine {
    use super::*;

    #[derive(Deserialize)]
    struct Points {
        count: usize,
        xy8: String,
        pred: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Strips {
        bits: String,
        count: usize,
        extra: usize,
        every: usize,
        xy8: String,
        pred: String,
        prefix_same: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Sigma {
        sigma: f64,
        count: usize,
        first: Vec<f64>,
        sum_pred: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        tier: u8,
        n: usize,
        sigma: f64,
        anchors: Points,
        cached: bool,
        same_as_direct: bool,
        strips: Strips,
        sigmas: Vec<Sigma>,
    }

    fn xy_of(xy8: &str) -> Vec<f64> {
        b64_i16(xy8).iter().map(|&v| v as f64 / 8.0).collect()
    }

    fn check_tier(tier: GridTier) {
        let v: Vectors = load(&format!("refine-t{}", tier as u8));
        assert_eq!(v.tier, tier as u8);
        let layout = grid_layout(tier);
        assert_eq!(layout.n, v.n);
        // anchorPoints rounds σ to 1/50 (0.35 · 50 = 17.5 rounds up to σ = 0.36) and caches per (grid, σ).
        let a = anchor_points(layout, v.sigma);
        assert_eq!(a.pred.len(), v.anchors.count, "anchor point count");
        assert_eq!(a.xy.len(), 2 * v.anchors.count);
        assert_abs(&a.xy, &xy_of(&v.anchors.xy8), 0.0, "anchor xy");
        assert_abs(&a.pred, &b64_f64(&v.anchors.pred), 0.0, "anchor pred");
        let direct = refine_points(layout, v.sigma, None);
        assert_eq!(
            v.same_as_direct,
            *a == direct,
            "anchorPoints vs refinePoints at the unrounded σ"
        );
        assert_eq!(
            *a,
            refine_points(layout, 0.36, None),
            "anchorPoints equals refinePoints at the rounded σ"
        );
        let a2 = anchor_points(layout, 0.3501);
        assert_eq!(v.cached, Arc::ptr_eq(&a, &a2), "anchorPoints cache");
        assert!(
            *anchor_points(layout, 0.3499) == refine_points(layout, 0.34, None),
            "σ rounding down"
        );
        // With header strips: the anchor points come first, then the strip points. Known header cells change the
        // predictions near the anchors too, so the prefix is not the anchor-only set (the vector records that).
        let bits = b64(&v.strips.bits);
        let with = refine_points(layout, v.sigma, Some(&bits));
        assert_eq!(with.pred.len(), v.strips.count, "strip point count");
        let base = v.anchors.count;
        assert_eq!(with.pred.len() - base, v.strips.extra);
        let prefix_same = with.pred[..base] == a.pred[..] && with.xy[..2 * base] == a.xy[..];
        assert_eq!(
            prefix_same, v.strips.prefix_same,
            "anchor prefix of the strip points"
        );
        let want_xy = xy_of(&v.strips.xy8);
        let want_pred = b64_f64(&v.strips.pred);
        let mut got_xy = Vec::new();
        let mut got_pred = Vec::new();
        let mut i = base;
        while i < with.pred.len() {
            got_xy.push(with.xy[2 * i]);
            got_xy.push(with.xy[2 * i + 1]);
            got_pred.push(with.pred[i]);
            i += v.strips.every;
        }
        assert_abs(&got_xy, &want_xy, 0.0, "strip xy");
        assert_abs(&got_pred, &want_pred, 0.0, "strip pred");
        for s in &v.sigmas {
            let p = refine_points(layout, s.sigma, None);
            assert_eq!(p.pred.len(), s.count, "σ={} count", s.sigma);
            // Tail predictions of order 1e-28 differ by one ULP at σ = 0.2 (V8's fdlibm exp vs the platform's
            // libm); everything at working magnitudes matches exactly (the anchor vectors above).
            assert_rel(
                &p.pred[..s.first.len()],
                &s.first,
                1e-12,
                &format!("σ={} first", s.sigma),
            );
            let sum: f64 = p.pred.iter().sum();
            assert_rel(&[sum], &[s.sum_pred], 1e-12, &format!("σ={} sum", s.sigma));
        }
    }

    #[test]
    fn refine_points_t1() {
        check_tier(GridTier::T1);
    }

    #[test]
    fn refine_points_t2() {
        check_tier(GridTier::T2);
    }

    #[test]
    fn refine_points_t3() {
        check_tier(GridTier::T3);
    }

    #[test]
    fn refine_homography_rejects_bad_input() {
        let layout = grid_layout(GridTier::T1);
        let pts = anchor_points(layout, 0.35);
        let h: Homography = [4.0, 0.0, 10.0, 0.0, 4.0, 10.0, 0.0, 0.0, 1.0];
        let short = LumaPlane {
            width: 600,
            height: 600,
            data: vec![0.5; 100],
        };
        assert!(refine_homography(&short, &h, &pts).is_none());
        let flat = LumaPlane {
            width: 600,
            height: 600,
            data: vec![0.5; 360_000],
        };
        assert!(refine_homography(&flat, &h, &pts).is_none(), "no contrast");
        let few = RefinePoints {
            xy: vec![0.0; 20],
            pred: vec![0.0; 10],
        };
        assert!(refine_homography(&flat, &h, &few).is_none());
        let mismatched = RefinePoints {
            xy: vec![0.0; 10],
            pred: vec![0.0; 100],
        };
        assert!(refine_homography(&flat, &h, &mismatched).is_none());
    }
}

mod e2e {
    use super::*;

    #[derive(Deserialize)]
    struct Capture {
        width: usize,
        height: usize,
        file: String,
    }
    #[derive(Deserialize)]
    struct Luma {
        width: usize,
        height: usize,
        sum: f64,
    }
    #[derive(Deserialize)]
    struct Hs {
        n: usize,
        h: Option<Vec<f64>>,
        ppc: Option<f64>,
    }
    #[derive(Deserialize)]
    struct Set {
        points: Vec<[f64; 2]>,
        unit: f64,
        score: f64,
        sizes: Vec<usize>,
        hs: Vec<Hs>,
    }
    #[derive(Deserialize)]
    struct Refined {
        h: Vec<f64>,
        rms: f64,
        used: usize,
        adopted: bool,
    }
    #[derive(Deserialize)]
    struct Noise {
        rgba: String,
        sets: usize,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        tier: u8,
        n: usize,
        sigma: f64,
        capture: Capture,
        luma: Luma,
        sets: Vec<Set>,
        coarse: Vec<f64>,
        refined: Option<Refined>,
        perturbed: Vec<f64>,
        refined2: Option<Refined>,
        far: Vec<f64>,
        refined_far: Option<Refined>,
        same_again: bool,
        noise: Noise,
        tiny: usize,
        dark: usize,
    }

    fn assert_refined(got: Option<RefineResult>, want: &Option<Refined>, what: &str) {
        match (got, want) {
            (None, None) => {}
            (Some(g), Some(w)) => {
                assert_rel(&g.h, &w.h, 1e-9, &format!("{what} h"));
                assert_rel(&[g.rms], &[w.rms], 1e-9, &format!("{what} rms"));
                assert_eq!(g.used, w.used, "{what} used");
                assert_eq!(g.rms < 0.35, w.adopted, "{what} adopted");
            }
            (g, w) => panic!(
                "{what}: {:?} vs {}",
                g.map(|r| r.rms),
                w.as_ref().map_or("null".into(), |r| r.rms.to_string())
            ),
        }
    }

    #[test]
    fn synthetic_capture() {
        let v: Vectors = load("detect-e2e");
        let path = format!("{}/{}", vectors_dir(), v.capture.file);
        let rgba = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        assert_eq!(rgba.len(), v.capture.width * v.capture.height * 4);
        let img = RgbaImage::new(v.capture.width, v.capture.height, &rgba);
        let mut det = GridDetector::new();
        let sets = det.detect(&img);
        let luma = det.luma.as_ref().expect("luma plane kept");
        assert_eq!((luma.width, luma.height), (v.luma.width, v.luma.height));
        let sum: f64 = luma.data.iter().map(|&x| x as f64).sum();
        assert_rel(&[sum], &[v.luma.sum], 1e-9, "luma sum");
        assert_eq!(sets.len(), v.sets.len(), "corner set count");
        for (i, (got, want)) in sets.iter().zip(&v.sets).enumerate() {
            assert_corner_set(
                got,
                &want.points,
                want.unit,
                want.score,
                &format!("set[{i}]"),
            );
            assert_eq!(grid_sizes_for(got), want.sizes, "set[{i}] sizes");
            for hs in &want.hs {
                let h = grid_homography(got, hs.n, luma);
                match (&h, &hs.h) {
                    (Some(h), Some(w)) => {
                        assert_rel(h, w, 1e-9, &format!("set[{i}] gridHomography({})", hs.n));
                        assert_rel(&[pixels_per_cell(h, hs.n)], &[opt_nan(hs.ppc)], 1e-9, "ppc");
                    }
                    (None, None) => {}
                    _ => panic!("set[{i}] gridHomography({}): {h:?} vs {:?}", hs.n, hs.h),
                }
            }
        }
        let coarse = grid_homography(&sets[0], v.n, luma).expect("coarse homography");
        assert_rel(&coarse, &v.coarse, 1e-9, "coarse");
        let tier = GridTier::from_u8(v.tier).expect("grid tier");
        let pts = anchor_points(grid_layout(tier), v.sigma);
        assert_refined(
            refine_homography(luma, &coarse, &pts),
            &v.refined,
            "refined",
        );
        assert_refined(
            refine_homography(luma, &h9(&v.perturbed), &pts),
            &v.refined2,
            "refined2",
        );
        assert_refined(
            refine_homography(luma, &h9(&v.far), &pts),
            &v.refined_far,
            "refinedFar",
        );
        // Detecting again on the same detector (buffers reused) gives the same sets.
        let again = det.detect(&img);
        let same = again.len() == sets.len()
            && again
                .iter()
                .zip(&sets)
                .all(|(a, b)| a.points == b.points && a.unit == b.unit && a.score == b.score);
        assert_eq!(same, v.same_again, "second detection");
        // Negative cases.
        let noise = b64(&v.noise.rgba);
        assert_eq!(
            GridDetector::new()
                .detect(&RgbaImage::new(64, 64, &noise))
                .len(),
            v.noise.sets,
            "noise"
        );
        let tiny = vec![200u8; 31 * 40 * 4];
        assert_eq!(
            GridDetector::new()
                .detect(&RgbaImage::new(31, 40, &tiny))
                .len(),
            v.tiny,
            "tiny"
        );
        let dark = vec![10u8; 40 * 40 * 4];
        assert_eq!(
            GridDetector::new()
                .detect(&RgbaImage::new(40, 40, &dark))
                .len(),
            v.dark,
            "dark"
        );
        // A short buffer is refused without panicking, and does not disturb the kept luma plane.
        let mut det2 = GridDetector::new();
        assert!(
            det2.detect(&RgbaImage::new(64, 64, &noise[..100]))
                .is_empty()
        );
        assert!(det2.luma.is_none());
    }
}

mod fixtures {
    use super::*;

    #[derive(Deserialize)]
    struct File {
        width: usize,
        height: usize,
        file: String,
    }
    #[derive(Deserialize)]
    struct Detect {
        points: Vec<[f64; 2]>,
        unit: f64,
        score: f64,
        sets: usize,
    }
    #[derive(Deserialize)]
    struct Refine {
        h: Vec<f64>,
        rms: f64,
        used: bool,
    }
    #[derive(Deserialize)]
    struct CalibrationIn {
        sigma: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        name: String,
        tier: u8,
        n: usize,
        capture: File,
        luma: File,
        detect: Detect,
        coarse: Vec<f64>,
        refine: Option<Refine>,
        calibration_in: CalibrationIn,
    }

    fn fixture_paths() -> Vec<std::path::PathBuf> {
        let dir = format!("{}/fixtures", env!("CARGO_MANIFEST_DIR"));
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out: Vec<_> = rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| e == "json")
                    && p.file_name()
                        .and_then(|f| f.to_str())
                        .is_some_and(|f| f.starts_with('t') && f.contains('-'))
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn stage_parity() {
        let paths = fixture_paths();
        if paths.is_empty() {
            eprintln!(
                "no fixtures under crates/sealed-facet/fixtures (run `pnpm fixtures:grid` in packages/core); skipping"
            );
            return;
        }
        for path in paths {
            let dir = path.parent().expect("fixture dir");
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let f: Fixture = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
            let name = f.name.clone();
            let rgba = std::fs::read(dir.join(&f.capture.file))
                .unwrap_or_else(|e| panic!("{name}: capture: {e}"));
            assert_eq!(
                rgba.len(),
                f.capture.width * f.capture.height * 4,
                "{name}: capture size"
            );
            let img = RgbaImage::new(f.capture.width, f.capture.height, &rgba);
            let mut det = GridDetector::new();
            let sets = det.detect(&img);
            let luma = det.luma.as_ref().expect("luma plane kept");
            // Luma plane.
            let want_luma = std::fs::read(dir.join(&f.luma.file))
                .unwrap_or_else(|e| panic!("{name}: luma: {e}"));
            let want_luma: Vec<f32> = want_luma
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            assert_eq!(
                (luma.width, luma.height),
                (f.luma.width, f.luma.height),
                "{name}: luma dims"
            );
            assert_eq!(luma.data.len(), want_luma.len(), "{name}: luma length");
            let mut max_dev = 0f32;
            for (a, b) in luma.data.iter().zip(&want_luma) {
                max_dev = max_dev.max((a - b).abs());
            }
            assert!(max_dev <= 1e-6, "{name}: luma deviates by {max_dev}");
            // Corner sets.
            assert_eq!(sets.len(), f.detect.sets, "{name}: corner set count");
            let first = sets
                .first()
                .unwrap_or_else(|| panic!("{name}: no corner set"));
            assert_corner_set(
                first,
                &f.detect.points,
                f.detect.unit,
                f.detect.score,
                &format!("{name} detect"),
            );
            // Coarse homography.
            let coarse = grid_homography(first, f.n, luma)
                .unwrap_or_else(|| panic!("{name}: no homography"));
            assert_rel(&coarse, &f.coarse, 1e-9, &format!("{name} coarse"));
            // Model-based refinement from the coarse pose.
            let tier = GridTier::from_u8(f.tier).expect("grid tier");
            let pts = anchor_points(grid_layout(tier), f.calibration_in.sigma);
            let refined = refine_homography(luma, &coarse, &pts);
            match (&refined, &f.refine) {
                (Some(r), Some(w)) => {
                    assert_rel(&r.h, &w.h, 1e-9, &format!("{name} refine h"));
                    assert_rel(&[r.rms], &[w.rms], 1e-9, &format!("{name} refine rms"));
                    assert_eq!(r.rms < 0.35, w.used, "{name}: refine adoption rule");
                }
                (None, None) => {}
                _ => panic!(
                    "{name}: refine {refined:?} vs {}",
                    f.refine
                        .as_ref()
                        .map_or("null".into(), |r| r.rms.to_string())
                ),
            }
            let dev = |a: &[f64], b: &[f64]| {
                a.iter()
                    .zip(b)
                    .map(|(x, y)| (x - y).abs() / x.abs().max(y.abs()).max(1.0))
                    .fold(0f64, f64::max)
            };
            let want_pts: Vec<f64> = f
                .detect
                .points
                .iter()
                .flat_map(|q| q.iter().copied())
                .collect();
            let pts_dev = flat_points(&first.points)
                .iter()
                .zip(&want_pts)
                .map(|(x, y)| (x - y).abs())
                .fold(0f64, f64::max);
            let refine_dev = match (&refined, &f.refine) {
                (Some(r), Some(w)) => dev(&r.h, &w.h).max(dev(&[r.rms], &[w.rms])),
                _ => 0.0,
            };
            eprintln!(
                "{name}: ok (luma max dev {max_dev:e}, points max dev {pts_dev:e} px, coarse rel dev {:e}, refine rel dev {refine_dev:e})",
                dev(&coarse, &f.coarse)
            );
        }
    }
}
