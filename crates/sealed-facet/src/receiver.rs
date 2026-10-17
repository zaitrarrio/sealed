//! The grid receive path per camera frame (ADR-0023): the native half of `FacetReceiver` (`receiver.ts`,
//! `tryGrid` → `decodeGrid` → `calibrate`). Pixels in, header ∥ payload bytes out. RaptorQ, descriptors and
//! keys stay on the JavaScript side (`FacetReceiver.pushFrameBytes`).
//!
//! State carried between frames, as in the TypeScript: the stream id once locked, per-tier channel calibration
//! (from calibration frames; an anchor-only fallback before one is seen), the last tier decoded (header probe
//! order), and temporal fusion statistics of frames that did not decode, keyed by header, so repeated captures of
//! the same symbol add up.

use std::collections::HashMap;
use std::time::Instant;

use crate::calibrate::{
    ChannelCalibration, DEFAULT_SIGMA, anchor_calibration, default_calibration, fit_channel,
};
use crate::decode::{
    FusionStats, HeaderCandidate, decode_data, decode_headers, fuse_stats, observe,
};
use crate::detect::{GridDetector, grid_homography, grid_sizes_for, pixels_per_cell};
use crate::grid::calibration_picture;
use crate::header::{FrameHeader, HEADER_BYTES, header_crc_matches};
use crate::layout::{grid_layout, grid_tier_for_size};
use crate::palette::palette_excess;
use crate::refine::{anchor_points, refine_homography};
use crate::types::{FrameType, GridTier, Homography, RgbaImage};

const MAX_FUSION: usize = 48;
const MAX_CAL_RMS: f64 = 0.12;
const MAX_REFINE_RMS: f64 = 0.45;

struct Calibration {
    channel: ChannelCalibration,
    centroids: Vec<f32>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct FusionKey {
    tier: u8,
    r#type: FrameType,
    sbn: u8,
    esi: u32,
    stream_id: [u8; 4],
}

impl FusionKey {
    fn of(h: &FrameHeader) -> Self {
        Self {
            tier: h.tier,
            r#type: h.r#type,
            sbn: h.sbn,
            esi: h.esi,
            stream_id: h.stream_id,
        }
    }
}

/// Wall time per receiver stage of the last `push_timed`, in milliseconds (profiling aid; not part of the ABI).
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StageTimes {
    pub detect: f64,
    pub refine: f64,
    pub observe: f64,
    pub headers: f64,
    pub data: f64,
    pub calibrate: f64,
}

/// A stage clock: `None` when timing is off (or on wasm32, where `Instant::now` is unavailable).
fn clock(enabled: bool) -> Option<Instant> {
    if enabled && cfg!(not(target_arch = "wasm32")) {
        Some(Instant::now())
    } else {
        None
    }
}

fn lap(start: Option<Instant>, slot: Option<&mut f64>) {
    if let (Some(t), Some(s)) = (start, slot) {
        *s += t.elapsed().as_secs_f64() * 1e3;
    }
}

pub struct GridDecoder {
    allowed: u8,
    timing: Option<StageTimes>,
    detector: GridDetector,
    stream_id: Option<[u8; 4]>,
    calibration: HashMap<GridTier, Calibration>,
    last_tier: Option<GridTier>,
    fusion: Vec<(FusionKey, FusionStats)>,
    frames: Vec<Vec<u8>>,
    last_pixels_per_cell: f64,
}

impl GridDecoder {
    /// `tiers_mask` has bit t set for each allowed grid tier (1..=3); none set → `None`.
    pub fn new(tiers_mask: u8) -> Option<Self> {
        let allowed = tiers_mask & 0b1110;
        if allowed == 0 {
            return None;
        }
        Some(Self {
            allowed,
            timing: None,
            detector: GridDetector::new(),
            stream_id: None,
            calibration: HashMap::new(),
            last_tier: None,
            fusion: Vec::new(),
            frames: Vec::new(),
            last_pixels_per_cell: 0.0,
        })
    }

    fn allows(&self, t: GridTier) -> bool {
        self.allowed & (1 << t as u8) != 0
    }

    /// Frames decoded by the last `push`: header ∥ payload (payload empty for a calibration frame).
    pub fn frames(&self) -> &[Vec<u8>] {
        &self.frames
    }

