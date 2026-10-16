/**
 * FacetReceiver: consumes camera frames, decodes T0 (QR) and T1–T3 (grid) frames, and reconstructs the Envelope
 * with RaptorQ (spec §7.6).
 *
 * Stream handling: the receiver locks onto `expectedStreamId` or, failing that, the first stream_id of a frame
 * whose header CRC verifies against its payload. One stream may carry several tier sub-streams (Broadcast
 * interleave): each has its own descriptor and RaptorQ decoder, and the first to complete wins. Data symbols that
 * arrive before their tier's descriptor are buffered (bounded) and replayed once the OTI is known.
 *
 * Calibration is tracked per tier. Until a calibration frame has been seen, frames are decoded with a per-frame
 * fallback calibration from the anchors (sRGB tone curve, diagonal gain/offset).
 */
import { RaptorQDecoder, decodeOti } from "../fec/index";
import { ctEqual } from "../bytes";
import type { CapabilityMeasurement, ReceiveProgress, RgbaImage, StreamDescriptor, Tier } from "./types";
import { TIERS, isT0SymbolSize, type GridTier } from "./tiers";
import { LossEstimator } from "./backchannel";
import { GridDetector, gridHomography, gridSizesFor, pixelsPerCell, type LumaPlane } from "./detect";
import { anchorPoints, refineHomography } from "./refine";
import { gridLayout, gridTierForSize } from "./layout";
import { calibrationPicture } from "./grid";
import { anchorCalibration, defaultCalibration, fitChannel, DEFAULT_SIGMA, type ChannelCalibration } from "./calibrate";
import { decodeData, decodeHeaders, observe, type FusionStats, type HeaderCandidate } from "./decode";
import { decodeDescriptorPayload } from "./descriptor";
import { HEADER_BYTES, headerCrcMatches, parseFrameHeader, type FrameHeader } from "./header";
import { qrFrameBytes, readQr } from "./qr";
import { paletteExcess } from "./palette";
import type { Homography } from "./homography";

export interface FacetReceiverOptions {
  expectedStreamId?: Uint8Array;
  /** Tiers this receiver decodes (default all). A T0-only receiver models a plain QR scanner. */
  tiers?: readonly Tier[];
}

interface TierState {
  descriptor: StreamDescriptor | null;
  decoder: RaptorQDecoder | null;
  /** Symbol size of this stream (from its descriptor's OTI). */
  symbolSize: number | null;
  pending: { sbn: number; esi: number; symbol: Uint8Array }[];
  seen: Set<string>;
}

interface Calib {
  channel: ChannelCalibration;
  centroids: Float32Array;
}

const MAX_PENDING = 512;
const MAX_FUSION = 48;
const MAX_CAL_RMS = 0.12;
/** Registration fits worse than this (relative luma RMS) are discarded in favor of the detector's estimate. */
const MAX_REFINE_RMS = 0.45;

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}

function emptyProgress(): ReceiveProgress {
  return {
    streamId: null,
    tier: null,
    framesSeen: 0,
    framesDecoded: 0,
    symbolsReceived: 0,
    symbolsNeeded: 0,
    blocksComplete: 0,
    blockCount: 0,
    fraction: 0,
    symbolSize: null,
    recentLoss: null,
    calibrated: false,
    complete: false,
  };
}

export class FacetReceiver {
  private streamId: Uint8Array | null;
  private readonly allowed: Set<Tier>;
  private readonly detector = new GridDetector();
  private readonly tiers = new Map<Tier, TierState>();
  private readonly calibration = new Map<GridTier, Calib>();
  private readonly fusion = new Map<string, FusionStats>();
  private completedTier: Tier | null = null;
  private resultBytes: Uint8Array | null = null;
  private framesSeen = 0;
  private framesDecoded = 0;
  private timestamps: number[] = [];
  private decodeMs: number[] = [];
  private lastPixelsPerCell = NaN;
  private lastTier: Tier | null = null;
  private _progress: ReceiveProgress = emptyProgress();
  private readonly lossEstimator = new LossEstimator();

