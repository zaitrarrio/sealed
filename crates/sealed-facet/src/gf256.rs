//! GF(2^8) arithmetic over the RFC 6330 field: reducing polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D),
//! primitive element alpha = 2. The Reed-Solomon code in `rs.rs` uses this field. Addition is XOR.
//! Port of `packages/core/src/fec/gf256.ts`; tables are built at compile time.

/// Reducing polynomial of the field.
pub const GF256_POLY: u16 = 0x11d;

struct Tables {
    exp: [u8; 512],
    log: [u8; 256],
    inv: [u8; 256],
    mul: [u8; 65536],
}

const fn build_tables() -> Tables {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut inv = [0u8; 256];
    let mut mul = [0u8; 65536];
    let mut x: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = x as u8;
        log[x as usize] = i as u8;
        x <<= 1;
        if x & 0x100 != 0 {
            x ^= GF256_POLY;
        }
        i += 1;
    }
    let mut i = 255;
    while i < 512 {
        exp[i] = exp[i - 255];
        i += 1;
    }
    let mut a = 1usize;
    while a < 256 {
        let la = log[a] as usize;
        inv[a] = exp[255 - la];
        let mut b = 1usize;
        while b < 256 {
            mul[(a << 8) | b] = exp[la + log[b] as usize];
            b += 1;
        }
        a += 1;
    }
    Tables { exp, log, inv, mul }
}

const TABLES: Tables = build_tables();

/// `GF256_EXP[i] = alpha^i`. Length 512 so that `EXP[LOG[a] + LOG[b]]` never needs a modular reduction.
pub static GF256_EXP: [u8; 512] = TABLES.exp;
/// `GF256_LOG[a] = log_alpha(a)` for a in 1..255. `LOG[0]` is 0 and must never be used.
pub static GF256_LOG: [u8; 256] = TABLES.log;
/// Full multiplication table: `GF256_MUL[(a << 8) | b] = a * b`.
pub static GF256_MUL: [u8; 65536] = TABLES.mul;
/// `GF256_INV[a] = a^-1` for a != 0. `INV[0]` is 0 and must never be used.
pub static GF256_INV: [u8; 256] = TABLES.inv;

/// alpha^i for any integer i (negative exponents allowed).
pub fn gf_pow2(i: i64) -> u8 {
    GF256_EXP[i.rem_euclid(255) as usize]
}

/// a + b (= a - b) in GF(256).
#[inline]
pub fn add(a: u8, b: u8) -> u8 {
    a ^ b
}

/// a * b in GF(256).
#[inline]
pub fn mul(a: u8, b: u8) -> u8 {
    GF256_MUL[((a as usize) << 8) | b as usize]
}

/// a / b in GF(256); `None` on division by zero.
pub fn div(a: u8, b: u8) -> Option<u8> {
    if b == 0 {
        return None;
    }
    if a == 0 {
        return Some(0);
    }
    Some(GF256_EXP[GF256_LOG[a as usize] as usize + 255 - GF256_LOG[b as usize] as usize])
}

/// a^-1 in GF(256); `None` for a = 0.
pub fn inv(a: u8) -> Option<u8> {
    if a == 0 {
        None
    } else {
        Some(GF256_INV[a as usize])
    }
}

/// a^e in GF(256) for integer e >= 0.
pub fn pow(a: u8, e: u32) -> u8 {
    if e == 0 {
        return 1;
    }
    if a == 0 {
        return 0;
    }
    GF256_EXP[((GF256_LOG[a as usize] as u64 * e as u64) % 255) as usize]
}

/// The 256-entry multiplication row for multiplier c: `mul_row(c)[x] = c * x`.
pub fn mul_row(c: u8) -> &'static [u8; 256] {
    let base = (c as usize) << 8;
    GF256_MUL[base..base + 256]
        .try_into()
        .expect("256-entry slice")
}

/// `dst[i] ^= src[i]` over `src.len()` bytes (GF(256) vector addition). `dst` must be at least as long as `src`.
pub fn add_assign(dst: &mut [u8], src: &[u8]) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d ^= *s;
    }
}

/// `dst[i] ^= c * src[i]` over `src.len()` bytes.
pub fn mul_add_assign(dst: &mut [u8], src: &[u8], c: u8) {
    if c == 0 {
        return;
    }
    if c == 1 {
        add_assign(dst, src);
        return;
    }
    let row = mul_row(c);
    for (d, s) in dst.iter_mut().zip(src) {
        *d ^= row[*s as usize];
    }
}

/// `dst[i] = c * dst[i]` for every byte.
pub fn mul_assign(dst: &mut [u8], c: u8) {
    if c == 1 {
        return;
    }
    if c == 0 {
        dst.fill(0);
        return;
    }
    let row = mul_row(c);
    for d in dst.iter_mut() {
        *d = row[*d as usize];
    }
}
