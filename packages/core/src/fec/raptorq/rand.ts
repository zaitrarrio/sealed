/**
 * RFC 6330 pseudo-random generator Rand[y, i, m] (§5.3.5.1), degree generator Deg[v] (§5.3.5.2)
 * and tuple generator Tuple[K', X] (§5.3.5.4). All arithmetic is exact 32-bit unsigned, done with
 * plain numbers (no BigInt).
 */
import { V0, V1, V2, V3 } from "./tables";
import type { BlockParams } from "./params";

/** Rand[y, i, m] for 32-bit unsigned y, small non-negative i and m > 0. */
export function rand(y: number, i: number, m: number): number {
  const x0 = (y + i) & 0xff;
  const x1 = ((y >>> 8) + i) & 0xff;
  const x2 = ((y >>> 16) + i) & 0xff;
  const x3 = ((y >>> 24) + i) & 0xff;
  const v = ((V0[x0] as number) ^ (V1[x1] as number) ^ (V2[x2] as number) ^ (V3[x3] as number)) >>> 0;
  return v % m;
}

const DEG_F: Uint32Array = Uint32Array.from([
  0, 5243, 529531, 704294, 791675, 844104, 879057, 904023, 922747, 937311, 948962, 958494, 966438, 973160,
  978921, 983914, 988283, 992138, 995565, 998631, 1001391, 1003887, 1006157, 1008229, 1010129, 1011876,
  1013490, 1014983, 1016370, 1017662, 1048576,
]);

/** Deg[v] for 0 <= v < 2^20, capped at W - 2. */
export function deg(v: number, W: number): number {
  for (let d = 1; d < DEG_F.length; d++) {
    if (v < (DEG_F[d] as number)) return Math.min(d, W - 2);
  }
  throw new RangeError(`Deg: v out of range: ${v}`);
}

/**
 * Tuple[K', X] = (d, a, b, d1, a1, b1), written into `out[0..5]`.
 * X is the internal symbol id (ISI).
 */
export function intermediateTuple(X: number, p: BlockParams, out: Uint32Array): void {
  let A = 53591 + p.J * 997;
  if ((A & 1) === 0) A += 1;
  const B = 10267 * (p.J + 1);
  const y = (B + Math.imul(X, A)) >>> 0;
  const v = rand(y, 0, 1048576);
  const d = deg(v, p.W);
  const a = 1 + rand(y, 1, p.W - 1);
  const b = rand(y, 2, p.W);
  const d1 = d < 4 ? 2 + rand(X, 3, 2) : 2;
  const a1 = 1 + rand(X, 4, p.P1 - 1);
  const b1 = rand(X, 5, p.P1);
  out[0] = d;
  out[1] = a;
  out[2] = b;
  out[3] = d1;
  out[4] = a1;
  out[5] = b1;
}

/**
 * Calls `f(j)` for each intermediate-symbol index j combined by Enc[K', C, (d,a,b,d1,a1,b1)]
 * (RFC 6330 §5.3.5.3) for internal symbol id X, in the same order as the reference encoder.
 * Returns the number of indices written into `idx`.
 */
export function encIndices(X: number, p: BlockParams, tuple: Uint32Array, idx: Int32Array): number {
  intermediateTuple(X, p, tuple);
  const W = p.W;
  const P = p.P;
  const P1 = p.P1;
  const d = tuple[0] as number;
  const a = tuple[1] as number;
  let b = tuple[2] as number;
  const d1 = tuple[3] as number;
  const a1 = tuple[4] as number;
  let b1 = tuple[5] as number;
  let n = 0;
  idx[n++] = b;
  for (let j = 1; j < d; j++) {
    b = (b + a) % W;
    idx[n++] = b;
  }
  while (b1 >= P) b1 = (b1 + a1) % P1;
  idx[n++] = W + b1;
  for (let j = 1; j < d1; j++) {
    b1 = (b1 + a1) % P1;
    while (b1 >= P) b1 = (b1 + a1) % P1;
    idx[n++] = W + b1;
  }
  return n;
}

/** Upper bound on the number of indices `encIndices` can produce (max degree 30 + 3 PI). */
export const MAX_ENC_INDICES = 34;
