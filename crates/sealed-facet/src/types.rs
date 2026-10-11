//! Shared Facet types.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityTier {
    T0 = 0,
    T1 = 1,
    T2 = 2,
    T3 = 3,
}

#[derive(Debug, Clone)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct DecodeProgress {
    pub frames_seen: u32,
    pub frames_decoded: u32,
    pub fraction: f32,
    pub complete: bool,
    pub tier: Option<CapabilityTier>,
}

/// Corner anchors in image pixel space (TL, TR, BR, BL).
#[derive(Debug, Clone, Copy)]
pub struct Anchors {
    pub points: [[f32; 2]; 4],
}
