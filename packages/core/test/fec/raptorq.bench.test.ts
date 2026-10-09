import { describe, expect, it } from "vitest";
import { RaptorQDecoder, RaptorQEncoder, planOti } from "../../src/fec";

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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Targets: encode K=160,T=7240 (+40 repair) < 0.5 s; decode K=256,T=8280 from K+2 < 1.5 s.
// Asserted bounds are 3x the targets to absorb CI noise.
describe("RaptorQ performance", () => {
  it("encodes K=160, T=7240: all source + 40 repair symbols", () => {
    const r = prng(1);
    const T = 7240;
    const K = 160;
    const data = new Uint8Array(K * T).map(() => r() & 0xff);
    const oti = planOti(data.length, T, K);
    const t0 = performance.now();
    const enc = new RaptorQEncoder(data, oti);
    for (let esi = 0; esi < K + 40; esi++) enc.symbol(0, esi);
    const ms = performance.now() - t0;
    console.log(`encode K=160 T=7240 +40 repair: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1500);
  });

  it("decodes K=256, T=8280 from K+2 mixed source/repair symbols", () => {
    const r = prng(2);
    const T = 8280;
    const K = 256;
    const data = new Uint8Array(K * T).map(() => r() & 0xff);
    const oti = planOti(data.length, T, K);
    const enc = new RaptorQEncoder(data, oti);
    const pkts: [number, Uint8Array][] = [];
    // Drop every 3rd source symbol and fill with repair symbols up to K + 2.
    for (let esi = 0; esi < K; esi++) if (esi % 3 !== 1) pkts.push([esi, enc.symbol(0, esi)]);
    for (let esi = K; pkts.length < K + 2; esi++) pkts.push([esi, enc.symbol(0, esi)]);
    const dec = new RaptorQDecoder(oti);
    const t0 = performance.now();
    for (const [esi, sym] of pkts) dec.add(0, esi, sym);
    const ms = performance.now() - t0;
    console.log(`decode K=256 T=8280 from K+2 (${K - pkts.filter(([e]) => e < K).length} lost source): ${ms.toFixed(1)} ms`);
    const out = dec.result();
    expect(out).not.toBeNull();
    expect(sameBytes(out as Uint8Array, data)).toBe(true);
    expect(ms).toBeLessThan(4500);
  });
});
