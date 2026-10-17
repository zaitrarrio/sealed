//! Grid-frame decoding (spec §7.6 steps 3–8) given a homography and a channel calibration. Port of
//! `packages/core/src/facet/decode.ts`.
//!
//! Header strips: full black/white cells, decided by decision feedback against the channel model (known anchors
//! and quiet zone, expected-mean data neighbors), then RS(20,12)-decoded with the least confident bytes as
//! erasures. Either strip is accepted.
//!
//! Data cells: joint color + shape detection by VAMP over the residual after cancelling every known source
//! (`vamp.rs`), then RS(255,207) per codeword, erasing the least confident bytes. Codewords that decode turn
//! their cells into known sources and the remaining cells are re-detected (turbo refinement, ≤ 2 rounds).
//!
//! Temporal fusion (spec §7.6 step 8): when a frame fails, the per-capture Gram sums WᵀW / σ² are kept per
//! (stream, tier, SBN, ESI) so a later capture of the same symbol can be decoded from the joint statistics.
//!
//! Torn frames: when the two header strips decode to different headers, both headers are tried; the CRC binds
//! the header to the payload, so only the matching interpretation is accepted.

use std::borrow::Cow;
use std::sync::OnceLock;

use crate::calibrate::{ChannelCalibration, WHITE_EXCESS, correct_features, set_source};
use crate::equalize::detect_from_stats;
use crate::glyphs::mean_fill;
use crate::grid::{
    DecodedCodewords, FrameIdentity, PIC_BG, PIC_WHITE, StreamDecodeResult, decode_stream,
    frame_mask, padding_cells, stream_cells, strip_bits,
};
use crate::header::{
    FrameHeader, HEADER_BITS, HEADER_BYTES, decode_header_strip, header_crc_matches, js_min,
    parse_frame_header,
};
use crate::layout::{CellKind, GridLayout, cells_of_byte, cells_to_stream};
use crate::model::{
    EDGE_CLASSES, ResponseModel, SourceGrid, edge_class, new_source_grid, predict_features,
    predict_features_into, response_model, spread_grams,
};
use crate::sample::sample_cells;
use crate::types::{GridTier, Homography, RgbaImage};
use crate::vamp::{VampOptions, VampProblem, vamp_detect};

const VAMP_ITERATIONS: usize = 12;
const VAMP_DAMPING: f64 = 0.5;
const TURBO_ROUNDS: usize = 2;
const HEADER_PASSES: usize = 4;

/// Noise variance assumed before a calibration frame has measured it (≈ σ 6 code values on mid-gray).
const DEFAULT_NOISE_VARIANCE: f64 = 1e-4;

fn white_norm2() -> f64 {
    let we = &*WHITE_EXCESS;
    we[0] * we[0] + we[1] * we[1] + we[2] * we[2]
}

/// Observed frame: corrected features + the model they were corrected for.
#[derive(Clone, Debug)]
pub struct Observation {
    pub layout: &'static GridLayout,
    /// Corrected features `[cell * 12 + q * 3 + ch]` (NaN where sampling fell outside the image).
    pub feat: Vec<f32>,
    pub valid: Vec<u8>,
    pub model: ResponseModel,
    /// Palette centroids (K × 3).
    pub centroids: Vec<f32>,
    /// Per-component noise variance of the corrected features (from the calibration fit residual).
    pub noise_variance: f64,
}

/// Samples and colour-corrects a frame. `None` if sampling fails or fewer than 98 % of the cells are visible.
pub fn observe(
    img: &RgbaImage<'_>,
    h: &Homography,
    layout: &'static GridLayout,
    cal: &ChannelCalibration,
    centroids: &[f32],
) -> Option<Observation> {
    let s = sample_cells(img, h, layout.n, &cal.lut, None)?;
    let valid: usize = s.valid.iter().map(|&v| v as usize).sum();
    if (valid as f64) < s.valid.len() as f64 * 0.98 {
        return None;
    }
    let noise_variance = if cal.rms.is_finite() && cal.rms > 0.0 {
        ((cal.rms * cal.rms * white_norm2()) / 3.0).max(1e-6)
    } else {
        DEFAULT_NOISE_VARIANCE
    };
    Some(Observation {
        layout,
        feat: correct_features(&s, &cal.x),
        valid: s.valid,
        model: response_model(cal.sigma),
        centroids: centroids.to_vec(),
        noise_variance,
    })
}

