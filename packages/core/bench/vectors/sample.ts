/** Reference vectors for sample.ts (crates/sealed-facet/tests/parity_geometry.rs). */
import { homographyFrom4 } from "../../src/facet/homography";
import { LINEAR_LUT, CODE_LUT, sampleCells, gridToImage, type ChannelLut } from "../../src/facet/sample";
import { Xorshift32 } from "../../src/facet/random";
import type { RgbaImage } from "../../src/facet/types";
import { b64, print } from "./util";

const arr = (a: ArrayLike<number> | null): number[] | null => (a ? Array.from(a) : null);
const pt = (p: [number, number]): (number | null)[] => p.map((v) => (Number.isNaN(v) ? null : v));
const probes: [number, number][] = [
  [0, 0],
  [6, 6],
  [12, 12],
  [-3, 7.5],
  [100, -40],
  [1e3, 1e3],
];

// --- sample ------------------------------------------------------------------------------------------------

const W = 96;
const Hh = 96;
const ri = new Xorshift32(0x1a6e);
const img = new Uint8Array(W * Hh * 4);
for (let y = 0; y < Hh; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    img[o] = Math.min(255, Math.floor((x * 255) / 95) + ri.below(24));
    img[o + 1] = Math.min(255, Math.floor((y * 255) / 95) + ri.below(24));
    img[o + 2] = Math.min(255, Math.floor(((x + y) * 255) / 190) + ri.below(24));
    img[o + 3] = 255;
  }
}
const image: RgbaImage = { width: W, height: Hh, data: new Uint8ClampedArray(img.buffer) };
const gridN = 12;
const sampleQuads: { label: string; h: number[] }[] = [
  {
    label: "inside",
    h: arr(
      homographyFrom4(
        [
          [0, 0],
          [gridN, 0],
          [gridN, gridN],
          [0, gridN],
        ],
        [
          [6.3, 5.1],
          [89.2, 7.7],
          [91.5, 90.4],
          [4.2, 87.9],
        ],
      ),
    ) as number[],
  },
  {
    label: "partly outside",
    h: arr(
      homographyFrom4(
        [
          [0, 0],
          [gridN, 0],
          [gridN, gridN],
          [0, gridN],
        ],
        [
          [-10, 5],
          [80, -3],
          [100, 90],
          [3, 100],
        ],
      ),
    ) as number[],
  },
  { label: "behind camera", h: [7, 0, 10, 0, 7, 10, -0.08, 0, 1] },
];
const subset = Uint32Array.from([0, 1, 5, 17, 66, 77, 78, 100, 143, 60, 61]);
const luts: [string, ChannelLut][] = [
  ["linear", LINEAR_LUT],
  ["code", CODE_LUT],
];
const sampleRuns = sampleQuads.flatMap((q) =>
  luts.flatMap(([lutName, lut]) =>
    [null, subset].map((cells) => {
      const s = sampleCells(image, Float64Array.from(q.h), gridN, lut, cells ?? undefined);
      return { label: q.label, lut: lutName, cells: cells ? Array.from(cells) : null, feat: b64(s.feat), valid: b64(s.valid) };
    }),
  ),
);
const overlay = probes.map((p) => pt(gridToImage(Float64Array.from(sampleQuads[1]!.h), p[0], p[1])));

print({ width: W, height: Hh, rgba: b64(img), n: gridN, quads: sampleQuads, lutLinear: b64(LINEAR_LUT), lutCode: b64(CODE_LUT), runs: sampleRuns, overlay });
