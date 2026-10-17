//! Parity tests against reference vectors produced by the TypeScript codec (`packages/core/bench/vectors/*.ts`,
//! written to `tests/vectors/*.json`), plus the end-to-end fixtures under `fixtures/`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sealed_facet::types::{FrameType, GridTier};
use serde::Deserialize;
use serde_json::Value;

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

fn b64_u16(s: &str) -> Vec<u16> {
    b64(s)
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect()
}

fn b64_i16(s: &str) -> Vec<i16> {
    b64(s)
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

fn b64_f32(s: &str) -> Vec<f32> {
    b64(s)
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn digits(s: &str) -> Vec<u8> {
    s.bytes().map(|b| b - b'0').collect()
}

/// FNV-1a (32-bit) over raw bytes, matching `bench/vectors/util.ts`.
fn fnv(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn fnv_i16(v: &[i16]) -> u32 {
    let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    fnv(&bytes)
}

fn frame_type(s: &str) -> FrameType {
    match s {
        "calibration" => FrameType::Calibration,
        "descriptor" => FrameType::Descriptor,
        "data" => FrameType::Data,
        "end" => FrameType::End,
        _ => panic!("unknown frame type {s}"),
    }
}

fn tier(t: u8) -> GridTier {
    GridTier::from_u8(t).expect("grid tier")
}

fn assert_f32_close(a: &[f32], b: &[f32], tol: f32, what: &str) {
    assert_eq!(a.len(), b.len(), "{what}: length");
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        assert!((x - y).abs() <= tol, "{what}[{i}]: {x} vs {y}");
    }
}

mod random {
    use super::*;
    use sealed_facet::random::{SeedPart, Xorshift32, seed_from, shuffle_in_place};

    #[derive(Deserialize)]
    struct Seq {
        seed: u32,
        next: Vec<u32>,
        below: Vec<u32>,
    }
    #[derive(Deserialize)]
    struct SeedCase {
        label: String,
        parts: Vec<Value>,
        seed: u32,
    }
    #[derive(Deserialize)]
    struct Shuffle {
        seed: u32,
        out: Vec<i32>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        sequences: Vec<Seq>,
        seed_cases: Vec<SeedCase>,
        shuffles: Vec<Shuffle>,
    }

    #[test]
    fn sequences_and_below() {
        let v: Vectors = load("random");
        for s in &v.sequences {
            let mut r = Xorshift32::new(s.seed);
            let next: Vec<u32> = (0..s.next.len()).map(|_| r.next_u32()).collect();
            assert_eq!(next, s.next, "seed {}", s.seed);
            let below: Vec<u32> = [1, 2, 3, 7, 16, 100, 4096, 65537]
                .iter()
                .map(|&n| r.below(n))
                .collect();
            assert_eq!(below, s.below, "seed {} below", s.seed);
        }
    }

    #[test]
    fn seed_from_parts() {
        let v: Vectors = load("random");
        for c in &v.seed_cases {
            let owned: Vec<Vec<u8>> = c
                .parts
                .iter()
                .filter_map(|p| p.as_array())
                .map(|a| a.iter().map(|x| x.as_u64().unwrap() as u8).collect())
                .collect();
            let mut bytes_iter = owned.iter();
            let parts: Vec<SeedPart<'_>> = c
                .parts
                .iter()
                .map(|p| {
                    if p.is_array() {
                        SeedPart::Bytes(bytes_iter.next().unwrap())
                    } else {
                        SeedPart::U32(p.as_u64().unwrap() as u32)
                    }
                })
                .collect();
            assert_eq!(seed_from(&parts), c.seed, "{}", c.label);
        }
    }

    #[test]
    fn shuffle() {
        let v: Vectors = load("random");
        for s in &v.shuffles {
            let mut arr: Vec<i32> = (0..s.out.len() as i32).collect();
            shuffle_in_place(&mut arr, &mut Xorshift32::new(s.seed));
            assert_eq!(arr, s.out, "seed {}", s.seed);
        }
    }
}

mod rs {
    use super::*;
    use sealed_facet::gf256;
    use sealed_facet::rs::ReedSolomon;

    #[derive(Deserialize)]
    struct Case {
        n: usize,
        k: usize,
        data: String,
        codeword: String,
        received: String,
        erasures: Vec<usize>,
        decoded: Option<String>,
        note: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        cases: Vec<Case>,
        unit_cw: String,
    }

    #[test]
    fn gf256_identities() {
        for a in 1..=255u8 {
            assert_eq!(gf256::mul(a, gf256::inv(a).unwrap()), 1);
            assert_eq!(gf256::div(a, a), Some(1));
            assert_eq!(gf256::pow(a, 255), 1);
        }
        assert_eq!(gf256::div(1, 0), None);
        assert_eq!(gf256::inv(0), None);
        assert_eq!(gf256::gf_pow2(-1), gf256::GF256_EXP[254]);
        assert_eq!(gf256::GF256_EXP[1], 2);
        assert_eq!(gf256::GF256_EXP[8], 0x1d);
        let mut d = [1u8, 2, 3];
        gf256::mul_add_assign(&mut d, &[4, 5, 6], 7);
        assert_eq!(
            d,
            [
                1 ^ gf256::mul(7, 4),
                2 ^ gf256::mul(7, 5),
                3 ^ gf256::mul(7, 6)
            ]
        );
        gf256::mul_assign(&mut d, 3);
        gf256::add_assign(&mut d, &[1, 1, 1]);
        assert_eq!(gf256::mul_row(3)[5], gf256::mul(3, 5));
    }

    #[test]
    fn encode_and_decode() {
        let v: Vectors = load("rs");
        assert!(!v.cases.is_empty());
        let rs255 = ReedSolomon::new(255, 207).unwrap();
        let mut unit = vec![0u8; 207];
        unit[0] = 1;
        assert_eq!(rs255.encode(&unit).unwrap(), b64(&v.unit_cw));
        for c in &v.cases {
            let rs = ReedSolomon::new(c.n, c.k).unwrap();
            let data = b64(&c.data);
            let cw = rs.encode(&data).unwrap();
            assert_eq!(
                cw,
                b64(&c.codeword),
                "encode RS({},{}) {}",
                c.n,
                c.k,
                c.note
            );
            let decoded = rs.decode(&b64(&c.received), &c.erasures);
            assert_eq!(
                decoded,
                c.decoded.as_deref().map(b64),
                "decode RS({},{}) {} erasures={:?}",
                c.n,
                c.k,
                c.note,
                c.erasures
            );
        }
        assert!(ReedSolomon::new(1, 0).is_err());
        assert!(ReedSolomon::new(256, 1).is_err());
        assert!(ReedSolomon::new(10, 10).is_err());
        assert_eq!(rs255.encode(&[0; 10]), None);
        assert_eq!(rs255.decode(&[0; 10], &[]), None);
        assert_eq!(rs255.decode(&[0; 255], &[300]), None);
    }
}

mod header {
    use super::*;
    use sealed_facet::header::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Hdr {
        tier: u8,
        r#type: String,
        r#loop: bool,
        signed: bool,
        stream_id: String,
        sbn: u8,
        esi: u32,
    }
    #[derive(Deserialize)]
    struct Flip {
        positions: Vec<usize>,
        conf: Option<Vec<f32>>,
        decoded: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        header: Hdr,
        payload: String,
        encoded: String,
        parsed: Hdr,
        crc_matches: bool,
        crc_mismatch: bool,
        strip: String,
        flips: Vec<Flip>,
    }
    #[derive(Deserialize)]
    struct Bad {
        bytes: String,
        parsed: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        crc_check: u16,
        crc_parts: u16,
        crc_empty: u16,
        headers: Vec<Case>,
        bad_headers: Vec<Bad>,
    }

    fn to_header(h: &Hdr) -> FrameHeader {
        let sid = b64(&h.stream_id);
        FrameHeader {
            tier: h.tier,
            r#type: frame_type(&h.r#type),
            r#loop: h.r#loop,
            signed: h.signed,
            stream_id: [sid[0], sid[1], sid[2], sid[3]],
            sbn: h.sbn,
            esi: h.esi,
        }
    }

    #[test]
    fn crc() {
        let v: Vectors = load("header");
        assert_eq!(crc16_ccitt_false(&[b"123456789"]), 0x29b1);
        assert_eq!(crc16_ccitt_false(&[b"123456789"]), v.crc_check);
        assert_eq!(crc16_ccitt_false(&[b"1234", b"56789"]), v.crc_parts);
        assert_eq!(crc16_ccitt_false(&[]), v.crc_empty);
    }

    #[test]
    fn encode_parse_strip_decode() {
        let v: Vectors = load("header");
        for c in &v.headers {
            let h = to_header(&c.header);
            let payload = b64(&c.payload);
            let enc = encode_frame_header(&h, &payload).unwrap();
            assert_eq!(enc.to_vec(), b64(&c.encoded));
            assert_eq!(parse_frame_header(&enc).unwrap(), to_header(&c.parsed));
            assert_eq!(header_crc_matches(&enc, &payload), c.crc_matches);
            let mut other = if payload.is_empty() {
                vec![1]
            } else {
                payload.clone()
            };
            if !payload.is_empty() {
                other[0] ^= 1;
            }
            assert_eq!(header_crc_matches(&enc, &other), c.crc_mismatch);
            let strip = header_strip_bits(&enc).unwrap();
            assert_eq!(strip.to_vec(), digits(&c.strip));
            for f in &c.flips {
                let mut bits = strip;
                for &p in &f.positions {
                    bits[p] ^= 1;
                }
                let got = decode_header_strip(&bits, f.conf.as_deref());
                assert_eq!(
                    got.map(|b| b.to_vec()),
                    f.decoded.as_deref().map(b64),
                    "flips {:?} conf={}",
                    f.positions,
                    f.conf.is_some()
                );
                if let Some(d) = &got {
                    assert_eq!(d, &enc);
                }
            }
        }
        for b in &v.bad_headers {
            assert_eq!(parse_frame_header(&b64(&b.bytes)).is_some(), b.parsed);
        }
        assert!(
            encode_frame_header(
                &FrameHeader {
                    tier: 4,
                    ..to_header(&v.headers[0].header)
                },
                &[]
            )
            .is_err()
        );
        assert!(
            encode_frame_header(
                &FrameHeader {
                    esi: 1 << 24,
                    ..to_header(&v.headers[0].header)
                },
                &[]
            )
            .is_err()
        );
        assert_eq!(decode_header_strip(&[0; 100], None), None);
        assert_eq!(header_strip_bits(&[0; 5]), None);
    }
}

mod palette {
    use super::*;
    use sealed_facet::palette::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        #[serde(rename = "BACKGROUND")]
        background: [u8; 3],
        #[serde(rename = "WHITE")]
        white: [u8; 3],
        #[serde(rename = "PALETTE_8")]
        palette_8: Vec<[u8; 3]>,
        palette_for: Vec<Vec<[u8; 3]>>,
        srgb_to_linear: Vec<f64>,
        linear_to_srgb: Vec<f64>,
        #[serde(rename = "SRGB_TO_LINEAR_8")]
        srgb_to_linear_8: Vec<f32>,
        encode_linear8: Vec<u8>,
        encode_linear8_fine: String,
        linear: Vec<[f32; 3]>,
        #[serde(rename = "LINEAR_BACKGROUND")]
        linear_background: [f32; 3],
        #[serde(rename = "LINEAR_WHITE")]
        linear_white: [f32; 3],
        excess: Vec<[f32; 3]>,
        palette_excess: Vec<Vec<f32>>,
        #[serde(rename = "GRAY_RAMP")]
        gray_ramp: Vec<f64>,
    }

    fn samples() -> Vec<f64> {
        let mut s: Vec<f64> = (0..=200).map(|i| i as f64 / 200.0).collect();
        s.extend([-0.5, 1.5, 0.04045, 0.0031308, 1e-9]);
        s
    }

    #[test]
    fn tables_and_curves() {
        let v: Vectors = load("palette");
        assert_eq!(BACKGROUND, v.background);
        assert_eq!(WHITE, v.white);
        assert_eq!(PALETTE_8.to_vec(), v.palette_8);
        for t in 0..4u8 {
            assert_eq!(palette_for(t), v.palette_for[t as usize].as_slice());
        }
        let s = samples();
        for (i, &x) in s.iter().enumerate() {
            assert!(
                (srgb_to_linear(x) - v.srgb_to_linear[i]).abs() <= 1e-15,
                "srgb_to_linear({x})"
            );
            assert!(
                (linear_to_srgb(x) - v.linear_to_srgb[i]).abs() <= 1e-15,
                "linear_to_srgb({x})"
            );
            assert_eq!(
                encode_linear8(x),
                v.encode_linear8[i],
                "encode_linear8({x})"
            );
        }
        let fine: Vec<u8> = v
            .encode_linear8_fine
            .split(',')
            .map(|t| t.parse().unwrap())
            .collect();
        for (i, &e) in fine.iter().enumerate() {
            assert_eq!(
                encode_linear8(i as f64 / 4096.0),
                e,
                "encode_linear8({i}/4096)"
            );
        }
        assert_eq!(
            srgb_to_linear_8().to_vec(),
            v.srgb_to_linear_8,
            "SRGB_TO_LINEAR_8 exact"
        );
        for (k, c) in PALETTE_8.iter().enumerate() {
            assert_eq!(linear(*c), v.linear[k]);
            assert_eq!(excess(*c), v.excess[k]);
        }
        assert_eq!(linear_background(), v.linear_background);
        assert_eq!(linear_white(), v.linear_white);
        for t in 0..4u8 {
            assert_eq!(palette_excess(t), v.palette_excess[t as usize]);
        }
        assert_eq!(GRAY_RAMP.to_vec(), v.gray_ramp);
    }
}

mod glyphs {
    use super::*;
    use sealed_facet::glyphs::*;

    #[derive(Deserialize)]
    struct Tiles {
        px: usize,
        colors: usize,
        tiles: Vec<Vec<f32>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Templates {
        colors: usize,
        res: usize,
        sigma: f64,
        oversample: usize,
        templates: Vec<Vec<f32>>,
        min_pairwise: f64,
        d01: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        #[serde(rename = "GLYPH_COUNT")]
        glyph_count: usize,
        fills4: Vec<f32>,
        fills8: Vec<f32>,
        fills_tier: Vec<usize>,
        mean_fill: Vec<f64>,
        tiles: Vec<Tiles>,
        templates: Vec<Templates>,
        blur: Vec<f32>,
        blur_small: Vec<f32>,
        down: Vec<f32>,
    }

    #[test]
    fn fills_tiles_templates() {
        let v: Vectors = load("glyphs");
        assert_eq!(GLYPH_COUNT, v.glyph_count);
        assert_eq!(glyph_fills(4).to_vec(), v.fills4);
        assert_eq!(glyph_fills(8).to_vec(), v.fills8);
        for (i, t) in [1u8, 2, 3].iter().enumerate() {
            assert_eq!(glyph_fills_for_tier(*t).len(), v.fills_tier[i]);
        }
        assert!((mean_fill(4) - v.mean_fill[0]).abs() < 1e-12);
        assert!((mean_fill(8) - v.mean_fill[1]).abs() < 1e-12);
        for t in &v.tiles {
            let got = glyph_tiles(t.px, t.colors).unwrap();
            assert_eq!(got.len(), GLYPH_COUNT);
            for (s, tile) in got.iter().enumerate() {
                assert_eq!(
                    tile, &t.tiles[s],
                    "tile px={} colors={} s={s}",
                    t.px, t.colors
                );
            }
        }
        assert!(glyph_tiles(0, 4).is_none());
        for t in &v.templates {
            let got: Vec<Vec<f32>> = (0..GLYPH_COUNT)
                .map(|s| blurred_template(s, t.colors, t.res, t.sigma, t.oversample))
                .collect();
            for (s, g) in got.iter().enumerate() {
                assert_f32_close(
                    g,
                    &t.templates[s],
                    1e-6,
                    &format!("template colors={} res={} s={s}", t.colors, t.res),
                );
            }
            assert!((min_pairwise_distance(&got) - t.min_pairwise).abs() < 1e-6);
            assert!((template_distance(&got[0], &got[1]) - t.d01).abs() < 1e-6);
        }
        let img: Vec<f32> = (0..30).map(|i| ((i * 37) % 11) as f32 / 10.0).collect();
        assert_f32_close(&gaussian_blur(&img, 6, 5, 1.2), &v.blur, 1e-6, "blur");
        assert_f32_close(
            &gaussian_blur(&img, 6, 5, 0.2),
            &v.blur_small,
            1e-6,
            "blur small",
        );
        let ds: Vec<f32> = (0..64).map(|i| ((i * 13) % 7) as f32 / 6.0).collect();
        assert_f32_close(
            &downsample_blurred(&ds, 8, 4, 0.3),
            &v.down,
            1e-6,
            "downsample",
        );
        assert!(min_pairwise_distance(&[]).is_infinite());
    }
}

mod layout {
    use super::*;
    use sealed_facet::layout::*;
    use sealed_facet::random::Xorshift32;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Layout {
        tier: u8,
        n: usize,
        kind: String,
        anchor_light: String,
        header_top: Vec<u32>,
        header_bottom: Vec<u32>,
        data_order: String,
        anchor_centers: Vec<[f64; 2]>,
        bits_per_cell: u8,
        codewords: usize,
        cells_used: usize,
        stream_bytes: usize,
        systematic_bytes: usize,
        symbol_size: usize,
    }
    #[derive(Deserialize)]
    struct Pos {
        codeword: usize,
        position: usize,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        #[serde(rename = "QUIET_CELLS")]
        quiet_cells: usize,
        #[serde(rename = "ANCHOR_CELLS")]
        anchor_cells: usize,
        #[serde(rename = "ANCHOR_BANDS")]
        anchor_bands: [[u8; 4]; 4],
        interior_runs: Vec<Vec<u32>>,
        #[serde(rename = "ANCHOR_INTERIOR_RUNS")]
        anchor_interior_runs: Vec<Vec<u32>>,
        #[serde(rename = "ANCHOR_QUIET_SIDES")]
        anchor_quiet_sides: [[i8; 2]; 4],
        grid_tier_for_size: Vec<Vec<u8>>,
        stream_position: Vec<Pos>,
        cells_of_byte: Vec<[usize; 2]>,
        layout: Layout,
        stream: String,
        cells: String,
        back_equals_stream: bool,
        noisy_back_hash: u32,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RampC {
        cell: usize,
        level: usize,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cal {
        #[serde(rename = "RAMP_PATCH")]
        ramp_patch: usize,
        symbols: String,
        ramp: String,
        ramp_centers: Vec<RampC>,
    }

    fn check_tier(t: u8) {
        let v: Vectors = load(&format!("layout-t{t}"));
        assert_eq!(QUIET_CELLS, v.quiet_cells);
        assert_eq!(ANCHOR_CELLS, v.anchor_cells);
        assert_eq!(ANCHOR_BANDS, v.anchor_bands);
        for (c, runs) in ANCHOR_INTERIOR_RUNS.iter().enumerate() {
            assert_eq!(anchor_interior_runs(c), v.interior_runs[c]);
            assert_eq!(*runs, v.anchor_interior_runs[c].as_slice());
        }
        assert_eq!(ANCHOR_QUIET_SIDES, v.anchor_quiet_sides);
        for (i, n) in [0usize, 112, 144, 100].iter().enumerate() {
            let got: Vec<u8> = grid_tier_for_size(*n).iter().map(|t| *t as u8).collect();
            assert_eq!(got, v.grid_tier_for_size[i]);
        }
        let l = grid_layout(tier(t));
        for (i, j) in [0usize, 1, 34, 35, 36, 1000, 8924].iter().enumerate() {
            let p = stream_position(*j, l.codewords);
            assert_eq!(
                (p.codeword, p.position),
                (v.stream_position[i].codeword, v.stream_position[i].position)
            );
        }
        for (i, j) in [0usize, 1, 2, 3, 100, 8924].iter().enumerate() {
            assert_eq!(
                cells_of_byte(*j, l.bits_per_cell as usize),
                v.cells_of_byte[i]
            );
        }
        let e = &v.layout;
        assert_eq!(l.tier as u8, e.tier);
        assert_eq!(l.n, e.n);
        assert_eq!(l.kind, digits(&e.kind), "kind");
        assert_eq!(l.anchor_light, digits(&e.anchor_light), "anchor_light");
        assert_eq!(l.header_top, e.header_top);
        assert_eq!(l.header_bottom, e.header_bottom);
        let order: Vec<u32> = b64_u16(&e.data_order).into_iter().map(u32::from).collect();
        assert_eq!(l.data_order, order, "data_order");
        assert_eq!(l.anchor_centers.to_vec(), e.anchor_centers);
        assert_eq!(l.bits_per_cell, e.bits_per_cell);
        assert_eq!(l.codewords, e.codewords);
        assert_eq!(l.cells_used, e.cells_used);
        assert_eq!(l.stream_bytes, e.stream_bytes);
        assert_eq!(l.systematic_bytes, e.systematic_bytes);
        assert_eq!(l.symbol_size, e.symbol_size);
        // Same instance on repeat calls (cached).
        assert!(std::ptr::eq(l, grid_layout(tier(t))));

        let stream = b64(&v.stream);
        let cells = stream_to_cells(&stream, l, &mut Xorshift32::new(77));
        assert_eq!(cells, b64(&v.cells), "stream_to_cells");
        let back = cells_to_stream(&cells, l);
        assert_eq!(back == stream, v.back_equals_stream);
        let mask = (1u8 << l.bits_per_cell) - 1;
        let noisy: Vec<u8> = cells.iter().map(|&c| c.wrapping_add(1) & mask).collect();
        assert_eq!(fnv(&cells_to_stream(&noisy, l)), v.noisy_back_hash);

        let c: Cal = load(&format!("calibration-t{t}"));
        let cal = calibration_layout(tier(t));
        assert_eq!(RAMP_PATCH, c.ramp_patch);
        assert_eq!(cal.symbols, b64_i16(&c.symbols), "symbols");
        assert_eq!(
            cal.ramp,
            b64(&c.ramp)
                .into_iter()
                .map(|b| b as i8)
                .collect::<Vec<_>>(),
            "ramp"
        );
        let centers: Vec<(usize, usize)> =
            cal.ramp_centers.iter().map(|r| (r.cell, r.level)).collect();
        let expected: Vec<(usize, usize)> =
            c.ramp_centers.iter().map(|r| (r.cell, r.level)).collect();
        assert_eq!(centers, expected);
    }

    #[test]
    fn tier1() {
        check_tier(1);
    }
    #[test]
    fn tier2() {
        check_tier(2);
    }
    #[test]
    fn tier3() {
        check_tier(3);
    }
}

mod grid {
    use super::*;
    use sealed_facet::grid::*;
    use sealed_facet::layout::grid_layout;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Id {
        stream_id: String,
        tier: u8,
        r#type: String,
        sbn: u8,
        esi: u32,
    }
    fn identity(id: &Id) -> FrameIdentity {
        let s = b64(&id.stream_id);
        FrameIdentity {
            stream_id: [s[0], s[1], s[2], s[3]],
            tier: tier(id.tier),
            r#type: frame_type(&id.r#type),
            sbn: id.sbn,
            esi: id.esi,
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        #[serde(rename = "PIC_BG")]
        pic_bg: i16,
        #[serde(rename = "PIC_WHITE")]
        pic_white: i16,
        #[serde(rename = "PIC_GRAY_BASE")]
        pic_gray_base: i16,
        id: Id,
        frame_rng: Vec<u32>,
        padding_next: Vec<u32>,
        payload: String,
        header: String,
        cal_header: String,
        mask: String,
        stream: String,
        cells: String,
        padding_cells: String,
        strip_bits: String,
        picture: Option<String>,
        picture_hash: u32,
        calibration_picture: Option<String>,
        calibration_picture_hash: u32,
        stream_cells_is_prefix_of_cells: bool,
        cells_stream_equals_stream: bool,
    }

    fn check_tier(t: u8) {
        let v: Vectors = load(&format!("grid-t{t}"));
        assert_eq!(
            (PIC_BG, PIC_WHITE, PIC_GRAY_BASE),
            (v.pic_bg, v.pic_white, v.pic_gray_base)
        );
        let l = grid_layout(tier(t));
        let id = identity(&v.id);
        let payload = b64(&v.payload);
        let header = b64(&v.header);
        let mut fr = frame_rng(&id);
        let got: Vec<u32> = (0..8).map(|_| fr.next_u32()).collect();
        assert_eq!(got, v.frame_rng);
        let FrameMask { mask, mut padding } = frame_mask(l, &id);
        assert_eq!(mask, b64(&v.mask), "mask");
        let got: Vec<u32> = (0..8).map(|_| padding.next_u32()).collect();
        assert_eq!(got, v.padding_next);
        let stream = encode_stream(l, &payload, &mask).unwrap();
        assert_eq!(stream, b64(&v.stream), "stream");
        let cells = encode_data_cells(l, &id, &payload).unwrap();
        assert_eq!(cells, b64(&v.cells), "cells");
        assert_eq!(
            padding_cells(l, &id),
            b64(&v.padding_cells),
            "padding cells"
        );
        assert_eq!(
            strip_bits(l, &header).unwrap(),
            digits(&v.strip_bits),
            "strip bits"
        );
        let pic = data_picture(l, &header, &id, &payload).unwrap();
        assert_eq!(fnv_i16(&pic), v.picture_hash, "picture hash");
        if let Some(p) = &v.picture {
            assert_eq!(pic, b64_i16(p), "picture");
        }
        let cal = calibration_picture(l, &b64(&v.cal_header)).unwrap();
        assert_eq!(
            fnv_i16(&cal),
            v.calibration_picture_hash,
            "calibration picture hash"
        );
        if let Some(p) = &v.calibration_picture {
            assert_eq!(cal, b64_i16(p), "calibration picture");
        }
        assert_eq!(
            stream_cells(l, &stream) == cells[..l.cells_used],
            v.stream_cells_is_prefix_of_cells
        );
        assert_eq!(
            cells_stream(l, &cells) == stream,
            v.cells_stream_equals_stream
        );
        assert!(encode_stream(l, &vec![0u8; l.symbol_size + 1], &mask).is_none());
        assert!(data_picture(l, &header[..5], &id, &payload).is_none());
    }

    #[test]
    fn tier1() {
        check_tier(1);
    }
    #[test]
    fn tier2() {
        check_tier(2);
    }
    #[test]
    fn tier3() {
        check_tier(3);
    }

    #[derive(Deserialize)]
    struct Diff {
        idx: String,
        val: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Known {
        ok: String,
        stream_hash: u32,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        received: Diff,
        low_conf: Diff,
        forced: Option<String>,
        known: Option<Known>,
        max_failures: Option<usize>,
        payload: Option<String>,
        ok: String,
        stream_hash: u32,
        failed: usize,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DecodeVectors {
        id: Id,
        payload: String,
        mask_hash: u32,
        stream_hash: u32,
        decode: std::collections::BTreeMap<String, Case>,
    }

    fn check_decode(t: u8) {
        let v: DecodeVectors = load(&format!("decode-t{t}"));
        let l = grid_layout(tier(t));
        let id = identity(&v.id);
        let payload = b64(&v.payload);
        let FrameMask { mask, .. } = frame_mask(l, &id);
        assert_eq!(fnv(&mask), v.mask_hash);
        let stream = encode_stream(l, &payload, &mask).unwrap();
        assert_eq!(fnv(&stream), v.stream_hash);
        assert!(!v.decode.is_empty());
        for (name, c) in &v.decode {
            let mut received = stream.clone();
            for (i, val) in b64_u16(&c.received.idx)
                .into_iter()
                .zip(b64(&c.received.val))
            {
                received[i as usize] = val;
            }
            let mut conf = vec![1f32; l.stream_bytes];
            for (i, val) in b64_u16(&c.low_conf.idx)
                .into_iter()
                .zip(b64_f32(&c.low_conf.val))
            {
                conf[i as usize] = val;
            }
            let forced: Option<Vec<u8>> = c.forced.as_ref().map(|f| {
                let mut m = vec![0u8; l.stream_bytes];
                for i in b64_u16(f) {
                    m[i as usize] = 1;
                }
                m
            });
            let known = c.known.as_ref().map(|k| {
                assert_eq!(fnv(&stream), k.stream_hash);
                DecodedCodewords {
                    ok: b64(&k.ok),
                    stream: stream.clone(),
                }
            });
            let res = decode_stream(
                l,
                &received,
                &mask,
                &conf,
                forced.as_deref(),
                known.as_ref(),
                c.max_failures,
            )
            .unwrap();
            assert_eq!(res.failed, c.failed, "{name}: failed");
            assert_eq!(res.ok, b64(&c.ok), "{name}: ok");
            assert_eq!(
                res.payload,
                c.payload.as_deref().map(b64),
                "{name}: payload"
            );
            assert_eq!(fnv(&res.stream), c.stream_hash, "{name}: stream");
            if name == "clean" {
                let mut full = payload.clone();
                full.resize(l.symbol_size, 0);
                assert_eq!(res.payload.as_deref(), Some(full.as_slice()));
            }
        }
        assert!(decode_stream(l, &stream[..10], &mask, &[1.0; 10], None, None, None).is_none());
    }

    #[test]
    fn decode_tier1() {
        check_decode(1);
    }
    #[test]
    fn decode_tier2() {
        check_decode(2);
    }
    #[test]
    fn decode_tier3() {
        check_decode(3);
    }
}

mod fixtures {
    use super::*;
    use sealed_facet::grid::{FrameIdentity, calibration_picture, data_picture};
    use sealed_facet::header::parse_frame_header;
    use sealed_facet::layout::grid_layout;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HeaderParsed {
        tier: u8,
        r#type: String,
        r#loop: bool,
        signed: bool,
        stream_id: String,
        sbn: u8,
        esi: u32,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Truth {
        header: String,
        header_parsed: HeaderParsed,
        payload: String,
        picture: String,
    }
    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        tier: u8,
        n: usize,
        r#type: String,
        truth: Truth,
    }

    #[test]
    fn pictures_and_headers_match() {
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
            let header = b64(&f.truth.header);
            let parsed = parse_frame_header(&header)
                .unwrap_or_else(|| panic!("{}: header does not parse", f.name));
            let hp = &f.truth.header_parsed;
            assert_eq!(parsed.tier, hp.tier, "{}", f.name);
            assert_eq!(parsed.r#type, frame_type(&hp.r#type), "{}", f.name);
            assert_eq!(parsed.r#loop, hp.r#loop, "{}", f.name);
            assert_eq!(parsed.signed, hp.signed, "{}", f.name);
            assert_eq!(parsed.stream_id.to_vec(), b64(&hp.stream_id), "{}", f.name);
            assert_eq!(parsed.sbn, hp.sbn, "{}", f.name);
            assert_eq!(parsed.esi, hp.esi, "{}", f.name);
            assert_eq!(parsed.tier, f.tier);
            let l = grid_layout(tier(f.tier));
            assert_eq!(l.n, f.n);
            let expected = b64_i16(&f.truth.picture);
            let payload = b64(&f.truth.payload);
            let picture = if f.r#type == "calibration" {
                calibration_picture(l, &header).unwrap()
            } else {
                let id = FrameIdentity {
                    stream_id: parsed.stream_id,
                    tier: l.tier,
                    r#type: parsed.r#type,
                    sbn: parsed.sbn,
                    esi: parsed.esi,
                };
                data_picture(l, &header, &id, &payload).unwrap()
            };
            assert_eq!(picture.len(), expected.len(), "{}: picture length", f.name);
            let mismatches = picture
                .iter()
                .zip(&expected)
                .filter(|(a, b)| a != b)
                .count();
            assert_eq!(
                mismatches, 0,
                "{}: {mismatches} picture cells differ",
                f.name
            );
        }
    }
}
