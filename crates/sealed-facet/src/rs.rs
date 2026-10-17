//! Systematic Reed-Solomon code RS(n, k) over GF(256) (field polynomial 0x11D, alpha = 2).
//! Port of `packages/core/src/fec/rs.ts`.
//!
//! - Generator polynomial g(x) = prod_{i=0}^{n-k-1} (x - alpha^i), i.e. first consecutive root 0.
//! - Codeword layout: k data bytes followed by n-k parity bytes. Byte j of the codeword is the coefficient of
//!   x^(n-1-j), so position j has error locator X_j = alpha^(n-1-j).
//! - Decoding handles e errors and f erasures whenever 2e + f <= n - k, using Forney syndromes
//!   (erasure-modified syndromes) + Berlekamp-Massey, Chien search and the Forney algorithm. After correcting,
//!   syndromes are recomputed; if they are not all zero the word is reported as uncorrectable (`None`) instead of
//!   being mis-corrected.

use crate::gf256::{GF256_EXP, GF256_INV, GF256_MUL};

#[inline]
fn gmul(a: u8, b: u8) -> u8 {
    GF256_MUL[((a as usize) << 8) | b as usize]
}

/// Evaluate polynomial p (ascending coefficients) at x.
fn eval_asc(p: &[u8], x: u8) -> u8 {
    let mut acc = 0u8;
    for &c in p.iter().rev() {
        acc = gmul(acc, x) ^ c;
    }
    acc
}

/// Why a `ReedSolomon` could not be constructed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RsParamError {
    /// n must be in 2..=255.
    NOutOfRange,
    /// k must be in 1..=n-1.
    KOutOfRange,
}

#[derive(Clone, Debug)]
pub struct ReedSolomon {
    pub n: usize,
    pub k: usize,
    /// Number of parity symbols n - k.
    pub parity: usize,
    /// Generator polynomial, descending coefficients, g[0] = 1, length parity + 1.
    generator: Vec<u8>,
}

impl ReedSolomon {
    pub fn new(n: usize, k: usize) -> Result<Self, RsParamError> {
        if !(2..=255).contains(&n) {
            return Err(RsParamError::NOutOfRange);
        }
        if k < 1 || k >= n {
            return Err(RsParamError::KOutOfRange);
        }
        let parity = n - k;
        // g(x) = prod (x - alpha^i), built in descending-coefficient form.
        let mut g: Vec<u8> = vec![1];
        for &root in &GF256_EXP[..parity] {
            let mut next = vec![0u8; g.len() + 1];
            for (j, &c) in g.iter().enumerate() {
                next[j] ^= c;
                next[j + 1] ^= gmul(c, root);
            }
            g = next;
        }
        Ok(Self {
            n,
            k,
            parity,
            generator: g,
        })
    }

    /// Encode k data bytes into an n-byte systematic codeword (data then parity). `None` if `data.len() != k`.
    pub fn encode(&self, data: &[u8]) -> Option<Vec<u8>> {
        let mut out = vec![0u8; self.n];
        self.encode_into(data, &mut out).then_some(out)
    }

    /// `encode` into a caller-provided n-byte buffer; false (buffer untouched) on a length mismatch.
    pub fn encode_into(&self, data: &[u8], out: &mut [u8]) -> bool {
        if data.len() != self.k || out.len() != self.n {
            return false;
        }
        let m = self.parity;
        out[..self.k].copy_from_slice(data);
        let par = &mut out[self.k..];
        par.fill(0);
        let g = &self.generator;
        for &d in data {
            let fb = d ^ par[0];
            par.copy_within(1.., 0);
            par[m - 1] = 0;
            if fb != 0 {
                let base = (fb as usize) << 8;
                for j in 0..m {
                    par[j] ^= GF256_MUL[base | g[j + 1] as usize];
                }
            }
        }
        true
    }

    /// Syndromes S_i = c(alpha^i), i = 0..parity-1. Returns true if all zero.
    fn syndromes(&self, cw: &[u8], out: &mut [u8]) -> bool {
        let mut all_zero = true;
        for i in 0..self.parity {
            let x = GF256_EXP[i];
            let mut acc = 0u8;
            if i == 0 {
                for &c in cw {
                    acc ^= c;
                }
            } else {
                for &c in cw {
                    acc = GF256_MUL[((acc as usize) << 8) | x as usize] ^ c;
                }
            }
            out[i] = acc;
            if acc != 0 {
                all_zero = false;
            }
        }
        all_zero
    }

