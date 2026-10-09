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

/** RaptorQ OTI for streaming `length` bytes at `tier` (Al = 8, N = 1). */
export function planStreamOti(length: number, tier: Tier): Oti {
  const spec = TIERS[tier];
  return planOti(length, spec.symbolSize, spec.maxSourceSymbolsPerBlock, 8);
}
