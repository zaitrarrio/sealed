import { describe, expect, it } from "vitest";
import {
  twoCellMatrix,
  twoCellObservation,
  twoCellSeparationSquared,
  twoCellCodebookSeparations,
  binaryEntropy,
  fanoMutualInformationBound,
  calculateGmi,
  calculateGmiForS,
  evaluateRateLedger,
  certificationSampleSize,
  exactLowerConfidenceBound,
} from "../../src/facet/identifiability";

describe("Identifiability & Information Theory Engine", () => {
  describe("Appendix C: Two-cell optical channel analytic model", () => {
    it("proves distinguishability collapse as a approaches 0.5 (singularity test)", () => {
      const sigma = 0.1;

      // At a = 0 (no blur mixing), maximum separation
      const d0 = twoCellSeparationSquared(0.0, sigma);
      expect(d0).toBeCloseTo(2 / (sigma * sigma));

      // As a -> 0.5, separation d^2 strictly approaches 0
      const d04 = twoCellSeparationSquared(0.4, sigma);
      const d049 = twoCellSeparationSquared(0.49, sigma);
      const d05 = twoCellSeparationSquared(0.5, sigma);

      expect(d04).toBeGreaterThan(d049);
      expect(d049).toBeGreaterThan(d05);
      expect(d05).toBe(0); // Identifiability singularity!
    });

    it("verifies observations of [1, 0] and [0, 1] become identical at a = 0.5", () => {
      const a = 0.5;
      const obs10 = twoCellObservation(a, [1, 0]);
      const obs01 = twoCellObservation(a, [0, 1]);

      expect(obs10[0]).toBeCloseTo(0.5);
      expect(obs10[1]).toBeCloseTo(0.5);
      expect(obs01[0]).toBeCloseTo(0.5);
      expect(obs01[1]).toBeCloseTo(0.5);
      expect(obs10).toEqual(obs01); // Indistinguishable without side information
    });

    it("demonstrates coding trade-off: restricted codebook {00, 11} preserves separation at a = 0.5", () => {
      const a = 0.5;
      // 4-word unconstrained codebook
      const unconstrainedCodebook: [number, number][] = [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ];
      const resUnconstrained = twoCellCodebookSeparations(a, unconstrainedCodebook);
      expect(resUnconstrained.minDistance).toBe(0); // Collapses

      // 2-word restricted codebook
      const restrictedCodebook: [number, number][] = [
        [0, 0],
        [1, 1],
      ];
      const resRestricted = twoCellCodebookSeparations(a, restrictedCodebook);
      expect(resRestricted.minDistance).toBeCloseTo(Math.SQRT2); // Preserves separation!
    });
  });

  describe("Generalized Mutual Information (GMI) (Eq 5)", () => {
    it("evaluates GMI close to 1.0 for confident, correct LLRs", () => {
      const bits = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0]);
      const llrs = new Float64Array([8.0, -8.0, 7.5, 9.0, -8.5, -7.0, 8.2, -9.1]);

      const { gmi, optimalS } = calculateGmi(bits, llrs);
      expect(gmi).toBeGreaterThan(0.98);
      expect(optimalS).toBeGreaterThan(0);
    });

    it("evaluates GMI close to 0.0 for completely uninformative random LLRs", () => {
      const n = 1000;
      const bits = new Uint8Array(n);
      const llrs = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        bits[i] = i % 2;
        llrs[i] = (Math.random() - 0.5) * 0.1; // Pure noise near zero
      }

      const { gmi } = calculateGmi(bits, llrs);
      expect(gmi).toBeLessThan(0.05);
    });
  });

  describe("Fano's converse inequality (Eq 4)", () => {
    it("computes mutual information lower bounds consistent with entropy", () => {
      expect(binaryEntropy(0)).toBe(0);
      expect(binaryEntropy(0.5)).toBe(1);
      expect(binaryEntropy(1)).toBe(0);

      // For 100-bit message with Pe = 0.01
      const bound = fanoMutualInformationBound(100, 0.01);
      expect(bound).toBeGreaterThan(98.0);
    });
  });

  describe("Rate ledger & 128 MiB / 120s deadline evaluation (Eq 11)", () => {
    it("certifies feasible configurations meeting 128 MiB within 120 seconds", () => {
      // Proposal §11 reference capacity hypothesis:
      // 448x800 binary field at 60 fps (358,400 bits/frame = 21.504M bits/s nominal)
      // 88% spatial overhead, 0.80 inner rate, 0.95 outer efficiency, 0.80 usable fraction -> 11.51 Mbps
      const res12 = evaluateRateLedger({
        fEpoch: 60,
        nTile: 448,
        bTile: 800,
        rInner: 0.80,
        etaOuter: 0.95,
        etaUsable: 0.80 * 0.88, // 0.704
        setupSeconds: 10,
        targetPayloadBytes: 134217728, // 128 MiB = 1,073,741,824 bits
      });

      expect(res12.netRateMbps).toBeCloseTo(11.51, 1);
      expect(res12.totalDurationSeconds).toBeCloseTo(103.3, 1);
      expect(res12.deadlineMet).toBe(true);
    });

    it("identifies failing operating points where goodput is insufficient", () => {
      const resSlow = evaluateRateLedger({
        fEpoch: 15,
        nTile: 16,
        bTile: 384,
        rInner: 0.70,
        etaOuter: 0.90,
        etaUsable: 0.70,
        setupSeconds: 10,
        targetPayloadBytes: 134217728,
      });

      expect(resSlow.deadlineMet).toBe(false);
      expect(resSlow.totalDurationSeconds).toBeGreaterThan(120.0);
    });
  });

  describe("Statistical deadline certification (Eq 12)", () => {
    it("computes required sample size n = 59 for alpha = 0.05 and target = 0.95", () => {
      const n = certificationSampleSize(0.05, 0.95);
      expect(n).toBe(59);
    });

    it("verifies exact lower confidence bound gives >= 0.95 for 59/59 successes", () => {
      const lowerBound = exactLowerConfidenceBound(59, 59, 0.05);
      expect(lowerBound).toBeGreaterThan(0.95);
      expect(lowerBound).toBeCloseTo(Math.pow(0.05, 1 / 59), 4);
    });
  });
});
