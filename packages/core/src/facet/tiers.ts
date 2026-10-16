/**
 * Facet tier table (spec §7.2, §7.3, §7.7; ADR-0008, ADR-0010).
 *
 * Every number here is part of the wire contract for codec version 1: grid size, bits per cell, symbol size T
 * and the RS(255,207) codeword count per frame must agree between sender and receiver.
 */
import { planOti, type Oti } from "../fec/index";
import type { CapabilityMeasurement, Tier } from "./types";

export interface TierSpec {
  readonly tier: Tier;
  /** Grid side N in cells (0 for T0, which is a QR code). */
  readonly grid: number;
  /** Total bits per data cell: color bits (most significant) + 4 shape bits. 0 for T0. */
  readonly bitsPerCell: number;
  /** Palette size (4 or 8; 0 for T0). */
  readonly colors: number;
  /** Nominal data frames per second at 60 Hz. */
  readonly dataFps: number;
  /** Display refreshes (60 Hz) each frame is held for; double on 120 Hz displays. */
  readonly holdRefreshes60: number;
  /** RaptorQ symbol size T in bytes: the payload of one data frame. */
  readonly symbolSize: number;
  /** Inner Reed-Solomon code length n (0 for T0, where QR's own EC applies). */
  readonly rsN: number;
  /** Inner Reed-Solomon code dimension k. */
  readonly rsK: number;
  /** RS codewords per frame. */
  readonly codewords: number;
  /**
   * Largest RaptorQ source block (K) the sender plans. Spec §7.5 allows up to 8 segments per block; Facet caps K
   * so a block decodes in about a second on a phone CPU (RaptorQ decoding is roughly cubic in K).
   */
  readonly maxSourceSymbolsPerBlock: number;
}

export const TIERS: Record<Tier, TierSpec> = {
  0: { tier: 0, grid: 0, bitsPerCell: 0, colors: 0, dataFps: 10, holdRefreshes60: 6, symbolSize: 840, rsN: 0, rsK: 0, codewords: 0, maxSourceSymbolsPerBlock: 256 },
  1: { tier: 1, grid: 112, bitsPerCell: 6, colors: 4, dataFps: 10, holdRefreshes60: 6, symbolSize: 7240, rsN: 255, rsK: 207, codewords: 35, maxSourceSymbolsPerBlock: 256 },
  2: { tier: 2, grid: 112, bitsPerCell: 7, colors: 8, dataFps: 15, holdRefreshes60: 4, symbolSize: 8280, rsN: 255, rsK: 207, codewords: 40, maxSourceSymbolsPerBlock: 256 },
  3: { tier: 3, grid: 144, bitsPerCell: 7, colors: 8, dataFps: 20, holdRefreshes60: 3, symbolSize: 14072, rsN: 255, rsK: 207, codewords: 68, maxSourceSymbolsPerBlock: 192 },
};

export type GridTier = 1 | 2 | 3;

