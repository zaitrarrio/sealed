/**
 * Acoustic modem profiles (ADR-0024). Design-target goodput before FEC overhead; measured on a clean
 * synthetic channel in tests. Real-phone rates are published only after a device bench passes A0.
 */

export type AcousticProfileId = 0 | 1;

export interface AcousticProfile {
  id: AcousticProfileId;
  name: string;
  /** PCM sample rate. */
  sampleRate: number;
  /** Samples per OFDM/QPSK symbol including cyclic prefix. */
  symbolSamples: number;
  /** Carrier frequencies in Hz (one QPSK symbol each). */
  carriersHz: readonly number[];
  /** RaptorQ symbol size T (bytes). Must be a multiple of 8. */
  symbolSize: number;
  /** Fixed acoustic packet payload capacity (bytes), including RaptorQ symbols and descriptor fragments. */
  packetPayload: number;
  /** Target goodput floor after FEC (bytes/s) for a clean close-range channel. */
  targetGoodputBps: number;
  /** Human description for UI. */
  description: string;
}

/** A0: audible, robust, few metres — design ~0.4 KB/s raw (before FEC / packet overhead). */
export const PROFILE_A0: AcousticProfile = (() => {
  const sampleRate = 48_000;
  const symbolSamples = 384; // bin = 125 Hz
  const bin = sampleRate / symbolSamples;
  // 16 carriers from bin 10..25 → 1250–3125 Hz; 16×2×(48000/384) = 500 B/s raw
  const carriersHz = Array.from({ length: 16 }, (_, i) => (10 + i) * bin);
  return {
    id: 0 as const,
    name: "A0",
    sampleRate,
    symbolSamples,
    carriersHz,
    symbolSize: 32,
    packetPayload: 48,
    targetGoodputBps: 400,
    description: "Audible, works across a quiet room",
  };
})();

/** A1: denser audible band, close range — design ~1.5 KB/s raw. */
export const PROFILE_A1: AcousticProfile = (() => {
  const sampleRate = 48_000;
  const symbolSamples = 256; // bin = 187.5 Hz — carriers must sit on bin centres
  const bin = sampleRate / symbolSamples;
  // 32 carriers from bin 8..39 → 1500–7312.5 Hz; 32×2×(48000/256) = 1500 B/s raw
  const carriersHz = Array.from({ length: 32 }, (_, i) => (8 + i) * bin);
  return {
    id: 1 as const,
    name: "A1",
    sampleRate,
    symbolSamples,
    carriersHz,
    symbolSize: 64,
    packetPayload: 80,
    targetGoodputBps: 1500,
    description: "Faster, devices within about a metre and a half",
  };
})();

export const ACOUSTIC_PROFILES: readonly AcousticProfile[] = [PROFILE_A0, PROFILE_A1];

export function acousticProfile(id: AcousticProfileId): AcousticProfile {
  const p = ACOUSTIC_PROFILES[id];
  if (!p) throw new RangeError(`unknown acoustic profile ${id}`);
  return p;
}

export function isAcousticProfileId(v: number): v is AcousticProfileId {
  return v === 0 || v === 1;
}

/** Bits carried per OFDM symbol (2 bits × carriers). */
export function bitsPerSymbol(p: AcousticProfile): number {
  return p.carriersHz.length * 2;
}

/** Raw payload bytes per second before packet overhead. */
export function rawByteRate(p: AcousticProfile): number {
  return (bitsPerSymbol(p) / 8) * (p.sampleRate / p.symbolSamples);
}
