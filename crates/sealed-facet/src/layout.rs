//! Facet grid geometry (spec §7.2) and the mapping between frame payload bytes and cells (spec §7.4, §7.5).
//! Port of `packages/core/src/facet/layout.ts`.
//!
//! Coordinates: cell (x, y) covers [x, x+1] × [y, y+1] in grid units; the grid spans [0, N]² and is surrounded by
//! a quiet zone of `QUIET_CELLS` background cells.
//!
//! Anchors (8 × 8 cells at each corner) are concentric square bands one cell wide. Band d (Chebyshev distance d
//! from the anchor's outer edge, d = 0..3; band 3 is the central 2 × 2) is light or dark per `ANCHOR_BANDS`. The
//! outer two bands are always light, dark; the inner two identify the corner by the run pattern *between* the two
//! band-0 squares: TL D1 L4 D1, TR D1 L1 D2 L1 D1, BR D2 L2 D2, BL D6. TL has a 4 × 4 light center that receivers
//! use as their white reference.

use std::sync::OnceLock;

use crate::palette::GRAY_RAMP;
use crate::random::{SeedPart, Xorshift32, seed_from, shuffle_in_place};
use crate::types::{GridTier, TIERS, tier_spec};

pub const QUIET_CELLS: usize = 2;
pub const ANCHOR_CELLS: usize = 8;

/// Corner index: 0 TL, 1 TR, 2 BR, 3 BL.
pub type Corner = usize;
pub const CORNER_NAMES: [&str; 4] = ["TL", "TR", "BR", "BL"];

/// Light (1) / dark (0) for bands 0 (outer) … 3 (center 2 × 2), per corner.
pub const ANCHOR_BANDS: [[u8; 4]; 4] = [
    [1, 0, 1, 1], // TL
    [1, 0, 1, 0], // TR
    [1, 0, 0, 1], // BR
    [1, 0, 0, 0], // BL
];

/// Run lengths (in cells) of the 6-cell interior between the two band-0 squares along a line through the center.
/// The interior always starts and ends dark and alternates dark/light. Corners > 3 are taken modulo 4.
pub fn anchor_interior_runs(corner: Corner) -> Vec<u32> {
    let b = ANCHOR_BANDS[corner % 4];
    let seq = [b[1], b[2], b[3], b[3], b[2], b[1]];
    let mut runs: Vec<u32> = Vec::new();
    let mut prev: Option<u8> = None;
    for v in seq {
        if prev == Some(v) {
            if let Some(last) = runs.last_mut() {
                *last += 1;
            }
        } else {
            runs.push(1);
        }
        prev = Some(v);
    }
    runs
}

/// Interior run templates indexed by corner (what `anchor_interior_runs` yields for each corner).
pub const ANCHOR_INTERIOR_RUNS: [&[u32]; 4] = [&[1, 4, 1], &[1, 1, 2, 1, 1], &[2, 2, 2], &[6]];

/// Which sides of each anchor face the quiet zone: [x side (-1 or +1), y side (-1 or +1)].
pub const ANCHOR_QUIET_SIDES: [[i8; 2]; 4] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CellKind {
    Data = 0,
    Anchor = 1,
    HeaderTop = 2,
    HeaderBottom = 3,
}

#[derive(Clone, Debug)]
pub struct GridLayout {
    pub tier: GridTier,
    pub n: usize,
    /// `CellKind` (as u8) per cell, index y * n + x.
    pub kind: Vec<u8>,
    /// Anchor cells: 1 light, 0 dark (0 for non-anchor cells).
    pub anchor_light: Vec<u8>,
    /// Header strip cells in bit order (row-major within the strip).
    pub header_top: Vec<u32>,
    pub header_bottom: Vec<u32>,
    /// Data cells in the tier's fixed pseudo-random permutation order.
    pub data_order: Vec<u32>,
    /// Anchor centers in grid units, by corner.
    pub anchor_centers: [[f64; 2]; 4],
    pub bits_per_cell: u8,
    pub codewords: usize,
    /// Cells that carry codeword bits (the rest of `data_order` is padding).
    pub cells_used: usize,
    /// Bytes in the interleaved codeword stream (codewords × 255).
    pub stream_bytes: usize,
    /// Systematic bytes (codewords × 207); the payload occupies the first T of them.
    pub systematic_bytes: usize,
    pub symbol_size: usize,
}

