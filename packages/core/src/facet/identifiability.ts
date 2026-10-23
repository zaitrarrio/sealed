/**
 * Optical Channel Identifiability & Information Theory Engine
 *
 * Implements the theoretical framework from Sections 3, 4, 11, and Appendix C of the Research Proposal:
 * 1. Two-cell optical channel analytic model & singularity analysis (Eq 13, 14, Appendix C).
 * 2. Generalized Mutual Information (GMI) / bit-metric achievable information rate calculator with
 *    optimal scaling search (Eq 5).
 * 3. Fano's converse inequality & information limits (Eq 4).
 * 4. Finite-blocklength / Rate ledger calculation for 128 MiB in 120s (Eq 11).
 * 5. Exact statistical deadline certification calculator (Eq 12).
 * 6. Codeword pairwise confusion & identifiability analysis under spatial blur.
 */

/** Two-cell symmetric blur mixing matrix A(a) = [[1-a, a], [a, 1-a]] (Eq 13). */
export function twoCellMatrix(a: number): [[number, number], [number, number]] {
  return [
    [1 - a, a],
    [a, 1 - a],
  ];
}

/**
 * Expected observation y = A(a) * x for a 2-cell message.
 * x: [bit0, bit1] in {0, 1}^2.
 */
export function twoCellObservation(a: number, x: readonly [number, number]): [number, number] {
  const [x0, x1] = x;
  return [(1 - a) * x0 + a * x1, a * x0 + (1 - a) * x1];
}

/**
 * Squared noise-normalized separation between messages [1, 0] and [0, 1] (Eq 14):
 * d^2 = 2 * (1 - 2a)^2 / sigma^2.
 *
 * At a = 0.5, d^2 = 0, proving these two messages become strictly indistinguishable under noise.
 */
export function twoCellSeparationSquared(a: number, sigma: number): number {
  if (sigma <= 0) throw new RangeError("Noise standard deviation sigma must be positive");
  const diff = 1 - 2 * a;
  return (2 * diff * diff) / (sigma * sigma);
}

/**
 * Evaluates pairwise Euclidean distances between all codewords in a 2-cell codebook under mixing parameter a.
 */
export function twoCellCodebookSeparations(
  a: number,
  codebook: readonly (readonly [number, number])[],
): {
  minDistance: number;
  pairwise: { pair: [number, number]; codewordA: readonly [number, number]; codewordB: readonly [number, number]; dist: number }[];
} {
  const pairwise: { pair: [number, number]; codewordA: readonly [number, number]; codewordB: readonly [number, number]; dist: number }[] = [];
  let minDistance = Infinity;

  for (let i = 0; i < codebook.length; i++) {
    for (let j = i + 1; j < codebook.length; j++) {
      const ca = codebook[i] as readonly [number, number];
      const cb = codebook[j] as readonly [number, number];
      const ya = twoCellObservation(a, ca);
      const yb = twoCellObservation(a, cb);
      const d0 = ya[0] - yb[0];
      const d1 = ya[1] - yb[1];
      const dist = Math.hypot(d0, d1);
      pairwise.push({ pair: [i, j], codewordA: ca, codewordB: cb, dist });
      if (dist < minDistance) {
        minDistance = dist;
      }
    }
  }

  return { minDistance: pairwise.length > 0 ? minDistance : 0, pairwise };
}

/**
 * Binary entropy function h_2(p) = -p*log2(p) - (1-p)*log2(1-p).
 */
export function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
}

/**
 * Fano's converse inequality lower bound on mutual information I(U; Y) (Eq 4):
 * I(U; Y) >= (1 - Pe) * B - h_2(Pe)
 *
 * For a message of B bits and desired block error probability Pe.
 */
export function fanoMutualInformationBound(bBits: number, blockErrorProbability: number): number {
  const pe = Math.max(0, Math.min(1, blockErrorProbability));
  return Math.max(0, (1 - pe) * bBits - binaryEntropy(pe));
}

/**
 * Generalized Mutual Information (GMI) bit-metric achievable information rate (Eq 5):
 * R_gmi = max_{s > 0} { 1 - E[ log2( 1 + exp(-s * (2B - 1) * L) ) ] }
 *
 * where:
 * - bits: transmitted ground-truth bits B in {0, 1}
 * - llrs: receiver-estimated log-likelihood ratios L = log(P(B=1|Y)/P(B=0|Y))
 * - s: calibration / temperature scaling parameter.
 */
export function calculateGmiForS(
  bits: ArrayLike<number>,
  llrs: ArrayLike<number>,
  s: number,
): number {
  const n = Math.min(bits.length, llrs.length);
  if (n === 0) return 0;

  let lossSum = 0;
  for (let i = 0; i < n; i++) {
    const b = bits[i] as number;
    const l = llrs[i] as number;
    // (2B - 1) is +1 for bit 1, -1 for bit 0
    const bitSign = b === 1 ? 1 : -1;
    const exponent = -s * bitSign * l;

    // Numerically stable log2(1 + exp(exponent))
    let term: number;
    if (exponent > 50) {
      term = exponent / Math.LN2;
    } else if (exponent < -50) {
      term = Math.exp(exponent) / Math.LN2;
    } else {
      term = Math.log2(1 + Math.exp(exponent));
    }
    lossSum += term;
  }

  const expectedLoss = lossSum / n;
  return Math.max(0, Math.min(1, 1 - expectedLoss));
}

