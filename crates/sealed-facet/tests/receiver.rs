//! End to end: the native receive path on the fixture captures, in stream order, must yield exactly the frames
//! the sender emitted (header ∥ payload), learning calibration from the calibration frame first.
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use base64::Engine;
use sealed_facet::receiver::GridDecoder;
use sealed_facet::types::RgbaImage;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .expect("base64")
}

#[test]
fn fixture_streams_decode_at_arbitrary_rotations() {
    let dir = fixtures_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        return;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json") && n.starts_with("t1-"))
        .collect();
    names.sort();
    if names.is_empty() {
        return;
    }

    fn rot90(w: usize, h: usize, data: &[u8]) -> (usize, usize, Vec<u8>) {
        let mut out = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let src = (y * w + x) * 4;
                let nx = h - 1 - y;
                let ny = x;
                let dst = (ny * h + nx) * 4;
                out[dst..dst + 4].copy_from_slice(&data[src..src + 4]);
            }
        }
        (h, w, out)
    }

    for rotation_steps in 1..=3 {
        let angle_deg = rotation_steps * 90;
        let mut dec = GridDecoder::new(1 << 1).expect("decoder");
        for name in &names {
            let json: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(dir.join(name)).unwrap()).unwrap();
            let cap = &json["capture"];
            let (mut w, mut h) = (
                cap["width"].as_u64().unwrap() as usize,
                cap["height"].as_u64().unwrap() as usize,
            );
            let mut rgba = fs::read(dir.join(cap["file"].as_str().unwrap())).unwrap();
            for _ in 0..rotation_steps {
                let (nw, nh, nbytes) = rot90(w, h, &rgba);
                w = nw;
                h = nh;
                rgba = nbytes;
            }
            let img = RgbaImage::new(w, h, &rgba);
            let frames = dec.push(&img).to_vec();
            let header = b64(json["truth"]["header"].as_str().unwrap());
            assert_eq!(
                frames.len(),
                1,
                "{name} at {angle_deg}°: expected 1 frame, got {}",
                frames.len()
            );
            assert_eq!(&frames[0][..12], &header[..], "{name} at {angle_deg}°: header mismatch");
        }
    }

    // Mirroring (horizontal flip)
    let mut dec_mirrored = GridDecoder::new(1 << 1).expect("decoder");
    for name in &names {
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join(name)).unwrap()).unwrap();
        let cap = &json["capture"];
        let (w, h) = (
            cap["width"].as_u64().unwrap() as usize,
            cap["height"].as_u64().unwrap() as usize,
        );
        let rgba = fs::read(dir.join(cap["file"].as_str().unwrap())).unwrap();
        let mut mirrored = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let src = (y * w + x) * 4;
                let nx = w - 1 - x;
                let dst = (y * w + nx) * 4;
                mirrored[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
            }
        }
        let img = RgbaImage::new(w, h, &mirrored);
        let frames = dec_mirrored.push(&img).to_vec();
        eprintln!("{name} mirrored: {} frames", frames.len());
    }
}

#[test]
fn fixture_streams_decode_end_to_end() {
    let dir = fixtures_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        eprintln!(
            "no fixtures at {}: run `pnpm fixtures:grid` in packages/core",
            dir.display()
        );
        return;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    for tier in [1u8, 3u8] {
        let mut dec = GridDecoder::new(1 << tier).expect("decoder");
        let mut data_frames = 0;
        for name in names.iter().filter(|n| n.starts_with(&format!("t{tier}-"))) {
            let json: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(dir.join(name)).unwrap()).unwrap();
            let cap = &json["capture"];
            let (w, h) = (
                cap["width"].as_u64().unwrap() as usize,
                cap["height"].as_u64().unwrap() as usize,
            );
            let rgba = fs::read(dir.join(cap["file"].as_str().unwrap())).unwrap();
            let img = RgbaImage::new(w, h, &rgba);
            let t0 = Instant::now();
            let frames = dec.push(&img).to_vec();
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            let header = b64(json["truth"]["header"].as_str().unwrap());
            let payload = b64(json["truth"]["payload"].as_str().unwrap());
            let kind = json["type"].as_str().unwrap();
            eprintln!(
                "{name}: {} frame(s) in {ms:.0} ms, ppc {:.1}",
                frames.len(),
                dec.pixels_per_cell()
            );
            assert_eq!(frames.len(), 1, "{name}: one frame expected");
            let f = &frames[0];
            assert_eq!(&f[..12], &header[..], "{name}: header");
            if kind == "calibration" {
                assert_eq!(f.len(), 12, "{name}: calibration frame carries no payload");
            } else {
                assert_eq!(&f[12..], &payload[..], "{name}: payload");
                data_frames += 1;
            }
        }
        assert!(data_frames >= 2, "tier {tier}: data frames decoded");
        assert!(dec.pixels_per_cell() > 2.0);
    }
}

#[test]
fn rejects_an_empty_tier_mask_and_survives_garbage() {
    assert!(GridDecoder::new(0).is_none());
    assert!(GridDecoder::new(1).is_none(), "tier 0 is not a grid tier");
    let mut dec = GridDecoder::new(0b10).unwrap();
    let noise: Vec<u8> = (0..64 * 64 * 4)
        .map(|i| ((i * 2654435761u64 as usize) >> 13) as u8)
        .collect();
    assert!(dec.push(&RgbaImage::new(64, 64, &noise)).is_empty());
    assert!(
        dec.push(&RgbaImage::new(640, 640, &noise)).is_empty(),
        "short buffer must not panic"
    );
}

#[test]
fn bgra_and_rgb_frames_decode_like_rgba() {
    use sealed_facet::types::PixelFormat;
    let dir = fixtures_dir();
    let name = "t1-02-data.json";
    let Ok(text) = fs::read_to_string(dir.join(name)) else {
        eprintln!("no fixtures: skipped");
        return;
    };
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let cap = &json["capture"];
    let (w, h) = (cap["width"].as_u64().unwrap() as usize, cap["height"].as_u64().unwrap() as usize);
    let rgba = fs::read(dir.join(cap["file"].as_str().unwrap())).unwrap();
    let want = {
        let mut d = GridDecoder::new(0b10).unwrap();
        d.push(&RgbaImage::new(w, h, &rgba)).to_vec()
    };
    assert_eq!(want.len(), 1);
    let bgra: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
    let mut d = GridDecoder::new(0b10).unwrap();
    assert_eq!(d.push_format(&bgra, w, h, w * 4, PixelFormat::Bgra8), &want[..]);
    // RGB with a padded stride.
    let stride = w * 3 + 16;
    let mut rgb = vec![0u8; stride * h];
    for y in 0..h {
        for x in 0..w {
            rgb[y * stride + x * 3..y * stride + x * 3 + 3].copy_from_slice(&rgba[(y * w + x) * 4..(y * w + x) * 4 + 3]);
        }
    }
    let mut d = GridDecoder::new(0b10).unwrap();
    assert_eq!(d.push_format(&rgb, w, h, stride, PixelFormat::Rgb8), &want[..]);
    assert!(d.push_format(&rgb[..100], w, h, stride, PixelFormat::Rgb8).is_empty());
}