    pub fn pixels_per_cell(&self) -> f32 {
        self.last_pixels_per_cell as f32
    }

    /// Decodes one camera frame. Returns the frames found (also kept in `frames()` until the next push).
    pub fn push(&mut self, img: &RgbaImage<'_>) -> &[Vec<u8>] {
        self.timing = None;
        self.push_inner(img);
        &self.frames
    }

    /// `push` with wall time per stage (profiling aid for the tests; zero on wasm32).
    #[doc(hidden)]
    pub fn push_timed(&mut self, img: &RgbaImage<'_>) -> (&[Vec<u8>], StageTimes) {
        self.timing = Some(StageTimes::default());
        self.push_inner(img);
        let t = self.timing.take().unwrap_or_default();
        (&self.frames, t)
    }

    fn timed(&self) -> bool {
        self.timing.is_some()
    }

    fn push_inner(&mut self, img: &RgbaImage<'_>) {
        self.frames.clear();
        let t = clock(self.timed());
        let sets = self.detector.detect(img);
        lap(t, self.timing.as_mut().map(|s| &mut s.detect));
        let Some(luma) = self.detector.luma.take() else {
            return;
        };
        'sets: for set in &sets {
            for n in grid_sizes_for(set) {
                let tiers: Vec<GridTier> = grid_tier_for_size(n)
                    .into_iter()
                    .filter(|&t| self.allows(t))
                    .collect();
                if tiers.is_empty() {
                    continue;
                }
                let t = clock(self.timed());
                let Some(coarse) = grid_homography(set, n, &luma) else {
                    continue;
                };
                let h = self.refine(&luma, &coarse, &tiers);
                lap(t, self.timing.as_mut().map(|s| &mut s.refine));
                if self.decode_grid(img, &h, n, &tiers) {
                    self.last_pixels_per_cell = pixels_per_cell(&h, n);
                    break 'sets;
                }
            }
        }
        self.detector.luma = Some(luma);
    }

    fn refine(
        &self,
        luma: &crate::types::LumaPlane,
        coarse: &Homography,
        tiers: &[GridTier],
    ) -> Homography {
        let tier = tiers
            .iter()
            .copied()
            .find(|t| self.calibration.contains_key(t))
            .unwrap_or(tiers[0]);
        let sigma = self
            .calibration
            .get(&tier)
            .map_or(DEFAULT_SIGMA, |c| c.channel.sigma);
        let pts = anchor_points(grid_layout(tier), sigma);
        match refine_homography(luma, coarse, &pts) {
            Some(r) if r.rms < MAX_REFINE_RMS => r.h,
            _ => *coarse,
        }
    }

    fn calib_for(
        &self,
        tier: GridTier,
        img: &RgbaImage<'_>,
        h: &Homography,
    ) -> Option<Calibration> {
        if let Some(c) = self.calibration.get(&tier) {
            return Some(Calibration {
                channel: c.channel.clone(),
                centroids: c.centroids.clone(),
            });
        }
        let layout = grid_layout(tier);
        let fallback = anchor_calibration(img, h, layout, &default_calibration())?;
        Some(Calibration {
            channel: fallback,
            centroids: palette_excess(tier as u8),
        })
    }

    fn stream_matches(&self, h: &FrameHeader) -> bool {
        self.stream_id.is_none_or(|id| id == h.stream_id)
    }