/**
 * Calculates Generalized Mutual Information (GMI) and searches for the optimal
 * calibration parameter s > 0 via golden section search.
 */
export function calculateGmi(
  bits: ArrayLike<number>,
  llrs: ArrayLike<number>,
  sFixed?: number,
): { gmi: number; optimalS: number } {
  if (sFixed !== undefined) {
    return { gmi: calculateGmiForS(bits, llrs, sFixed), optimalS: sFixed };
  }

  // Golden section search for optimal s in range [0.05, 5.0]
  const phi = (1 + Math.sqrt(5)) / 2;
  const resphi = 2 - phi;

  let a = 0.05;
  let b = 5.0;
  const tol = 1e-4;

  let x1 = a + resphi * (b - a);
  let x2 = b - resphi * (b - a);
  let f1 = calculateGmiForS(bits, llrs, x1);
  let f2 = calculateGmiForS(bits, llrs, x2);

  while (Math.abs(b - a) > tol) {
    if (f1 > f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = a + resphi * (b - a);
      f1 = calculateGmiForS(bits, llrs, x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = b - resphi * (b - a);
      f2 = calculateGmiForS(bits, llrs, x2);
    }
  }

  const optimalS = (a + b) / 2;
  const gmi = calculateGmiForS(bits, llrs, optimalS);
  return { gmi, optimalS };
}

/**
 * Optical transfer rate ledger (Eq 11):
 * R_net = f_epoch * N_tile * b_tile * r_inner * eta_outer * eta_usable
 */
export interface RateLedgerInput {
  fEpoch: number; // Display update rate (epochs/sec), e.g. 30 or 60
  nTile: number; // Number of spatial patches/tiles per frame, e.g. 16
  bTile: number; // Coded bit capacity per tile
  rInner: number; // Inner code rate, e.g. 0.8
  etaOuter: number; // Outer RaptorQ efficiency, e.g. 0.95
  etaUsable: number; // Usable fraction (accounting for capture loss, dropped frames), e.g. 0.85
  setupSeconds?: number; // Time reserved for acquisition & finalization, default 10s
  targetPayloadBytes?: number; // Default 128 MiB = 134,217,728 bytes
}

export interface RateLedgerResult {
  netRateBps: number;
  netRateMbps: number;
  payloadDurationSeconds: number;
  totalDurationSeconds: number;
  deadlineMet: boolean; // <= 120 seconds
}

export function evaluateRateLedger(input: RateLedgerInput): RateLedgerResult {
  const { fEpoch, nTile, bTile, rInner, etaOuter, etaUsable } = input;
  const setupSeconds = input.setupSeconds ?? 10;
  const payloadBytes = input.targetPayloadBytes ?? 134217728; // 128 MiB

  const netRateBps = fEpoch * nTile * bTile * rInner * etaOuter * etaUsable;
  const netRateMbps = netRateBps / 1e6;

  const totalPayloadBits = payloadBytes * 8;
  const payloadDurationSeconds = netRateBps > 0 ? totalPayloadBits / netRateBps : Infinity;
  const totalDurationSeconds = setupSeconds + payloadDurationSeconds;
  const deadlineMet = totalDurationSeconds <= 120.0;

  return {
    netRateBps,
    netRateMbps,
    payloadDurationSeconds,
    totalDurationSeconds,
    deadlineMet,
  };
}

/**
 * Statistical certification sample size and lower confidence bound (Eq 12):
 * p_lower = alpha^(1 / n)
 * n >= ln(1 / alpha) / ln(1 / 0.95)
 */
export function certificationSampleSize(alpha = 0.05, targetSuccessProb = 0.95): number {
  if (alpha <= 0 || alpha >= 1) throw new RangeError("alpha must be in (0, 1)");
  if (targetSuccessProb <= 0 || targetSuccessProb >= 1) throw new RangeError("targetSuccessProb must be in (0, 1)");
  return Math.ceil(Math.log(alpha) / Math.log(targetSuccessProb));
}

/**
 * Exact Clopper-Pearson lower confidence bound on the binomial completion probability
 * with k successes in n independent trials at significance level alpha.
 */
export function exactLowerConfidenceBound(successes: number, total: number, alpha = 0.05): number {
  if (total <= 0) return 0;
  if (successes === total) {
    // Exact zero-failure formula: alpha^(1/n) (Eq 12)
    return Math.pow(alpha, 1 / total);
  }
  if (successes === 0) return 0;

  // Numerical approximation of Beta distribution quantile
  let lo = 0.0;
  let hi = 1.0;
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    // Cumulative binomial probability P(X >= successes | p = mid)
    let sum = 0;
    for (let x = successes; x <= total; x++) {
      sum += binomialProb(total, x, mid);
    }
    if (sum > alpha) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return lo;
}

function binomialProb(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 1; i <= k; i++) {
    c = (c * (n - i + 1)) / i;
  }
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
}