fn build_layout(tier: GridTier) -> GridLayout {
    let spec = tier_spec(tier);
    let n = spec.grid;
    let mut kind = vec![CellKind::Data as u8; n * n];
    let mut anchor_light = vec![0u8; n * n];
    let origins = [
        [0, 0],
        [n - ANCHOR_CELLS, 0],
        [n - ANCHOR_CELLS, n - ANCHOR_CELLS],
        [0, n - ANCHOR_CELLS],
    ];
    for (corner, [ox, oy]) in origins.into_iter().enumerate() {
        let bands = ANCHOR_BANDS[corner];
        for ay in 0..ANCHOR_CELLS {
            for ax in 0..ANCHOR_CELLS {
                let d = ax
                    .min(ANCHOR_CELLS - 1 - ax)
                    .min(ay)
                    .min(ANCHOR_CELLS - 1 - ay);
                let idx = (oy + ay) * n + ox + ax;
                kind[idx] = CellKind::Anchor as u8;
                anchor_light[idx] = bands[d];
            }
        }
    }
    let mut top: Vec<u32> = Vec::new();
    let mut bottom: Vec<u32> = Vec::new();
    for r in 0..2 {
        for x in 9..=n - 10 {
            let t = r * n + x;
            let b = (n - 2 + r) * n + x;
            kind[t] = CellKind::HeaderTop as u8;
            kind[b] = CellKind::HeaderBottom as u8;
            top.push(t as u32);
            bottom.push(b as u32);
        }
    }
    let mut data_order: Vec<u32> = (0..n * n)
        .filter(|&i| kind[i] == CellKind::Data as u8)
        .map(|i| i as u32)
        .collect();
    let mut rng = Xorshift32::new(seed_from(&[
        SeedPart::Bytes(b"facet/v1/cells"),
        SeedPart::U32(tier as u32),
    ]));
    shuffle_in_place(&mut data_order, &mut rng);

    let bpc = spec.bits_per_cell;
    let stream_bytes = spec.codewords * spec.rs_n;
    let cells_used = (stream_bytes * 8).div_ceil(bpc as usize);
    debug_assert!(
        cells_used <= data_order.len(),
        "tier {tier:?}: {cells_used} cells needed"
    );
    debug_assert!(
        spec.codewords * spec.rs_k >= spec.symbol_size,
        "tier {tier:?}: symbol does not fit"
    );
    let half = ANCHOR_CELLS as f64 / 2.0;
    let nf = n as f64;
    GridLayout {
        tier,
        n,
        kind,
        anchor_light,
        header_top: top,
        header_bottom: bottom,
        data_order,
        anchor_centers: [
            [half, half],
            [nf - half, half],
            [nf - half, nf - half],
            [half, nf - half],
        ],
        bits_per_cell: bpc,
        codewords: spec.codewords,
        cells_used,
        stream_bytes,
        systematic_bytes: spec.codewords * spec.rs_k,
        symbol_size: spec.symbol_size,
    }
}

/// The fixed layout of a grid tier, built once per tier.
pub fn grid_layout(tier: GridTier) -> &'static GridLayout {
    static CACHE: [OnceLock<GridLayout>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    CACHE[tier as usize - 1].get_or_init(|| build_layout(tier))
}

/// Grid tiers whose side is `n` cells.
pub fn grid_tier_for_size(n: usize) -> Vec<GridTier> {
    TIERS
        .iter()
        .filter(|s| s.grid == n)
        .map(|s| s.tier)
        .collect()
}

/// Position of codeword stream byte j: codeword j mod C at position floor(j / C), so the first C·207 stream bytes
/// are the (zero-filled) payload in order and adjacent bytes always belong to different codewords.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamPosition {
    pub codeword: usize,
    pub position: usize,
}

pub fn stream_position(j: usize, codewords: usize) -> StreamPosition {
    StreamPosition {
        codeword: j % codewords,
        position: j / codewords,
    }
}

