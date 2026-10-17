//! Parity tests for `calibrate`, `equalize`, `vamp` and `decode` against reference vectors produced by the
//! TypeScript codec (`packages/core/bench/vectors/equalize.ts` → `tests/vectors/equalize.json`), plus the
//! end-to-end fixtures under `fixtures/` (made by `pnpm fixtures:grid` in `packages/core`; skipped when absent).

use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sealed_facet::calibrate::{
    ChannelCalibration, DEFAULT_SIGMA, TonePoint, WHITE_EXCESS, anchor_calibration,
    correct_features, default_calibration, fit_channel, fit_tone_lut,
};
use sealed_facet::decode::{
    FusionStats, HeaderCandidate, Strip, decode_data, decode_headers, fuse_stats, observe,
    payload_matches_header,
};
use sealed_facet::equalize::{
    DEFAULT_EP_OPTIONS, EpOptions, EpProblem, detect_from_stats, ep_detect,
};
use sealed_facet::grid::calibration_picture;
use sealed_facet::header::parse_frame_header;
use sealed_facet::layout::grid_layout;
use sealed_facet::model::response_model;
use sealed_facet::sample::{CellSamples, ChannelLut, LUT_LEN, linear_lut};
use sealed_facet::types::{GridTier, Homography, RgbaImage};
use sealed_facet::vamp::{
    DEFAULT_VAMP_OPTIONS, VampOptions, VampProblem, half_cell_operator, symmetric_eigen,
    vamp_detect,
};
use serde::Deserialize;