/// Known structure: anchors light/dark, everything else background (zero).
fn base_source(layout: &GridLayout, centroids: &[f32]) -> SourceGrid {
    let n = layout.n;
    let mut src = new_source_grid(n);
    for c in 0..n * n {
        if layout.kind[c] == CellKind::Anchor as u8 && layout.anchor_light[c] != 0 {
            // PIC_WHITE never fails for an in-range cell.
            let _ = set_source(&mut src, c, PIC_WHITE, centroids);
        }
    }
    src
}

/// Sets cell c to the expected source of an unknown data cell.
fn set_mean_source(src: &mut SourceGrid, c: usize, mean_fill: f64, mean_color: &[f32; 3]) {
    let qo = c * 12;
    for (dst, &mc) in src.q[qo..qo + 12].iter_mut().zip(mean_color.iter().cycle()) {
        *dst = (mean_fill * mc as f64) as f32;
    }
    src.f[c * 3..c * 3 + 3].fill(0.0);
}

fn mean_of(centroids: &[f32]) -> [f32; 3] {
    let k = centroids.len() / 3;
    let mut m = [0f32; 3];
    for i in 0..k {
        for ch in 0..3 {
            m[ch] = (m[ch] as f64 + centroids[i * 3 + ch] as f64 / k as f64) as f32;
        }
    }
    m
}

