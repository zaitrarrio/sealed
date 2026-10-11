//! Facet optical codec: GPU kernels via wgpu (WebGPU / Metal / Vulkan) and a CPU fallback.
//!
//! Kernels (ADR-0011): rectification, color calibration, cell sampling, RS syndrome.

#![deny(unsafe_code)]

pub mod calibrate;
pub mod cpu;
pub mod pipeline;
pub mod rectify;
pub mod sample;
pub mod syndrome;
pub mod types;

pub use pipeline::{FacetDecoder, GpuBackend};
pub use types::{CapabilityTier, DecodeProgress, RgbaImage};