fn vectors(name: &str) -> String {
    let path = format!("{}/tests/vectors/{name}.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    serde_json::from_str(&vectors(name)).unwrap_or_else(|e| panic!("parse {name}.json: {e}"))
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
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn lut_of(s: &str) -> ChannelLut {
    let v = b64_f32(s);
    assert_eq!(v.len(), LUT_LEN, "lut length");
    v.try_into().unwrap()
}

fn h9(v: &[f64]) -> Homography {
    v.try_into().expect("9 homography entries")
}

fn assert_f32_close(a: &[f32], b: &[f32], tol: f32, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        if x.is_nan() && y.is_nan() {
            continue;
        }
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

fn assert_f64_close(a: &[f64], b: &[f64], tol: f64, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

fn max_abs_diff_f32(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0f32, f32::max)
}

// --- unit vectors --------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationVec {
    white_excess: Vec<f64>,
    default_sigma: f64,
    x: Vec<f64>,
    sigma: f64,
    fitted: bool,
    rms_na_n: bool,
    lut: String,
}

#[derive(Deserialize)]
struct CorrectVec {
    n: usize,
    feat: String,
    valid: String,
    x: Vec<f64>,
    out: String,
}

#[derive(Deserialize)]
struct TonePointVec {
    code: Vec<f64>,
    target: Vec<f64>,
}

#[derive(Deserialize)]
struct ToneCase {
    name: String,
    points: Vec<TonePointVec>,
    lut: Option<String>,
}

#[derive(Deserialize)]
struct EigenCase {
    n: usize,
    a: String,
    values: String,
    vectors: String,
}

#[derive(Deserialize)]
struct OperatorVec {
    sigma: f64,
    n: usize,
    m: usize,
    a: String,
    v: String,
    vt: String,
    lambda: String,
}

#[derive(Deserialize)]
struct Decision {
    sym: String,
    margin: String,
    #[serde(default)]
    stats: Option<String>,
    #[serde(default)]
    rounds: Option<usize>,
    #[serde(default)]
    iterations: Option<usize>,
    #[serde(default)]
    calls: Vec<Call>,
}

#[derive(Deserialize)]
struct Call {
    #[serde(default)]
    round: Option<i32>,
    #[serde(default)]
    iteration: Option<usize>,
    sym: String,
    #[serde(default)]
    margin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectionVec {
    n: usize,
    sigma: f64,
    noise_variance: f64,
    y: String,
    cells: Vec<u32>,
    centroids: String,
    grams: String,
    classes: String,
    ep: Decision,
    ep_checkpoints: Decision,
    ep_short: Decision,
    from_stats: Decision,
    vamp: Decision,
    vamp_early: Decision,
    vamp_damped: Decision,
}

#[derive(Deserialize)]
struct StatsVec {
    b: String,
    m: String,
    captures: u32,
}

#[derive(Deserialize)]
struct FusionVec {
    a: StatsVec,
    b: StatsVec,
    out: StatsVec,
}

#[derive(Deserialize)]
struct CrcVec {
    header: String,
    payload: String,
    matches: bool,
    altered: bool,
    tail: bool,
    truncated: bool,
}

#[derive(Deserialize)]
struct Vectors {
    calibration: CalibrationVec,
    correct: CorrectVec,
    tone: Vec<ToneCase>,
    eigen: Vec<EigenCase>,
    operators: Vec<OperatorVec>,
    detection: DetectionVec,
    fusion: FusionVec,
    crc: CrcVec,
}

fn stats_of(s: &StatsVec) -> FusionStats {
    FusionStats {
        b: b64_f32(&s.b),
        m: b64_f64(&s.m),
        captures: s.captures,
    }
}

#[test]
fn default_calibration_matches() {
    let v: Vectors = load("equalize");
    let c = &v.calibration;
    // serde_json parses decimals without the `float_roundtrip` feature, so JSON f64s may be 1 ulp off.
    assert_f64_close(&WHITE_EXCESS[..], &c.white_excess, 1e-15, "WHITE_EXCESS");
    assert_eq!(DEFAULT_SIGMA, c.default_sigma);
    let d = default_calibration();
    assert_f64_close(&d.x, &c.x, 1e-15, "x");
    assert_eq!(d.sigma, c.sigma);
    assert_eq!(d.fitted, c.fitted);
    assert!(c.rms_na_n && d.rms.is_nan());
    assert_eq!(&d.lut[..], &lut_of(&c.lut)[..], "lut");
    assert_eq!(&d.lut[..], &linear_lut()[..]);
}

#[test]
fn correct_features_matches() {
    let v: Vectors = load("equalize");
    let c = &v.correct;
    let samples = CellSamples {
        n: c.n,
        feat: b64_f32(&c.feat),
        valid: b64(&c.valid),
    };
    let x: [f64; 12] = c.x.clone().try_into().unwrap();
    let got = correct_features(&samples, &x);
    let want = b64_f32(&c.out);
    assert_eq!(got.len(), want.len());
    for (i, (g, w)) in got.iter().zip(&want).enumerate() {
        assert!(
            g.to_bits() == w.to_bits() || (g.is_nan() && w.is_nan()),
            "feature {i}: {g} vs {w}"
        );
    }
}

#[test]
fn fit_tone_lut_matches() {
    let v: Vectors = load("equalize");
    for case in &v.tone {
        let pts: Vec<TonePoint> = case
            .points
            .iter()
            .map(|p| TonePoint {
                code: p.code.clone().try_into().unwrap(),
                target: p.target.clone().try_into().unwrap(),
            })
            .collect();
        let got = fit_tone_lut(&pts);
        match (&got, &case.lut) {
            (Some(g), Some(w)) => {
                let want = lut_of(w);
                let d = max_abs_diff_f32(&g[..], &want[..]);
                assert!(d <= 1e-7, "{}: lut max |Δ| = {d}", case.name);
            }
            (None, None) => {}
            _ => panic!(
                "{}: fit {:?} vs {:?}",
                case.name,
                got.is_some(),
                case.lut.is_some()
            ),
        }
    }
}

#[test]
fn symmetric_eigen_matches() {
    let v: Vectors = load("equalize");
    for (ci, case) in v.eigen.iter().enumerate() {
        let n = case.n;
        let a = b64_f64(&case.a);
        let e = symmetric_eigen(&a, n).unwrap_or_else(|| panic!("case {ci}: no convergence"));
        let values = b64_f64(&case.values);
        let vectors = b64_f64(&case.vectors);
        assert_eq!(e.values.len(), n);
        assert_eq!(e.vectors.len(), n * n);
        let dv = e
            .values
            .iter()
            .zip(&values)
            .map(|(x, y)| (x - y).abs())
            .fold(0f64, f64::max);
        assert!(dv <= 1e-9, "case {ci} (n={n}): eigenvalue max |Δ| = {dv}");
        println!("eigen case {ci} (n={n}): eigenvalue max |Δ| = {dv:.3e}");
        // Eigenvectors (columns) match up to sign.
        for j in 0..n {
            let mut same = 0f64;
            let mut flipped = 0f64;
            for i in 0..n {
                same = same.max((e.vectors[i * n + j] - vectors[i * n + j]).abs());
                flipped = flipped.max((e.vectors[i * n + j] + vectors[i * n + j]).abs());
            }
            assert!(
                same <= 1e-9 || flipped <= 1e-9,
                "case {ci} (n={n}): eigenvector {j} differs (|Δ| {same} / sign-flipped {flipped})"
            );
        }
        // And they diagonalize `a`: A v = λ v.
        for j in 0..n {
            for i in 0..n {
                let mut av = 0f64;
                for k in 0..n {
                    av += a[i * n + k] * e.vectors[k * n + j];
                }
                let lv = e.values[j] * e.vectors[i * n + j];
                assert!(
                    (av - lv).abs() <= 1e-9,
                    "case {ci}: A v ≠ λ v at ({i}, {j})"
                );
            }
        }
    }
    assert!(symmetric_eigen(&[1.0, 2.0], 2).is_none(), "short input");
    let empty = symmetric_eigen(&[], 0).unwrap();
    assert!(empty.values.is_empty() && empty.vectors.is_empty());
}

#[test]
fn half_cell_operator_matches() {
    let v: Vectors = load("equalize");
    for o in &v.operators {
        let model = response_model(o.sigma);
        let op = half_cell_operator(&model, o.n).expect("operator");
        assert_eq!(op.n, o.n);
        assert_eq!(op.m, o.m);
        assert_f64_close(&op.a, &b64_f64(&o.a), 0.0, "a");
        assert_f64_close(&op.lambda, &b64_f64(&o.lambda), 1e-9, "lambda");
        let want_v = b64_f64(&o.v);
        let want_vt = b64_f64(&o.vt);
        let m = o.m;
        for j in 0..m {
            let mut same = 0f64;
            let mut flipped = 0f64;
            for i in 0..m {
                same = same.max((op.v[i * m + j] - want_v[i * m + j]).abs());
                flipped = flipped.max((op.v[i * m + j] + want_v[i * m + j]).abs());
                assert_eq!(
                    op.vt[j * m + i].to_bits(),
                    op.v[i * m + j].to_bits(),
                    "vt is vᵀ"
                );
                assert_eq!(want_vt[j * m + i].to_bits(), want_v[i * m + j].to_bits());
            }
            assert!(
                same <= 1e-9 || flipped <= 1e-9,
                "σ {} n {}: column {j}",
                o.sigma,
                o.n
            );
        }
        // The cache hands back the same operator.
        let again = half_cell_operator(&model, o.n).expect("operator");
        assert!(std::sync::Arc::ptr_eq(&op, &again));
    }
}

fn assert_decision(sym: &[u8], margin: &[f32], want: &Decision, tol: f32, what: &str) {
    let want_sym = b64(&want.sym);
    let want_margin = b64_f32(&want.margin);
    assert_eq!(sym, &want_sym[..], "{what}: sym");
    let d = max_abs_diff_f32(margin, &want_margin);
    assert_eq!(margin.len(), want_margin.len(), "{what}: margin length");
    assert!(d <= tol, "{what}: margin max |Δ| = {d}");
    println!("{what}: margin max |Δ| = {d:.3e}");
}

#[test]
fn ep_detect_matches() {
    let v: Vectors = load("equalize");
    let d = &v.detection;
    let model = response_model(d.sigma);
    let y = b64_f32(&d.y);
    let centroids = b64_f32(&d.centroids);
    let grams = b64_f64(&d.grams);
    let classes = b64(&d.classes);
    let problem = EpProblem {
        n: d.n,
        model: &model,
        y: &y,
        cells: &d.cells,
        grams: &grams,
        classes: &classes,
        centroids: &centroids,
        noise_variance: d.noise_variance,
    };
    let r = ep_detect(&problem, &DEFAULT_EP_OPTIONS, None).expect("ep");
    assert_decision(&r.sym, &r.margin, &d.ep, 1e-4, "ep");
    assert_eq!(Some(r.rounds), d.ep.rounds);
    let want_stats = b64_f32(d.ep.stats.as_deref().unwrap());
    let ds = max_abs_diff_f32(&r.stats, &want_stats);
    let scale = want_stats.iter().fold(0f32, |a, &s| a.max(s.abs()));
    assert!(ds <= 1e-3 * (1.0 + scale), "ep stats max |Δ| = {ds}");
    println!("ep stats max |Δ| = {ds:.3e} (max |stat| {scale:.3e})");

    // Checkpoints and the round callback (stops at round 2).
    let mut calls: Vec<(i32, Vec<u8>)> = Vec::new();
    let mut cb = |round: i32, sym: &[u8], _margin: &[f32]| -> bool {
        calls.push((round, sym.to_vec()));
        round == 2
    };
    let opts = EpOptions {
        checkpoints: &[2, 5],
        ..DEFAULT_EP_OPTIONS
    };
    let r = ep_detect(&problem, &opts, Some(&mut cb)).expect("ep");
    assert_decision(&r.sym, &r.margin, &d.ep_checkpoints, 1e-4, "ep checkpoints");
    assert_eq!(Some(r.rounds), d.ep_checkpoints.rounds);
    assert_eq!(calls.len(), d.ep_checkpoints.calls.len(), "callback count");
    for (i, (got, want)) in calls.iter().zip(&d.ep_checkpoints.calls).enumerate() {
        assert_eq!(got.0, want.round.unwrap(), "call {i}: round");
        assert_eq!(got.1, b64(&want.sym), "call {i}: sym");
    }

    let opts = EpOptions {
        rounds: 2,
        cg_iterations: &[6],
        checkpoints: &[],
        damping: 0.7,
        min_variance: 1e-5,
        cg_tolerance: 1e-3,
    };
    let r = ep_detect(&problem, &opts, None).expect("ep");
    assert_decision(&r.sym, &r.margin, &d.ep_short, 1e-4, "ep short");
    assert_eq!(Some(r.rounds), d.ep_short.rounds);

    // Fused statistics of the first result.
    let r = ep_detect(&problem, &DEFAULT_EP_OPTIONS, None).expect("ep");
    let gram_sums: Vec<f64> = grams.iter().map(|g| g / d.noise_variance).collect();
    let entry_classes: Vec<u8> = d.cells.iter().map(|&c| classes[c as usize]).collect();
    let f = detect_from_stats(&r.stats, &gram_sums, &entry_classes, &centroids).expect("stats");
    assert_decision(&f.sym, &f.margin, &d.from_stats, 1e-3, "from stats");

    // Bad input is refused, not panicked on.
    assert!(
        ep_detect(
            &EpProblem {
                y: &y[..12],
                ..problem
            },
            &DEFAULT_EP_OPTIONS,
            None
        )
        .is_none()
    );
    assert!(
        ep_detect(
            &EpProblem {
                cells: &[(d.n * d.n) as u32],
                ..problem
            },
            &DEFAULT_EP_OPTIONS,
            None
        )
        .is_none()
    );
    assert!(detect_from_stats(&r.stats, &gram_sums, &[255], &centroids).is_none());
}

#[test]
fn vamp_detect_matches() {
    let v: Vectors = load("equalize");
    let d = &v.detection;
    let model = response_model(d.sigma);
    let y = b64_f32(&d.y);
    let centroids = b64_f32(&d.centroids);
    let problem = VampProblem {
        n: d.n,
        model: &model,
        y: &y,
        cells: &d.cells,
        centroids: &centroids,
        noise_variance: d.noise_variance,
    };
    let r = vamp_detect(&problem, &DEFAULT_VAMP_OPTIONS, None).expect("vamp");
    assert_decision(&r.sym, &r.margin, &d.vamp, 1e-4, "vamp");
    assert_eq!(Some(r.iterations), d.vamp.iterations);

    let mut calls: Vec<(usize, Vec<u8>, Vec<f32>)> = Vec::new();
    let mut cb = |it: usize, sym: &[u8], margin: &[f32]| -> bool {
        calls.push((it, sym.to_vec(), margin.to_vec()));
        it == 3
    };
    let r = vamp_detect(&problem, &DEFAULT_VAMP_OPTIONS, Some(&mut cb)).expect("vamp");
    assert_decision(&r.sym, &r.margin, &d.vamp_early, 1e-4, "vamp early");
    assert_eq!(Some(r.iterations), d.vamp_early.iterations);
    assert_eq!(calls.len(), d.vamp_early.calls.len());
    for (i, (got, want)) in calls.iter().zip(&d.vamp_early.calls).enumerate() {
        assert_eq!(got.0, want.iteration.unwrap(), "call {i}: iteration");
        assert_eq!(got.1, b64(&want.sym), "call {i}: sym");
        let dm = max_abs_diff_f32(&got.2, &b64_f32(want.margin.as_deref().unwrap()));
        assert!(dm <= 1e-4, "call {i}: margin max |Δ| = {dm}");
    }

    let r = vamp_detect(
        &problem,
        &VampOptions {
            iterations: 5,
            damping: 0.8,
        },
        None,
    )
    .expect("vamp");
    assert_decision(&r.sym, &r.margin, &d.vamp_damped, 1e-4, "vamp damped");
    assert_eq!(Some(r.iterations), d.vamp_damped.iterations);

    assert!(
        vamp_detect(
            &VampProblem {
                y: &y[..12],
                ..problem
            },
            &DEFAULT_VAMP_OPTIONS,
            None
        )
        .is_none()
    );
    assert!(
        vamp_detect(
            &VampProblem {
                centroids: &[],
                ..problem
            },
            &DEFAULT_VAMP_OPTIONS,
            None
        )
        .is_none()
    );
}

#[test]
fn fuse_stats_matches() {
    let v: Vectors = load("equalize");
    let out = fuse_stats(&stats_of(&v.fusion.a), &stats_of(&v.fusion.b));
    let want = stats_of(&v.fusion.out);
    assert_f32_close(&out.b, &want.b, 0.0, "b");
    assert_f64_close(&out.m, &want.m, 0.0, "m");
    assert_eq!(out.captures, want.captures);
}

#[test]
fn payload_matches_header_matches() {
    let v: Vectors = load("equalize");
    let c = &v.crc;
    let bytes: [u8; 12] = b64(&c.header).try_into().unwrap();
    let candidate = HeaderCandidate {
        header: parse_frame_header(&bytes).expect("header"),
        bytes,
        strip: Strip::Bottom,
    };
    let payload = b64(&c.payload);
    assert_eq!(payload_matches_header(&candidate, &payload), c.matches);
    let mut altered = payload.clone();
    altered[10] ^= 1;
    assert_eq!(payload_matches_header(&candidate, &altered), c.altered);
    let mut tail = payload.clone();
    tail[200] ^= 1;
    assert_eq!(payload_matches_header(&candidate, &tail), c.tail);
    assert_eq!(
        payload_matches_header(&candidate, &payload[..40]),
        c.truncated
    );
}

// --- fixtures ------------------------------------------------------------------------------------------------

mod fixtures {
    use super::*;

    #[derive(Deserialize)]
    struct Capture {
        width: usize,
        height: usize,
        file: String,
    }
    #[derive(Deserialize)]
    struct Refine {
        h: Vec<f64>,
        used: bool,
    }
    #[derive(Deserialize)]
    struct Truth {
        header: String,
        payload: String,
    }
    #[derive(Deserialize)]
    struct CalibrationIn {
        x: Vec<f64>,
        sigma: f64,
        fitted: bool,
        rms: Option<f64>,
        lut: String,
        centroids: String,
    }
    #[derive(Deserialize)]
    struct CalibrationOut {
        x: Vec<f64>,
        sigma: f64,
        rms: f64,
        lut: String,
        centroids: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ObservationVec {
        file: String,
        valid: String,
        noise_variance: f64,
    }
    #[derive(Deserialize)]
    struct HeaderVec {
        bytes: String,
        strip: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Decoded {
        payload: Option<String>,
        codeword_fraction: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        name: String,
        tier: u8,
        n: usize,
        r#type: String,
        capture: Capture,
        truth: Truth,
        coarse: Vec<f64>,
        refine: Option<Refine>,
        calibration_in: CalibrationIn,
        observation: ObservationVec,
        headers: Vec<HeaderVec>,
        header_matched: bool,
        decoded: Decoded,
        calibration_out: Option<CalibrationOut>,
    }

    fn fixture_paths() -> Option<Vec<std::path::PathBuf>> {
        let dir = format!("{}/fixtures", env!("CARGO_MANIFEST_DIR"));
        let Ok(entries) = std::fs::read_dir(&dir) else {
            eprintln!("skipping: fixtures directory {dir} is missing");
            return None;
        };
        let mut paths: Vec<_> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                name.starts_with('t') && name.ends_with(".json") && name.contains('-')
            })
            .collect();
        paths.sort();
        if paths.is_empty() {
            eprintln!("skipping: no t*-*.json fixtures in {dir}");
            return None;
        }
        Some(paths)
    }

    #[test]
    fn decode_pipeline_matches_javascript() {
        let Some(paths) = fixture_paths() else {
            return;
        };
        let dir = format!("{}/fixtures", env!("CARGO_MANIFEST_DIR"));
        for path in paths {
            let text = std::fs::read_to_string(&path).unwrap();
            let f: Fixture =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let name = &f.name;
            let tier = GridTier::from_u8(f.tier).expect("grid tier");
            let layout = grid_layout(tier);
            assert_eq!(layout.n, f.n, "{name}: grid size");
            let data = std::fs::read(format!("{dir}/{}", f.capture.file)).unwrap();
            assert_eq!(
                data.len(),
                f.capture.width * f.capture.height * 4,
                "{name}: capture size"
            );
            let img = RgbaImage::new(f.capture.width, f.capture.height, &data);
            let h = h9(match &f.refine {
                Some(r) if r.used => &r.h,
                _ => &f.coarse,
            });
            let ci = &f.calibration_in;
            let cal = ChannelCalibration {
                lut: lut_of(&ci.lut),
                x: ci.x.clone().try_into().unwrap(),
                sigma: ci.sigma,
                fitted: ci.fitted,
                rms: ci.rms.unwrap_or(f64::NAN),
            };
            let centroids = b64_f32(&ci.centroids);

            // Before any calibration frame the receiver used the anchor fallback: reproduce it.
            if !cal.fitted {
                let fallback = anchor_calibration(&img, &h, layout, &default_calibration())
                    .unwrap_or_else(|| panic!("{name}: anchor calibration"));
                assert_f64_close(&fallback.x, &cal.x, 1e-9, &format!("{name}: anchor x"));
                assert_eq!(fallback.sigma, cal.sigma, "{name}: anchor sigma");
                assert!(!fallback.fitted && fallback.rms.is_nan());
                assert_eq!(&fallback.lut[..], &cal.lut[..], "{name}: anchor lut");
            }

            // observe
            let t0 = Instant::now();
            let obs = observe(&img, &h, layout, &cal, &centroids)
                .unwrap_or_else(|| panic!("{name}: observe"));
            let t_observe = t0.elapsed();
            let want_feat_bytes = std::fs::read(format!("{dir}/{}", f.observation.file)).unwrap();
            let want_feat: Vec<f32> = want_feat_bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            assert_eq!(obs.feat.len(), want_feat.len(), "{name}: feature count");
            let d = max_abs_diff_f32(&obs.feat, &want_feat);
            assert!(d <= 1e-5, "{name}: corrected features max |Δ| = {d}");
            println!("{name}: corrected features max |Δ| = {d:.3e}");
            assert_eq!(obs.valid, b64(&f.observation.valid), "{name}: valid");
            assert!(
                (obs.noise_variance - f.observation.noise_variance).abs() <= 1e-9,
                "{name}: noise variance {} vs {}",
                obs.noise_variance,
                f.observation.noise_variance
            );

            // headers
            let t0 = Instant::now();
            let cands = decode_headers(&obs);
            let t_headers = t0.elapsed();
            assert_eq!(
                cands.len(),
                f.headers.len(),
                "{name}: header candidate count"
            );
            for (i, (c, w)) in cands.iter().zip(&f.headers).enumerate() {
                assert_eq!(&c.bytes[..], &b64(&w.bytes)[..], "{name}: header {i} bytes");
                let strip = match w.strip.as_str() {
                    "top" => Strip::Top,
                    "bottom" => Strip::Bottom,
                    s => panic!("{name}: strip {s}"),
                };
                assert_eq!(c.strip, strip, "{name}: header {i} strip");
                assert_eq!(c.header, parse_frame_header(&c.bytes).unwrap());
            }
            let truth_header = b64(&f.truth.header);
            let cand = cands.iter().find(|c| c.bytes[..] == truth_header[..]);
            assert_eq!(cand.is_some(), f.header_matched, "{name}: headerMatched");

            let mut t_decode = None;
            let mut t_fit = None;
            if f.r#type == "calibration" {
                let cand = cand.expect("calibration header decoded");
                let pic = calibration_picture(layout, &cand.bytes).expect("picture");
                let t0 = Instant::now();
                let fit = fit_channel(&img, &h, layout, &pic, &cal, &centroids, true)
                    .unwrap_or_else(|| panic!("{name}: fit_channel"));
                t_fit = Some(t0.elapsed());
                let want = f.calibration_out.as_ref().expect("calibrationOut");
                assert_f64_close(&fit.channel.x, &want.x, 1e-6, &format!("{name}: x"));
                assert!(
                    (fit.channel.sigma - want.sigma).abs() <= 1e-9,
                    "{name}: sigma {} vs {}",
                    fit.channel.sigma,
                    want.sigma
                );
                assert!(
                    (fit.channel.rms - want.rms).abs() <= 1e-6,
                    "{name}: rms {} vs {}",
                    fit.channel.rms,
                    want.rms
                );
                assert!(fit.channel.fitted);
                let dl = max_abs_diff_f32(&fit.channel.lut[..], &lut_of(&want.lut)[..]);
                assert!(dl <= 1e-5, "{name}: lut max |Δ| = {dl}");
                let dc = max_abs_diff_f32(&fit.centroids, &b64_f32(&want.centroids));
                assert!(dc <= 1e-5, "{name}: centroids max |Δ| = {dc}");
                let dx = fit
                    .channel
                    .x
                    .iter()
                    .zip(&want.x)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0f64, f64::max);
                println!(
                    "{name}: fit x max |Δ| = {dx:.3e}, rms |Δ| = {:.3e}, lut max |Δ| = {dl:.3e}, centroids max |Δ| = {dc:.3e}",
                    (fit.channel.rms - want.rms).abs()
                );
                assert!(f.decoded.payload.is_none());
            } else if let Some(cand) = cand {
                let t0 = Instant::now();
                let res = decode_data(&obs, cand, None);
                t_decode = Some(t0.elapsed());
                let want_payload = f.decoded.payload.as_deref().map(b64);
                let payload = res.payload.filter(|p| payload_matches_header(cand, p));
                assert_eq!(payload, want_payload, "{name}: payload");
                if let Some(p) = &payload {
                    assert_eq!(p, &b64(&f.truth.payload), "{name}: payload is the truth");
                }
                assert!(
                    (res.codeword_fraction - f.decoded.codeword_fraction).abs() <= 1e-9,
                    "{name}: codewordFraction {} vs {}",
                    res.codeword_fraction,
                    f.decoded.codeword_fraction
                );
                assert!(f.calibration_out.is_none());
            }
            println!(
                "{name}: observe {:.1} ms, headers {:.1} ms{}{}",
                t_observe.as_secs_f64() * 1e3,
                t_headers.as_secs_f64() * 1e3,
                t_decode.map_or(String::new(), |t| format!(
                    ", decode_data {:.1} ms",
                    t.as_secs_f64() * 1e3
                )),
                t_fit.map_or(String::new(), |t| format!(
                    ", fit_channel {:.1} ms",
                    t.as_secs_f64() * 1e3
                )),
            );
        }
    }
}
