/** Stage timings of the JavaScript grid decoder on simulated captures (`pnpm bench:profile`). */
import { prepareBenchmarkStream, type Tier } from "../src/index";
import { cellSizeFor } from "../src/facet/render";
import { CameraChannel } from "../test/facet/channel";
import { GridDetector, gridHomography, gridSizesFor } from "../src/facet/detect";
import { anchorPoints, refineHomography } from "../src/facet/refine";
import { gridLayout } from "../src/facet/layout";
import { paletteExcess } from "../src/facet/palette";
import { anchorCalibration, defaultCalibration } from "../src/facet/calibrate";
import { observe, decodeHeaders, decodeData } from "../src/facet/decode";
import { FacetReceiver } from "../src/facet/receiver";

const tier = Number(process.argv[2] ?? "1") as Tier;
const n = tier === 3 ? 144 : 112;
const { sender } = await prepareBenchmarkStream({ size: 64 * 1024, tier, seed: 1 });
const channel = new CameraChannel({ seed: 31, blurCells: 0.3, maxRotationDeg: 15, dropRate: 0 });
const cellPx = cellSizeFor(1000, n);
const full = new FacetReceiver({ tiers: [tier] });
const t: Record<string, number[]> = {};
const time = <T,>(k: string, f: () => T): T => {
  const a = performance.now();
  const r = f();
  (t[k] ??= []).push(performance.now() - a);
  return r;
};
for (let i = 0; i < 12; i++) {
  const frame = sender.next();
  const img = sender.render(frame, 1000);
  const cap = channel.capture(img, cellPx).image;
  const det = new GridDetector();
  const sets = time("detect", () => det.detect(cap));
  const luma = det.luma!;
  const set = sets[0];
  if (!set) {
    console.log("no corner set");
    continue;
  }
  const coarse = time("homography", () => gridHomography(set, n, luma))!;
  const layout = gridLayout(tier as 1 | 2 | 3);
  const h = time("refine", () => refineHomography(luma, coarse, anchorPoints(layout, 0.3)))?.h ?? coarse;
  const cal = time("calibrate", () => anchorCalibration(cap, h, layout, defaultCalibration()))!;
  const obs = time("observe", () => observe(cap, h, layout, cal, paletteExcess(tier as 1 | 2 | 3)))!;
  const cands = time("headers", () => decodeHeaders(obs));
  if (cands[0]) time("data", () => decodeData(obs, cands[0]!, null));
  time("receiver.push (all stages, real path)", () => full.push(cap, i * 100));
}
console.log(`T${tier}, ${cap(1000)} px captures, ms per frame (median of ${Object.values(t)[0]?.length}):`);
for (const [k, v] of Object.entries(t)) {
  const s = [...v].sort((a, b) => a - b);
  console.log(`  ${k.padEnd(40)} ${s[s.length >> 1]!.toFixed(1)}`);
}
function cap(x: number) {
  return x;
}
