//! Stage timing of the native receive path on the fixture captures (`-- --nocapture` prints a table). Each tier's
//! fixtures are pushed in stream order; the frames must still decode so the numbers describe the real path.
use std::fs;
use std::path::PathBuf;

use sealed_facet::receiver::{GridDecoder, StageTimes};
use sealed_facet::types::RgbaImage;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

#[test]
fn stage_times() {
    let dir = fixtures_dir();
    let Ok(rd) = fs::read_dir(&dir) else {
        eprintln!("no fixtures at {}", dir.display());
        return;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    let runs: usize = std::env::var("FACET_PROFILE_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    eprintln!(
        "{:<22} {:>7} {:>7} {:>8} {:>8} {:>7} {:>9} {:>7}",
        "fixture", "detect", "refine", "observe", "headers", "data", "calibrate", "total"
    );
    for tier in [1u8, 3u8] {
        let tier_names: Vec<&String> = names
            .iter()
            .filter(|n| n.starts_with(&format!("t{tier}-")))
            .collect();
        let mut best: Vec<Option<StageTimes>> = vec![None; tier_names.len()];
        for _ in 0..runs {
            let mut dec = GridDecoder::new(1 << tier).expect("decoder");
            for (i, name) in tier_names.iter().enumerate() {
                let json: serde_json::Value =
                    serde_json::from_str(&fs::read_to_string(dir.join(name)).unwrap()).unwrap();
                let cap = &json["capture"];
                let (w, h) = (
                    cap["width"].as_u64().unwrap() as usize,
                    cap["height"].as_u64().unwrap() as usize,
                );
                let rgba = fs::read(dir.join(cap["file"].as_str().unwrap())).unwrap();
                let img = RgbaImage::new(w, h, &rgba);
                let (frames, t) = dec.push_timed(&img);
                assert_eq!(frames.len(), 1, "{name}: one frame expected");
                let total = |t: &StageTimes| {
                    t.detect + t.refine + t.observe + t.headers + t.data + t.calibrate
                };
                if best[i].is_none_or(|b| total(&t) < total(&b)) {
                    best[i] = Some(t);
                }
            }
        }
        for (name, t) in tier_names.iter().zip(&best) {
            let t = t.unwrap();
            eprintln!(
                "{:<22} {:>7.1} {:>7.1} {:>8.1} {:>8.1} {:>7.1} {:>9.1} {:>7.1}",
                name.trim_end_matches(".json"),
                t.detect,
                t.refine,
                t.observe,
                t.headers,
                t.data,
                t.calibrate,
                t.detect + t.refine + t.observe + t.headers + t.data + t.calibrate
            );
        }
    }
}
