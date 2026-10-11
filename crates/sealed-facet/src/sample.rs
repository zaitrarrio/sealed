//! Cell sampling / classification.

pub const SAMPLE_WGSL: &str = include_str!("../shaders/sample.wgsl");

pub use crate::cpu::sample_cells;