    fn decode_grid(
        &mut self,
        img: &RgbaImage<'_>,
        h: &Homography,
        n: usize,
        tiers: &[GridTier],
    ) -> bool {
        // Header strips are identical for all tiers of the same grid size; decode them with the first tier's layout.
        let probe_tier = match self.last_tier {
            Some(t) if tiers.contains(&t) => t,
            _ => tiers[0],
        };
        let t = clock(self.timed());
        let Some(probe_cal) = self.calib_for(probe_tier, img, h) else {
            return false;
        };
        let Some(probe) = observe(
            img,
            h,
            grid_layout(probe_tier),
            &probe_cal.channel,
            &probe_cal.centroids,
        ) else {
            return false;
        };
        lap(t, self.timing.as_mut().map(|s| &mut s.observe));
        let t = clock(self.timed());
        let candidates: Vec<HeaderCandidate> = decode_headers(&probe)
            .into_iter()
            .filter(|c| {
                GridTier::from_u8(c.header.tier).is_some_and(|t| tiers.contains(&t))
                    && self.stream_matches(&c.header)
            })
            .collect();
        lap(t, self.timing.as_mut().map(|s| &mut s.headers));
        for cand in candidates {
            let Some(tier) = GridTier::from_u8(cand.header.tier) else {
                continue;
            };
            let layout = grid_layout(tier);
            if layout.n != n {
                continue;
            }
            if cand.header.r#type == FrameType::Calibration {
                let t = clock(self.timed());
                let ok = self.calibrate(img, h, tier, &cand);
                lap(t, self.timing.as_mut().map(|s| &mut s.calibrate));
                if ok {
                    return true;
                }
                continue;
            }
            let (obs, owned);
            if tier == probe_tier {
                obs = &probe;
            } else {
                let t = clock(self.timed());
                let Some(cal) = self.calib_for(tier, img, h) else {
                    continue;
                };
                let Some(o) = observe(img, h, layout, &cal.channel, &cal.centroids) else {
                    continue;
                };
                lap(t, self.timing.as_mut().map(|s| &mut s.observe));
                owned = o;
                obs = &owned;
            }
            let key = FusionKey::of(&cand.header);
            let prior = self.fusion.iter().position(|(k, _)| *k == key);
            let t = clock(self.timed());
            let res = decode_data(obs, &cand, prior.map(|i| &self.fusion[i].1));
            lap(t, self.timing.as_mut().map(|s| &mut s.data));
            if let Some(payload) = res.payload.filter(|p| header_crc_matches(&cand.bytes, p)) {
                if let Some(i) = prior {
                    self.fusion.remove(i);
                }
                self.last_tier = Some(tier);
                if self.stream_matches(&cand.header) {
                    self.lock_stream(cand.header.stream_id);
                    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
                    out.extend_from_slice(&cand.bytes);
                    out.extend_from_slice(&payload);
                    self.frames.push(out);
                    return true;
                }
                continue;
            }
            if let Some(stats) = res.stats {
                // decode_data already folded the prior into `stats`.
                if let Some(i) = prior {
                    self.fusion.remove(i);
                }
                self.fusion.push((key, stats));
                if self.fusion.len() > MAX_FUSION {
                    self.fusion.remove(0);
                }
            }
        }
        false
    }

    fn calibrate(
        &mut self,
        img: &RgbaImage<'_>,
        h: &Homography,
        tier: GridTier,
        cand: &HeaderCandidate,
    ) -> bool {
        // The calibration frame's header CRC covers an empty payload; the header RS decode already verified it.
        if !header_crc_matches(&cand.bytes, &[]) {
            return false;
        }
        let layout = grid_layout(tier);
        let Some(pic) = calibration_picture(layout, &cand.bytes) else {
            return false;
        };
        let default = default_calibration();
        let default_centroids = palette_excess(tier as u8);
        let (prev_channel, prev_centroids) = match self.calibration.get(&tier) {
            Some(c) => (&c.channel, c.centroids.as_slice()),
            None => (&default, default_centroids.as_slice()),
        };
        let Some(fit) = fit_channel(img, h, layout, &pic, prev_channel, prev_centroids, true)
        else {
            return false;
        };
        // NaN rms rejects, as the TypeScript `!(rms < MAX)` does.
        if fit.channel.rms.partial_cmp(&MAX_CAL_RMS) != Some(std::cmp::Ordering::Less) {
            return false;
        }
        self.calibration.insert(
            tier,
            Calibration {
                channel: fit.channel,
                centroids: fit.centroids,
            },
        );
        self.lock_stream(cand.header.stream_id);
        self.last_tier = Some(tier);
        self.frames.push(cand.bytes.to_vec());
        true
    }

    fn lock_stream(&mut self, id: [u8; 4]) {
        if self.stream_id.is_none() {
            self.stream_id = Some(id);
        }
    }
}

/// Keeps `fuse_stats` reachable for hosts that merge statistics across decoders (parity with the TypeScript API).
pub fn merge_fusion(a: &FusionStats, b: &FusionStats) -> FusionStats {
    fuse_stats(a, b)
}
