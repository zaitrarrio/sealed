/**
 * Reference vectors for calibrate.ts, equalize.ts, vamp.ts and decode.ts helpers
 * (crates/sealed-facet/tests/parity_decode.rs).
 */
import { DEFAULT_SIGMA, WHITE_EXCESS, correctFeatures, defaultCalibration, fitToneLut } from "../../src/facet/calibrate";
import { fuseStats, payloadMatchesHeader, type HeaderCandidate } from "../../src/facet/decode";
import { DEFAULT_EP_OPTIONS, detectFromStats, epDetect, type EpProblem } from "../../src/facet/equalize";
import { glyphFills } from "../../src/facet/glyphs";
import { encodeFrameHeader, parseFrameHeader } from "../../src/facet/header";
import { EDGE_CLASSES, edgeClass, newSourceGrid, predictFeatures, responseModel, spreadGrams } from "../../src/facet/model";
import { paletteExcess } from "../../src/facet/palette";
import { Xorshift32 } from "../../src/facet/random";
import type { CellSamples } from "../../src/facet/sample";
import { DEFAULT_VAMP_OPTIONS, halfCellOperator, symmetricEigen, vampDetect, type VampProblem } from "../../src/facet/vamp";
import { b64, print } from "./util";

const f64 = (a: ArrayLike<number>) => Array.from(a);
const rng = new Xorshift32(0x5ea1);
/** Uniform in [0, 1). */
const unit = () => rng.next() / 4294967296;
/** Standard normal (Box–Muller). */
const gauss = () => {
  const u = Math.max(unit(), 1e-12);
  const v = unit();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// --- calibrate ----------------------------------------------------------------------------------------------

const dc = defaultCalibration();
const calibration = { whiteExcess: f64(WHITE_EXCESS), defaultSigma: DEFAULT_SIGMA, x: f64(dc.x), sigma: dc.sigma, fitted: dc.fitted, rmsNaN: Number.isNaN(dc.rms), lut: b64(dc.lut) };

const sampleN = 6;
const feat = new Float32Array(sampleN * sampleN * 12);
const valid = new Uint8Array(sampleN * sampleN).fill(1);
for (let i = 0; i < feat.length; i++) feat[i] = unit() * 1.2 - 0.1;
for (const c of [3, 17, 30]) {
  valid[c] = 0;
  feat.fill(NaN, c * 12, c * 12 + 12);
}
const samples: CellSamples = { n: sampleN, feat, valid };
const xRand = Float64Array.from({ length: 12 }, () => unit() * 2 - 1);
const correct = { n: sampleN, feat: b64(feat), valid: b64(valid), x: f64(xRand), out: b64(correctFeatures(samples, xRand)) };

const toneCases: { name: string; points: { code: number[]; target: number[] }[]; lut: string | null }[] = [];
const tonePoint = (level: number, gamma: number, noise: number) => {
  const code = [0, 1, 2].map((ch) => Math.min(1, Math.max(0, Math.pow(level, 1 / gamma) * (0.9 + 0.03 * ch) + noise * gauss())));
  const target = [0, 1, 2].map((ch) => level * (WHITE_EXCESS[ch] as number) + 0.01 * ch);
  return { code, target };
};
{
  const levels = [0, 0.02, 0.05, 0.1, 0.16, 0.24, 0.33, 0.44, 0.57, 0.72, 0.86, 1, 1, 0.86, 0.72, 0.57, 0.44, 0.33, 0.24, 0.16, 0.1, 0.05, 0.02, 0];
  const pts = levels.map((l) => tonePoint(l, 2.2, 0.004));
  toneCases.push({ name: "ramp", points: pts, lut: ((v) => (v ? b64(v) : null))(fitToneLut(pts)) });
  // Duplicated abscissae (merged) and a glitch that PAV must pool.
  const dup = pts.concat([pts[5]!, pts[5]!, { code: pts[7]!.code, target: pts[7]!.target.map((t) => t * 0.6) }]);
  toneCases.push({ name: "duplicates", points: dup, lut: ((v) => (v ? b64(v) : null))(fitToneLut(dup)) });
  const few = pts.slice(0, 5);
  toneCases.push({ name: "too-few", points: few, lut: ((v) => (v ? b64(v) : null))(fitToneLut(few)) });
  const flat = pts.map((p) => ({ code: [0.5, 0.5, 0.5], target: p.target }));
  toneCases.push({ name: "flat", points: flat, lut: ((v) => (v ? b64(v) : null))(fitToneLut(flat)) });
  const decreasing = pts.map((p) => ({ code: p.code, target: p.target.map((t) => -t) }));
  toneCases.push({ name: "decreasing", points: decreasing, lut: ((v) => (v ? b64(v) : null))(fitToneLut(decreasing)) });
}

// --- symmetric eigen ----------------------------------------------------------------------------------------

const eigenCases: { n: number; a: string; values: string; vectors: string }[] = [];
const symmetric = (n: number, gen: (i: number, j: number) => number) => {
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = gen(i, j);
      a[i * n + j] = v;
      a[j * n + i] = v;
    }
  }
  return a;
};
for (const n of [1, 2, 3, 5, 9, 16]) {
  const a = symmetric(n, () => gauss());
  const { values, vectors } = symmetricEigen(a, n);
  eigenCases.push({ n, a: b64(a), values: b64(values), vectors: b64(vectors) });
}
{
  const a = symmetric(4, (i, j) => (i === j ? 2 : 0));
  const { values, vectors } = symmetricEigen(a, 4);
  eigenCases.push({ n: 4, a: b64(a), values: b64(values), vectors: b64(vectors) });
}
{
  const a = new Float64Array(9);
  const { values, vectors } = symmetricEigen(a, 3);
  eigenCases.push({ n: 3, a: b64(a), values: b64(values), vectors: b64(vectors) });
}
{
  // Gram of a random 6 × 6 (PSD, as the operator's normal matrix).
  const g = Array.from({ length: 36 }, () => gauss());
  const a = symmetric(6, (i, j) => {
    let s = 0;
    for (let r = 0; r < 6; r++) s += (g[r * 6 + i] as number) * (g[r * 6 + j] as number);
    return s;
  });
  const { values, vectors } = symmetricEigen(a, 6);
  eigenCases.push({ n: 6, a: b64(a), values: b64(values), vectors: b64(vectors) });
}

