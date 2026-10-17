//! Planar homographies (grid coordinates → image pixels) and small dense linear solvers. Port of
//! `packages/core/src/facet/homography.ts`.
//!
//! A [`Homography`] is a row-major 3 × 3 matrix with `h[8] = 1`.

use crate::types::Homography;

/// Solves `A x = b` (`n × n`, row-major, copied) by Gaussian elimination with partial pivoting.
///
/// `None` if the system is singular (pivot magnitude ≤ 1e-12, or any non-finite solution component), or if `a`
/// holds fewer than `n²` values or `b` fewer than `n`.
pub fn solve_linear(a: &[f64], b: &[f64], n: usize) -> Option<Vec<f64>> {
    if a.len() < n * n || b.len() < n {
        return None;
    }
    let mut m = a[..n * n].to_vec();
    let mut x = b[..n].to_vec();
    for col in 0..n {
        let mut piv = col;
        let mut best = m[col * n + col].abs();
        for r in col + 1..n {
            let v = m[r * n + col].abs();
            if v > best {
                best = v;
                piv = r;
            }
        }
        if best.is_nan() || best <= 1e-12 {
            return None;
        }
        if piv != col {
            for c in 0..n {
                m.swap(col * n + c, piv * n + c);
            }
            x.swap(col, piv);
        }
        let d = m[col * n + col];
        for r in col + 1..n {
            let f = m[r * n + col] / d;
            if f == 0.0 {
                continue;
            }
            for c in col..n {
                m[r * n + c] -= f * m[col * n + c];
            }
            x[r] -= f * x[col];
        }
    }
    for r in (0..n).rev() {
        let mut s = x[r];
        for c in r + 1..n {
            s -= m[r * n + c] * x[c];
        }
        x[r] = s / m[r * n + r];
    }
    if x.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some(x)
}

/// Exact homography from four point correspondences (DLT with `h33 = 1`). `None` if degenerate.
pub fn homography_from_4(src: &[[f64; 2]; 4], dst: &[[f64; 2]; 4]) -> Option<Homography> {
    let mut a = [0f64; 64];
    let mut b = [0f64; 8];
    for i in 0..4 {
        let [x, y] = src[i];
        let [u, v] = dst[i];
        let r0 = i * 2;
        let r1 = r0 + 1;
        a[r0 * 8..r0 * 8 + 8].copy_from_slice(&[x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u]);
        a[r1 * 8..r1 * 8 + 8].copy_from_slice(&[0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v]);
        b[r0] = u;
        b[r1] = v;
    }
    let h = solve_linear(&a, &b, 8)?;
    let mut out = [1f64; 9];
    out[..8].copy_from_slice(&h[..8]);
    Some(out)
}

/// Maps a grid point through `h`; returns `[NaN, NaN]` behind the camera (`w ≤ 0`).
pub fn project(h: &Homography, x: f64, y: f64) -> [f64; 2] {
    let w = h[6] * x + h[7] * y + h[8];
    if w.is_nan() || w <= 1e-12 {
        return [f64::NAN, f64::NAN];
    }
    [
        (h[0] * x + h[1] * y + h[2]) / w,
        (h[3] * x + h[4] * y + h[5]) / w,
    ]
}

/// Composes `H = A · B`, normalized to `h33 = 1` when possible.
pub fn compose(a: &Homography, b: &Homography) -> Homography {
    let mut o = [0f64; 9];
    for r in 0..3 {
        for c in 0..3 {
            let mut s = 0.0;
            for k in 0..3 {
                s += a[r * 3 + k] * b[k * 3 + c];
            }
            o[r * 3 + c] = s;
        }
    }
    let n = o[8];
    if n.abs() > 1e-15 {
        for v in &mut o {
            *v /= n;
        }
    }
    o
}

/// Inverse of a homography (adjugate), normalized to `h33 = 1` when possible. `None` if singular.
pub fn invert(h: &Homography) -> Option<Homography> {
    let [a, b, c, d, e, f, g, hh, i] = *h;
    let ca = e * i - f * hh;
    let cb = -(d * i - f * g);
    let cc = d * hh - e * g;
    let det = a * ca + b * cb + c * cc;
    let det_abs = det.abs();
    if det_abs.is_nan() || det_abs <= 1e-15 {
        return None;
    }
    let mut o = [
        ca,
        -(b * i - c * hh),
        b * f - c * e,
        cb,
        a * i - c * g,
        -(a * f - c * d),
        cc,
        -(a * hh - b * g),
        a * e - b * d,
    ];
    let n = o[8];
    let s = if n.abs() > 1e-15 { n } else { det };
    for v in &mut o {
        *v /= s;
    }
    Some(o)
}
