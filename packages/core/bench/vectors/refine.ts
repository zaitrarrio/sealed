/**
 * Reference vectors for refine.ts (crates/sealed-facet/tests/parity_detect.rs): refinePoints / anchorPoints per
 * tier at σ = 0.35. Grid coordinates are exact multiples of 1/8, stored as Int16 of xy × 8.
 */
import { refinePoints, anchorPoints } from "../../src/facet/refine";
import { gridLayout } from "../../src/facet/layout";
import { HEADER_BITS } from "../../src/facet/header";
import { Xorshift32 } from "../../src/facet/random";
import { b64, print } from "./util";

const tier = Number(process.argv[2] ?? "1") as 1 | 2 | 3;
const layout = gridLayout(tier);
const sigma = 0.35;

const xy16 = (xy: Float64Array): string => b64(Int16Array.from(xy, (v) => v * 8));

const anchors = anchorPoints(layout, sigma);
// anchorPoints rounds σ to 1/50 and caches; the same object comes back for a σ that rounds the same.
const cached = anchorPoints(layout, 0.3501) === anchors;
const direct = refinePoints(layout, sigma, null);
const sameAsDirect = direct.pred.length === anchors.pred.length && direct.pred.every((v, i) => v === anchors.pred[i]) && direct.xy.every((v, i) => v === anchors.xy[i]);

// With header strips: pseudo-random bits, strip order. The anchor points come first and are unchanged; the strip
// points follow. Stored subsampled (every 5th) to keep the file small.
const rng = new Xorshift32(0xbeef + tier);
const strips = Uint8Array.from({ length: HEADER_BITS }, () => rng.next() & 1);
const withStrips = refinePoints(layout, sigma, strips);
const base = anchors.pred.length;
const extra = withStrips.pred.length - base;
const every = 5;
const exXy: number[] = [];
const exPred: number[] = [];
for (let i = base; i < withStrips.pred.length; i += every) {
  exXy.push(withStrips.xy[2 * i] as number, withStrips.xy[2 * i + 1] as number);
  exPred.push(withStrips.pred[i] as number);
}
const prefixSame = anchors.pred.every((v, i) => v === withStrips.pred[i]) && anchors.xy.every((v, i) => v === withStrips.xy[i]);

// Different σ values change only the predictions; record a checksum-free small sample.
const sigmas = [0.0, 0.2, 0.6, 0.8].map((s) => {
  const p = refinePoints(layout, s, null);
  return { sigma: s, count: p.pred.length, first: Array.from(p.pred.subarray(0, 24)), sumPred: p.pred.reduce((a, v) => a + v, 0) };
});

print({
  tier,
  n: layout.n,
  sigma,
  anchors: { count: anchors.pred.length, xy8: xy16(anchors.xy), pred: b64(anchors.pred) },
  cached,
  sameAsDirect,
  strips: { bits: b64(strips), count: withStrips.pred.length, extra, every, xy8: xy16(Float64Array.from(exXy)), pred: b64(Float64Array.from(exPred)), prefixSame },
  sigmas,
});
