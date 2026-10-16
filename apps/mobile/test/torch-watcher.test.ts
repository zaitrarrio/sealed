import { describe, expect, it } from "vitest";
import { topBrightness } from "../src/lib/brightness";

describe("top brightness of a frame", () => {
  it("is the mean of the brightest 1 % of pixels, so a small torch spot dominates a dark frame", () => {
    const w = 100;
    const h = 100;
    const bpr = w * 4 + 16; // row padding
    const px = new Uint8Array(bpr * h).fill(20);
    // A 10×10 saturated spot (100 px = 1 % of the frame; the stride-2 sample sees 25 of 2500).
    for (let y = 40; y < 50; y++) for (let x = 40; x < 50; x++) px.set([255, 255, 255, 255], y * bpr + x * 4);
    expect(topBrightness(px, w, h, bpr, 4)).toBe(255);
    const dark = new Uint8Array(bpr * h).fill(20);
    expect(topBrightness(dark, w, h, bpr, 4)).toBe(20);
  });
  it("uses the brightest channel and copes with 3-byte RGB", () => {
    const w = 8;
    const h = 8;
    const px = new Uint8Array(w * h * 3).fill(0);
    for (let i = 0; i < px.length; i += 3) px[i + 2] = 200; // blue only
    expect(topBrightness(px, w, h, w * 3, 3)).toBe(200);
  });
});
