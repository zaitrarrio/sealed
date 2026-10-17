/** Reference vectors for detect.ts and refine.ts (crates/sealed-facet/tests/parity_detect.rs): unit-level functions. */
import { linearLuma, sampleLuma, gridSizesFor, anchorCenterPoints, pixelsPerCell, type CornerSet } from "../../src/facet/detect";
import { homographyFrom4 } from "../../src/facet/homography";
import { Xorshift32 } from "../../src/facet/random";
import type { RgbaImage } from "../../src/facet/types";
import { b64, print } from "./util";

const nan = (v: number): number | null => (Number.isNaN(v) ? null : v);

// --- linearLuma -------------------------------------------------------------------------------------------------

const W = 37;
const H = 23;
const rng = new Xorshift32(0x5eed);
const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = rng.next() & 0xff;
  rgba[i * 4 + 1] = rng.next() & 0xff;
  rgba[i * 4 + 2] = rng.next() & 0xff;
  rgba[i * 4 + 3] = 255;
}
// A few exact extremes.
rgba.set([0, 0, 0, 255], 0);
rgba.set([255, 255, 255, 255], 4);
rgba.set([255, 0, 0, 255], 8);
rgba.set([0, 255, 0, 255], 12);
rgba.set([0, 0, 255, 255], 16);
const img: RgbaImage = { width: W, height: H, data: new Uint8ClampedArray(rgba.buffer) };
const luma = linearLuma(img);

// --- sampleLuma -------------------------------------------------------------------------------------------------

const probes: [number, number][] = [
  [0, 0],
  [0.5, 0.5],
  [0.25, 0.75],
  [1, 1],
  [3.3, 7.7],
  [12.49, 5.51],
  [W - 0.5, H - 0.5],
  [W - 0.5000001, H - 0.5000001],
  [W, H],
  [W + 1, 2],
  [-1, 2],
  [18.5, 11.5],
  [19.125, 11.875],
];
const samples = probes.map(([u, v]) => nan(sampleLuma(luma, u, v)));
// Degenerate planes (1 pixel wide / tall).
const thin: { width: number; height: number; data: number[]; probes: [number, number][] }[] = [
  { width: 1, height: 5, data: [0.1, 0.2, 0.4, 0.8, 1.0], probes: [[0.5, 0.5], [0.5, 2.75], [0.5, 4.5], [0.6, 1], [1.5, 1]] },
  { width: 4, height: 1, data: [0.9, 0.3, 0.6, 0.0], probes: [[0.5, 0.5], [2.25, 0.5], [3.5, 0.5], [3.6, 0.5], [1, 1]] },
  { width: 1, height: 1, data: [0.42], probes: [[0.5, 0.5], [0.6, 0.5]] },
];
const thinOut = thin.map((t) => ({
  ...t,
  samples: t.probes.map(([u, v]) => nan(sampleLuma({ width: t.width, height: t.height, data: Float32Array.from(t.data) }, u, v))),
}));

// --- gridSizesFor / anchorCenterPoints / pixelsPerCell ---------------------------------------------------------

const sets: CornerSet[] = [
  { points: [[100, 100], [600, 100], [600, 600], [100, 600]], unit: 5, score: 40 },
  { points: [[100, 100], [600, 100], [600, 600], [100, 600]], unit: 3.6, score: 40 },
  { points: [[100, 100], [600, 100], [600, 600], [100, 600]], unit: 4.0625, score: 40 },
  { points: [[155.6, 232.2], [730.8, 159.2], [853.1, 730], [274.7, 813]], unit: 5.5459, score: 55 },
  { points: [[10, 10], [20, 11], [21, 22], [9, 20]], unit: 0.5, score: 8 },
  { points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], unit: 7.5, score: 12 },
];
const sizes = sets.map((s) => gridSizesFor(s));
const centers = [112, 144, 7, 0].map((n) => anchorCenterPoints(n));
const hs: number[][] = [
  Array.from(homographyFrom4([[4, 4], [108, 4], [108, 108], [4, 108]], [[155.6, 232.2], [730.8, 159.2], [853.1, 730], [274.7, 813]]) as Float64Array),
  Array.from(homographyFrom4([[4, 4], [140, 4], [140, 140], [4, 140]], [[100, 100], [600, 100], [600, 600], [100, 600]]) as Float64Array),
  [2, 0.1, 30, -0.1, 2.2, 40, 0.0005, -0.0003, 1],
  [5, 0, 10, 0, 5, 10, -0.02, 0, 1],
];
const ppc = hs.flatMap((h) => [112, 144].map((n) => ({ h, n, ppc: nan(pixelsPerCell(Float64Array.from(h), n)) })));

print({
  image: { width: W, height: H, rgba: b64(rgba) },
  luma: b64(luma.data),
  probes,
  samples,
  thin: thinOut,
  sets,
  sizes,
  centers,
  ppc,
});
