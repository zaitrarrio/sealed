//! Deterministic, non-cryptographic PRNG used by the Facet codec for fixed layouts (cell permutation,
//! calibration tiling), header whitening and padding bits. Both ends must produce identical sequences, so this
//! is a fixed algorithm (xorshift32 with a splitmix-style seed finalizer) and must never change within a codec
//! version. Port of `packages/core/src/facet/random.ts`.

/// Mixes a 32-bit value (murmur3 fmix32) so nearby seeds give unrelated streams.
fn fmix32(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// xorshift32 generator seeded through `fmix32` (a zero state is replaced by the golden-ratio constant).
#[derive(Clone, Debug)]
pub struct Xorshift32 {
    s: u32,
}

impl Xorshift32 {
    pub fn new(seed: u32) -> Self {
        let s = fmix32(seed);
        Self {
            s: if s == 0 { 0x9e37_79b9 } else { s },
        }
    }

    /// Next 32-bit unsigned value.
    pub fn next_u32(&mut self) -> u32 {
        let mut s = self.s;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.s = s;
        s
    }

    /// Uniform integer in `[0, n)` (multiply-shift; bias < 2^-24 for the small n used here).
    pub fn below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as f64 / 4_294_967_296.0) * n as f64).floor() as u32
    }
}

/// One part of a `seed_from` input: a byte string or a 32-bit integer (hashed big-endian).
#[derive(Clone, Copy, Debug)]
pub enum SeedPart<'a> {
    Bytes(&'a [u8]),
    U32(u32),
}

impl<'a> From<&'a [u8]> for SeedPart<'a> {
    fn from(b: &'a [u8]) -> Self {
        SeedPart::Bytes(b)
    }
}

impl<'a, const N: usize> From<&'a [u8; N]> for SeedPart<'a> {
    fn from(b: &'a [u8; N]) -> Self {
        SeedPart::Bytes(b)
    }
}

impl From<u32> for SeedPart<'_> {
    fn from(v: u32) -> Self {
        SeedPart::U32(v)
    }
}

/// FNV-1a over byte strings and 32-bit integers (big-endian), finalized with fmix32.
pub fn seed_from(parts: &[SeedPart<'_>]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    let mut byte = |b: u8| {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    };
    for p in parts {
        match *p {
            SeedPart::U32(v) => {
                for b in v.to_be_bytes() {
                    byte(b);
                }
            }
            SeedPart::Bytes(bytes) => {
                for &b in bytes {
                    byte(b);
                }
            }
        }
    }
    fmix32(h)
}

/// Fisher–Yates shuffle of `arr` in place with the given generator.
pub fn shuffle_in_place<T>(arr: &mut [T], rng: &mut Xorshift32) {
    let mut i = arr.len();
    while i > 1 {
        i -= 1;
        let j = rng.below(i as u32 + 1) as usize;
        arr.swap(i, j);
    }
}