    /// Decode an n-byte (possibly corrupted) codeword. `erasures` lists codeword positions (0..n-1) known to be
    /// unreliable (duplicates are ignored). Returns the k corrected data bytes, or `None` if the word cannot be
    /// corrected within the code's capability (2e + f <= n - k), the codeword length is wrong, or an erasure
    /// position is out of range.
    pub fn decode(&self, codeword: &[u8], erasures: &[usize]) -> Option<Vec<u8>> {
        let n = self.n;
        let m = self.parity;
        if codeword.len() != n {
            return None;
        }
        let mut erased = vec![false; n];
        let mut era_list: Vec<usize> = Vec::with_capacity(erasures.len());
        for &e in erasures {
            if e >= n {
                return None;
            }
            if !erased[e] {
                erased[e] = true;
                era_list.push(e);
            }
        }
        let f = era_list.len();
        if f > m {
            return None;
        }

        let mut cw = codeword.to_vec();
        let mut s = vec![0u8; m];
        if self.syndromes(&cw, &mut s) {
            cw.truncate(self.k);
            return Some(cw);
        }

        // Erasure locator Gamma(x) = prod (1 - X_j x), ascending coefficients.
        let mut gamma = vec![0u8; m + 1];
        gamma[0] = 1;
        let mut gamma_deg = 0usize;
        for &pos in &era_list {
            let x = GF256_EXP[n - 1 - pos];
            for i in (1..=gamma_deg + 1).rev() {
                gamma[i] ^= gmul(gamma[i - 1], x);
            }
            gamma_deg += 1;
        }

        // Forney syndromes: T(x) = Gamma(x) S(x) mod x^m; T_f..T_{m-1} is an errors-only sequence.
        let mut t = vec![0u8; m];
        for i in 0..m {
            let mut acc = 0u8;
            let lim = i.min(gamma_deg);
            for j in 0..=lim {
                acc ^= gmul(gamma[j], s[i - j]);
            }
            t[i] = acc;
        }

        // Berlekamp-Massey on s_r = T_{f + r}, r = 0..m-f-1.
        let big_n = m - f;
        let mut c = vec![0u8; m + 1];
        let mut b = vec![0u8; m + 1];
        let mut tmp = vec![0u8; m + 1];
        c[0] = 1;
        b[0] = 1;
        let mut l = 0usize;
        let mut shift = 1usize;
        let mut bb = 1u8;
        for r in 0..big_n {
            let mut d = t[f + r];
            for i in 1..=l {
                d ^= gmul(c[i], t[f + r - i]);
            }
            if d == 0 {
                shift += 1;
                continue;
            }
            let coef = gmul(d, GF256_INV[bb as usize]);
            if 2 * l <= r {
                tmp.copy_from_slice(&c);
                let mut i = 0;
                while i + shift <= m {
                    c[i + shift] ^= gmul(coef, b[i]);
                    i += 1;
                }
                l = r + 1 - l;
                b.copy_from_slice(&tmp);
                bb = d;
                shift = 1;
            } else {
                let mut i = 0;
                while i + shift <= m {
                    c[i + shift] ^= gmul(coef, b[i]);
                    i += 1;
                }
                shift += 1;
            }
        }
        if 2 * l + f > m {
            return None;
        }
        if c[l + 1..=m].iter().any(|&v| v != 0) {
            return None;
        }

        // Errata locator Lambda = C * Gamma.
        let lam_deg = l + gamma_deg;
        let mut lambda = vec![0u8; lam_deg + 1];
        for i in 0..=l {
            let ci = c[i];
            if ci == 0 {
                continue;
            }
            for j in 0..=gamma_deg {
                lambda[i + j] ^= gmul(ci, gamma[j]);
            }
        }

        // Chien search over the n valid positions.
        let mut positions: Vec<usize> = Vec::new();
        for pos in 0..n {
            let power = n - 1 - pos;
            let xinv = GF256_EXP[(255 - power) % 255];
            if eval_asc(&lambda, xinv) == 0 {
                positions.push(pos);
            }
        }
        if positions.len() != lam_deg {
            return None;
        }

        // Omega(x) = S(x) Lambda(x) mod x^m.
        let mut omega = vec![0u8; m];
        for i in 0..m {
            let mut acc = 0u8;
            let lim = i.min(lam_deg);
            for j in 0..=lim {
                acc ^= gmul(lambda[j], s[i - j]);
            }
            omega[i] = acc;
        }
        // Formal derivative Lambda'(x): in characteristic 2 only odd-degree terms survive.
        let mut dlam = vec![0u8; lam_deg.max(1)];
        let mut i = 1;
        while i <= lam_deg {
            dlam[i - 1] = lambda[i];
            i += 2;
        }

        // Forney with first consecutive root 0: e_j = X_j * Omega(X_j^-1) / Lambda'(X_j^-1).
        for &pos in &positions {
            let power = n - 1 - pos;
            let x = GF256_EXP[power];
            let xinv = GF256_EXP[(255 - power) % 255];
            let num = eval_asc(&omega, xinv);
            let den = eval_asc(&dlam, xinv);
            if den == 0 {
                return None;
            }
            let mag = gmul(gmul(x, num), GF256_INV[den as usize]);
            cw[pos] ^= mag;
        }

        if !self.syndromes(&cw, &mut s) {
            return None;
        }
        // Distance budget: the corrected word may differ from the input in at most L non-erased spots.
        let changed_outside = (0..n)
            .filter(|&j| cw[j] != codeword[j] && !erased[j])
            .count();
        if 2 * changed_outside + f > m {
            return None;
        }
        cw.truncate(self.k);
        Some(cw)
    }
}
