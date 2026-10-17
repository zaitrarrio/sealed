//! Facet frame header (spec §7.5): 12 bytes, protected by RS(20,12) over GF(256) in the grid tiers and by QR's
//! own error correction in T0. Port of `packages/core/src/facet/header.ts`.
//!
//! ```text
//!   byte 0      magic 0xF (high nibble) ∥ version 1 (low nibble)
//!   byte 1      tier (bits 7–5) ∥ frame type (bits 4–2) ∥ loop flag (bit 1) ∥ signed flag (bit 0)
//!   bytes 2–5   stream_id
//!   byte 6      SBN
//!   bytes 7–9   ESI (big-endian)
//!   bytes 10–11 CRC-16/CCITT-FALSE over bytes 0–9 ∥ first 64 payload bytes (zero-extended if shorter)
//! ```
//!
//! The CRC binds the header to the payload decoded under it; a receiver can only check it after decoding the
//! data region, which is how torn frames (header from one frame, data from another) are rejected.

use std::sync::OnceLock;

use crate::random::{SeedPart, Xorshift32, seed_from};
use crate::rs::ReedSolomon;
use crate::types::FrameType;

pub const HEADER_BYTES: usize = 12;
pub const HEADER_RS_N: usize = 20;
pub const HEADER_BITS: usize = HEADER_RS_N * 8;
pub const CODEC_VERSION: u8 = 1;
const MAGIC: u8 = 0xf;
/// Payload bytes covered by the CRC.
pub const CRC_PAYLOAD_BYTES: usize = 64;

const FRAME_TYPES: [FrameType; 4] = [
    FrameType::Calibration,
    FrameType::Descriptor,
    FrameType::Data,
    FrameType::End,
];

/// Index of a frame type in the header's 3-bit type field.
pub fn frame_type_index(t: FrameType) -> u8 {
    match t {
        FrameType::Calibration => 0,
        FrameType::Descriptor => 1,
        FrameType::Data => 2,
        FrameType::End => 3,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    /// Tier 0–3.
    pub tier: u8,
    pub r#type: FrameType,
    pub r#loop: bool,
    pub signed: bool,
    pub stream_id: [u8; 4],
    pub sbn: u8,
    /// 24-bit encoding symbol id.
    pub esi: u32,
}

/// Why a header could not be encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderError {
    TierOutOfRange,
    EsiOutOfRange,
}

/// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR) over the concatenation of `parts`.
/// Check("123456789") = 0x29B1.
pub fn crc16_ccitt_false(parts: &[&[u8]]) -> u16 {
    let mut crc: u16 = 0xffff;
    for p in parts {
        for &byte in *p {
            crc ^= (byte as u16) << 8;
            for _ in 0..8 {
                crc = if crc & 0x8000 != 0 {
                    (crc << 1) ^ 0x1021
                } else {
                    crc << 1
                };
            }
        }
    }
    crc
}

fn crc_payload(payload: &[u8]) -> [u8; CRC_PAYLOAD_BYTES] {
    let mut out = [0u8; CRC_PAYLOAD_BYTES];
    let n = payload.len().min(CRC_PAYLOAD_BYTES);
    out[..n].copy_from_slice(&payload[..n]);
    out
}

/// Serialize a header for `payload` (computes the CRC).
pub fn encode_frame_header(
    h: &FrameHeader,
    payload: &[u8],
) -> Result<[u8; HEADER_BYTES], HeaderError> {
    if h.tier > 3 {
        return Err(HeaderError::TierOutOfRange);
    }
    if h.esi > 0xff_ffff {
        return Err(HeaderError::EsiOutOfRange);
    }
    let t = frame_type_index(h.r#type);
    let mut out = [0u8; HEADER_BYTES];
    out[0] = (MAGIC << 4) | CODEC_VERSION;
    out[1] = (h.tier << 5) | (t << 2) | if h.r#loop { 2 } else { 0 } | if h.signed { 1 } else { 0 };
    out[2..6].copy_from_slice(&h.stream_id);
    out[6] = h.sbn;
    out[7] = ((h.esi >> 16) & 0xff) as u8;
    out[8] = ((h.esi >> 8) & 0xff) as u8;
    out[9] = (h.esi & 0xff) as u8;
    let crc = crc16_ccitt_false(&[&out[..10], &crc_payload(payload)]);
    out[10] = (crc >> 8) as u8;
    out[11] = (crc & 0xff) as u8;
    Ok(out)
}

/// Parse the header fields (magic, version, tier and type checked; CRC not checked). `None` if malformed.
pub fn parse_frame_header(b: &[u8]) -> Option<FrameHeader> {
    if b.len() < HEADER_BYTES {
        return None;
    }
    let b0 = b[0];
    let b1 = b[1];
    if b0 >> 4 != MAGIC || (b0 & 0xf) != CODEC_VERSION {
        return None;
    }
    let tier = b1 >> 5;
    if tier > 3 {
        return None;
    }
    let r#type = *FRAME_TYPES.get(((b1 >> 2) & 7) as usize)?;
    let mut stream_id = [0u8; 4];
    stream_id.copy_from_slice(&b[2..6]);
    Some(FrameHeader {
        tier,
        r#type,
        r#loop: (b1 & 2) != 0,
        signed: (b1 & 1) != 0,
        stream_id,
        sbn: b[6],
        esi: ((b[7] as u32) << 16) | ((b[8] as u32) << 8) | b[9] as u32,
    })
}

/// True when the header's CRC matches `payload`.
pub fn header_crc_matches(header: &[u8], payload: &[u8]) -> bool {
    if header.len() < HEADER_BYTES {
        return false;
    }
    let crc = crc16_ccitt_false(&[&header[..10], &crc_payload(payload)]);
    header[10] == (crc >> 8) as u8 && header[11] == (crc & 0xff) as u8
}

fn header_rs() -> &'static ReedSolomon {
    static RS: OnceLock<ReedSolomon> = OnceLock::new();
    RS.get_or_init(|| {
        ReedSolomon::new(HEADER_RS_N, HEADER_BYTES).expect("RS(20,12) parameters are valid")
    })
}

