//! Shared types of the grid decoder. Mirrors `packages/core/src/facet/types.ts` and `detect.ts` (LumaPlane).

/// An RGBA image, 4 bytes per pixel, row-major; `stride` bytes per row (≥ width × 4).
#[derive(Clone, Copy, Debug)]
pub struct RgbaImage<'a> {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub data: &'a [u8],
}

impl<'a> RgbaImage<'a> {
    pub fn new(width: usize, height: usize, data: &'a [u8]) -> Self {
        Self {
            width,
            height,
            stride: width * 4,
            data,
        }
    }
    #[inline]
    pub fn px(&self, x: usize, y: usize) -> [u8; 4] {
        let o = y * self.stride + x * 4;
        [
            self.data[o],
            self.data[o + 1],
            self.data[o + 2],
            self.data[o + 3],
        ]
    }
}

/// Linear-light luma (Rec. 709 weights over sRGB-decoded channels), 0..1.
#[derive(Clone, Debug)]
pub struct LumaPlane {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

/// 3 × 3 row-major homography (grid units → image pixels), as in `homography.ts`.
pub type Homography = [f64; 9];

/// Grid tiers only; T0 (QR) is decoded by platform detectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum GridTier {
    T1 = 1,
    T2 = 2,
    T3 = 3,
}

impl GridTier {
    pub fn from_u8(t: u8) -> Option<Self> {
        match t {
            1 => Some(Self::T1),
            2 => Some(Self::T2),
            3 => Some(Self::T3),
            _ => None,
        }
    }
}

/// Per-tier constants (`tiers.ts` TIERS) for the grid tiers.
#[derive(Clone, Copy, Debug)]
pub struct TierSpec {
    pub tier: GridTier,
    pub grid: usize,
    pub bits_per_cell: u8,
    pub colors: u8,
    pub symbol_size: usize,
    pub rs_n: usize,
    pub rs_k: usize,
    pub codewords: usize,
}

pub const TIERS: [TierSpec; 3] = [
    TierSpec {
        tier: GridTier::T1,
        grid: 112,
        bits_per_cell: 6,
        colors: 4,
        symbol_size: 7240,
        rs_n: 255,
        rs_k: 207,
        codewords: 35,
    },
    TierSpec {
        tier: GridTier::T2,
        grid: 112,
        bits_per_cell: 7,
        colors: 8,
        symbol_size: 8280,
        rs_n: 255,
        rs_k: 207,
        codewords: 40,
    },
    TierSpec {
        tier: GridTier::T3,
        grid: 144,
        bits_per_cell: 7,
        colors: 8,
        symbol_size: 14072,
        rs_n: 255,
        rs_k: 207,
        codewords: 68,
    },
];

pub fn tier_spec(t: GridTier) -> &'static TierSpec {
    &TIERS[t as usize - 1]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameType {
    Calibration,
    Descriptor,
    Data,
    End,
}