/// Packs the codeword stream into cell values (color bits most significant), in permutation order. Bits beyond
/// `stream` (shorter than `stream_bytes`) read as zero.
pub fn stream_to_cells(stream: &[u8], layout: &GridLayout, padding: &mut Xorshift32) -> Vec<u8> {
    let bpc = layout.bits_per_cell as usize;
    let mut out = vec![0u8; layout.data_order.len()];
    let total_bits = layout.stream_bytes * 8;
    let mut bit = 0usize;
    for cell in out.iter_mut() {
        let mut v = 0u8;
        for _ in 0..bpc {
            let value = if bit < total_bits {
                stream
                    .get(bit >> 3)
                    .map_or(0, |b| (b >> (7 - (bit & 7))) & 1)
            } else {
                (padding.next_u32() & 1) as u8
            };
            v = (v << 1) | value;
            bit += 1;
        }
        *cell = v;
    }
    out
}

/// Inverse of `stream_to_cells` for the used cells (missing cells read as zero).
pub fn cells_to_stream(cells: &[u8], layout: &GridLayout) -> Vec<u8> {
    let bpc = layout.bits_per_cell as usize;
    let mut out = vec![0u8; layout.stream_bytes];
    let total_bits = layout.stream_bytes * 8;
    let mut bit = 0usize;
    for c in 0..layout.cells_used {
        let v = cells.get(c).copied().unwrap_or(0);
        for b in (0..bpc).rev() {
            if bit >= total_bits {
                break;
            }
            if (v >> b) & 1 != 0 {
                out[bit >> 3] |= 0x80 >> (bit & 7);
            }
            bit += 1;
        }
    }
    out
}

/// Cells (indices into the permutation order) that hold bits of stream byte j.
pub fn cells_of_byte(j: usize, bpc: usize) -> [usize; 2] {
    [(8 * j) / bpc, (8 * j + 7) / bpc]
}

/// Center cell of a calibration ramp patch and its gray level index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RampCenter {
    pub cell: usize,
    pub level: usize,
}

/// Calibration frame content (spec §7.5): gray ramp patches plus every palette color in every shape.
#[derive(Clone, Debug)]
pub struct CalibrationLayout {
    /// Symbol (color · 16 + shape) per data cell, index y * n + x; -1 for ramp cells and non-data cells.
    pub symbols: Vec<i16>,
    /// Gray level index into `GRAY_RAMP` per cell (-1 when not a ramp cell).
    pub ramp: Vec<i8>,
    /// Center cell index of each ramp patch, and its gray level index.
    pub ramp_centers: Vec<RampCenter>,
}

pub const RAMP_PATCH: usize = 3;

fn build_calibration(tier: GridTier) -> CalibrationLayout {
    let layout = grid_layout(tier);
    let n = layout.n;
    let colors = tier_spec(tier).colors as u32;
    let mut symbols = vec![-1i16; n * n];
    let mut ramp = vec![-1i8; n * n];
    let mut centers = Vec::new();
    let rows = [
        (n as f64 * 0.27).round() as usize,
        (n as f64 * 0.7).round() as usize,
    ];
    for (band, &row) in rows.iter().enumerate() {
        for level in 0..GRAY_RAMP.len() {
            // The second band runs the ramp in reverse so each level appears at two distinct positions.
            let slot = if band == 0 {
                level
            } else {
                GRAY_RAMP.len() - 1 - level
            };
            let x0 = 10 + slot * 8;
            for dy in 0..RAMP_PATCH {
                for dx in 0..RAMP_PATCH {
                    let idx = (row + dy) * n + x0 + dx;
                    debug_assert!(
                        layout.kind[idx] == CellKind::Data as u8,
                        "ramp patch overlaps a reserved cell"
                    );
                    ramp[idx] = level as i8;
                }
            }
            centers.push(RampCenter {
                cell: (row + 1) * n + x0 + 1,
                level,
            });
        }
    }
    let mut rng = Xorshift32::new(seed_from(&[
        SeedPart::Bytes(b"facet/v1/calibration"),
        SeedPart::U32(tier as u32),
    ]));
    for i in 0..n * n {
        if layout.kind[i] == CellKind::Data as u8 && ramp[i] == -1 {
            symbols[i] = rng.below(colors * 16) as i16;
        }
    }
    CalibrationLayout {
        symbols,
        ramp,
        ramp_centers: centers,
    }
}

/// The calibration-frame layout of a grid tier, built once per tier.
pub fn calibration_layout(tier: GridTier) -> &'static CalibrationLayout {
    static CACHE: [OnceLock<CalibrationLayout>; 3] =
        [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    CACHE[tier as usize - 1].get_or_init(|| build_calibration(tier))
}
