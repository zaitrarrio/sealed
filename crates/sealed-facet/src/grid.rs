//! Grid-frame content (T1–T3): header strips, anchors, and the data region produced from a payload via the inner
//! RS(255,207) code (spec §7.5) — shared by the sender (rendering) and the receiver (decoding).
//! Port of `packages/core/src/facet/grid.ts`.
//!
//! Data path for one frame:
//!   payload (T bytes) ∥ zero fill → C × 207 systematic bytes, byte j belongs to codeword j mod C
//!   → each codeword RS(255,207)-encoded → C × 255 stream bytes, same interleave
//!   → XOR whitening with a PRNG keyed by (stream_id, tier, type, SBN, ESI)
//!   → bits packed into cells (color bits most significant) in the tier's fixed cell permutation
//!   → remaining cells filled with the same PRNG (spec §7.2 padding).
//!
//! Spec §7.2 seeds padding with "stream_id ∥ frame counter"; the frame counter is not in the header, so Facet uses
//! the header's (type, SBN, ESI), which identifies the frame content and lets receivers regenerate padding cells.

use std::sync::OnceLock;

use crate::header::{HEADER_BITS, frame_type_index, header_strip_bits, js_cmp};
use crate::layout::{CellKind, GridLayout, calibration_layout, cells_to_stream, stream_to_cells};
use crate::parallel::{par_rows, parts_for, worker_count};
use crate::random::{SeedPart, Xorshift32, seed_from};
use crate::rs::ReedSolomon;
use crate::types::{FrameType, GridTier};

/// Picture codes for one grid cell: ≥ 0 is a glyph symbol (color · 16 + shape).
pub const PIC_BG: i16 = -1;
pub const PIC_WHITE: i16 = -2;
/// Gray ramp level l is encoded as `PIC_GRAY_BASE - l`.
pub const PIC_GRAY_BASE: i16 = -3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameIdentity {
    pub stream_id: [u8; 4],
    pub tier: GridTier,
    pub r#type: FrameType,
    pub sbn: u8,
    /// 24-bit encoding symbol id (the full 32 bits are hashed, as in the JavaScript).
    pub esi: u32,
}

