/**
 * End-to-end reference vector for detect.ts + refine.ts (crates/sealed-facet/tests/parity_detect.rs): a T1 frame
 * rendered by FacetSender, captured by the simulated camera, and the detector's corner sets, the coarse grid
 * homography and the model-based refinement. The capture's RGBA goes to detect-e2e.rgba next to the JSON.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareBenchmarkStream } from "../../src/facet/bench";
import { cellSizeFor } from "../../src/facet/render";
import { CameraChannel } from "../../test/facet/channel";
import { GridDetector, gridHomography, gridSizesFor, pixelsPerCell } from "../../src/facet/detect";
import { anchorPoints, refineHomography } from "../../src/facet/refine";
import { gridLayout } from "../../src/facet/layout";
import { Xorshift32 } from "../../src/facet/random";
import type { RgbaImage } from "../../src/facet/types";
import { b64, fnv, print } from "./util";

const outBin = process.argv[2] ?? resolve(process.cwd(), "../../crates/sealed-facet/tests/vectors/detect-e2e.rgba");
const tier = 1;
const n = 112;
const sigma = 0.35;
const framePx = 580;
const { sender } = await prepareBenchmarkStream({ size: 8 * 1024, tier, seed: 41 });
const channel = new CameraChannel({ seed: 23, width: 576, height: 576, blurCells: 0.3, maxRotationDeg: 8, dropRate: 0, scale: [0.9, 1.0] });
let frame = sender.next();
// Skip to a data frame (calibration and descriptor frames come first).
for (let i = 0; i < 12 && frame.type !== "data"; i++) frame = sender.next();
const rendered = sender.render(frame, framePx);
const cap = channel.capture(rendered, cellSizeFor(framePx, n)).image;
writeFileSync(outBin, Buffer.from(cap.data.buffer, cap.data.byteOffset, cap.data.byteLength));

const det = new GridDetector();
const sets = det.detect(cap);
const luma = det.luma;
if (!luma || sets.length === 0) throw new Error("detector found nothing; adjust the capture");
const perSet = sets.map((set) => {
  const sizes = gridSizesFor(set);
  const hs = sizes.map((sz) => {
    const h = gridHomography(set, sz, luma);
    return { n: sz, h: h ? Array.from(h) : null, ppc: h ? pixelsPerCell(h, sz) : null };
  });
  return { points: set.points.map((p) => [p[0], p[1]]), unit: set.unit, score: set.score, sizes, hs };
});
const coarse = gridHomography(sets[0]!, n, luma)!;
const refined = refineHomography(luma, coarse, anchorPoints(gridLayout(tier), sigma));
// Refinement from a deliberately perturbed start, and with a tiny translation (must converge to about the same).
const perturbed = Float64Array.from(coarse);
perturbed[2] += 1.5;
perturbed[5] -= 1.0;
perturbed[0] *= 1.01;
const refined2 = refineHomography(luma, perturbed, anchorPoints(gridLayout(tier), sigma));
// Degenerate: homography far outside the image.
const far = Float64Array.from(coarse);
far[2] += 5000;
const refinedFar = refineHomography(luma, far, anchorPoints(gridLayout(tier), sigma));
// Second detection on the same detector (buffer reuse must not change anything).
const again = det.detect(cap);
const sameAgain = again.length === sets.length && again.every((s, i) => s.unit === sets[i]!.unit && s.score === sets[i]!.score && s.points.every((p, k) => p[0] === sets[i]!.points[k]![0] && p[1] === sets[i]!.points[k]![1]));

// Negative cases: noise and a too-small image.
const rng = new Xorshift32(77);
const noise = new Uint8Array(64 * 64 * 4);
for (let i = 0; i < noise.length; i++) noise[i] = (i & 3) === 3 ? 255 : rng.next() & 0xff;
const noiseImg: RgbaImage = { width: 64, height: 64, data: new Uint8ClampedArray(noise.buffer) };
const noiseSets = new GridDetector().detect(noiseImg);
const tiny: RgbaImage = { width: 31, height: 40, data: new Uint8ClampedArray(31 * 40 * 4).fill(200) };
const tinySets = new GridDetector().detect(tiny);
// Uniform dark image: white level below the floor.
const dark: RgbaImage = { width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4).fill(10) };
const darkSets = new GridDetector().detect(dark);

const out = (r: ReturnType<typeof refineHomography>) => (r ? { h: Array.from(r.h), rms: r.rms, used: r.used, adopted: r.rms < 0.35 } : null);
print({
  tier,
  n,
  sigma,
  capture: { width: cap.width, height: cap.height, file: "detect-e2e.rgba", fnv: fnv(cap.data) },
  luma: { width: luma.width, height: luma.height, fnv: fnv(luma.data), sum: Array.from(luma.data).reduce((a, v) => a + v, 0) },
  sets: perSet,
  coarse: Array.from(coarse),
  refined: out(refined),
  perturbed: Array.from(perturbed),
  refined2: out(refined2),
  far: Array.from(far),
  refinedFar: out(refinedFar),
  sameAgain,
  noise: { rgba: b64(noise), sets: noiseSets.length },
  tiny: tinySets.length,
  dark: darkSets.length,
});