export function isTier(v: number): v is Tier {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/** Receiver requirements per tier (spec §7.7). */
export interface TierRequirement {
  readonly minCaptureFps: number;
  readonly minPixelsPerCell: number;
  readonly maxDecodeMsPerFrame: number;
}

export const TIER_REQUIREMENTS: Record<GridTier, TierRequirement> = {
  1: { minCaptureFps: 24, minPixelsPerCell: 4.0, maxDecodeMsPerFrame: 90 },
  2: { minCaptureFps: 50, minPixelsPerCell: 4.5, maxDecodeMsPerFrame: 60 },
  3: { minCaptureFps: 110, minPixelsPerCell: 5.0, maxDecodeMsPerFrame: 45 },
};

/** Highest tier whose requirements the measurement meets; T0 when none (spec §7.7). */
export function chooseTier(m: CapabilityMeasurement): Tier {
  for (const t of [3, 2, 1] as const) {
    const r = TIER_REQUIREMENTS[t];
    if (
      Number.isFinite(m.captureFps) &&
      Number.isFinite(m.pixelsPerCell) &&
      Number.isFinite(m.decodeMsPerFrame) &&
      m.captureFps >= r.minCaptureFps &&
      m.pixelsPerCell >= r.minPixelsPerCell &&
      m.decodeMsPerFrame >= 0 &&
      m.decodeMsPerFrame <= r.maxDecodeMsPerFrame
    ) {
      return t;
    }
  }
  return 0;
}

/**
 * QR sizes for T0 streams (ADR-0019). Each frame is one QR code, error correction L, holding the 12-byte header
 * and a symbol of `symbolSize` bytes as Base45 text; the symbol size is the largest multiple of 8 that fits the
 * version's alphanumeric capacity. Larger versions carry more per frame but need a sharper, closer view. The
 * receiver learns the size from the stream descriptor, so any of these interoperates.
 */
export const QR_PROFILES = [
  { qrVersion: 21, symbolSize: 840 },
  { qrVersion: 25, symbolSize: 1216 },
  { qrVersion: 30, symbolSize: 1664 },
  { qrVersion: 35, symbolSize: 2216 },
  { qrVersion: 40, symbolSize: 2848 },
] as const;

export const T0_MIN_SYMBOL = 64;
export const T0_MAX_SYMBOL = 2848;

/** Symbol sizes a T0 stream may use: multiples of 8 (RaptorQ Al) from 64 to 2848 bytes. */
export function isT0SymbolSize(n: number): boolean {
  return Number.isInteger(n) && n >= T0_MIN_SYMBOL && n <= T0_MAX_SYMBOL && n % 8 === 0;
}

/** Frame rates a T0 stream may use, as display refreshes per frame at 60 Hz (6 = 10 frames/s … 2 = 30 frames/s). */
export const QR_HOLDS = [6, 4, 3, 2] as const;

/** How a sender draws a T0 stream: bytes per code, codes on screen and frame hold. Saved per device (ADR-0020). */
export interface QrStreamSetting {
  symbolSize: number;
  codesPerScreen: 1 | 2 | 4;
  holdRefreshes60: number;
}

/** Version 21, one code, 10 frames/s: what every pairing read reliably before profiles existed. */
export const DEFAULT_QR_STREAM: Readonly<QrStreamSetting> = Object.freeze({ symbolSize: 840, codesPerScreen: 1, holdRefreshes60: 6 });

/** Validates a stored setting, falling back field by field to the default (old or hand-edited storage). */
export function qrStreamSetting(v: unknown): QrStreamSetting {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof QrStreamSetting, unknown>>;
  const size = typeof o.symbolSize === "number" && isT0SymbolSize(o.symbolSize) ? o.symbolSize : DEFAULT_QR_STREAM.symbolSize;
  const codes = o.codesPerScreen === 2 || o.codesPerScreen === 4 ? o.codesPerScreen : 1;
  const hold = typeof o.holdRefreshes60 === "number" && (QR_HOLDS as readonly number[]).includes(o.holdRefreshes60) ? o.holdRefreshes60 : DEFAULT_QR_STREAM.holdRefreshes60;
  return { symbolSize: size, codesPerScreen: codes, holdRefreshes60: hold };
}

/** "v30 · 1,664 B × 2 at 20/s (≤ 65 KB/s)". */
export function describeQrStream(s: QrStreamSetting): string {
  const p = QR_PROFILES.find((q) => q.symbolSize === s.symbolSize);
  const fps = 60 / s.holdRefreshes60;
  const max = (s.symbolSize * s.codesPerScreen * fps) / 1024;
  return `${p ? `v${p.qrVersion} · ` : ""}${s.symbolSize.toLocaleString("en-US")} B × ${s.codesPerScreen} at ${fps}/s (≤ ${max.toFixed(0)} KB/s)`;
}

export function isDefaultQrStream(s: QrStreamSetting): boolean {
  return s.symbolSize === DEFAULT_QR_STREAM.symbolSize && s.codesPerScreen === DEFAULT_QR_STREAM.codesPerScreen && s.holdRefreshes60 === DEFAULT_QR_STREAM.holdRefreshes60;
}

/**
 * RaptorQ OTI for streaming `length` bytes at `tier` (Al = 8, N = 1). T0 streams may use a larger symbol size
 * (`symbolSize`, see QR_PROFILES); grid tiers always use their fixed size.
 */
export function planStreamOti(length: number, tier: Tier, symbolSize?: number): Oti {
  const spec = TIERS[tier];
  const t = tier === 0 && symbolSize !== undefined ? symbolSize : spec.symbolSize;
  if (tier === 0 && !isT0SymbolSize(t)) throw new RangeError(`invalid T0 symbol size ${t}`);
  return planOti(length, t, spec.maxSourceSymbolsPerBlock, 8);
}