/// Which header strip a candidate came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strip {
    Top,
    Bottom,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeaderCandidate {
    pub bytes: [u8; HEADER_BYTES],
    pub header: FrameHeader,
    pub strip: Strip,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StripDecisions {
    /// Hard bits per strip (top, bottom), strip bit order.
    pub bits: [Vec<u8>; 2],
    /// Per-bit reliability (distance of the matched-filter level from the threshold, in white-cell units).
    pub conf: [Vec<f32>; 2],
}

/// `Math.min(1, Math.max(0, v))`: NaN propagates.
#[inline]
fn clamp01_js(v: f64) -> f64 {
    if v.is_nan() { v } else { v.clamp(0.0, 1.0) }
}

/// Soft decision-feedback detection of both header strips (spec §7.6 step 3).
///
/// Every strip cell is a full black/white cell. The observation of cell c is predicted from all known sources
/// (anchors; filler bits; data cells at their expected mean) plus the current soft estimates of the other strip
/// cells; the residual is matched-filtered against the cell's own response and gives its level ℓ ∈ ≈[0, 1]. The
/// soft estimate fed back is a clipped ℓ (soft values stop a wrong early decision from propagating), and the
/// last pass makes the hard decisions. The two strips are detected jointly because they are far apart (no
/// interaction), which keeps one prediction per pass.
pub fn header_strip_decisions(obs: &Observation) -> StripDecisions {
    let layout = obs.layout;
    let n = layout.n;
    let mut src = base_source(layout, &obs.centroids);
    let mean_color = mean_of(&obs.centroids);
    let fill_mean = mean_fill(obs.centroids.len() / 3);
    for c in 0..n * n {
        if layout.kind[c] == CellKind::Data as u8 {
            set_mean_source(&mut src, c, fill_mean, &mean_color);
        }
    }
    let strips: [&[u32]; 2] = [&layout.header_top, &layout.header_bottom];
    let len = layout.header_top.len();
    let mut bits: [Vec<u8>; 2] = [vec![0u8; len], vec![0u8; len]];
    let mut conf: [Vec<f32>; 2] = [vec![0f32; len], vec![0f32; len]];
    let mut soft: [Vec<f32>; 2] = [vec![0.5f32; len], vec![0.5f32; len]];
    // Filler bits after the RS codeword are known.
    for sv in soft.iter_mut() {
        for (i, v) in sv.iter_mut().enumerate().skip(HEADER_BITS) {
            *v = (i & 1) as f32;
        }
    }
    let wf0 = obs.model.wf0;
    let we = &*WHITE_EXCESS;
    let w_norm: f64 = wf0.iter().fold(0.0, |a, &w| a + w * w);
    let white_norm2 = white_norm2();
    let set_level = |src: &mut SourceGrid, c: usize, level: f64| {
        for (dst, &w) in src.f[c * 3..c * 3 + 3].iter_mut().zip(we) {
            *dst = (level * w) as f32;
        }
    };
    for (si, cells) in strips.iter().enumerate() {
        for (i, &c) in cells.iter().enumerate() {
            set_level(&mut src, c as usize, soft[si][i] as f64);
        }
    }
    let mut pred = vec![0f32; n * n * 12];
    let feat = &obs.feat;
    for pass in 0..HEADER_PASSES {
        if predict_features_into(&obs.model, &src, &mut pred).is_err() {
            break;
        }
        let last = pass == HEADER_PASSES - 1;
        let mut new_soft: [Vec<f32>; 2] = [vec![0f32; len], vec![0f32; len]];
        for (si, cells) in strips.iter().enumerate() {
            let sv = &soft[si];
            let ns = &mut new_soft[si];
            for i in 0..len {
                if i >= HEADER_BITS {
                    ns[i] = (i & 1) as f32;
                    continue;
                }
                let c = cells[i] as usize;
                let own = sv[i] as f64;
                let mut acc = 0f64;
                for (q, &w) in wf0.iter().enumerate() {
                    let mut dot = 0f64;
                    let o = c * 12 + q * 3;
                    for ((&f, &p), &wch) in feat[o..o + 3].iter().zip(&pred[o..o + 3]).zip(we) {
                        let r = (f as f64 - p as f64) + w * own * wch;
                        dot += r * wch;
                    }
                    acc += w * dot;
                }
                let level = acc / (w_norm * white_norm2);
                ns[i] = clamp01_js(level) as f32;
                if last {
                    bits[si][i] = u8::from(level > 0.5);
                    conf[si][i] = (level - 0.5).abs() as f32;
                }
            }
        }
        if last {
            break;
        }
        // Sharpen the soft estimates progressively toward hard decisions.
        let gain = (1 + pass) as f64;
        for (si, cells) in strips.iter().enumerate() {
            let ns = &new_soft[si];
            let sv = &mut soft[si];
            for i in 0..len {
                let v = if i >= HEADER_BITS {
                    ns[i] as f64
                } else {
                    clamp01_js(0.5 + gain * (ns[i] as f64 - 0.5))
                };
                sv[i] = v as f32;
                set_level(&mut src, cells[i] as usize, v);
            }
        }
    }
    for b in bits.iter_mut() {
        for (i, v) in b.iter_mut().enumerate().skip(HEADER_BITS) {
            *v = (i & 1) as u8;
        }
    }
    for cf in conf.iter_mut() {
        for v in cf.iter_mut().skip(HEADER_BITS) {
            *v = f32::INFINITY;
        }
    }
    StripDecisions { bits, conf }
}

/// Decodes both header strips. Returns the distinct valid headers (top first).
pub fn decode_headers(obs: &Observation) -> Vec<HeaderCandidate> {
    let StripDecisions { bits, conf } = header_strip_decisions(obs);
    let mut out: Vec<HeaderCandidate> = Vec::with_capacity(2);
    for (si, strip) in [Strip::Top, Strip::Bottom].into_iter().enumerate() {
        let Some(b) = decode_header_strip(&bits[si], Some(&conf[si])) else {
            continue;
        };
        let Some(header) = parse_frame_header(&b) else {
            continue;
        };
        if out.iter().any(|o| o.bytes == b) {
            continue;
        }
        out.push(HeaderCandidate {
            bytes: b,
            header,
            strip,
        });
    }
    out
}

/// Sufficient statistics of one or more captures of the same frame (for temporal fusion).
#[derive(Clone, Debug, PartialEq)]
pub struct FusionStats {
    /// Σ Wᵀ r / σ² per used data cell (permutation order): `[p * 12 + q * 3 + ch]`.
    pub b: Vec<f32>,
    /// Σ WᵀW / σ² per edge class (EDGE_CLASSES² × 16).
    pub m: Vec<f64>,
    pub captures: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataDecodeResult {
    pub payload: Option<Vec<u8>>,
    pub stats: Option<FusionStats>,
    /// Fraction of codewords that decoded.
    pub codeword_fraction: f64,
}

impl DataDecodeResult {
    const FAILED: Self = Self {
        payload: None,
        stats: None,
        codeword_fraction: 0.0,
    };
}

/// Edge class index (cy · EDGE_CLASSES + cx) of every grid cell, built once per tier (a layout whose size
/// disagrees with its tier's is computed afresh).
fn cell_classes(layout: &GridLayout) -> Cow<'static, [u8]> {
    static CACHE: [OnceLock<Vec<u8>>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let n = layout.n;
    let build = || {
        let mut c = vec![0u8; n * n];
        for y in 0..n {
            for x in 0..n {
                c[y * n + x] = (edge_class(y, n) * EDGE_CLASSES + edge_class(x, n)) as u8;
            }
        }
        c
    };
    let cached = CACHE[layout.tier as usize - 1].get_or_init(build);
    if cached.len() == n * n {
        Cow::Borrowed(cached.as_slice())
    } else {
        Cow::Owned(build())
    }
}

/// Bits → whitened stream and per-byte confidence from per-cell margins (permutation order).
fn cells_to_stream_with_conf(
    layout: &GridLayout,
    sym: &[u8],
    margin: &[f32],
) -> (Vec<u8>, Vec<f32>) {
    let stream = cells_to_stream(sym, layout);
    let bpc = layout.bits_per_cell as usize;
    let conf: Vec<f32> = (0..layout.stream_bytes)
        .map(|j| {
            let [a, b] = cells_of_byte(j, bpc);
            js_min(
                margin.get(a).copied().unwrap_or(f32::NAN),
                margin.get(b).copied().unwrap_or(f32::NAN),
            )
        })
        .collect();
    (stream, conf)
}

fn known_margins(margin: &[f32], known: &[u8]) -> Vec<f32> {
    margin
        .iter()
        .zip(known)
        .map(|(&m, &k)| if k != 0 { f32::INFINITY } else { m })
        .collect()
}

fn cell_from_decoded_codewords(p: usize, layout: &GridLayout, ok: &[u8]) -> bool {
    let bpc = layout.bits_per_cell as usize;
    let first = (p * bpc) / 8;
    let last = (layout.stream_bytes - 1).min((p * bpc + bpc - 1) / 8);
    let c_n = layout.codewords;
    (first..=last).all(|j| ok[j % c_n] != 0)
}

/// Decodes the data region of a frame (data, descriptor or end) under `candidate.header`. `prior` holds
/// fusion statistics from earlier failed captures of the same frame.
pub fn decode_data(
    obs: &Observation,
    candidate: &HeaderCandidate,
    prior: Option<&FusionStats>,
) -> DataDecodeResult {
    let layout = obs.layout;
    let n = layout.n;
    let h = &candidate.header;
    let Some(tier) = GridTier::from_u8(h.tier) else {
        return DataDecodeResult::FAILED;
    };
    let id = FrameIdentity {
        stream_id: h.stream_id,
        tier,
        r#type: h.r#type,
        sbn: h.sbn,
        esi: h.esi,
    };
    let mask = frame_mask(layout, &id).mask;
    let used = layout.cells_used;
    let order = &layout.data_order;
    if obs.feat.len() != n * n * 12 || used > order.len() {
        return DataDecodeResult::FAILED;
    }

    // Known sources: anchors, both header strips (from the decoded header), padding pilots. Unknown cells are
    // zero.
    let mut src = base_source(layout, &obs.centroids);
    let Some(strip_bits_top) = strip_bits(layout, &candidate.bytes) else {
        return DataDecodeResult::FAILED;
    };
    for (i, &bit) in strip_bits_top.iter().enumerate() {
        let v = if bit != 0 { PIC_WHITE } else { PIC_BG };
        let _ = set_source(&mut src, layout.header_top[i] as usize, v, &obs.centroids);
        let _ = set_source(
            &mut src,
            layout.header_bottom[i] as usize,
            v,
            &obs.centroids,
        );
    }
    let pad = padding_cells(layout, &id);
    for (p, &cell) in order.iter().enumerate().skip(used) {
        if set_source(
            &mut src,
            cell as usize,
            pad[p - used] as i16,
            &obs.centroids,
        )
        .is_err()
        {
            return DataDecodeResult::FAILED;
        }
    }

    let grams = spread_grams(&obs.model, n);
    let s2 = obs.noise_variance;
    let mut known = vec![0u8; used];
    let mut sym = vec![0u8; used];
    let mut margin = vec![0f32; used];
    let mut last_stats: Option<FusionStats> = None;
    let mut ok_fraction = 0f64;
    let mut decoded: Option<DecodedCodewords> = None;
    let mut payload: Option<Vec<u8>> = None;
    let mut y = vec![0f32; n * n * 12];

    for round in 0..=TURBO_ROUNDS {
        let positions: Vec<usize> = (0..used).filter(|&p| known[p] == 0).collect();
        let cells: Vec<u32> = positions.iter().map(|&p| order[p]).collect();
        let Ok(pred) = predict_features(&obs.model, &src) else {
            return DataDecodeResult::FAILED;
        };
        for ((yv, &f), &p) in y.iter_mut().zip(&obs.feat).zip(&pred) {
            let v = f - p;
            *yv = if v.is_nan() { 0.0 } else { v };
        }
        let mut res: Option<StreamDecodeResult> = None;
        {
            let (sym_r, margin_r, known_r, decoded_r, res_r) =
                (&mut sym, &mut margin, &known, &decoded, &mut res);
            let mut try_decode = |a_sym: &[u8],
                                  a_margin: &[f32],
                                  max_failures: Option<usize>|
             -> Option<StreamDecodeResult> {
                for (i, &p) in positions.iter().enumerate() {
                    sym_r[p] = a_sym[i];
                    margin_r[p] = a_margin[i];
                }
                let (stream, conf) =
                    cells_to_stream_with_conf(layout, sym_r, &known_margins(margin_r, known_r));
                decode_stream(
                    layout,
                    &stream,
                    &mask,
                    &conf,
                    None,
                    decoded_r.as_ref(),
                    max_failures,
                )
            };
            let mut on_iteration = |r: usize, a_sym: &[u8], a_margin: &[f32]| -> bool {
                let last = r + 1 == VAMP_ITERATIONS;
                let Some(attempt) = try_decode(a_sym, a_margin, if last { None } else { Some(1) })
                else {
                    return false;
                };
                let decoded_now = attempt.payload.is_some();
                if decoded_now || last {
                    *res_r = Some(attempt);
                }
                decoded_now
            };
            let ep = vamp_detect(
                &VampProblem {
                    n,
                    model: &obs.model,
                    y: &y,
                    cells: &cells,
                    centroids: &obs.centroids,
                    noise_variance: s2,
                },
                &VampOptions {
                    iterations: VAMP_ITERATIONS,
                    damping: VAMP_DAMPING,
                },
                Some(&mut on_iteration),
            );
            if res_r.is_none() {
                let Some(ep) = ep else {
                    return DataDecodeResult::FAILED;
                };
                *res_r = try_decode(&ep.sym, &ep.margin, None);
            }
        }
        let Some(result) = res else {
            return DataDecodeResult::FAILED;
        };
        ok_fraction =
            result.ok.iter().map(|&v| v as u32).sum::<u32>() as f64 / layout.codewords as f64;
        if let Some(p) = result.payload {
            payload = Some(p);
            break;
        }

        // Fusion statistics (first round: every used cell is in the problem).
        if round == 0 {
            let stats = FusionStats {
                b: vec![0f32; used * 12],
                m: grams.iter().map(|&g| g / s2).collect(),
                captures: 1,
            };
            if let Some(prior) = prior
                && prior.b.len() == stats.b.len()
                && prior.m.len() == stats.m.len()
            {
                let fused = fuse_stats(prior, &stats);
                if let Some(out) = decode_from_stats(layout, &fused, &obs.centroids, &mask) {
                    return DataDecodeResult {
                        payload: Some(out),
                        stats: None,
                        codeword_fraction: 1.0,
                    };
                }
                last_stats = Some(fused);
            } else {
                last_stats = Some(stats);
            }
        }
        if ok_fraction == 0.0 || round == TURBO_ROUNDS {
            break;
        }
        // Turbo: cells whose bits come only from decoded codewords become known sources.
        let cells_now = stream_cells(layout, &result.stream);
        let mut gained = 0usize;
        for p in 0..used {
            if known[p] != 0 || !cell_from_decoded_codewords(p, layout, &result.ok) {
                continue;
            }
            known[p] = 1;
            sym[p] = cells_now[p];
            if set_source(&mut src, order[p] as usize, sym[p] as i16, &obs.centroids).is_err() {
                return DataDecodeResult::FAILED;
            }
            gained += 1;
        }
        decoded = Some(DecodedCodewords {
            ok: result.ok,
            stream: result.stream,
        });
        if gained == 0 {
            break;
        }
    }
    if let Some(payload) = payload {
        return DataDecodeResult {
            payload: Some(payload),
            stats: None,
            codeword_fraction: 1.0,
        };
    }
    DataDecodeResult {
        payload: None,
        stats: last_stats,
        codeword_fraction: ok_fraction,
    }
}

/// Adds the statistics of two capture sets (element-wise over the shorter of each pair of buffers).
pub fn fuse_stats(a: &FusionStats, b: &FusionStats) -> FusionStats {
    FusionStats {
        b: a.b.iter().zip(&b.b).map(|(&x, &y)| x + y).collect(),
        m: a.m.iter().zip(&b.m).map(|(&x, &y)| x + y).collect(),
        captures: a.captures.saturating_add(b.captures),
    }
}

/// Decodes a payload from (fused) sufficient statistics without interference re-estimation.
fn decode_from_stats(
    layout: &GridLayout,
    stats: &FusionStats,
    centroids: &[f32],
    mask: &[u8],
) -> Option<Vec<u8>> {
    let used = layout.cells_used;
    let classes = cell_classes(layout);
    let entry_classes: Vec<u8> = (0..used)
        .map(|p| classes[layout.data_order[p] as usize])
        .collect();
    let d = detect_from_stats(&stats.b, &stats.m, &entry_classes, centroids)?;
    let (stream, conf) = cells_to_stream_with_conf(layout, &d.sym, &d.margin);
    decode_stream(layout, &stream, mask, &conf, None, None, None)?.payload
}

/// CRC check of a decoded payload against its header.
pub fn payload_matches_header(candidate: &HeaderCandidate, payload: &[u8]) -> bool {
    header_crc_matches(&candidate.bytes, payload)
}