  constructor(opts: FacetReceiverOptions = {}) {
    if (opts.expectedStreamId && opts.expectedStreamId.length !== 4) throw new RangeError("expectedStreamId must be 4 bytes");
    this.streamId = opts.expectedStreamId ? opts.expectedStreamId.slice() : null;
    this.allowed = new Set(opts.tiers ?? [0, 1, 2, 3]);
  }

  get progress(): ReceiveProgress {
    return this._progress;
  }

  /** Descriptor of the completed tier stream, else the most advanced one seen so far. */
  get descriptor(): StreamDescriptor | null {
    if (this.completedTier !== null) return this.tiers.get(this.completedTier)?.descriptor ?? null;
    let best: StreamDescriptor | null = null;
    let bestFraction = -1;
    for (const [, st] of this.tiers) {
      if (!st.descriptor) continue;
      const f = st.decoder ? fractionOf(st.decoder) : 0;
      if (f > bestFraction) {
        bestFraction = f;
        best = st.descriptor;
      }
    }
    return best;
  }

  /** Descriptor of a specific tier sub-stream, if seen. */
  descriptorFor(tier: Tier): StreamDescriptor | null {
    return this.tiers.get(tier)?.descriptor ?? null;
  }

  result(): Uint8Array | null {
    return this.resultBytes ? this.resultBytes.slice() : null;
  }

  measure(): CapabilityMeasurement {
    let fps = 0;
    if (this.timestamps.length >= 2) {
      const d: number[] = [];
      for (let i = 1; i < this.timestamps.length; i++) {
        const dt = (this.timestamps[i] as number) - (this.timestamps[i - 1] as number);
        if (dt > 0) d.push(dt);
      }
      if (d.length) {
        d.sort((a, b) => a - b);
        fps = 1000 / (d[d.length >> 1] as number);
      }
    }
    const ms = this.decodeMs.length ? this.decodeMs.reduce((a, b) => a + b, 0) / this.decodeMs.length : NaN;
    return { captureFps: fps, pixelsPerCell: this.lastPixelsPerCell, decodeMsPerFrame: ms };
  }

  push(image: RgbaImage, timestampMs?: number): ReceiveProgress {
    this.framesSeen++;
    if (timestampMs !== undefined && Number.isFinite(timestampMs)) {
      this.timestamps.push(timestampMs);
      if (this.timestamps.length > 120) this.timestamps.shift();
    }
    if (this.resultBytes) return this.updateProgress();
    try {
      if (isImage(image)) {
        let handled = false;
        if (this.allowed.has(1) || this.allowed.has(2) || this.allowed.has(3)) {
          const t0 = now();
          handled = this.tryGrid(image);
          if (handled) {
            this.decodeMs.push(now() - t0);
            if (this.decodeMs.length > 120) this.decodeMs.shift();
          }
        }
        if (!handled && this.allowed.has(0)) this.tryQr(image);
      }
    } catch {
      // Malformed or adversarial frames must never break the capture loop.
    }
    return this.updateProgress();
  }

  /**
   * Feeds one QR code read by an external detector (a phone's system QR scanner, the web BarcodeDetector): its
   * text, or its bytes when the detector exposes them. Use this instead of `push` when the platform finds codes
   * itself — it is far faster than decoding camera frames here and needs no alignment. Non-Sealed codes and
   * codes from other streams are ignored. Never throws.
   */
  pushQrCode(content: string | Uint8Array, timestampMs?: number): ReceiveProgress {
    this.framesSeen++;
    if (timestampMs !== undefined && Number.isFinite(timestampMs)) {
      this.timestamps.push(timestampMs);
      if (this.timestamps.length > 120) this.timestamps.shift();
    }
    if (this.resultBytes || !this.allowed.has(0)) return this.updateProgress();
    try {
      const bytes = qrFrameBytes(content);
      if (bytes) this.acceptT0(bytes);
    } catch {
      // Malformed or adversarial codes must never break the capture loop.
    }
    return this.updateProgress();
  }

