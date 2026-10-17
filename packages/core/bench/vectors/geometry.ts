/** Reference vectors for homography.ts and model.ts (crates/sealed-facet/tests/parity_geometry.rs). */
import { solveLinear, homographyFrom4, project, compose, invert, type Homography } from "../../src/facet/homography";
import {
  ISI_RADIUS,
  SPAN,
  SAMPLE_OFFSETS,
  erf,
  normCdf,
  boxResponse,
  responseModel,
  newSourceGrid,
  predictFeatures,
  selfFeatures,
  adjointFeatures,
  edgeClass,
  EDGE_CLASSES,
  spreadGrams,
  NormalOperator,
} from "../../src/facet/model";
import { Xorshift32 } from "../../src/facet/random";
import { b64, print } from "./util";

const arr = (a: ArrayLike<number> | null): number[] | null => (a ? Array.from(a) : null);
const pt = (p: [number, number]): (number | null)[] => p.map((v) => (Number.isNaN(v) ? null : v));
const uniform = (r: Xorshift32): number => r.next() / 4294967296;

// --- homography --------------------------------------------------------------------------------------------

const linearCases = [
  { label: "3x3", n: 3, a: [4, 1, 2, 1, 5, 1, 2, 1, 6], b: [1, 2, 3] },
  { label: "4x4 pivoting", n: 4, a: [0, 2, 1, 3, 1, 0, 4, 1, 2, 3, 0, 5, 1, 1, 1, 0], b: [10, 7, 3, 1] },
  { label: "1x1", n: 1, a: [2.5], b: [5] },
  { label: "2x2 singular", n: 2, a: [1, 2, 2, 4], b: [1, 2] },
  { label: "3x3 rank 2", n: 3, a: [1, 2, 3, 4, 5, 6, 7, 8, 9], b: [1, 1, 1] },
  { label: "zero pivot column", n: 2, a: [0, 1, 0, 2], b: [1, 2] },
  { label: "tiny pivot", n: 2, a: [1e-13, 0, 0, 1], b: [1, 1] },
  { label: "nan", n: 2, a: [NaN, 0, 0, 1], b: [1, 1] },
];
const solveLinear_ = linearCases.map((c) => ({
  label: c.label,
  n: c.n,
  a: c.a.map((v) => (Number.isNaN(v) ? null : v)),
  b: c.b,
  x: arr(solveLinear(Float64Array.from(c.a), Float64Array.from(c.b), c.n)),
}));

