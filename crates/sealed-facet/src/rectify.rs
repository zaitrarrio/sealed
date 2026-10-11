//! Homography rectification — GPU entry wraps CPU path until device init completes.

use crate::cpu::rectify_cpu;
use crate::types::{Anchors, RgbaImage};

pub const RECTIFY_WGSL: &str = include_str!("../shaders/rectify.wgsl");

pub fn rectify(src: &RgbaImage, anchors: &Anchors, grid_px: u32) -> RgbaImage {
    rectify_cpu(src, anchors, grid_px)
}
