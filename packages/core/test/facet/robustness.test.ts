import { describe, expect, it } from "vitest";
import { FacetReceiver, FacetSender, type RgbaImage } from "../../src/facet/index";
import { Rng } from "./channel";

describe("Facet receiver robustness", () => {
  it("never throws on noise, black, white, tiny or partial frames", { timeout: 120_000 }, () => {
    const rng = new Rng(1);
    const r = new FacetReceiver();
    const make = (w: number, h: number, fill: (i: number) => number): RgbaImage => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 255 : fill(i);
      return { width: w, height: h, data };
    };
    const frames: RgbaImage[] = [make(640, 480, () => rng.int(256)), make(640, 480, () => 0), make(640, 480, () => 255), make(1, 1, () => 7), make(0, 0, () => 0)];
    const s = new FacetSender({ envelope: rng.bytes(5000), tier: 1, descriptor: { cek: rng.bytes(32) } });
    s.next();
    const full = s.render(s.next(), 600);
    const half = { width: 600, height: 300, data: full.data.slice(0, 600 * 300 * 4) };
    frames.push(half);
    for (const f of frames) expect(() => r.push(f)).not.toThrow();
    expect(r.progress.complete).toBe(false);
    expect(r.result()).toBeNull();
  });
});
