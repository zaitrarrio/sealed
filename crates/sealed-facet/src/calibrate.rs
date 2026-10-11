//! Color calibration from palette swatches.

pub const CALIBRATE_WGSL: &str = include_str!("../shaders/calibrate.wgsl");

#[derive(Debug, Clone, Copy, Default)]
pub struct ChannelCalibration {
    pub gain: [f32; 3],
    pub offset: [f32; 3],
}

pub struct Swatch {
    pub expected: [f32; 3],
    pub sampled: [f32; 3],
}

/// Bootstrap calibration: per-channel gain = mean(expected)/mean(sampled).
pub fn fit_channels(swatches: &[Swatch]) -> ChannelCalibration {
    if swatches.is_empty() {
        return ChannelCalibration {
            gain: [1.0, 1.0, 1.0],
            offset: [0.0, 0.0, 0.0],
        };
    }
    let n = swatches.len() as f32;
    let mut sum_e = [0.0f32; 3];
    let mut sum_s = [0.0f32; 3];
    for s in swatches {
        for i in 0..3 {
            sum_e[i] += s.expected[i];
            sum_s[i] += s.sampled[i];
        }
    }
    let mut gain = [1.0f32; 3];
    for i in 0..3 {
        let me = sum_e[i] / n;
        let ms = sum_s[i] / n;
        if ms > 1e-4 {
            gain[i] = me / ms;
        }
    }
    ChannelCalibration {
        gain,
        offset: [0.0, 0.0, 0.0],
    }
}
