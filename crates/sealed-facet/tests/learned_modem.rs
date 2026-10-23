//! Tests for native learned optical modem and identifiability algorithms.

use sealed_facet::learned_modem::{
    calculate_gmi, evaluate_rate_ledger, two_cell_observation,
    two_cell_separation_squared, TWO_CELL_SINGULARITY_ALPHA,
};

#[test]
fn test_two_cell_singularity_at_half() {
    let sigma = 0.1;
    // At a = 0.5, separation d^2 strictly drops to 0 (Appendix C, Eq 14)
    let d2 = two_cell_separation_squared(TWO_CELL_SINGULARITY_ALPHA, sigma);
    assert_eq!(d2, 0.0);

    // Observations of [1, 0] and [0, 1] become identical
    let obs10 = two_cell_observation(TWO_CELL_SINGULARITY_ALPHA, 1.0, 0.0);
    let obs01 = two_cell_observation(TWO_CELL_SINGULARITY_ALPHA, 0.0, 1.0);
    assert!((obs10.0 - obs01.0).abs() < 1e-12);
    assert!((obs10.1 - obs01.1).abs() < 1e-12);
}

#[test]
fn test_gmi_calculation() {
    let bits = vec![1u8, 0, 1, 1, 0, 0, 1, 0];
    let llrs = vec![8.0f64, -8.0, 7.5, 9.0, -8.5, -7.0, 8.2, -9.1];

    let (gmi, optimal_s) = calculate_gmi(&bits, &llrs);
    assert!(gmi > 0.98);
    assert!(optimal_s > 0.0);
}

#[test]
fn test_deadline_rate_ledger() {
    // Proposal §11 reference hypothesis: 128 MiB in 120s
    let res = evaluate_rate_ledger(
        60.0,
        448,
        800,
        0.80,
        0.95,
        0.80 * 0.88,
        10.0,
        134_217_728,
    );

    assert!(res.net_rate_mbps > 11.0);
    assert!(res.total_duration_seconds < 120.0);
    assert!(res.deadline_met);
}

#[test]
fn benchmark_learned_modem_native() {
    use std::time::Instant;
    use sealed_facet::learned_modem::apply_wiener_deconvolution;

    println!("\n=== Rust Native Learned Optical Modem Micro-Benchmarks ===");

    // 1. GMI Golden-Section Search Bench
    let mut bits = Vec::with_capacity(10_000);
    let mut llrs = Vec::with_capacity(10_000);
    for i in 0..10_000 {
        let b = (i % 2) as u8;
        bits.push(b);
        let sign = if b == 1 { 1.0 } else { -1.0 };
        llrs.push(sign * (7.0 + ((i % 17) as f64) * 0.1));
    }

    let start_gmi = Instant::now();
    let (gmi, optimal_s) = calculate_gmi(&bits, &llrs);
    let duration_gmi = start_gmi.elapsed();
    println!(
        "GMI Calculation (10,000 bits): {:.3} ms (GMI: {:.4}, s*: {:.4})",
        duration_gmi.as_secs_f64() * 1000.0,
        gmi,
        optimal_s
    );
    assert!(gmi > 0.99);

    // 2. 2D Wiener Deconvolution Filter Bench (112x112 tile field)
    let w = 112;
    let h = 112;
    let mut luma = vec![0.5f64; w * h];
    for y in 0..h {
        for x in 0..w {
            luma[y * w + x] = ((x + y) % 2) as f64;
        }
    }

    let start_wiener = Instant::now();
    let iters = 50;
    for _ in 0..iters {
        let _ = apply_wiener_deconvolution(&luma, w, h, 0.04);
    }
    let duration_wiener = start_wiener.elapsed() / iters;
    println!(
        "Wiener 2D Deconvolution (112x112): {:.3} ms / frame ({:.1} fps)",
        duration_wiener.as_secs_f64() * 1000.0,
        1.0 / duration_wiener.as_secs_f64()
    );

    // 3. Two-cell Singularity & Separation Sweep
    let start_singularity = Instant::now();
    for i in 0..1000 {
        let a = (i as f64) / 1000.0;
        let _ = two_cell_separation_squared(a, 0.1);
    }
    let duration_singularity = start_singularity.elapsed();
    println!(
        "Singularity Evaluation (1,000 sweeps): {:.3} µs total",
        duration_singularity.as_secs_f64() * 1_000_000.0
    );
    println!("==========================================================\n");
}