// --- half-cell operator -------------------------------------------------------------------------------------

const operators = [
  { sigma: 0.35, n: 6 },
  { sigma: 0.6, n: 12 },
].map(({ sigma, n }) => {
  const op = halfCellOperator(responseModel(sigma), n);
  return { sigma, n, m: op.m, a: b64(op.a), v: b64(op.v), vt: b64(op.vt), lambda: b64(op.lambda) };
});

// --- synthetic detection problem ----------------------------------------------------------------------------

const n = 12;
const sigma = 0.45;
const model = responseModel(sigma);
const centroids = paletteExcess(1);
const K = centroids.length / 3;
const fills = glyphFills(K);
const src = newSourceGrid(n);
const truth = new Uint8Array(n * n);
const unknown: number[] = [];
for (let c = 0; c < n * n; c++) {
  const x = c % n;
  const y = (c - x) / n;
  // A known light border (anchors, zero in the residual) around an unknown interior, plus a few known interior cells.
  const known = x === 0 || y === 0 || x === n - 1 || y === n - 1 || c % 17 === 0;
  if (known) continue;
  unknown.push(c);
  const sym = rng.below(K * 16);
  truth[c] = sym;
  const k = sym >> 4;
  const s = sym & 15;
  for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) src.q[c * 12 + q * 3 + ch] = (fills[s * 4 + q] as number) * (centroids[k * 3 + ch] as number);
}
const clean = predictFeatures(model, src);
const noiseSigma = 0.03;
const y = new Float32Array(clean.length);
for (let i = 0; i < y.length; i++) y[i] = (clean[i] as number) + noiseSigma * gauss();
const noiseVariance = noiseSigma * noiseSigma;
const cells = Int32Array.from(unknown);
const grams = spreadGrams(model, n);
const classes = new Uint8Array(n * n);
for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++) classes[yy * n + xx] = edgeClass(yy, n) * EDGE_CLASSES + edgeClass(xx, n);

