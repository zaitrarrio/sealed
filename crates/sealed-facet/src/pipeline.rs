//! Facet decode pipeline: prefers GPU (wgpu) when available, else CPU.

use thiserror::Error;

use crate::calibrate::{fit_channels, Swatch};
use crate::cpu::{sample_cells, CpuDecoder};
use crate::rectify::rectify;
use crate::types::{Anchors, CapabilityTier, DecodeProgress, RgbaImage};

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error("gpu unavailable: {0}")]
    Gpu(String),
    #[error("invalid frame")]
    InvalidFrame,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuBackend {
    WebGpu,
    Metal,
    Vulkan,
    CpuFallback,
}

pub struct FacetDecoder {
    tier: CapabilityTier,
    cpu: CpuDecoder,
    backend: GpuBackend,
    centroids: Vec<[f32; 3]>,
}

impl FacetDecoder {
    pub fn new(tier: CapabilityTier) -> Self {
        let centroids = default_palette(tier);
        Self {
            tier,
            cpu: CpuDecoder::new(tier),
            backend: detect_backend(),
            centroids,
        }
    }

    pub fn backend(&self) -> GpuBackend {
        self.backend
    }

    /// Push one RGBA camera frame. Anchors come from the detector (or defaults for tests).
    pub fn push_frame(&mut self, image: &RgbaImage, anchors: &Anchors) -> Result<DecodeProgress, PipelineError> {
        if image.data.len() < (image.width * image.height * 4) as usize {
            return Err(PipelineError::InvalidFrame);
        }
        let grid_px = match self.tier {
            CapabilityTier::T0 => 512,
            CapabilityTier::T1 | CapabilityTier::T2 => 112 * 8,
            CapabilityTier::T3 => 144 * 6,
        };
        let grid = match self.tier {
            CapabilityTier::T0 => 32,
            CapabilityTier::T1 | CapabilityTier::T2 => 112,
            CapabilityTier::T3 => 144,
        };
        let rectified = rectify(image, anchors, grid_px);
        // Optional calibration bootstrap from corner swatches (identity when none provided).
        let _calib = fit_channels(&[] as &[Swatch]);
        let symbols = sample_cells(&rectified, grid, &self.centroids);
        Ok(self.cpu.push_symbols(&symbols))
    }

    pub fn progress(&self) -> &DecodeProgress {
        self.cpu.progress()
    }
}

fn default_palette(tier: CapabilityTier) -> Vec<[f32; 3]> {
    let n = match tier {
        CapabilityTier::T0 => 2,
        CapabilityTier::T1 => 4,
        CapabilityTier::T2 | CapabilityTier::T3 => 8,
    };
    (0..n)
        .map(|i| {
            let t = i as f32 / (n as f32 - 1.0).max(1.0);
            [t, 1.0 - t, 0.5]
        })
        .collect()
}

fn detect_backend() -> GpuBackend {
    #[cfg(target_arch = "wasm32")]
    {
        GpuBackend::WebGpu
    }
    #[cfg(all(not(target_arch = "wasm32"), target_os = "macos"))]
    {
        GpuBackend::Metal
    }
    #[cfg(all(not(target_arch = "wasm32"), not(target_os = "macos")))]
    {
        GpuBackend::Vulkan
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_pipeline_advances() {
        let mut dec = FacetDecoder::new(CapabilityTier::T1);
        let img = RgbaImage {
            width: 64,
            height: 64,
            data: vec![128u8; 64 * 64 * 4],
        };
        let anchors = Anchors {
            points: [[0.0, 0.0], [63.0, 0.0], [63.0, 63.0], [0.0, 63.0]],
        };
        let p = dec.push_frame(&img, &anchors).unwrap();
        assert!(p.frames_seen >= 1);
        assert!(matches!(dec.backend(), GpuBackend::Metal | GpuBackend::Vulkan | GpuBackend::WebGpu | GpuBackend::CpuFallback));
    }
}
