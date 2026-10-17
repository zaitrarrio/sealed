//! Facet colors (spec §7.4). Rendering and the receiver's channel model both work in *linear light*: blur,
//! glyph coverage and color mixing are linear there, so the receiver's inter-symbol-interference model is exact.
//! Palette entries are sRGB code values; `linear()` converts with the sRGB EOTF.
//! Port of `packages/core/src/facet/palette.ts`.

use std::sync::OnceLock;

pub type Rgb = [u8; 3];

/// Background #0B0908 (warm near-black).
pub const BACKGROUND: Rgb = [0x0b, 0x09, 0x08];
/// Light elements: anchors, header "1" bits, T0 quiet zone.
pub const WHITE: Rgb = [0xf5, 0xf5, 0xf5];

/// Spec §7.4 candidates, in index order. T1 uses the first four.
pub const PALETTE_8: [Rgb; 8] = [
    [0x00, 0xe5, 0xff], // cyan
    [0xff, 0x2b, 0xd6], // magenta
    [0xff, 0xe6, 0x00], // yellow
    [0xf5, 0xf5, 0xf5], // white
    [0xff, 0x3b, 0x30], // red
    [0x34, 0xff, 0x5c], // green
    [0x2f, 0x6b, 0xff], // blue
    [0xff, 0x9f, 0x0a], // amber
];

/// Palette of a tier (0–3): empty for T0, the first four entries for T1, all eight otherwise.
pub fn palette_for(tier: u8) -> &'static [Rgb] {
    match tier {
        0 => &[],
        1 => &PALETTE_8[..4],
        _ => &PALETTE_8,
    }
}

/// sRGB EOTF: code value in [0, 1] → linear light in [0, 1].
pub fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Inverse sRGB EOTF: linear light in [0, 1] → code value in [0, 1].
pub fn linear_to_srgb(v: f64) -> f64 {
    if v <= 0.0 {
        return 0.0;
    }
    if v >= 1.0 {
        return 1.0;
    }
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// 8-bit code → linear light.
pub fn srgb_to_linear_8() -> &'static [f32; 256] {
    static T: OnceLock<[f32; 256]> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0f32; 256];
        for (i, v) in t.iter_mut().enumerate() {
            *v = srgb_to_linear(i as f64 / 255.0) as f32;
        }
        t
    })
}

const ENC_STEPS: usize = 4096;

fn linear_to_srgb_8() -> &'static [u8; ENC_STEPS + 1] {
    static T: OnceLock<[u8; ENC_STEPS + 1]> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0u8; ENC_STEPS + 1];
        for (i, v) in t.iter_mut().enumerate() {
            *v = (linear_to_srgb(i as f64 / ENC_STEPS as f64) * 255.0).round() as u8;
        }
        t
    })
}

/// Linear light in [0, 1] → nearest 8-bit sRGB code (table lookup, 1/4096 resolution).
pub fn encode_linear8(v: f64) -> u8 {
    let i = if v <= 0.0 {
        0
    } else if v >= 1.0 {
        ENC_STEPS
    } else {
        (v * ENC_STEPS as f64).round() as usize
    };
    linear_to_srgb_8()[i]
}

/// Linear light of an sRGB color (f32, via the 8-bit table).
pub fn linear(c: Rgb) -> [f32; 3] {
    let t = srgb_to_linear_8();
    [t[c[0] as usize], t[c[1] as usize], t[c[2] as usize]]
}

pub fn linear_background() -> [f32; 3] {
    linear(BACKGROUND)
}

pub fn linear_white() -> [f32; 3] {
    linear(WHITE)
}

/// Linear-light excess of a color over the background: what a fully covered glyph adds to a pixel.
pub fn excess(c: Rgb) -> [f32; 3] {
    let l = linear(c);
    let bg = linear_background();
    [l[0] - bg[0], l[1] - bg[1], l[2] - bg[2]]
}

/// Excess vectors of a tier's palette, flattened `[k*3 + ch]`.
pub fn palette_excess(tier: u8) -> Vec<f32> {
    palette_for(tier).iter().flat_map(|&c| excess(c)).collect()
}

/// Gray levels of the calibration ramp, as fractions of the white excess in linear light.
pub const GRAY_RAMP: [f64; 12] = [
    0.0, 0.02, 0.05, 0.1, 0.16, 0.24, 0.33, 0.44, 0.57, 0.72, 0.86, 1.0,
];
