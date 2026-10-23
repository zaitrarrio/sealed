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