const epProblem: EpProblem = { n, model, y, cells, grams, classes, centroids, noiseVariance };
const ep = epDetect(epProblem);
const epRounds: { round: number; sym: string }[] = [];
const epCheckpoints = epDetect(epProblem, {
  ...DEFAULT_EP_OPTIONS,
  checkpoints: [2, 5],
  onRound: (round, sym) => {
    epRounds.push({ round, sym: b64(sym) });
    return round === 2;
  },
});
const epShort = epDetect(epProblem, { rounds: 2, cgIterations: [6], damping: 0.7, minVariance: 1e-5, cgTolerance: 1e-3 });
const fused = detectFromStats(
  ep.stats,
  Float64Array.from(grams, (g) => g / noiseVariance),
  Uint8Array.from(cells, (c) => classes[c] as number),
  centroids,
);

const vampProblem: VampProblem = { n, model, y, cells, centroids, noiseVariance };
const vamp = vampDetect(vampProblem);
const vampIterations: { iteration: number; sym: string; margin: string }[] = [];
const vampEarly = vampDetect(vampProblem, {
  ...DEFAULT_VAMP_OPTIONS,
  onIteration: (it, sym, margin) => {
    vampIterations.push({ iteration: it, sym: b64(sym), margin: b64(margin) });
    return it === 3;
  },
});
const vampDamped = vampDetect(vampProblem, { iterations: 5, damping: 0.8 });

const detection = {
  n,
  sigma,
  noiseVariance,
  y: b64(y),
  cells: Array.from(cells),
  truth: b64(truth),
  centroids: b64(centroids),
  grams: b64(grams),
  classes: b64(classes),
  ep: { sym: b64(ep.sym), margin: b64(ep.margin), stats: b64(ep.stats), rounds: ep.rounds },
  epCheckpoints: { sym: b64(epCheckpoints.sym), margin: b64(epCheckpoints.margin), rounds: epCheckpoints.rounds, calls: epRounds },
  epShort: { sym: b64(epShort.sym), margin: b64(epShort.margin), stats: b64(epShort.stats), rounds: epShort.rounds },
  fromStats: { sym: b64(fused.sym), margin: b64(fused.margin) },
  vamp: { sym: b64(vamp.sym), margin: b64(vamp.margin), iterations: vamp.iterations },
  vampEarly: { sym: b64(vampEarly.sym), margin: b64(vampEarly.margin), iterations: vampEarly.iterations, calls: vampIterations },
  vampDamped: { sym: b64(vampDamped.sym), margin: b64(vampDamped.margin), iterations: vampDamped.iterations },
};

// --- fusion + header CRC ------------------------------------------------------------------------------------

const fa = { b: Float32Array.from({ length: 24 }, () => gauss()), m: Float64Array.from({ length: 32 }, () => gauss()), captures: 1 };
const fb = { b: Float32Array.from({ length: 24 }, () => gauss()), m: Float64Array.from({ length: 32 }, () => gauss()), captures: 2 };
const fab = fuseStats(fa, fb);
const fusion = { a: { b: b64(fa.b), m: b64(fa.m), captures: fa.captures }, b: { b: b64(fb.b), m: b64(fb.m), captures: fb.captures }, out: { b: b64(fab.b), m: b64(fab.m), captures: fab.captures } };

const payload = Uint8Array.from({ length: 300 }, () => rng.next() & 0xff);
const headerBytes = encodeFrameHeader({ tier: 1, type: "data", loop: false, signed: true, streamId: Uint8Array.from([1, 2, 3, 4]), sbn: 5, esi: 0x010203 }, payload);
const candidate: HeaderCandidate = { bytes: headerBytes, header: parseFrameHeader(headerBytes)!, strip: "bottom" };
const altered = Uint8Array.from(payload);
altered[10] ^= 1;
const tail = Uint8Array.from(payload);
tail[200] ^= 1;
const crc = {
  header: b64(headerBytes),
  payload: b64(payload),
  matches: payloadMatchesHeader(candidate, payload),
  altered: payloadMatchesHeader(candidate, altered),
  tail: payloadMatchesHeader(candidate, tail),
  truncated: payloadMatchesHeader(candidate, payload.subarray(0, 40)),
};

print({ calibration, correct, tone: toneCases, eigen: eigenCases, operators, detection, fusion, crc });
