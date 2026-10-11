//! Reed-Solomon syndrome computation (CPU + WGSL kernel source).

pub const SYNDROME_WGSL: &str = include_str!("../shaders/syndrome.wgsl");

/// GF(256) tables for RS syndromes (primitive polynomial 0x11d).
pub fn gf_tables() -> (Vec<u8>, Vec<u8>) {
    let mut exp = vec![0u8; 512];
    let mut log = vec![0u8; 256];
    let mut x = 1u16;
    for i in 0..255 {
        exp[i] = x as u8;
        log[x as usize] = i as u8;
        x <<= 1;
        if x & 0x100 != 0 {
            x ^= 0x11d;
        }
    }
    for i in 255..512 {
        exp[i] = exp[i - 255];
    }
    (exp, log)
}

fn gf_mul(exp: &[u8], log: &[u8], a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    exp[(log[a as usize] as usize + log[b as usize] as usize) % 255]
}

/// Compute `nroots` syndromes for a codeword over GF(256).
pub fn syndromes(codeword: &[u8], nroots: usize) -> Vec<u8> {
    let (exp, log) = gf_tables();
    let mut out = vec![0u8; nroots];
    for (i, s) in out.iter_mut().enumerate() {
        let mut acc = 0u8;
        let mut alpha_pow = 1u8;
        let root = exp[i + 1];
        for &c in codeword {
            acc ^= gf_mul(&exp, &log, c, alpha_pow);
            alpha_pow = gf_mul(&exp, &log, alpha_pow, root);
        }
        *s = acc;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_codeword_zero_syndromes() {
        let cw = vec![0u8; 32];
        let s = syndromes(&cw, 4);
        assert!(s.iter().all(|&x| x == 0));
    }
}