/// Fixed whitening mask so header strips never show long uniform runs (aids thresholding).
fn whiten() -> &'static [u8; HEADER_RS_N] {
    static W: OnceLock<[u8; HEADER_RS_N]> = OnceLock::new();
    W.get_or_init(|| {
        let mut r = Xorshift32::new(seed_from(&[SeedPart::Bytes(b"facet/v1/header-whiten")]));
        let mut m = [0u8; HEADER_RS_N];
        for v in m.iter_mut() {
            *v = (r.next_u32() & 0xff) as u8;
        }
        m
    })
}

/// The 160 header strip bits (MSB first) for an encoded 12-byte header (0/1 per entry). `None` if `header` is
/// shorter than 12 bytes.
pub fn header_strip_bits(header: &[u8]) -> Option<[u8; HEADER_BITS]> {
    let cw = header_rs().encode(header.get(..HEADER_BYTES)?)?;
    let w = whiten();
    let mut bits = [0u8; HEADER_BITS];
    for i in 0..HEADER_RS_N {
        let v = cw[i] ^ w[i];
        for b in 0..8 {
            bits[i * 8 + b] = (v >> (7 - b)) & 1;
        }
    }
    Some(bits)
}

/// Decode one strip's 160 hard bits (with optional per-bit confidence; least confident bytes are tried as
/// erasures). Returns the 12 header bytes or `None`.
pub fn decode_header_strip(bits: &[u8], confidence: Option<&[f32]>) -> Option<[u8; HEADER_BYTES]> {
    if bits.len() < HEADER_BITS {
        return None;
    }
    if let Some(c) = confidence
        && c.len() < HEADER_BITS
    {
        return None;
    }
    let w = whiten();
    let mut cw = [0u8; HEADER_RS_N];
    let mut byte_conf = [f32::INFINITY; HEADER_RS_N];
    for i in 0..HEADER_RS_N {
        let mut v = 0u8;
        let mut c = f32::INFINITY;
        for b in 0..8 {
            v = (v << 1) | (bits[i * 8 + b] & 1);
            if let Some(conf) = confidence {
                c = js_min(c, conf[i * 8 + b]);
            }
        }
        cw[i] = v ^ w[i];
        byte_conf[i] = c;
    }
    let mut order: Vec<usize> = (0..HEADER_RS_N).collect();
    order.sort_by(|&a, &b| js_cmp(byte_conf[a], byte_conf[b]));
    let attempts: &[usize] = if confidence.is_some() {
        &[0, 2, 4, 6, 8]
    } else {
        &[0]
    };
    for &e in attempts {
        if let Some(out) = header_rs().decode(&cw, &order[..e])
            && parse_frame_header(&out).is_some()
        {
            let mut h = [0u8; HEADER_BYTES];
            h.copy_from_slice(&out);
            return Some(h);
        }
    }
    None
}

/// `Math.min` semantics: NaN is contagious.
#[inline]
pub(crate) fn js_min(a: f32, b: f32) -> f32 {
    if a.is_nan() || b.is_nan() {
        f32::NAN
    } else {
        a.min(b)
    }
}

/// Comparator matching `(a, b) => a - b` under a stable sort: NaN differences compare as equal.
#[inline]
pub(crate) fn js_cmp(a: f32, b: f32) -> std::cmp::Ordering {
    let d = a - b;
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}