  // ---------------------------------------------------------------- T0

  private tryQr(image: RgbaImage): boolean {
    const bytes = readQr(image);
    return bytes ? this.acceptT0(bytes) : false;
  }

  private acceptT0(bytes: Uint8Array): boolean {
    if (bytes.length < HEADER_BYTES + 2) return false;
    const header = bytes.subarray(0, HEADER_BYTES);
    const payload = bytes.subarray(HEADER_BYTES);
    const h = parseFrameHeader(header);
    if (!h || h.tier !== 0 || !isT0SymbolSize(payload.length)) return false;
    if (!headerCrcMatches(header, payload)) return false;
    return this.accept(h, payload);
  }

  // ---------------------------------------------------------------- grid

  private tryGrid(image: RgbaImage): boolean {
    const sets = this.detector.detect(image);
    const luma = this.detector.luma;
    if (!luma) return false;
    for (const set of sets) {
      for (const n of gridSizesFor(set)) {
        const tiers = gridTierForSize(n).filter((t) => this.allowed.has(t));
        if (tiers.length === 0) continue;
        const coarse = gridHomography(set, n, luma);
        if (!coarse) continue;
        const h = this.refine(luma, coarse, tiers);
        if (this.decodeGrid(image, h, n, tiers)) {
          this.lastPixelsPerCell = pixelsPerCell(h, n);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Sub-cell registration: aligns the anchors' known structure to the luma with the current blur estimate. The
   * detector's anchor centers are good to ≈ 0.1–0.2 cell; glyph quadrants need a few hundredths.
   */
  private refine(luma: LumaPlane, coarse: Homography, tiers: GridTier[]): Homography {
    const tier = tiers.find((t) => this.calibration.has(t)) ?? (tiers[0] as GridTier);
    const sigma = this.calibration.get(tier)?.channel.sigma ?? DEFAULT_SIGMA;
    const r = refineHomography(luma, coarse, anchorPoints(gridLayout(tier), sigma));
    return r && r.rms < MAX_REFINE_RMS ? r.h : coarse;
  }

  private calibFor(tier: GridTier, image: RgbaImage, h: Homography): Calib | null {
    const c = this.calibration.get(tier);
    if (c) return c;
    const layout = gridLayout(tier);
    const fallback = anchorCalibration(image, h, layout, defaultCalibration());
    if (!fallback) return null;
    return { channel: fallback, centroids: paletteExcess(tier) };
  }

  private decodeGrid(image: RgbaImage, h: Homography, n: number, tiers: GridTier[]): boolean {
    // Header strips are identical for all tiers of the same grid size; decode them with the first tier's layout.
    const probeTier = this.lastTier !== null && tiers.includes(this.lastTier as GridTier) ? (this.lastTier as GridTier) : (tiers[0] as GridTier);
    const probeCal = this.calibFor(probeTier, image, h);
    if (!probeCal) return false;
    const probe = observe(image, h, gridLayout(probeTier), probeCal.channel, probeCal.centroids);
    if (!probe) return false;
    const candidates = decodeHeaders(probe).filter((c) => tiers.includes(c.header.tier as GridTier) && this.streamMatches(c.header));
    for (const cand of candidates) {
      const tier = cand.header.tier as GridTier;
      const layout = gridLayout(tier);
      if (layout.n !== n) continue;
      if (cand.header.type === "calibration") {
        if (this.calibrate(image, h, tier, cand)) return true;
        continue;
      }
      // Skip the expensive data decode when its result would be discarded: a data symbol already held, a block
      // already recovered, or a descriptor/end frame whose descriptor is known.
      const st = this.tiers.get(tier);
      if (st && this.alreadyHave(st, cand.header)) {
        this.lastTier = tier;
        this.framesDecoded++;
        return true;
      }
      const cal = this.calibFor(tier, image, h);
      if (!cal) continue;
      const obs = tier === probeTier && cal === probeCal ? probe : observe(image, h, layout, cal.channel, cal.centroids);
      if (!obs) continue;
      const key = fusionKey(cand.header);
      const prior = this.fusion.get(key) ?? null;
      const res = decodeData(obs, cand, prior);
      if (res.payload && headerCrcMatches(cand.bytes, res.payload)) {
        this.fusion.delete(key);
        this.lastTier = tier;
        if (this.accept(cand.header, res.payload)) return true;
        continue;
      }
      if (res.stats) {
        // decodeData already folded `prior` into res.stats.
        this.fusion.delete(key);
        this.fusion.set(key, res.stats);
        if (this.fusion.size > MAX_FUSION) {
          const oldest = this.fusion.keys().next().value;
          if (oldest !== undefined) this.fusion.delete(oldest);
        }
      }
    }
    return false;
  }

  /** True when decoding the data region of a frame with this header cannot add anything. */
  private alreadyHave(st: TierState, h: FrameHeader): boolean {
    if (h.type === "descriptor" || h.type === "end") return st.descriptor !== null;
    if (h.type !== "data") return false;
    if (st.seen.has(`${h.sbn}/${h.esi}`)) return true;
    const dec = st.decoder;
    return dec !== null && h.sbn < dec.blockCount && dec.isBlockComplete(h.sbn);
  }

  private calibrate(image: RgbaImage, h: Homography, tier: GridTier, cand: HeaderCandidate): boolean {
    // The calibration frame's header CRC covers an empty payload; the header RS decode already verified it.
    if (!headerCrcMatches(cand.bytes, new Uint8Array(0))) return false;
    const layout = gridLayout(tier);
    const prev = this.calibration.get(tier);
    const pic = calibrationPicture(layout, cand.bytes);
    const fit = fitChannel(image, h, layout, pic, prev?.channel ?? defaultCalibration(), prev?.centroids ?? paletteExcess(tier), true);
    if (!fit || !(fit.channel.rms < MAX_CAL_RMS)) return false;
    this.calibration.set(tier, { channel: fit.channel, centroids: fit.centroids });
    this.lockStream(cand.header.streamId);
    this.lastTier = tier;
    this.framesDecoded++;
    return true;
  }

  // ---------------------------------------------------------------- stream state

  private streamMatches(h: FrameHeader): boolean {
    return this.streamId === null || ctEqual(this.streamId, h.streamId);
  }

  private lockStream(id: Uint8Array): void {
    if (this.streamId === null) this.streamId = id.slice();
  }

  private tierState(tier: Tier): TierState {
    let st = this.tiers.get(tier);
    if (!st) {
      st = { descriptor: null, decoder: null, symbolSize: null, pending: [], seen: new Set() };
      this.tiers.set(tier, st);
    }
    return st;
  }

  /** Accepts a CRC-verified frame payload. */
  private accept(h: FrameHeader, payload: Uint8Array): boolean {
    if (!this.streamMatches(h)) return false;
    if (h.type === "calibration") return false;
    this.lockStream(h.streamId);
    const st = this.tierState(h.tier);
    // A data frame whose size disagrees with this stream's descriptor is not part of it.
    if (h.type === "data" && st.symbolSize !== null && payload.length !== st.symbolSize) return false;
    this.framesDecoded++;
    if (h.type === "descriptor" || h.type === "end") {
      if (st.descriptor) return true;
      const d = decodeDescriptorPayload(payload);
      if (!d || !ctEqual(d.streamId, h.streamId) || d.tier !== h.tier) return false;
      const oti = decodeOti(d.oti);
      // Grid tiers have a fixed symbol size; a T0 stream names its own (QR_PROFILES), and the descriptor frame
      // itself is padded to exactly that size.
      const sizeOk = h.tier === 0 ? isT0SymbolSize(oti.symbolSize) && payload.length === oti.symbolSize : oti.symbolSize === TIERS[h.tier].symbolSize;
      if (!sizeOk) return false;
      st.descriptor = d;
      st.decoder = new RaptorQDecoder(oti);
      st.symbolSize = oti.symbolSize;
      const pend = st.pending;
      st.pending = [];
      for (const p of pend) if (p.symbol.length === oti.symbolSize) this.addSymbol(h.tier, st, p.sbn, p.esi, p.symbol);
      return true;
    }
    // data
    const key = `${h.sbn}/${h.esi}`;
    if (st.seen.has(key)) return true;
    this.lossEstimator.accept(h.sbn, h.esi);
    if (!st.decoder) {
      if (st.pending.length < MAX_PENDING) {
        st.pending.push({ sbn: h.sbn, esi: h.esi, symbol: payload.slice() });
        st.seen.add(key);
      }
      return true;
    }
    this.addSymbol(h.tier, st, h.sbn, h.esi, payload);
    return true;
  }

  private addSymbol(tier: Tier, st: TierState, sbn: number, esi: number, symbol: Uint8Array): void {
    const dec = st.decoder;
    if (!dec) return;
    st.seen.add(`${sbn}/${esi}`);
    if (sbn >= dec.blockCount) return;
    dec.add(sbn, esi, symbol);
    if (dec.isComplete() && !this.resultBytes) {
      this.resultBytes = dec.result();
      this.completedTier = tier;
    }
  }

  private updateProgress(): ReceiveProgress {
    let best: { tier: Tier; dec: RaptorQDecoder } | null = null;
    let bestF = -1;
    for (const [tier, st] of this.tiers) {
      if (!st.decoder) continue;
      const f = fractionOf(st.decoder);
      if (this.completedTier === tier || f > bestF) {
        best = { tier, dec: st.decoder };
        bestF = this.completedTier === tier ? 2 : f;
      }
    }
    const p = emptyProgress();
    p.streamId = this.streamId ? this.streamId.slice() : null;
    p.framesSeen = this.framesSeen;
    p.framesDecoded = this.framesDecoded;
    p.recentLoss = this.lossEstimator.loss;
    p.calibrated = this.calibration.size > 0;
    if (best) {
      const dec = best.dec;
      p.tier = best.tier;
      p.symbolSize = this.tiers.get(best.tier)?.symbolSize ?? null;
      p.blockCount = dec.blockCount;
      for (let b = 0; b < dec.blockCount; b++) {
        const k = dec.sourceSymbolCount(b);
        p.symbolsNeeded += k;
        if (dec.isBlockComplete(b)) {
          p.blocksComplete++;
          p.symbolsReceived += k;
        } else {
          p.symbolsReceived += Math.min(k, dec.receivedCount(b));
        }
      }
      p.fraction = this.resultBytes ? 1 : p.symbolsNeeded ? Math.min(0.99, p.symbolsReceived / p.symbolsNeeded) : 0;
    } else {
      for (const [tier, st] of this.tiers) {
        if (st.pending.length > 0 && p.tier === null) p.tier = tier;
      }
    }
    p.complete = this.resultBytes !== null;
    this._progress = p;
    return p;
  }
}

function fractionOf(dec: RaptorQDecoder): number {
  let need = 0;
  let have = 0;
  for (let b = 0; b < dec.blockCount; b++) {
    const k = dec.sourceSymbolCount(b);
    need += k;
    have += dec.isBlockComplete(b) ? k : Math.min(k, dec.receivedCount(b));
  }
  return need ? have / need : 0;
}

function fusionKey(h: FrameHeader): string {
  return `${h.tier}/${h.type}/${h.sbn}/${h.esi}/${Array.from(h.streamId).join(".")}`;
}

function isImage(img: RgbaImage): boolean {
  return (
    img !== null &&
    typeof img === "object" &&
    Number.isInteger(img.width) &&
    Number.isInteger(img.height) &&
    img.width > 0 &&
    img.height > 0 &&
    img.width * img.height <= 64_000_000 &&
    (img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) &&
    img.data.length >= img.width * img.height * 4
  );
}
