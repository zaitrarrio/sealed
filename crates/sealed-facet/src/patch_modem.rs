//! Monochrome Patch Modem ("Packet Grid") decode pipeline (Tier 4).
//!
//! Mirrors `packages/core/src/facet/patch-modem.ts`.
//! Partitions the 112×112 grid into 16 independent 24×24 spatial patches. Each patch carries
//! 4-border reference pilot cells to establish a local dynamic threshold and detect glare
//! erasures, and encodes 48 bytes of RaptorQ payload with CRC-16.

use crate::detect::sample_luma;
use crate::header::crc16_ccitt_false;
use crate::homography::project;
use crate::layout::{ANCHOR_BANDS, ANCHOR_CELLS};
use crate::palette::BACKGROUND;
use crate::types::{Homography, LumaPlane};

pub const PATCH_GRID_N: usize = 112;
pub const PATCH_ROWS: usize = 4;
pub const PATCH_COLS: usize = 4;
pub const TOTAL_PATCHES: usize = PATCH_ROWS * PATCH_COLS;
pub const ACTIVE_START: usize = 8;
pub const ACTIVE_SIZE: usize = 96;
pub const PATCH_CELLS: usize = ACTIVE_SIZE / PATCH_ROWS; // 24
pub const PATCH_PAYLOAD_BYTES: usize = 48;
pub const PATCH_HEADER_BYTES: usize = 5;
pub const PACKET_RAW_BYTES: usize = PATCH_HEADER_BYTES + PATCH_PAYLOAD_BYTES + 2; // 55
pub const MIN_PATCH_CONTRAST: f64 = 0.05;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchPacket {
    pub epoch: u8,
    pub r#type: u8, // 0 = data, 1 = descriptor, 2 = end
    pub patch_id: u8,
    pub sbn: u8,
    pub esi: u16,
    pub payload: [u8; PATCH_PAYLOAD_BYTES],
}

