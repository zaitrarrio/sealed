/**
 * Capability tier for the reverse key code (spec §7.7, ADR-0010 step 4). The tier a receiver reports caps the
 * stream the sender produces, so it must reflect what this phone can actually decode.
 *
 * Phones read T0 (QR) frames with the platform's own detector, which keeps up with the sender and needs no
 * alignment, so T0 is the default and what every offline transfer uses. The colour-grid tiers (T1–T3) need the
 * JavaScript image decoder (~0.5 s per frame on a phone) until a native decoder ships; a phone offers a grid
 * tier only when a measured pixel decode keeps up with that tier's frame interval, which the benchmark records.
 */
import { TIERS, type Tier } from "@sealed/core";

export interface OpticalMeasurement {
  captureFps: number;
  /** Pixel-path decode time per camera frame (the detector path is not measured here). */
  decodeMsPerFrame: number;
}

export const DEFAULT_TIER: Tier = 0;

export function tierForMeasurement(m: OpticalMeasurement | undefined): Tier {
  if (!m || !Number.isFinite(m.decodeMsPerFrame) || m.decodeMsPerFrame <= 0) return DEFAULT_TIER;
  for (const t of [3, 2, 1] as const) {
    const intervalMs = 1000 / TIERS[t].dataFps;
    if (m.decodeMsPerFrame <= intervalMs && m.captureFps >= TIERS[t].dataFps * 2) return t;
  }
  return 0;
}

/** How a tier is received on this phone. */
export function decodePathFor(tier: Tier): "codes" | "pixels" {
  return tier === 0 ? "codes" : "pixels";
}
