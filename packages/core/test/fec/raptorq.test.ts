import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Oti } from "../../src/fec";
import { RaptorQDecoder, RaptorQEncoder, decodeOti, encodeOti, planOti } from "../../src/fec";

interface VecSymbol {
  esi: number;
  data: string;
}
interface VecBlock {
  sbn: number;
  k: number;
  symbols: VecSymbol[];
  decodeSet: VecSymbol[];
}
interface VecCase {
  name: string;
  oti: Oti;
  maxSourceSymbolsPerBlock: number;
  otiBytes: string;
  data: string;
  blocks: VecBlock[];
}
interface VecFile {
  raptorqVersion: string;
  cases: VecCase[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../vectors/raptorq.json", import.meta.url)), "utf8"),
) as VecFile;

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

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

function shuffle<T>(r: () => number, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = r() % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe("RaptorQ OTI", () => {
  it("round-trips the 12-byte layout including 40-bit F", () => {
    const oti: Oti = { transferLength: 942574504275, symbolSize: 65535, sourceBlocks: 255, subBlocks: 1, alignment: 1 };
    const b = encodeOti(oti);
    expect(b.length).toBe(12);
    expect(b[5]).toBe(0);
    expect(decodeOti(b)).toEqual(oti);
  });

  it("planOti computes Z = ceil(ceil(F/T) / maxK)", () => {
    expect(planOti(1000, 16, 10)).toEqual({ transferLength: 1000, symbolSize: 16, sourceBlocks: 7, subBlocks: 1, alignment: 8 });
    expect(planOti(64, 64, 10).sourceBlocks).toBe(1);
    expect(() => planOti(100, 12, 10)).toThrow(/multiple of alignment/);
    expect(planOti(100, 12, 10, 4).alignment).toBe(4);
  });

  it("rejects N != 1 with a clear error", () => {
    const oti: Oti = { transferLength: 1000, symbolSize: 16, sourceBlocks: 1, subBlocks: 2, alignment: 8 };
    expect(() => new RaptorQEncoder(new Uint8Array(1000), oti)).toThrow(/N=2/);
    expect(() => new RaptorQDecoder(oti)).toThrow(/sub-blocking/);
  });
});

describe(`RaptorQ cross-check vs raptorq ${vectors.raptorqVersion}`, () => {
  it("has at least 12 vector cases including multi-block and ragged F", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(12);
    expect(vectors.cases.some((c) => c.oti.sourceBlocks > 1)).toBe(true);
    expect(vectors.cases.some((c) => c.oti.transferLength % c.oti.symbolSize !== 0)).toBe(true);
  });

  for (const c of vectors.cases) {
    describe(c.name, () => {
      const data = fromHex(c.data);

      it("OTI planning and serialization match the reference", () => {
        const planned = planOti(c.oti.transferLength, c.oti.symbolSize, c.maxSourceSymbolsPerBlock, c.oti.alignment);
        expect(planned).toEqual(c.oti);
        expect(toHex(encodeOti(planned))).toBe(c.otiBytes);
        expect(decodeOti(fromHex(c.otiBytes))).toEqual(c.oti);
      });

      it("every source and repair symbol is bit-exact", () => {
        const enc = new RaptorQEncoder(data, c.oti);
        expect(enc.blockCount).toBe(c.blocks.length);
        for (const b of c.blocks) {
          expect(enc.sourceSymbolCount(b.sbn)).toBe(b.k);
          for (const s of b.symbols) {
            expect(toHex(enc.symbol(b.sbn, s.esi)), `sbn=${b.sbn} esi=${s.esi}`).toBe(s.data);
          }
          for (const s of b.decodeSet) {
            expect(toHex(enc.symbol(b.sbn, s.esi)), `sbn=${b.sbn} esi=${s.esi}`).toBe(s.data);
          }
        }
      });

      it("decodes from the shuffled K..K+3 reference symbol subset", () => {
        const dec = new RaptorQDecoder(c.oti);
        for (const b of c.blocks) {
          expect(dec.sourceSymbolCount(b.sbn)).toBe(b.k);
          expect(b.decodeSet.length).toBeGreaterThanOrEqual(b.k);
          expect(b.decodeSet.length).toBeLessThanOrEqual(b.k + 3);
          for (const s of b.decodeSet) dec.add(b.sbn, s.esi, fromHex(s.data));
        }
        expect(dec.isComplete()).toBe(true);
        const out = dec.result();
        expect(out).not.toBeNull();
        expect(toHex(out as Uint8Array)).toBe(c.data);
      });
    });
  }
});

describe("RaptorQ decoder behaviour", () => {
  it("ignores duplicates, reports progress and trims block data", () => {
    const r = prng(77);
    const F = 16 * 25 + 3;
    const data = new Uint8Array(F).map(() => r() & 0xff);
    const oti = planOti(F, 16, 13);
    expect(oti.sourceBlocks).toBe(2);
    const enc = new RaptorQEncoder(data, oti);
    const dec = new RaptorQDecoder(oti);
    const k0 = enc.sourceSymbolCount(0);
    const k1 = enc.sourceSymbolCount(1);
    expect(k0 + k1).toBe(26);
    expect(dec.add(0, k0 + 5, enc.symbol(0, k0 + 5))).toBe(false);
    expect(dec.add(0, k0 + 5, enc.symbol(0, k0 + 5))).toBe(false);
    expect(dec.receivedCount(0)).toBe(1);
    for (let esi = 1; esi < k0; esi++) dec.add(0, esi, enc.symbol(0, esi));
    expect(dec.isBlockComplete(0)).toBe(true);
    expect(dec.isComplete()).toBe(false);
    expect(dec.result()).toBeNull();
    for (let i = 0; i < k1 + 2; i++) dec.add(1, k1 + 100 + i, enc.symbol(1, k1 + 100 + i));
    expect(dec.isComplete()).toBe(true);
    expect(dec.blockData(1)?.length).toBe(F - k0 * 16);
    expect(dec.result()).toEqual(data);
  });

  it("retries as more symbols arrive after an insufficient attempt", () => {
    const r = prng(1234);
    const T = 8;
    const K = 10;
    const data = new Uint8Array(K * T).map(() => r() & 0xff);
    const oti = planOti(data.length, T, 100);
    const enc = new RaptorQEncoder(data, oti);
    const dec = new RaptorQDecoder(oti);
    let added = 0;
    let esi = K;
    while (!dec.isComplete()) {
      dec.add(0, esi, enc.symbol(0, esi));
      esi++;
      added++;
      expect(added).toBeLessThan(K + 20);
    }
    expect(dec.result()).toEqual(data);
  });

  it("property: decodes once K+2 symbols arrive under 30% random loss (>=199/200)", () => {
    let ok = 0;
    for (let trial = 0; trial < 200; trial++) {
      const r = prng(0x9e3779b9 ^ (trial * 2654435761));
      const K = 10 + (r() % 60);
      const T = 8 * (1 + (r() % 4));
      const F = K * T - (r() % T);
      const data = new Uint8Array(F).map(() => r() & 0xff);
      const oti = planOti(F, T, 1000);
      const enc = new RaptorQEncoder(data, oti);
      const k = enc.sourceSymbolCount(0);
      const dec = new RaptorQDecoder(oti);
      let received = 0;
      for (let esi = 0; esi < k * 4 && received < k + 2; esi++) {
        if (r() % 100 < 30) continue;
        dec.add(0, esi, enc.symbol(0, esi));
        received++;
      }
      const out = dec.result();
      if (out && out.length === F && out.every((v, i) => v === data[i])) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(199);
  });

  it("decodes random subsets of exactly K symbols most of the time", () => {
    let ok = 0;
    const trials = 60;
    for (let t = 0; t < trials; t++) {
      const r = prng(5000 + t);
      const K = 20 + (r() % 100);
      const T = 16;
      const data = new Uint8Array(K * T).map(() => r() & 0xff);
      const oti = planOti(data.length, T, 1000);
      const enc = new RaptorQEncoder(data, oti);
      const esis = shuffle(r, Array.from({ length: 3 * K }, (_, i) => i)).slice(0, K);
      const dec = new RaptorQDecoder(oti);
      for (const e of esis) dec.add(0, e, enc.symbol(0, e));
      if (dec.isComplete()) {
        expect(dec.result()).toEqual(data);
        ok++;
      }
    }
    // RFC 6330 targets < 1% failure at zero overhead; leave generous slack for small sample size.
    expect(ok).toBeGreaterThanOrEqual(trials - 4);
  });
});
