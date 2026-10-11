//! Optical goodput gate (Gate M2): CPU oracle must process frames with measurable progress.
//! GPU goodput (≥ 60 KB/s T1) is measured on device corpus once wgpu dispatch is wired.

use sealed_facet::types::{Anchors, CapabilityTier, RgbaImage};
use sealed_facet::FacetDecoder;
use std::time::Instant;

#[test]
fn t1_cpu_pipeline_processes_frames() {
    let mut dec = FacetDecoder::new(CapabilityTier::T1);
    let img = RgbaImage {
        width: 128,
        height: 128,
        data: vec![90u8; 128 * 128 * 4],
    };
    let anchors = Anchors {
        points: [[8.0, 8.0], [120.0, 8.0], [120.0, 120.0], [8.0, 120.0]],
    };
    let start = Instant::now();
    let mut frames = 0u32;
    while start.elapsed().as_millis() < 500 {
        let _ = dec.push_frame(&img, &anchors).unwrap();
        frames += 1;
    }
    assert!(frames >= 1, "expected at least one frame in 500ms");
    let fps = frames as f64 / start.elapsed().as_secs_f64();
    println!("T1 CPU pipeline ≈ {fps:.1} frames/s over {frames} frames");
    assert!(fps > 0.5, "CPU oracle too slow: {fps} fps");
}
