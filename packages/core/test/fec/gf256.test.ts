import { describe, expect, it } from "vitest";
import { GF256_EXP, GF256_LOG, add, addAssign, div, inv, mul, mulAddAssign, mulAssign, pow } from "../../src/fec";

/** Bitwise reference multiply (Russian peasant) over 0x11D. */
function slowMul(a: number, b: number): number {
  let r = 0;
  let x = a;
  let y = b;
  while (y) {
    if (y & 1) r ^= x;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
    y >>= 1;
  }
  return r;
}

describe("gf256", () => {
  it("matches the RFC 6330 OCT_EXP prefix", () => {
    expect(Array.from(GF256_EXP.subarray(0, 12))).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 29, 58, 116, 232]);
    expect(GF256_EXP[255]).toBe(1);
  });

  it("exp/log are inverse bijections", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 255; i++) {
      const v = GF256_EXP[i] as number;
      seen.add(v);
      expect(GF256_LOG[v]).toBe(i);
    }
    expect(seen.size).toBe(255);
  });

  it("mul agrees with bitwise multiplication for every pair", () => {
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) if (mul(a, b) !== slowMul(a, b)) throw new Error(`${a}*${b}`);
  });

  it("div, inv, pow are consistent", () => {
    for (let a = 1; a < 256; a++) {
      expect(mul(a, inv(a))).toBe(1);
      for (let b = 1; b < 256; b += 7) expect(mul(div(a, b), b)).toBe(a);
      expect(pow(a, 255)).toBe(1);
      expect(pow(a, 3)).toBe(mul(a, mul(a, a)));
    }
    expect(div(0, 5)).toBe(0);
    expect(add(0x53, 0xca)).toBe(0x53 ^ 0xca);
    expect(() => inv(0)).toThrow();
    expect(() => div(3, 0)).toThrow();
  });

  it("bulk helpers handle aligned and unaligned views", () => {
    const buf = new Uint8Array(301);
    const src = new Uint8Array(301);
    for (let i = 0; i < 301; i++) {
      buf[i] = (i * 37) & 0xff;
      src[i] = (i * 91 + 5) & 0xff;
    }
    for (const off of [0, 1, 4]) {
      const d = buf.slice();
      const dv = d.subarray(off, off + 200);
      const sv = src.subarray(off, off + 200);
      addAssign(dv, sv);
      for (let i = 0; i < 301; i++) {
        const inRange = i >= off && i < off + 200;
        expect(d[i]).toBe(inRange ? (buf[i] as number) ^ (src[i] as number) : buf[i]);
      }
      const e = buf.slice();
      mulAddAssign(e.subarray(off, off + 200), sv, 0x8e);
      for (let i = off; i < off + 200; i++) expect(e[i]).toBe((buf[i] as number) ^ slowMul(0x8e, src[i] as number));
    }
    const f = src.slice();
    mulAssign(f, 0x1d);
    for (let i = 0; i < f.length; i++) expect(f[i]).toBe(slowMul(0x1d, src[i] as number));
    expect(() => addAssign(new Uint8Array(2), new Uint8Array(3))).toThrow();
  });
});