type Quad = [[number, number], [number, number], [number, number], [number, number]];
const unit: Quad = [
  [0, 0],
  [12, 0],
  [12, 12],
  [0, 12],
];
const quadCases: { label: string; src: Quad; dst: Quad }[] = [
  { label: "identity", src: unit, dst: unit },
  {
    label: "affine",
    src: unit,
    dst: [
      [10, 20],
      [94, 26],
      [88, 110],
      [4, 104],
    ],
  },
  {
    label: "perspective",
    src: unit,
    dst: [
      [155.6, 232.2],
      [730.8, 159.2],
      [853.1, 730],
      [120.5, 801.3],
    ],
  },
  {
    label: "strong keystone",
    src: unit,
    dst: [
      [30, 10],
      [70, 10],
      [95, 90],
      [5, 90],
    ],
  },
  {
    label: "three collinear",
    src: unit,
    dst: [
      [0, 0],
      [10, 10],
      [20, 20],
      [5, 50],
    ],
  },
  {
    label: "duplicate point",
    src: unit,
    dst: [
      [0, 0],
      [10, 0],
      [10, 0],
      [0, 10],
    ],
  },
  {
    label: "degenerate source",
    src: [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    dst: unit,
  },
];
const probes: [number, number][] = [
  [0, 0],
  [6, 6],
  [12, 12],
  [-3, 7.5],
  [100, -40],
  [1e3, 1e3],
];
const homographyFrom4_ = quadCases.map((c) => {
  const h = homographyFrom4(c.src, c.dst);
  return {
    label: c.label,
    src: c.src,
    dst: c.dst,
    h: arr(h),
    project: h ? probes.map((p) => pt(project(h, p[0], p[1]))) : null,
    inv: h ? arr(invert(h)) : null,
    hInvH: h && invert(h) ? arr(compose(h, invert(h) as Homography)) : null,
    invHH: h && invert(h) ? arr(compose(invert(h) as Homography, h)) : null,
  };
});

const r = new Xorshift32(0x6e0a);
const randomH = (): Homography => {
  const h = new Float64Array(9);
  for (let i = 0; i < 6; i++) h[i] = (uniform(r) - 0.5) * 40;
  h[6] = (uniform(r) - 0.5) * 0.02;
  h[7] = (uniform(r) - 0.5) * 0.02;
  h[8] = 1;
  return h;
};
const composeCases = Array.from({ length: 6 }, () => {
  const a = randomH();
  const b = randomH();
  const ab = compose(a, b);
  return { a: arr(a), b: arr(b), ab: arr(ab), ba: arr(compose(b, a)), invA: arr(invert(a)), invAb: arr(invert(ab)) };
});
const invertSpecial = [
  { label: "singular", h: [1, 2, 3, 2, 4, 6, 0, 0, 1] },
  { label: "h33 zero after adjugate", h: [0, 1, 0, 1, 0, 0, 0, 0, 1] },
  { label: "det tiny", h: [1e-8, 0, 0, 0, 1e-8, 0, 0, 0, 1e-8] },
  { label: "behind camera row", h: [1, 0, 0, 0, 1, 0, 0, 0, 0] },
].map((c) => ({ ...c, inv: arr(invert(Float64Array.from(c.h))) }));
const projectBehind = {
  h: [1, 0, 10, 0, 1, 10, -0.1, 0, 1],
  points: probes.map((p) => [p[0], p[1], ...pt(project(Float64Array.from([1, 0, 10, 0, 1, 10, -0.1, 0, 1]), p[0], p[1]))]),
};

// --- model -------------------------------------------------------------------------------------------------

const scalarX = [-3, -1.5, -0.7, -0.2, -1e-3, 0, 1e-3, 0.2, 0.7, 1.5, 3, 6];
const boxCases: [number, number, number, number][] = [
  [0, -0.5, 0, 0.35],
  [0.25, 0, 0.5, 0.35],
  [-0.4, -0.5, 0.5, 0.2],
  [1.3, -0.5, 0.5, 0.6],
  [0.1, 0, 0.5, 0],
  [0.5, 0, 0.5, 0],
  [-0.1, 0, 0.5, 5e-5],
  [2.9, 2.5, 3.5, 0.6],
];
const sigmas = [0.2, 0.35, 0.6, 0.0, 0.33337, 0.33333];
const models = sigmas.map((s) => {
  const m = responseModel(s);
  return { sigmaIn: s, sigma: m.sigma, gq: arr(m.gq), gf: arr(m.gf), w0: arr(m.w0), wf0: arr(m.wf0) };
});

const N = 12;
const src = newSourceGrid(N);
const rs = new Xorshift32(0x5ea1);
for (let i = 0; i < src.q.length; i++) src.q[i] = uniform(rs) < 0.6 ? uniform(rs) : 0;
for (let i = 0; i < src.f.length; i++) src.f[i] = uniform(rs) < 0.3 ? uniform(rs) * 1.2 : 0;
const feat = new Float32Array(N * N * 12);
for (let i = 0; i < feat.length; i++) feat[i] = uniform(rs) * 2 - 0.5;
// NaN holes exercise the adjoint's skip path.
const holes = [0, 13, 77, 143];
for (const c of holes) for (let i = 0; i < 12; i++) feat[c * 12 + i] = NaN;
const gridRuns = [0.35, 0.6].map((s) => {
  const m = responseModel(s);
  const pred = predictFeatures(m, src);
  const selfAll = new Float32Array(N * N * 12);
  const tmp = new Float32Array(12);
  for (let c = 0; c < N * N; c++) {
    selfFeatures(m, src, c, tmp);
    selfAll.set(tmp, c * 12);
  }
  const adj = adjointFeatures(m, feat, N);
  const x = new Float32Array(N * N * 12);
  for (let i = 0; i < x.length; i++) x[i] = uniform(rs) * 2 - 1;
  const op = new NormalOperator(m, N);
  const normal = new Float32Array(N * N * 12);
  op.apply(x, normal);
  // Cross-check: W^T W x should match adjoint(predict(x)) up to float rounding (sanity for the generator).
  const gx = { n: N, q: x, f: new Float32Array(N * N * 3) };
  const ref = adjointFeatures(m, predictFeatures(m, gx), N);
  let maxDiff = 0;
  for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs((ref[i] as number) - (normal[i] as number)));
  if (maxDiff > 1e-4) throw new Error(`NormalOperator disagrees with adjoint∘predict: ${maxDiff}`);
  return { sigma: s, predict: b64(pred), self: b64(selfAll), adjoint: b64(adj), normalX: b64(x), normal: b64(normal), spreadGrams: arr(spreadGrams(m, N)), spreadGrams7: arr(spreadGrams(m, 7)) };
});
const edgeTable = [5, 7, 12, 112].map((n) => ({ n, cls: Array.from({ length: n }, (_, p) => edgeClass(p, n)) }));
// Small-grid NormalOperator (n < 2 · 2R + 1) exercises the overlapping edge classes.
const smallOp = (() => {
  const m = responseModel(0.35);
  const n = 5;
  const x = new Float32Array(n * n * 12);
  for (let i = 0; i < x.length; i++) x[i] = uniform(rs) * 2 - 1;
  const out = new Float32Array(n * n * 12);
  new NormalOperator(m, n).apply(x, out);
  return { n, x: b64(x), out: b64(out) };
})();

print({
  solveLinear: solveLinear_,
  homographyFrom4: homographyFrom4_,
  compose: composeCases,
  invertSpecial,
  projectBehind,
  constants: { ISI_RADIUS, SPAN, SAMPLE_OFFSETS: SAMPLE_OFFSETS.map((a) => Array.from(a)), EDGE_CLASSES },
  erf: scalarX.map((x) => [x, erf(x)]),
  normCdf: scalarX.map((x) => [x, normCdf(x)]),
  boxResponse: boxCases.map((c) => [...c, boxResponse(...c)]),
  models,
  grid: { n: N, q: b64(src.q), f: b64(src.f), feat: b64(feat), runs: gridRuns },
  edgeClass: edgeTable,
  smallOp,
});
