//! Parity tests for `homography`, `model` and `sample` against vectors produced by the TypeScript codec
//! (`packages/core/bench/vectors/{geometry,sample}.ts`, written to `tests/vectors/{geometry,sample}.json`), plus a
//! shape/finiteness check of `sample_cells` over the end-to-end fixtures under `fixtures/`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sealed_facet::types::{Homography, RgbaImage};
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

/// JSON `null` stands for NaN in the TypeScript vectors.
fn opt_nan(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::NAN)
}

fn h9(v: &[f64]) -> Homography {
    v.try_into().expect("homography has 9 entries")
}

fn assert_rel_close(a: &[f64], b: &[f64], rel: f64, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        if x.is_nan() && y.is_nan() {
            continue;
        }
        let tol = rel * x.abs().max(y.abs()).max(1.0);
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

/// f32 comparison with NaN-equality, relative to the larger magnitude (floored at 1).
fn assert_f32_rel(a: &[f32], b: &[f32], rel: f32, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        if x.is_nan() && y.is_nan() {
            continue;
        }
        let tol = rel * x.abs().max(y.abs()).max(1.0);
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

mod homography {
    use super::*;
    use sealed_facet::homography::{compose, homography_from_4, invert, project, solve_linear};

    #[derive(Deserialize)]
    struct Linear {
        label: String,
        n: usize,
        a: Vec<Option<f64>>,
        b: Vec<f64>,
        x: Option<Vec<f64>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct From4 {
        label: String,
        src: [[f64; 2]; 4],
        dst: [[f64; 2]; 4],
        h: Option<Vec<f64>>,
        project: Option<Vec<[Option<f64>; 2]>>,
        inv: Option<Vec<f64>>,
        h_inv_h: Option<Vec<f64>>,
        inv_h_h: Option<Vec<f64>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Compose {
        a: Vec<f64>,
        b: Vec<f64>,
        ab: Vec<f64>,
        ba: Vec<f64>,
        inv_a: Option<Vec<f64>>,
        inv_ab: Option<Vec<f64>>,
    }
    #[derive(Deserialize)]
    struct InvertSpecial {
        label: String,
        h: Vec<f64>,
        inv: Option<Vec<f64>>,
    }
    #[derive(Deserialize)]
    struct ProjectBehind {
        h: Vec<f64>,
        points: Vec<[Option<f64>; 4]>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        solve_linear: Vec<Linear>,
        homography_from4: Vec<From4>,
        compose: Vec<Compose>,
        invert_special: Vec<InvertSpecial>,
        project_behind: ProjectBehind,
    }

    const PROBES: [[f64; 2]; 6] = [
        [0.0, 0.0],
        [6.0, 6.0],
        [12.0, 12.0],
        [-3.0, 7.5],
        [100.0, -40.0],
        [1e3, 1e3],
    ];

    #[test]
    fn solve_linear_matches() {
        let v: Vectors = load("geometry");
        for c in &v.solve_linear {
            let a: Vec<f64> = c.a.iter().map(|x| opt_nan(*x)).collect();
            let got = solve_linear(&a, &c.b, c.n);
            match (&got, &c.x) {
                (None, None) => {}
                (Some(g), Some(e)) => assert_rel_close(g, e, 1e-9, &c.label),
                _ => panic!("{}: {got:?} vs {:?}", c.label, c.x),
            }
        }
        assert!(
            solve_linear(&[1.0, 2.0], &[1.0], 2).is_none(),
            "short input"
        );
        assert!(solve_linear(&[], &[], 0).is_some_and(|x| x.is_empty()));
    }

    #[test]
    fn from_four_points_project_and_invert() {
        let v: Vectors = load("geometry");
        for c in &v.homography_from4 {
            let got = homography_from_4(&c.src, &c.dst);
            let Some(e) = &c.h else {
                assert!(got.is_none(), "{}: expected degenerate", c.label);
                continue;
            };
            let h = got.unwrap_or_else(|| panic!("{}: expected a homography", c.label));
            assert_rel_close(&h, e, 1e-9, &c.label);
            assert_eq!(h[8], 1.0);
            // Correspondences are reproduced exactly (a collinear target quad still solves, but maps its
            // own corners behind the camera, so it is only checked for parity).
            let proper = c.label != "three collinear";
            if proper {
                for (s, d) in c.src.iter().zip(&c.dst) {
                    let p = project(&h, s[0], s[1]);
                    assert_rel_close(&p, d, 1e-7, &format!("{}: correspondence", c.label));
                }
            }
            let proj: Vec<f64> = c
                .project
                .as_ref()
                .unwrap()
                .iter()
                .flat_map(|p| [opt_nan(p[0]), opt_nan(p[1])])
                .collect();
            let got_proj: Vec<f64> = PROBES
                .iter()
                .flat_map(|p| project(&h, p[0], p[1]))
                .collect();
            assert_rel_close(&got_proj, &proj, 1e-9, &format!("{}: project", c.label));
            let inv = invert(&h);
            match (&inv, &c.inv) {
                (None, None) => {}
                (Some(g), Some(e)) => {
                    assert_rel_close(g, e, 1e-9, &format!("{}: invert", c.label));
                    assert_rel_close(
                        &compose(&h, g),
                        c.h_inv_h.as_ref().unwrap(),
                        1e-9,
                        &format!("{}: h·inv", c.label),
                    );
                    assert_rel_close(
                        &compose(g, &h),
                        c.inv_h_h.as_ref().unwrap(),
                        1e-9,
                        &format!("{}: inv·h", c.label),
                    );
                    // Round trip through the inverse returns to the source grid.
                    for s in c.src.iter().filter(|_| proper) {
                        let d = project(&h, s[0], s[1]);
                        let back = project(g, d[0], d[1]);
                        assert_rel_close(&back, s, 1e-7, &format!("{}: round trip", c.label));
                    }
                }
                _ => panic!("{}: invert {inv:?} vs {:?}", c.label, c.inv),
            }
        }
    }

    #[test]
    fn compose_and_invert_random() {
        let v: Vectors = load("geometry");
        for (i, c) in v.compose.iter().enumerate() {
            let (a, b) = (h9(&c.a), h9(&c.b));
            let ab = compose(&a, &b);
            assert_rel_close(&ab, &c.ab, 1e-9, &format!("compose[{i}] ab"));
            assert_rel_close(&compose(&b, &a), &c.ba, 1e-9, &format!("compose[{i}] ba"));
            let inv_a = invert(&a);
            assert_eq!(inv_a.is_some(), c.inv_a.is_some(), "compose[{i}] inv a");
            if let (Some(g), Some(e)) = (&inv_a, &c.inv_a) {
                assert_rel_close(g, e, 1e-9, &format!("compose[{i}] inv a"));
            }
            let inv_ab = invert(&ab);
            assert_eq!(inv_ab.is_some(), c.inv_ab.is_some(), "compose[{i}] inv ab");
            if let (Some(g), Some(e)) = (&inv_ab, &c.inv_ab) {
                assert_rel_close(g, e, 1e-9, &format!("compose[{i}] inv ab"));
            }
        }
        for c in &v.invert_special {
            let got = invert(&h9(&c.h));
            match (&got, &c.inv) {
                (None, None) => {}
                (Some(g), Some(e)) => assert_rel_close(g, e, 1e-9, &c.label),
                _ => panic!("{}: {got:?} vs {:?}", c.label, c.inv),
            }
        }
        let pb = &v.project_behind;
        let h = h9(&pb.h);
        for p in &pb.points {
            let got = project(&h, p[0].unwrap(), p[1].unwrap());
            assert_rel_close(&got, &[opt_nan(p[2]), opt_nan(p[3])], 1e-9, "projectBehind");
        }
    }
}

mod model {
    use super::*;
    use sealed_facet::model::{
        EDGE_CLASSES, ISI_RADIUS, LengthMismatch, NormalOperator, SAMPLE_OFFSETS, SPAN, SourceGrid,
        adjoint_features, box_response, edge_class, erf, new_source_grid, norm_cdf,
        predict_features, response_model, self_features, spread_grams,
    };

    #[derive(Deserialize)]
    #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
    struct Constants {
        isi_radius: usize,
        span: usize,
        sample_offsets: [[f64; 3]; 2],
        edge_classes: usize,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Model {
        sigma_in: f64,
        sigma: f64,
        gq: Vec<f64>,
        gf: Vec<f64>,
        w0: Vec<f64>,
        wf0: Vec<f64>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Run {
        sigma: f64,
        predict: String,
        #[serde(rename = "self")]
        self_: String,
        adjoint: String,
        normal_x: String,
        normal: String,
        spread_grams: Vec<f64>,
        spread_grams7: Vec<f64>,
    }
    #[derive(Deserialize)]
    struct Grid {
        n: usize,
        q: String,
        f: String,
        feat: String,
        runs: Vec<Run>,
    }
    #[derive(Deserialize)]
    struct Edge {
        n: usize,
        cls: Vec<usize>,
    }
    #[derive(Deserialize)]
    struct SmallOp {
        n: usize,
        x: String,
        out: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        constants: Constants,
        erf: Vec<[f64; 2]>,
        norm_cdf: Vec<[f64; 2]>,
        box_response: Vec<[f64; 5]>,
        models: Vec<Model>,
        grid: Grid,
        edge_class: Vec<Edge>,
        small_op: SmallOp,
    }

    #[test]
    fn constants_and_scalars() {
        let v: Vectors = load("geometry");
        assert_eq!(v.constants.isi_radius, ISI_RADIUS);
        assert_eq!(v.constants.span, SPAN);
        assert_eq!(v.constants.sample_offsets, SAMPLE_OFFSETS);
        assert_eq!(v.constants.edge_classes, EDGE_CLASSES);
        for [x, e] in &v.erf {
            assert!((erf(*x) - e).abs() <= 1e-15, "erf({x}): {} vs {e}", erf(*x));
        }
        for [x, e] in &v.norm_cdf {
            assert!((norm_cdf(*x) - e).abs() <= 1e-15, "normCdf({x})");
        }
        for [x, lo, hi, s, e] in &v.box_response {
            let got = box_response(*x, *lo, *hi, *s);
            assert!(
                (got - e).abs() <= 1e-15,
                "boxResponse({x},{lo},{hi},{s}): {got} vs {e}"
            );
        }
    }

    #[test]
    fn response_models() {
        let v: Vectors = load("geometry");
        for m in &v.models {
            let got = response_model(m.sigma_in);
            let what = format!("sigma {}", m.sigma_in);
            assert_eq!(got.sigma, m.sigma, "{what}: sigma");
            assert_rel_close(&got.gq, &m.gq, 1e-12, &format!("{what}: gq"));
            assert_rel_close(&got.gf, &m.gf, 1e-12, &format!("{what}: gf"));
            assert_rel_close(&got.w0, &m.w0, 1e-12, &format!("{what}: w0"));
            assert_rel_close(&got.wf0, &m.wf0, 1e-12, &format!("{what}: wf0"));
        }
        assert_eq!(response_model(f64::NAN).sigma, 0.0);
        assert_eq!(response_model(-1.0).sigma, 0.0);
    }

    fn grid(v: &Grid) -> SourceGrid {
        let mut g = new_source_grid(v.n);
        g.q = b64_f32(&v.q);
        g.f = b64_f32(&v.f);
        assert_eq!(g.q.len(), v.n * v.n * 12);
        assert_eq!(g.f.len(), v.n * v.n * 3);
        g
    }

    #[test]
    fn predict_self_adjoint_normal() {
        let v: Vectors = load("geometry");
        let src = grid(&v.grid);
        let n = v.grid.n;
        let feat = b64_f32(&v.grid.feat);
        assert_eq!(feat.len(), n * n * 12);
        assert!(feat.iter().any(|f| f.is_nan()), "fixture has NaN holes");
        for r in &v.grid.runs {
            let m = response_model(r.sigma);
            let what = format!("sigma {}", r.sigma);
            let pred = predict_features(&m, &src).unwrap();
            assert_f32_rel(
                &pred,
                &b64_f32(&r.predict),
                1e-5,
                &format!("{what}: predict"),
            );
            let mut self_all = vec![0f32; n * n * 12];
            for c in 0..n * n {
                let s = self_features(&m, &src, c).unwrap();
                self_all[c * 12..c * 12 + 12].copy_from_slice(&s);
            }
            assert_f32_rel(
                &self_all,
                &b64_f32(&r.self_),
                1e-5,
                &format!("{what}: self"),
            );
            assert!(self_features(&m, &src, n * n).is_none());
            let adj = adjoint_features(&m, &feat, n).unwrap();
            assert_f32_rel(
                &adj,
                &b64_f32(&r.adjoint),
                1e-5,
                &format!("{what}: adjoint"),
            );
            assert!(
                adj.iter().all(|f| f.is_finite()),
                "{what}: NaN features count as zero"
            );
            let x = b64_f32(&r.normal_x);
            let mut op = NormalOperator::new(&m, n);
            assert_eq!(op.n(), n);
            let mut out = vec![0f32; n * n * 12];
            op.apply(&x, &mut out).unwrap();
            assert_f32_rel(&out, &b64_f32(&r.normal), 1e-5, &format!("{what}: normal"));
            assert_rel_close(
                &spread_grams(&m, n),
                &r.spread_grams,
                1e-12,
                &format!("{what}: spreadGrams"),
            );
            assert_rel_close(
                &spread_grams(&m, 7),
                &r.spread_grams7,
                1e-12,
                &format!("{what}: spreadGrams(7)"),
            );
            // Mis-sized buffers are refused, never panics.
            assert_eq!(op.apply(&x[..12], &mut out), Err(LengthMismatch));
            assert_eq!(adjoint_features(&m, &feat[..12], n), Err(LengthMismatch));
            let bad = SourceGrid {
                n,
                q: vec![0.0; 3],
                f: vec![0.0; 3],
            };
            assert_eq!(predict_features(&m, &bad), Err(LengthMismatch));
        }
    }

    #[test]
    fn edge_classes_and_small_grid_operator() {
        let v: Vectors = load("geometry");
        for e in &v.edge_class {
            let got: Vec<usize> = (0..e.n).map(|p| edge_class(p, e.n)).collect();
            assert_eq!(got, e.cls, "edgeClass n={}", e.n);
        }
        let s = &v.small_op;
        let m = response_model(0.35);
        let x = b64_f32(&s.x);
        let mut out = vec![0f32; s.n * s.n * 12];
        NormalOperator::new(&m, s.n).apply(&x, &mut out).unwrap();
        assert_f32_rel(&out, &b64_f32(&s.out), 1e-5, "small NormalOperator");
        // Degenerate grid sizes build and apply without panicking.
        for n in 0..4 {
            let mut op = NormalOperator::new(&m, n);
            let x = vec![0.5f32; n * n * 12];
            let mut out = vec![0f32; n * n * 12];
            op.apply(&x, &mut out).unwrap();
            let g = new_source_grid(n);
            let p = predict_features(&m, &g).unwrap();
            adjoint_features(&m, &p, n).unwrap();
            spread_grams(&m, n);
        }
    }
}

mod sample {
    use super::*;
    use sealed_facet::sample::{
        CellSamples, LUT_LEN, code_lut, grid_to_image, linear_lut, sample_cells,
    };

    #[derive(Deserialize)]
    struct Quad {
        label: String,
        h: Vec<f64>,
    }
    #[derive(Deserialize)]
    struct Run {
        label: String,
        lut: String,
        cells: Option<Vec<u32>>,
        feat: String,
        valid: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        width: usize,
        height: usize,
        rgba: String,
        n: usize,
        quads: Vec<Quad>,
        lut_linear: String,
        lut_code: String,
        runs: Vec<Run>,
        overlay: Vec<[Option<f64>; 2]>,
    }

    const PROBES: [[f64; 2]; 6] = [
        [0.0, 0.0],
        [6.0, 6.0],
        [12.0, 12.0],
        [-3.0, 7.5],
        [100.0, -40.0],
        [1e3, 1e3],
    ];

    #[test]
    fn luts() {
        let v: Vectors = load("sample");
        assert_eq!(linear_lut().as_slice(), b64_f32(&v.lut_linear).as_slice());
        assert_eq!(code_lut().as_slice(), b64_f32(&v.lut_code).as_slice());
        assert_eq!(LUT_LEN, 768);
    }

    #[test]
    fn cells_match() {
        let v: Vectors = load("sample");
        let data = b64(&v.rgba);
        assert_eq!(data.len(), v.width * v.height * 4);
        let img = RgbaImage::new(v.width, v.height, &data);
        let quad = |label: &str| h9(&v.quads.iter().find(|q| q.label == label).unwrap().h);
        let mut seen_invalid = false;
        let mut seen_subset = false;
        for r in &v.runs {
            let h = quad(&r.label);
            let lut = if r.lut == "linear" {
                linear_lut()
            } else {
                code_lut()
            };
            let what = format!(
                "{} / {} / {}",
                r.label,
                r.lut,
                if r.cells.is_some() { "subset" } else { "all" }
            );
            let got = sample_cells(&img, &h, v.n, lut, r.cells.as_deref()).unwrap();
            assert_eq!(got.n, v.n);
            let feat = b64_f32(&r.feat);
            let valid = b64(&r.valid);
            assert_f32_rel(&got.feat, &feat, 1e-6, &what);
            assert_eq!(got.valid, valid, "{what}: valid");
            for c in 0..v.n * v.n {
                let fin = got.feat[c * 12..c * 12 + 12].iter().all(|f| f.is_finite());
                assert_eq!(
                    fin,
                    got.valid[c] == 1,
                    "{what}: cell {c} valid/finite agree"
                );
            }
            seen_invalid |= got.valid.contains(&0);
            seen_subset |= r.cells.is_some();
        }
        assert!(seen_invalid && seen_subset);

        // Honouring `stride`: a padded buffer samples identically to the packed one.
        let h = quad("partly outside");
        let stride = v.width * 4 + 20;
        let mut padded = vec![0xabu8; stride * v.height];
        for y in 0..v.height {
            padded[y * stride..y * stride + v.width * 4]
                .copy_from_slice(&data[y * v.width * 4..(y + 1) * v.width * 4]);
        }
        let pimg = RgbaImage {
            width: v.width,
            height: v.height,
            stride,
            data: &padded,
        };
        let a: CellSamples = sample_cells(&img, &h, v.n, linear_lut(), None).unwrap();
        let b = sample_cells(&pimg, &h, v.n, linear_lut(), None).unwrap();
        assert_f32_rel(&a.feat, &b.feat, 0.0, "stride");
        assert_eq!(a.valid, b.valid);

        // Bad input is refused rather than panicking.
        let short = RgbaImage::new(v.width, v.height, &data[..data.len() - 4]);
        assert!(sample_cells(&short, &h, v.n, linear_lut(), None).is_none());
        assert!(sample_cells(&img, &h, v.n, linear_lut(), Some(&[(v.n * v.n) as u32])).is_none());
        let empty = sample_cells(&RgbaImage::new(0, 0, &[]), &h, v.n, linear_lut(), None).unwrap();
        assert!(empty.valid.iter().all(|&x| x == 0));
        let none = sample_cells(&img, &h, 0, linear_lut(), None).unwrap();
        assert!(none.feat.is_empty() && none.valid.is_empty());

        for (p, e) in PROBES.iter().zip(&v.overlay) {
            let got = grid_to_image(&h, p[0], p[1]);
            assert_rel_close(&got, &[opt_nan(e[0]), opt_nan(e[1])], 1e-9, "gridToImage");
        }
    }
}

mod fixtures {
    use super::*;
    use sealed_facet::sample::{ChannelLut, LUT_LEN, sample_cells};

    #[derive(Deserialize)]
    struct Capture {
        width: usize,
        height: usize,
        file: String,
    }
    #[derive(Deserialize)]
    struct Refine {
        h: Vec<f64>,
    }
    #[derive(Deserialize)]
    struct CalibrationIn {
        lut: String,
    }
    #[derive(Deserialize)]
    struct Observation {
        file: String,
        valid: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        name: String,
        n: usize,
        capture: Capture,
        coarse: Vec<f64>,
        refine: Option<Refine>,
        calibration_in: CalibrationIn,
        observation: Observation,
    }

    #[test]
    fn captures_sample_everywhere() {
        let dir = format!("{}/fixtures", env!("CARGO_MANIFEST_DIR"));
        let Ok(entries) = std::fs::read_dir(&dir) else {
            eprintln!("skipping: fixtures directory {dir} is missing");
            return;
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
            return;
        }
        for path in paths {
            let text = std::fs::read_to_string(&path).unwrap();
            let f: Fixture =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let data = std::fs::read(format!("{dir}/{}", f.capture.file)).unwrap();
            assert_eq!(
                data.len(),
                f.capture.width * f.capture.height * 4,
                "{}: capture size",
                f.name
            );
            let img = RgbaImage::new(f.capture.width, f.capture.height, &data);
            let h = h9(f.refine.as_ref().map_or(&f.coarse, |r| &r.h));
            let lut_v = b64_f32(&f.calibration_in.lut);
            assert_eq!(lut_v.len(), LUT_LEN, "{}: lut length", f.name);
            let lut: ChannelLut = lut_v.try_into().unwrap();
            let s = sample_cells(&img, &h, f.n, &lut, None).unwrap();
            assert_eq!(s.feat.len(), f.n * f.n * 12, "{}", f.name);
            assert_eq!(s.valid.len(), f.n * f.n, "{}", f.name);
            assert!(
                s.valid.iter().all(|&v| v == 1),
                "{}: every cell samples inside the capture",
                f.name
            );
            assert!(
                s.feat.iter().all(|v| v.is_finite()),
                "{}: finite features",
                f.name
            );
            // The JavaScript observation has the same shape (its values are colour-corrected, so not compared).
            assert_eq!(
                b64(&f.observation.valid),
                s.valid,
                "{}: observation.valid",
                f.name
            );
            let obs = std::fs::read(format!("{dir}/{}", f.observation.file)).unwrap();
            assert_eq!(
                obs.len(),
                s.feat.len() * 4,
                "{}: observation feature count",
                f.name
            );
        }
    }
}
