/**
 * Capability tier for the reverse key code (spec §7.7, ADR-0010 step 4). The tier a receiver reports caps the
 * stream the sender produces, so it must reflect what this phone can actually decode — not just what its camera
 * delivers. Facet decoding runs in JavaScript here (see ADR-0016), so the measured decode time per frame
 * dominates: a sender's frame is held for ~100 ms, and a receiver that reads fewer than roughly one frame in
 * eight cannot keep up with denser tiers.
 *
 * Without a measurement the phone reports T1. After every optical receive the measured capture rate and decode
 * time are kept and the next offer uses them.
 */
import type { Tier } from "@sealed/core";

export interface OpticalMeasurement {
  captureFps: number;
  decodeMsPerFrame: number;
}

export const DEFAULT_TIER: Tier = 1;

export function tierForMeasurement(m: OpticalMeasurement | undefined): Tier {
  if (!m || !Number.isFinite(m.decodeMsPerFrame) || m.decodeMsPerFrame <= 0) return DEFAULT_TIER;
  if (m.captureFps < 20) return 0;
  if (m.decodeMsPerFrame <= 150 && m.captureFps >= 50) return 3;
  if (m.decodeMsPerFrame <= 300 && m.captureFps >= 28) return 2;
  if (m.decodeMsPerFrame <= 1200) return 1;
  return 0;
}