pub fn encode_patch_bits(packet: &PatchPacket) -> Vec<u8> {
    let mut bits = vec![0u8; PATCH_CELLS * PATCH_CELLS];

    // 1. Perimeter reference cells
    for x in 0..PATCH_CELLS {
        bits[x] = if x % 2 == 0 { 1 } else { 0 };
        bits[(PATCH_CELLS - 1) * PATCH_CELLS + x] = if x % 2 == 1 { 1 } else { 0 };
    }
    for y in 1..(PATCH_CELLS - 1) {
        bits[y * PATCH_CELLS] = if y % 2 == 1 { 1 } else { 0 };
        bits[y * PATCH_CELLS + (PATCH_CELLS - 1)] = if y % 2 == 0 { 1 } else { 0 };
    }

    // 2. Header
    let mut header = [0u8; PATCH_HEADER_BYTES];
    header[0] = ((packet.epoch & 0x03) << 6) | ((packet.r#type & 0x03) << 4) | (packet.patch_id & 0x0f);
    header[1] = packet.sbn;
    header[2] = (packet.esi >> 8) as u8;
    header[3] = (packet.esi & 0xff) as u8;
    header[4] = packet.payload.len() as u8;

    // 3. CRC-16
    let crc = crc16_ccitt_false(&[&header, &packet.payload]);

    // 4. Assemble interior bitstream
    let mut interior_bytes = Vec::with_capacity(PACKET_RAW_BYTES);
    interior_bytes.extend_from_slice(&header);
    interior_bytes.extend_from_slice(&packet.payload);
    interior_bytes.push((crc >> 8) as u8);
    interior_bytes.push((crc & 0xff) as u8);

    let mut bit_idx = 0usize;
    for &b in &interior_bytes {
        for bit in (0..8).rev() {
            let val = (b >> bit) & 1;
            let ix = 1 + (bit_idx % (PATCH_CELLS - 2));
            let iy = 1 + (bit_idx / (PATCH_CELLS - 2));
            if iy < PATCH_CELLS - 1 {
                bits[iy * PATCH_CELLS + ix] = val;
            }
            bit_idx += 1;
        }
    }

    bits
}

pub fn draw_anchors(grid: &mut [u8], n: usize) {
    let corners: [(usize, usize, usize); 4] = [
        (0, 0, 0),
        (n - ANCHOR_CELLS, 0, 1),
        (n - ANCHOR_CELLS, n - ANCHOR_CELLS, 2),
        (0, n - ANCHOR_CELLS, 3),
    ];

    for &(x0, y0, c) in &corners {
        let bands = ANCHOR_BANDS[c];
        for dy in 0..ANCHOR_CELLS {
            for dx in 0..ANCHOR_CELLS {
                let d = (dx as f64 - 3.5).abs().max((dy as f64 - 3.5).abs());
                let ring = if d <= 1.0 {
                    3
                } else if d <= 2.0 {
                    2
                } else if d <= 3.0 {
                    1
                } else {
                    0
                };
                let is_light = ring == 0 || (ring <= 3 && bands[ring] == 1);
                grid[(y0 + dy) * n + (x0 + dx)] = if is_light { 1 } else { 0 };
            }
        }
    }
}

pub fn render_patch_field(packets: &[PatchPacket], size_px: usize) -> Vec<u8> {
    let n = PATCH_GRID_N;
    let mut grid = vec![0u8; n * n];
    draw_anchors(&mut grid, n);

    for pkt in packets {
        if (pkt.patch_id as usize) >= TOTAL_PATCHES {
            continue;
        }
        let b = get_patch_bounds(pkt.patch_id as usize);
        let pbits = encode_patch_bits(pkt);
        for py in 0..PATCH_CELLS {
            for px in 0..PATCH_CELLS {
                grid[(b.y0 + py) * n + (b.x0 + px)] = pbits[py * PATCH_CELLS + px];
            }
        }
    }

    let mut out = vec![0u8; size_px * size_px * 4];
    let cell = (size_px / (n + 2)).max(1);
    let origin = (size_px.saturating_sub(n * cell)) / 2;

    for i in 0..size_px * size_px {
        let o = i * 4;
        out[o] = BACKGROUND[0];
        out[o + 1] = BACKGROUND[1];
        out[o + 2] = BACKGROUND[2];
        out[o + 3] = 255;
    }

    for gy in 0..n {
        let y0 = origin + gy * cell;
        if y0 >= size_px {
            break;
        }
        for gx in 0..n {
            let x0 = origin + gx * cell;
            if x0 >= size_px {
                break;
            }
            let is_white = grid[gy * n + gx] == 1;
            let (r, g, b) = if is_white {
                (255, 255, 255)
            } else {
                (BACKGROUND[0], BACKGROUND[1], BACKGROUND[2])
            };
            let max_py = cell.min(size_px - y0);
            let max_px = cell.min(size_px - x0);
            for py in 0..max_py {
                let row_offset = (y0 + py) * size_px * 4;
                for px in 0..max_px {
                    let o = row_offset + (x0 + px) * 4;
                    out[o] = r;
                    out[o + 1] = g;
                    out[o + 2] = b;
                    out[o + 3] = 255;
                }
            }
        }
    }

    out
}

#[derive(Clone, Copy, Debug)]
pub struct PatchBounds {
    pub patch_id: usize,
    pub r: usize,
    pub c: usize,
    pub x0: usize,
    pub y0: usize,
    pub size: usize,
}

pub fn get_patch_bounds(patch_id: usize) -> PatchBounds {
    let r = patch_id / PATCH_COLS;
    let c = patch_id % PATCH_COLS;
    let x0 = ACTIVE_START + c * PATCH_CELLS;
    let y0 = ACTIVE_START + r * PATCH_CELLS;
    PatchBounds {
        patch_id,
        r,
        c,
        x0,
        y0,
        size: PATCH_CELLS,
    }
}

pub struct PatchDecodeResult {
    /// Each valid packet as its 55-byte wire representation:
    /// `[header (5B), payload (48B), crc-16 (2B)]`.
    pub valid_packets: Vec<Vec<u8>>,
    pub erasure_count: usize,
    pub crc_errors: usize,
}

/// Decodes all 16 patches from a camera luma plane given the estimated 112×112 homography.
pub fn decode_patch_field(luma: &LumaPlane, h: &Homography) -> PatchDecodeResult {
    let mut valid_packets = Vec::new();
    let mut erasure_count = 0;
    let mut crc_errors = 0;

    for pid in 0..TOTAL_PATCHES {
        let b = get_patch_bounds(pid);

        // 1. Measure local white and black levels from all 4 perimeter reference borders
        let mut white_acc = 0.0;
        let mut white_count = 0usize;
        let mut black_acc = 0.0;
        let mut black_count = 0usize;

        let mut sample_pilot = |gx: usize, gy: usize, is_white: bool| {
            let [u, v] = project(h, (b.x0 + gx) as f64 + 0.5, (b.y0 + gy) as f64 + 0.5);
            let s = sample_luma(luma, u, v);
            if s.is_finite() {
                if is_white {
                    white_acc += s;
                    white_count += 1;
                } else {
                    black_acc += s;
                    black_count += 1;
                }
            }
        };

        // Top border (y = 0): even = white, odd = black
        for px in 0..PATCH_CELLS {
            sample_pilot(px, 0, px % 2 == 0);
        }
        // Bottom border (y = PATCH_CELLS - 1): even = black, odd = white
        for px in 0..PATCH_CELLS {
            sample_pilot(px, PATCH_CELLS - 1, px % 2 == 1);
        }
        // Left border (x = 0): odd = white, even = black (interior points)
        for py in 1..(PATCH_CELLS - 1) {
            sample_pilot(0, py, py % 2 == 1);
        }
        // Right border (x = PATCH_CELLS - 1): even = white, odd = black (interior points)
        for py in 1..(PATCH_CELLS - 1) {
            sample_pilot(PATCH_CELLS - 1, py, py % 2 == 0);
        }

        if white_count < 8 || black_count < 8 {
            erasure_count += 1;
            continue;
        }

        let local_white = white_acc / white_count as f64;
        let local_black = black_acc / black_count as f64;
        let contrast = local_white - local_black;

        // 2. Glare erasure check: if local contrast is too low, reflection has washed it out
        if contrast < MIN_PATCH_CONTRAST {
            erasure_count += 1;
            continue;
        }

        // 3. Dynamic local threshold for this patch
        let local_threshold = (local_white + local_black) / 2.0;

        // 4. Sample interior cells (22×22 = 484 cells)
        let expected_bytes = PACKET_RAW_BYTES;
        let mut interior_bytes = vec![0u8; expected_bytes];

        let mut bit_idx = 0usize;
        for item in &mut interior_bytes {
            let mut byte_val = 0u8;
            for bit in (0..8).rev() {
                let ix = 1 + (bit_idx % (PATCH_CELLS - 2));
                let iy = 1 + (bit_idx / (PATCH_CELLS - 2));
                let [u, v] = project(h, (b.x0 + ix) as f64 + 0.5, (b.y0 + iy) as f64 + 0.5);
                let lum = sample_luma(luma, u, v);
                if lum.is_finite() && lum > local_threshold {
                    byte_val |= 1 << bit;
                }
                bit_idx += 1;
            }
            *item = byte_val;
        }

        // 5. Unpack header
        let header_byte_0 = interior_bytes[0];
        let decoded_patch_id = header_byte_0 & 0x0f;
        let len = interior_bytes[4] as usize;

        if decoded_patch_id != pid as u8 || len != PATCH_PAYLOAD_BYTES {
            crc_errors += 1;
            continue;
        }

        // 6. Verify CRC-16
        let header = &interior_bytes[..PATCH_HEADER_BYTES];
        let payload = &interior_bytes[PATCH_HEADER_BYTES..PATCH_HEADER_BYTES + len];
        let received_crc = ((interior_bytes[PATCH_HEADER_BYTES + len] as u16) << 8)
            | (interior_bytes[PATCH_HEADER_BYTES + len + 1] as u16);

        let calculated_crc = crc16_ccitt_false(&[header, payload]);
        if received_crc != calculated_crc {
            crc_errors += 1;
            continue;
        }

        // Valid packet recovered
        valid_packets.push(interior_bytes);
    }

    PatchDecodeResult {
        valid_packets,
        erasure_count,
        crc_errors,
    }
}
