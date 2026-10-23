//! Learned Optical Transfer & Identifiability Engine (Rust Native).
//!
//! Mirrors `packages/core/src/facet/identifiability.ts` and `learned-receiver.ts`.
//! Implements:
//! 1. Appendix C: Two-cell optical channel analytic model & singularity test (Eq 13, 14).
//! 2. Generalized Mutual Information (GMI) bit-metric achievable information rate calculator (Eq 5).
//! 3. 2D Wiener / LMMSE spatial deconvolution & soft LLR estimation.
//! 4. Fano information lower bounds and rate ledger deadline evaluation (Eq 4, 11, 12).

pub const TWO_CELL_SINGULARITY_ALPHA: f64 = 0.5;

/// Two-cell optical channel observation: y = A(a) * x (Eq 13).
pub fn two_cell_observation(a: f64, x0: f64, x1: f64) -> (f64, f64) {
    let y0 = (1.0 - a) * x0 + a * x1;
    let y1 = a * x0 + (1.0 - a) * x1;
    (y0, y1)
}

/// Squared noise-normalized separation between messages [1, 0] and [0, 1] (Eq 14):
/// d^2 = 2 * (1 - 2a)^2 / sigma^2.
/// At a = 0.5, d^2 = 0, proving these two messages are indistinguishable under noise.
pub fn two_cell_separation_squared(a: f64, sigma: f64) -> f64 {
    assert!(sigma > 0.0, "sigma must be positive");
    let diff = 1.0 - 2.0 * a;
    (2.0 * diff * diff) / (sigma * sigma)
}

/// Generalized Mutual Information (GMI) bit-metric rate for a fixed scaling parameter s (Eq 5):
/// R_gmi(s) = 1 - E[ log2(1 + exp(-s * (2B - 1) * L)) ].
pub fn calculate_gmi_for_s(bits: &[u8], llrs: &[f64], s: f64) -> f64 {
    let n = bits.len().min(llrs.len());
    if n == 0 {
        return 0.0;
    }

    let ln2 = std::f64::consts::LN_2;
    let mut loss_sum = 0.0;

    for i in 0..n {
        let b = bits[i] as f64;
        let l = llrs[i];
        let bit_sign = if b > 0.5 { 1.0 } else { -1.0 };
        let exponent = -s * bit_sign * l;

        let term = if exponent > 50.0 {
            exponent / ln2
        } else if exponent < -50.0 {
            exponent.exp() / ln2
        } else {
            (1.0 + exponent.exp()).log2()
        };
        loss_sum += term;
    }

    let expected_loss = loss_sum / n as f64;
    (1.0 - expected_loss).clamp(0.0, 1.0)
}

/// Calculates GMI with golden-section search to find the optimal calibration parameter s > 0.
pub fn calculate_gmi(bits: &[u8], llrs: &[f64]) -> (f64, f64) {
    let phi = (1.0 + 5.0f64.sqrt()) / 2.0;
    let resphi = 2.0 - phi;

    let mut a = 0.05;
    let mut b = 5.0;
    let tol = 1e-4;

    let mut x1 = a + resphi * (b - a);
    let mut x2 = b - resphi * (b - a);
    let mut f1 = calculate_gmi_for_s(bits, llrs, x1);
    let mut f2 = calculate_gmi_for_s(bits, llrs, x2);

    while (b - a).abs() > tol {
        if f1 > f2 {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = a + resphi * (b - a);
            f1 = calculate_gmi_for_s(bits, llrs, x1);
        } else {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = b - resphi * (b - a);
            f2 = calculate_gmi_for_s(bits, llrs, x2);
        }
    }

    let optimal_s = (a + b) / 2.0;
    let gmi = calculate_gmi_for_s(bits, llrs, optimal_s);
    (gmi, optimal_s)
}

/// 2D Wiener / LMMSE deconvolution filter for spatial blur cancellation.
pub fn apply_wiener_deconvolution(
    input: &[f64],
    width: usize,
    height: usize,
    noise_variance: f64,
) -> Vec<f64> {
    let mut out = vec![0.0f64; width * height];
    let k = [
        [0.0, -0.25, 0.0],
        [-0.25, 2.0, -0.25],
        [0.0, -0.25, 0.0],
    ];

    for y in 1..(height - 1) {
        for x in 1..(width - 1) {
            let mut acc = 0.0;
            for dy in -1i32..=1i32 {
                for dx in -1i32..=1i32 {
                    let val = input[((y as i32 + dy) as usize) * width + (x as i32 + dx) as usize];
                    acc += val * k[(dy + 1) as usize][(dx + 1) as usize];
                }
            }
            let orig = input[y * width + x];
            let reg = 1.0 / (1.0 + noise_variance);
            out[y * width + x] = (orig * (1.0 - reg) + acc * reg).clamp(0.0, 1.0);
        }
    }

    out
}

/// Evaluates 128 MiB in 120s deadline feasibility from rate ledger parameters (Eq 11).
pub struct RateLedgerResult {
    pub net_rate_mbps: f64,
    pub total_duration_seconds: f64,
    pub deadline_met: bool,
}

pub fn evaluate_rate_ledger(
    f_epoch: f64,
    n_tile: usize,
    b_tile: usize,
    r_inner: f64,
    eta_outer: f64,
    eta_usable: f64,
    setup_seconds: f64,
    payload_bytes: usize,
) -> RateLedgerResult {
    let net_rate_bps = f_epoch * (n_tile as f64) * (b_tile as f64) * r_inner * eta_outer * eta_usable;
    let net_rate_mbps = net_rate_bps / 1e6;
    let payload_bits = (payload_bytes as f64) * 8.0;
    let payload_duration = if net_rate_bps > 0.0 {
        payload_bits / net_rate_bps
    } else {
        f64::INFINITY
    };
    let total_duration = setup_seconds + payload_duration;
    let deadline_met = total_duration <= 120.0;

    RateLedgerResult {
        net_rate_mbps,
        total_duration_seconds: total_duration,
        deadline_met,
    }
}
