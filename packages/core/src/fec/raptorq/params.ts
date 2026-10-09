/**
 * Per-block code parameters for RaptorQ (RFC 6330 §5.3.1, §5.3.3.3, §5.6).
 */
import { H_K, J_K, K_PRIME, K_PRIME_MAX, P1_K, S_K, W_K } from "./tables";

export interface BlockParams {
  /** Source symbols in the block. */
  readonly K: number;
  /** Extended source block size K' (smallest table entry >= K). */
  readonly Kp: number;
  /** Systematic index J(K'). */
  readonly J: number;
  /** LDPC symbols S(K'). */
  readonly S: number;
  /** HDPC symbols H(K'). */
  readonly H: number;
  /** LT symbols W(K'). */
  readonly W: number;
  /** Intermediate symbols L = K' + S + H. */
  readonly L: number;
  /** PI symbols P = L - W. */
  readonly P: number;
  /** Smallest prime >= P. */
  readonly P1: number;
  /** B = W - S (non-LDPC LT symbols). */
  readonly B: number;
}

/** Maximum number of source symbols per block (K'_max). */
export const MAX_SOURCE_SYMBOLS_PER_BLOCK = K_PRIME_MAX;

const cache = new Map<number, BlockParams>();

/** Look up the code parameters for a block of K source symbols (1 <= K <= 56403). */
export function blockParams(K: number): BlockParams {
  const hit = cache.get(K);
  if (hit) return hit;
  if (!Number.isInteger(K) || K < 1 || K > K_PRIME_MAX) {
    throw new RangeError(`source block size K must be an integer in 1..${K_PRIME_MAX}, got ${K}`);
  }
  let lo = 0;
  let hi = K_PRIME.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((K_PRIME[mid] as number) >= K) hi = mid;
    else lo = mid + 1;
  }
  const Kp = K_PRIME[lo] as number;
  const S = S_K[lo] as number;
  const H = H_K[lo] as number;
  const W = W_K[lo] as number;
  const L = Kp + S + H;
  const p: BlockParams = {
    K,
    Kp,
    J: J_K[lo] as number,
    S,
    H,
    W,
    L,
    P: L - W,
    P1: P1_K[lo] as number,
    B: W - S,
  };
  cache.set(K, p);
  return p;
}