/// PRNG for whitening and padding of one frame.
pub fn frame_rng(id: &FrameIdentity) -> Xorshift32 {
    let word =
        ((id.tier as u32) << 24) | ((frame_type_index(id.r#type) as u32) << 16) | id.sbn as u32;
    Xorshift32::new(seed_from(&[
        SeedPart::Bytes(&id.stream_id),
        SeedPart::U32(word),
        SeedPart::U32(id.esi),
    ]))
}

/// Whitening mask for the codeword stream, and the generator positioned at the padding bits.
pub struct FrameMask {
    pub mask: Vec<u8>,
    pub padding: Xorshift32,
}

pub fn frame_mask(layout: &GridLayout, id: &FrameIdentity) -> FrameMask {
    let mut rng = frame_rng(id);
    let mut mask = vec![0u8; layout.stream_bytes];
    for m in mask.iter_mut() {
        *m = (rng.next_u32() & 0xff) as u8;
    }
    FrameMask { mask, padding: rng }
}

/// Inner-code decoding policy: erase the least confident bytes in steps, and keep `RS_SAFETY_MARGIN` parity
/// symbols unused (2e + f ≤ n − k − margin). With 8 spare symbols a codeword that is not within reach decodes to
/// a wrong codeword with probability ≈ 256⁻⁸, so wrong symbols do not reach RaptorQ.
const ERASURE_LADDER: [usize; 6] = [0, 8, 16, 24, 32, 40];
const RS_SAFETY_MARGIN: usize = 8;

/// The inner RS(255,207) code, built once.
pub fn inner_rs() -> &'static ReedSolomon {
    static RS: OnceLock<ReedSolomon> = OnceLock::new();
    RS.get_or_init(|| ReedSolomon::new(255, 207).expect("RS(255,207) parameters are valid"))
}

/// Encodes `payload` (≤ T bytes; zero-filled) into the whitened codeword stream. `None` if the payload exceeds T
/// or `mask` is shorter than the stream.
pub fn encode_stream(layout: &GridLayout, payload: &[u8], mask: &[u8]) -> Option<Vec<u8>> {
    if payload.len() > layout.symbol_size || mask.len() < layout.stream_bytes {
        return None;
    }
    let c_n = layout.codewords;
    let rs = inner_rs();
    let mut stream = vec![0u8; layout.stream_bytes];
    let mut data = vec![0u8; rs.k];
    let mut cw = vec![0u8; rs.n];
    for c in 0..c_n {
        for (p, d) in data.iter_mut().enumerate() {
            let j = p * c_n + c;
            *d = payload.get(j).copied().unwrap_or(0);
        }
        if !rs.encode_into(&data, &mut cw) {
            return None;
        }
        for (p, &v) in cw.iter().enumerate() {
            stream[p * c_n + c] = v;
        }
    }
    for (s, m) in stream.iter_mut().zip(mask) {
        *s ^= *m;
    }
    Some(stream)
}

/// Data-cell values (in permutation order) for a frame.
pub fn encode_data_cells(
    layout: &GridLayout,
    id: &FrameIdentity,
    payload: &[u8],
) -> Option<Vec<u8>> {
    let FrameMask { mask, mut padding } = frame_mask(layout, id);
    let stream = encode_stream(layout, payload, &mask)?;
    Some(stream_to_cells(&stream, layout, &mut padding))
}

/// Expected values of the pure padding cells (permutation positions ≥ `cells_used`). The receiver regenerates
/// them from the header so they serve as known pilots for inter-symbol-interference cancellation.
pub fn padding_cells(layout: &GridLayout, id: &FrameIdentity) -> Vec<u8> {
    let FrameMask { mut padding, .. } = frame_mask(layout, id);
    let bpc = layout.bits_per_cell as usize;
    let total_bits = layout.stream_bytes * 8;
    let partial_bits = layout.cells_used * bpc - total_bits; // padding bits inside the last used cell
    for _ in 0..partial_bits {
        padding.next_u32();
    }
    let mut out = vec![0u8; layout.data_order.len() - layout.cells_used];
    for cell in out.iter_mut() {
        let mut v = 0u8;
        for _ in 0..bpc {
            v = (v << 1) | (padding.next_u32() & 1) as u8;
        }
        *cell = v;
    }
    out
}

/// Header strip bits: 160 RS(20,12) bits followed by an alternating filler in the remaining strip cells.
/// `None` if `header` is shorter than 12 bytes.
pub fn strip_bits(layout: &GridLayout, header: &[u8]) -> Option<Vec<u8>> {
    let bits = header_strip_bits(header)?;
    let mut out = vec![0u8; layout.header_top.len()];
    let n = bits.len().min(out.len());
    out[..n].copy_from_slice(&bits[..n]);
    for (i, v) in out.iter_mut().enumerate().skip(HEADER_BITS) {
        *v = (i & 1) as u8;
    }
    Some(out)
}

/// Fills anchors and header strips into a picture.
fn frame(layout: &GridLayout, header: &[u8]) -> Option<Vec<i16>> {
    let n = layout.n;
    let mut pic = vec![PIC_BG; n * n];
    for (i, p) in pic.iter_mut().enumerate() {
        if layout.kind[i] == CellKind::Anchor as u8 && layout.anchor_light[i] != 0 {
            *p = PIC_WHITE;
        }
    }
    let bits = strip_bits(layout, header)?;
    for (i, &b) in bits.iter().enumerate() {
        let v = if b != 0 { PIC_WHITE } else { PIC_BG };
        pic[layout.header_top[i] as usize] = v;
        pic[layout.header_bottom[i] as usize] = v;
    }
    Some(pic)
}

/// The full cell picture (index y · N + x) of a data, descriptor or end frame.
pub fn data_picture(
    layout: &GridLayout,
    header: &[u8],
    id: &FrameIdentity,
    payload: &[u8],
) -> Option<Vec<i16>> {
    let mut pic = frame(layout, header)?;
    let cells = encode_data_cells(layout, id, payload)?;
    for (i, &c) in cells.iter().enumerate() {
        pic[layout.data_order[i] as usize] = c as i16;
    }
    Some(pic)
}

/// The cell picture of a calibration frame: palette × shape tiling plus gray ramps.
pub fn calibration_picture(layout: &GridLayout, header: &[u8]) -> Option<Vec<i16>> {
    let mut pic = frame(layout, header)?;
    let cal = calibration_layout(layout.tier);
    for (i, p) in pic.iter_mut().enumerate() {
        let s = cal.symbols[i];
        let r = cal.ramp[i];
        if r >= 0 {
            *p = PIC_GRAY_BASE - r as i16;
        } else if s >= 0 {
            *p = s;
        }
    }
    Some(pic)
}

#[derive(Clone, Debug)]
pub struct StreamDecodeResult {
    /// The T payload bytes when every codeword decoded.
    pub payload: Option<Vec<u8>>,
    /// Codewords that decoded (1 per codeword; for decision feedback).
    pub ok: Vec<u8>,
    /// Corrected, re-whitened stream bytes for decoded codewords (others hold the received bytes).
    pub stream: Vec<u8>,
    pub failed: usize,
}

/// Codewords already decoded in an earlier pass, with their corrected (whitened) stream bytes.
#[derive(Clone, Debug)]
pub struct DecodedCodewords {
    pub ok: Vec<u8>,
    pub stream: Vec<u8>,
}

/// RS-decodes the whitened stream read from the cells. `byte_conf` ranks byte reliability (low = erase first);
/// `forced_erasures` marks bytes that must be erased (torn-frame salvage). Known zero-fill bytes are restored.
/// Codewords marked in `known.ok` are taken from `known.stream` instead of being decoded again. Decoding stops
/// after `max_failures` failed codewords (the payload is then `None`; remaining codewords are reported as not ok).
/// Returns `None` when `received`, `mask`, `byte_conf`, `forced_erasures` or `known` are shorter than the stream.
pub fn decode_stream(
    layout: &GridLayout,
    received: &[u8],
    mask: &[u8],
    byte_conf: &[f32],
    forced_erasures: Option<&[u8]>,
    known: Option<&DecodedCodewords>,
    max_failures: Option<usize>,
) -> Option<StreamDecodeResult> {
    let c_n = layout.codewords;
    let rs = inner_rs();
    let t_len = layout.symbol_size;
    let sb = layout.stream_bytes;
    if received.len() < sb || mask.len() < sb || byte_conf.len() < sb {
        return None;
    }
    if forced_erasures.is_some_and(|f| f.len() < sb) {
        return None;
    }
    if known.is_some_and(|k| k.ok.len() < c_n || k.stream.len() < sb) {
        return None;
    }
    let max_failures = max_failures.unwrap_or(usize::MAX);
    let mut ok = vec![0u8; c_n];
    let mut stream = received[..sb].to_vec();
    let mut payload = vec![0u8; t_len];
    let mut failed = 0usize;
    // Codewords are independent: they are decoded in batches across the worker threads, and the batch results
    // are then folded in codeword order (so the failure limit stops exactly where a sequential walk would, at the
    // cost of at most one batch of extra decoding).
    let workers = worker_count();
    let batch = if workers > 1 { workers * 2 } else { c_n.max(1) };
    let mut results: Vec<CodewordResult> = Vec::with_capacity(batch);
    let mut c0 = 0usize;
    while c0 < c_n {
        let c1 = c_n.min(c0 + batch);
        results.clear();
        results.resize_with(c1 - c0, || CodewordResult::Known);
        par_rows(&mut results, 1, 1, parts_for(c1 - c0, 1), |i0, rows| {
            let mut scratch = CodewordScratch::new(rs.n);
            for (i, r) in rows.iter_mut().enumerate() {
                let c = c0 + i0 + i;
                if known.is_some_and(|k| k.ok[c] != 0) {
                    continue;
                }
                *r = decode_codeword(
                    rs,
                    c,
                    c_n,
                    t_len,
                    received,
                    mask,
                    byte_conf,
                    forced_erasures,
                    &mut scratch,
                );
            }
        });
        for (c, r) in (c0..c1).zip(results.drain(..)) {
            match r {
                CodewordResult::Known => {
                    let k = known.expect("known codewords come from `known`");
                    ok[c] = 1;
                    for p in 0..rs.n {
                        let j = p * c_n + c;
                        stream[j] = k.stream[j];
                        if p < rs.k && j < t_len {
                            payload[j] = stream[j] ^ mask[j];
                        }
                    }
                }
                CodewordResult::Failed => {
                    failed += 1;
                    if failed >= max_failures {
                        return Some(StreamDecodeResult {
                            payload: None,
                            ok,
                            stream,
                            failed,
                        });
                    }
                }
                CodewordResult::Decoded { out, enc } => {
                    ok[c] = 1;
                    for p in 0..rs.n {
                        let j = p * c_n + c;
                        stream[j] = enc[p] ^ mask[j];
                        if p < rs.k && j < t_len {
                            payload[j] = out[p];
                        }
                    }
                }
            }
        }
        c0 = c1;
    }
    Some(StreamDecodeResult {
        payload: (failed == 0).then_some(payload),
        ok,
        stream,
        failed,
    })
}

enum CodewordResult {
    /// Taken from `known` (or not decoded in this batch).
    Known,
    Failed,
    /// The decoded message and its re-encoded codeword.
    Decoded {
        out: Vec<u8>,
        enc: Vec<u8>,
    },
}

struct CodewordScratch {
    cw: Vec<u8>,
    conf: Vec<f32>,
    enc: Vec<u8>,
    erased_set: Vec<bool>,
}

impl CodewordScratch {
    fn new(n: usize) -> Self {
        Self {
            cw: vec![0u8; n],
            conf: vec![0f32; n],
            enc: vec![0u8; n],
            erased_set: vec![false; n],
        }
    }
}

/// Decodes codeword `c` of the stream with the erasure ladder and the miscorrection guard.
fn decode_codeword(
    rs: &ReedSolomon,
    c: usize,
    c_n: usize,
    t_len: usize,
    received: &[u8],
    mask: &[u8],
    byte_conf: &[f32],
    forced_erasures: Option<&[u8]>,
    sc: &mut CodewordScratch,
) -> CodewordResult {
    let max_erasures = rs.n - rs.k;
    let mut forced: Vec<usize> = Vec::new();
    let mut is_forced = vec![false; rs.n];
    for (p, fp) in is_forced.iter_mut().enumerate() {
        let j = p * c_n + c;
        let mut v = received[j] ^ mask[j];
        let mut cf = byte_conf[j];
        if p < rs.k && j >= t_len {
            v = 0; // known zero fill
            cf = f32::INFINITY;
        } else if forced_erasures.is_some_and(|f| f[j] != 0) {
            forced.push(p);
            *fp = true;
        }
        sc.cw[p] = v;
        sc.conf[p] = cf;
    }
    if forced.len() > max_erasures {
        return CodewordResult::Failed;
    }
    let conf = &sc.conf;
    let mut order: Vec<usize> = (0..rs.n).filter(|&p| !is_forced[p]).collect();
    order.sort_by(|&a, &b| js_cmp(conf[a], conf[b]));
    let mut erased: Vec<usize> = Vec::new();
    for &extra in &ERASURE_LADDER {
        erased.clear();
        erased.extend_from_slice(&forced);
        erased.extend_from_slice(&order[..extra.min(order.len())]);
        if erased.len() > max_erasures - RS_SAFETY_MARGIN {
            break;
        }
        let Some(cand) = rs.decode(&sc.cw, &erased) else {
            continue;
        };
        // Miscorrection guard: accept only when 2e + f leaves RS_SAFETY_MARGIN parity symbols unused, where e
        // counts corrected positions outside the erasures. Decoding at the full radius n − k would "correct"
        // any word.
        if !rs.encode_into(&cand, &mut sc.enc) {
            continue;
        }
        sc.erased_set.fill(false);
        for &e in &erased {
            sc.erased_set[e] = true;
        }
        let errors = (0..rs.n)
            .filter(|&p| !sc.erased_set[p] && sc.enc[p] != sc.cw[p])
            .count();
        if 2 * errors + erased.len() > max_erasures - RS_SAFETY_MARGIN {
            continue;
        }
        return CodewordResult::Decoded {
            out: cand,
            enc: sc.enc.clone(),
        };
    }
    CodewordResult::Failed
}

/// Cell values (permutation order, used cells) implied by a stream.
pub fn stream_cells(layout: &GridLayout, stream: &[u8]) -> Vec<u8> {
    let mut cells = stream_to_cells(stream, layout, &mut Xorshift32::new(1));
    cells.truncate(layout.cells_used);
    cells
}

/// Reads the whitened stream from decided cell values (permutation order).
pub fn cells_stream(layout: &GridLayout, cells: &[u8]) -> Vec<u8> {
    cells_to_stream(cells, layout)
}
