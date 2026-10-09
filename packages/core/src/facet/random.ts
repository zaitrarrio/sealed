/**
 * Deterministic, non-cryptographic PRNG used by the Facet codec for fixed layouts (cell permutation,
 * calibration tiling), header whitening and padding bits. Both ends must produce identical sequences, so
 * this is a fixed algorithm (xorshift32 with a splitmix-style seed finalizer) and must never change within
 * a codec version.
 */

/** Mixes a 32-bit value (murmur3 fmix32) so nearby seeds give unrelated streams. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Xorshift32 {
  private s: number;

  constructor(seed: number) {
    this.s = fmix32(seed >>> 0) || 0x9e3779b9;
  }

  /** Next 32-bit unsigned value. */
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s;
  }

  /** Uniform integer in [0, n) (multiply-shift; bias < 2^-24 for the small n used here). */
  below(n: number): number {
    return Math.floor((this.next() / 4294967296) * n);
  }
}

/** FNV-1a over byte strings and 32-bit integers (big-endian), finalized with fmix32. */
export function seedFrom(...parts: readonly (Uint8Array | number)[]): number {
  let h = 0x811c9dc5;
  const byte = (b: number): void => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  for (const p of parts) {
    if (typeof p === "number") {
      byte(p >>> 24);
      byte(p >>> 16);
      byte(p >>> 8);
      byte(p);
    } else {
      for (let i = 0; i < p.length; i++) byte(p[i] as number);
    }
  }
  return fmix32(h >>> 0);
}

/** Fisher–Yates shuffle of `arr` in place with the given generator. */
export function shuffleInPlace(arr: Int32Array, rng: Xorshift32): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    const t = arr[i] as number;
    arr[i] = arr[j] as number;
    arr[j] = t;
  }
}
