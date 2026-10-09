import { describe, expect, it } from "vitest";
import { ReedSolomon } from "../../src/fec";

/** Deterministic xorshift32 PRNG. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function randomBytes(r: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r() & 0xff;
  return out;
}

/** Choose `count` distinct positions in 0..n-1. */
function pick(r: () => number, n: number, count: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = r() % (i + 1);
    [idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
  }
  return idx.slice(0, count);
}

function corrupt(r: () => number, cw: Uint8Array, positions: number[]): Uint8Array {
  const out = cw.slice();
  for (const p of positions) out[p] = (out[p] as number) ^ (1 + (r() % 255));
  return out;
}

function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

describe("ReedSolomon", () => {
  it("rejects invalid parameters", () => {
    expect(() => new ReedSolomon(256, 10)).toThrow();
    expect(() => new ReedSolomon(10, 10)).toThrow();
    expect(() => new ReedSolomon(10, 0)).toThrow();
  });

  it("produces codewords with zero syndromes (roots alpha^0..alpha^(n-k-1))", () => {
    const rs = new ReedSolomon(20, 12);
    const r = prng(1);
    const cw = rs.encode(randomBytes(r, 12));
    expect(rs.decode(cw)).toEqual(cw.slice(0, 12));
    // Known vector: all-zero data encodes to all-zero parity; unit data is systematic.
    expect(Array.from(rs.encode(new Uint8Array(12)))).toEqual(new Array<number>(20).fill(0));
  });

  for (const [n, k] of [
    [255, 207],
    [20, 12],
  ] as const) {
    it(`roundtrips random data for (${n},${k})`, () => {
      const rs = new ReedSolomon(n, k);
      const r = prng(n * 1000 + k);
      for (let t = 0; t < 50; t++) {
        const data = randomBytes(r, k);
        const cw = rs.encode(data);
        expect(cw.subarray(0, k)).toEqual(data);
        expect(rs.decode(cw)).toEqual(data);
      }
    });
  }

  it("corrects up to 24 random errors for (255,207)", () => {
    const rs = new ReedSolomon(255, 207);
    const r = prng(42);
    for (let t = 0; t < 60; t++) {
      const data = randomBytes(r, 207);
      const cw = rs.encode(data);
      const e = 1 + (t % 24);
      const bad = corrupt(r, cw, pick(r, 255, t < 10 ? 24 : e));
      expect(rs.decode(bad)).toEqual(data);
    }
  });

  it("corrects 48 erasures for (255,207)", () => {
    const rs = new ReedSolomon(255, 207);
    const r = prng(7);
    for (let t = 0; t < 30; t++) {
      const data = randomBytes(r, 207);
      const cw = rs.encode(data);
      const pos = pick(r, 255, 48);
      const bad = corrupt(r, cw, pos);
      expect(rs.decode(bad, pos)).toEqual(data);
    }
  });

  it("corrects mixed errors and erasures with 2e + f = 48", () => {
    const rs = new ReedSolomon(255, 207);
    const r = prng(99);
    for (let e = 0; e <= 24; e++) {
      const f = 48 - 2 * e;
      const data = randomBytes(r, 207);
      const cw = rs.encode(data);
      const pos = pick(r, 255, e + f);
      const errs = pos.slice(0, e);
      const eras = pos.slice(e);
      // Erased positions may or may not actually be wrong.
      const bad = corrupt(r, cw, [...errs, ...eras.filter((_, i) => i % 3 !== 0)]);
      expect(rs.decode(bad, eras)).toEqual(data);
    }
  });

  it("corrects mixed errors and erasures for (20,12)", () => {
    const rs = new ReedSolomon(20, 12);
    const r = prng(5);
    for (let t = 0; t < 200; t++) {
      const e = t % 5;
      const f = 8 - 2 * e;
      const data = randomBytes(r, 12);
      const cw = rs.encode(data);
      const pos = pick(r, 20, e + f);
      const bad = corrupt(r, cw, pos);
      expect(rs.decode(bad, pos.slice(e))).toEqual(data);
    }
  });

  it("never returns data inconsistent with the distance budget beyond capacity", () => {
    for (const [n, k, seed] of [
      [255, 207, 3],
      [20, 12, 11],
    ] as const) {
      const rs = new ReedSolomon(n, k);
      const r = prng(seed);
      const m = n - k;
      let nulls = 0;
      for (let t = 0; t < 300; t++) {
        const data = randomBytes(r, k);
        const cw = rs.encode(data);
        const f = t % 3 === 0 ? r() % (m >> 1) : 0;
        // Push 2e + f past capacity by 1..6.
        const e = Math.floor((m - f) / 2) + 1 + (r() % 3);
        const pos = pick(r, n, Math.min(n, e + f));
        const bad = corrupt(r, cw, pos);
        const eras = pos.slice(e);
        const out = rs.decode(bad, eras);
        if (out === null) {
          nulls++;
          continue;
        }
        const re = rs.encode(out);
        const eraSet = new Set(eras);
        let d = 0;
        for (let i = 0; i < n; i++) if (re[i] !== bad[i] && !eraSet.has(i)) d++;
        expect(2 * d + eraSet.size).toBeLessThanOrEqual(m);
        expect(hamming(re, cw)).toBeGreaterThan(0);
      }
      expect(nulls).toBeGreaterThan(200);
    }
  });

  it("returns null when erasures exceed the parity count", () => {
    const rs = new ReedSolomon(20, 12);
    const cw = rs.encode(new Uint8Array(12).fill(9));
    expect(rs.decode(cw, [0, 1, 2, 3, 4, 5, 6, 7, 8])).toBeNull();
    expect(() => rs.decode(cw, [20])).toThrow();
  });
});
