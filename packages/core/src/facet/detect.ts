/**
 * Anchor detection and homography estimation for Facet grid frames (spec §7.6 step 2).
 *
 * 1. Linear-light luma of the camera image, binarized against a local mean (integral image) with an absolute
 *    floor relative to the image's white level, so blurred one-cell dark bands stay dark.
 * 2. Every row is run-length encoded and searched for "light, interior, light" where the interior matches one of
 *    the four anchor interiors (layout.ts) by run ratios. Each row hit is cross-checked with a vertical scan
 *    through its center and a second horizontal scan through the vertical center, which rejects lines that do
 *    not pass through the anchor's central 2 × 2 cells. Verified hits are clustered per corner type.
 * 3. Candidate corner sets (one cluster per corner) are ranked by hit count and checked for convex geometry and
 *    consistent cell size; the grid size N is inferred from anchor spacing (and confirmed by the header later).
 * 4. Homography from the four anchor centers (DLT), then refined: along lines through each anchor center the
 *    receiver finds the band-1 → band-0 edges at ±3 cells with sub-pixel interpolation and re-centers the anchor.
 */
import type { RgbaImage } from "./types";
import { SRGB_TO_LINEAR_8 } from "./palette";
import { ANCHOR_CELLS, ANCHOR_INTERIOR_RUNS, type Corner } from "./layout";
import { TIERS } from "./tiers";
import { homographyFrom4, project, type Homography } from "./homography";

export interface LumaPlane {
  readonly width: number;
  readonly height: number;
  /** Linear-light luma (Rec. 709 weights over sRGB-decoded channels), 0..1. */
  readonly data: Float32Array;
}

export interface CornerSet {
  /** Image positions of the TL, TR, BR, BL anchor centers. */
  readonly points: readonly (readonly [number, number])[];
  /** Mean cell size in pixels estimated from the anchors' run lengths. */
  readonly unit: number;
  readonly score: number;
}

interface Match {
  a: number;
  b: number;
  corner: Corner;
  unit: number;
  err: number;
}

interface Cluster {
  corner: Corner;
  sx: number;
  sy: number;
  su: number;
  w: number;
}

const GRID_SIZES: readonly number[] = Array.from(new Set([TIERS[1].grid, TIERS[2].grid, TIERS[3].grid])).sort((a, b) => a - b);
const MIN_UNIT_PX = 2.5;
/** Largest per-run deviation (in cells) from an anchor template after fitting unit and erosion. */
const MAX_RUN_ERROR = 0.5;
/** Binarization windows as divisors of the shorter image side (radius = side / divisor), tried in order. */
const BIN_WINDOW_DIVISORS: readonly number[] = [64, 20];
/** Bounds the work on adversarial images (each row hit costs up to four line scans). */
const MAX_ROW_HITS = 60000;
const MAX_CLUSTERS = 4096;
/** Hits after which an anchor cluster stops accepting more (its center is already well averaged). */
const SATURATED_HITS = 24;

/** Linear luma of an RGBA image. */
export function linearLuma(img: RgbaImage, out?: Float32Array): LumaPlane {
  const n = img.width * img.height;
  const data = out && out.length === n ? out : new Float32Array(n);
  const d = img.data;
  const t = SRGB_TO_LINEAR_8;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    data[i] = 0.2126 * (t[d[p] as number] as number) + 0.7152 * (t[d[p + 1] as number] as number) + 0.0722 * (t[d[p + 2] as number] as number);
  }
  return { width: img.width, height: img.height, data };
}

/** Bilinear luma sample at continuous pixel coordinates (pixel i spans [i, i + 1]). NaN outside. */
export function sampleLuma(l: LumaPlane, u: number, v: number): number {
  const x = u - 0.5;
  const y = v - 0.5;
  if (!(x >= 0 && y >= 0 && x <= l.width - 1 && y <= l.height - 1)) return NaN;
  const x0 = Math.min(Math.floor(x), l.width - 2 < 0 ? 0 : l.width - 2);
  const y0 = Math.min(Math.floor(y), l.height - 2 < 0 ? 0 : l.height - 2);
  const fx = x - x0;
  const fy = y - y0;
  const w = l.width;
  const i = y0 * w + x0;
  const d = l.data;
  const x1 = l.width > 1 ? 1 : 0;
  const y1 = l.height > 1 ? w : 0;
  const a = d[i] as number;
  const b = d[i + x1] as number;
  const c = d[i + y1] as number;
  const e = d[i + y1 + x1] as number;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

/** Run-length encoding of a binary line. */
class Runs {
  start: Int32Array;
  len: Int32Array;
  val: Uint8Array;
  count = 0;
  constructor(cap: number) {
    this.start = new Int32Array(cap);
    this.len = new Int32Array(cap);
    this.val = new Uint8Array(cap);
  }
  encode(bin: Uint8Array, offset: number, stride: number, n: number): void {
    if (this.start.length < n + 1) {
      this.start = new Int32Array(n + 1);
      this.len = new Int32Array(n + 1);
      this.val = new Uint8Array(n + 1);
    }
    let c = 0;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const v = bin[offset + i * stride] as number;
      if (v !== prev) {
        this.start[c] = i;
        this.len[c] = 1;
        this.val[c] = v;
        c++;
        prev = v;
      } else {
        this.len[c - 1] = (this.len[c - 1] as number) + 1;
      }
    }
    this.count = c;
  }
}

/**
 * Fits the interior runs x_j (alternating dark, light, …, dark) to template t: x_j = t_j·u + s_j·2e, where s_j is
 * −1 for dark and +1 for light runs. `e` is the binarization erosion of dark bands (blur turns one-cell dark bands
 * into shallow dips that a local threshold cuts narrower; |2e| ≤ 0.7u). Returns the unit and the worst relative
 * residual, or null.
 */
function fitInterior(r: Runs, first: number, t: readonly number[]): { u: number; err: number; sum: number } | null {
  const m = t.length;
  let u: number;
  let e2 = 0;
  if (m === 1) {
    u = (r.len[first] as number) / (t[0] as number);
  } else {
    // Least squares in (u, 2e).
    let suu = 0;
    let sue = 0;
    let see = 0;
    let bu = 0;
    let be = 0;
    for (let j = 0; j < m; j++) {
      const tj = t[j] as number;
      const sj = j % 2 === 0 ? -1 : 1;
      const x = r.len[first + j] as number;
      suu += tj * tj;
      sue += tj * sj;
      see += 1;
      bu += tj * x;
      be += sj * x;
    }
    const det = suu * see - sue * sue;
    if (!(det > 1e-9)) return null;
    u = (bu * see - be * sue) / det;
    e2 = (suu * be - sue * bu) / det;
    if (!(u > 0)) return null;
    const lim = 0.7 * u;
    if (e2 > lim || e2 < -lim) {
      // Clamp the erosion and refit the unit alone.
      e2 = Math.max(-lim, Math.min(lim, e2));
      let num = 0;
      for (let j = 0; j < m; j++) num += (t[j] as number) * ((r.len[first + j] as number) - (j % 2 === 0 ? -1 : 1) * e2);
      u = num / suu;
    }
  }
  if (!(u > 0)) return null;
  let max = 0;
  let sum = 0;
  for (let j = 0; j < m; j++) {
    const pred = (t[j] as number) * u + (j % 2 === 0 ? -1 : 1) * e2;
    const err = Math.abs((r.len[first + j] as number) - pred) / u;
    sum += err;
    if (err > max) max = err;
  }
  return { u, err: max, sum };
}

/** Finds anchor-interior patterns in a run-length encoded line. `lumaAt(i)` gives the line's luma. */
function findMatches(r: Runs, lumaAt: (i: number) => number, white: number, maxUnit: number, out: Match[]): void {
  const cnt = r.count;
  for (let i = 0; i + 2 < cnt; i++) {
    if (r.val[i] !== 1) continue;
    for (const m of [1, 3, 5]) {
      const last = i + m + 1;
      if (last >= cnt) break;
      const a = r.start[i + 1] as number;
      const b = r.start[last] as number;
      const span = b - a;
      if (span < 6 * MIN_UNIT_PX * 0.7 || span > 6 * maxUnit) continue;
      let best: Corner | -1 = -1;
      let bestErr = Infinity;
      let bestU = 0;
      for (let c = 0; c < 4; c++) {
        const t = ANCHOR_INTERIOR_RUNS[c] as readonly number[];
        if (t.length !== m) continue;
        const f = fitInterior(r, i + 1, t);
        if (!f || f.err > MAX_RUN_ERROR || f.sum >= bestErr) continue;
        bestErr = f.sum;
        best = c as Corner;
        bestU = f.u;
      }
      if (best === -1) continue;
      const u = bestU;
      if (u < MIN_UNIT_PX || u > maxUnit) continue;
      const la = r.len[i] as number;
      const lb = r.len[last] as number;
      if (la < 0.45 * u || lb < 0.45 * u || Math.min(la, lb) > 2.6 * u) continue;
      // Wide dark runs must be genuinely dark (rejects dim glyph areas in the data region).
      let ok = true;
      for (let j = 0; j < m && ok; j += 2) {
        const s = r.start[i + 1 + j] as number;
        const l = r.len[i + 1 + j] as number;
        if (l < 2 * u) continue;
        let acc = 0;
        for (let k = 0; k < l; k++) acc += lumaAt(s + k);
        if (acc / l > 0.3 * white) ok = false;
      }
      if (!ok) continue;
      out.push({ a, b, corner: best, unit: u, err: bestErr });
    }
  }
}

export class GridDetector {
  private lumaBuf: Float32Array | null = null;
  private binBuf: Uint8Array | null = null;
  private integral: Float64Array | null = null;
  private readonly rowRuns = new Runs(2048);
  private readonly lineRuns = new Runs(512);
  private colBin = new Uint8Array(512);
  private colLuma = new Float32Array(512);

  /** Luma plane of the most recent `detect` call. */
  luma: LumaPlane | null = null;

  detect(img: RgbaImage): CornerSet[] {
    const W = img.width;
    const H = img.height;
    if (!(W >= 32 && H >= 32) || img.data.length < W * H * 4) return [];
    const n = W * H;
    if (!this.lumaBuf || this.lumaBuf.length !== n) {
      this.lumaBuf = new Float32Array(n);
      this.binBuf = new Uint8Array(n);
      this.integral = new Float64Array((W + 1) * (H + 1));
    }
    const luma = linearLuma(img, this.lumaBuf);
    this.luma = luma;
    const bin = this.binBuf as Uint8Array;
    const white = this.whiteLevel(luma);
    if (!(white > 0.05)) return [];
    this.integrate(luma);
    // Binarization window radii, smallest first: a window about two cells wide keeps the anchors' one-cell dark band
    // dark under heavy blur; the wider window serves large codes whose cells exceed the small window.
    const minSide = Math.min(W, H);
    const radii = Array.from(new Set(BIN_WINDOW_DIVISORS.map((d) => Math.max(4, Math.round(minSide / d)))));
    for (const radius of radii) {
      this.binarize(luma, bin, radius, white);
      const sets = this.scan(luma, bin, white);
      if (sets.length > 0) return sets;
    }
    return [];
  }

  private scan(luma: LumaPlane, bin: Uint8Array, white: number): CornerSet[] {
    const W = luma.width;
    const H = luma.height;
    const maxUnit = Math.max(W, H) / 80;
    const clusters: Cluster[] = [];
    const rowMatches: Match[] = [];
    const lineMatches: Match[] = [];
    let processed = 0;
    const ld = luma.data;
    for (let y = 0; y < H && processed < MAX_ROW_HITS; y++) {
      this.rowRuns.encode(bin, y * W, 1, W);
      rowMatches.length = 0;
      const rowOff = y * W;
      findMatches(this.rowRuns, (i) => ld[rowOff + i] as number, white, maxUnit, rowMatches);
      for (const m of rowMatches) {
        if (++processed > MAX_ROW_HITS) break;
        const cx = (m.a + m.b) / 2;
        // Skip rows through an anchor that is already well established (saves the cross-checks).
        if (nearSaturated(clusters, m.corner, cx, y + 0.5)) continue;
        const v = this.crossCheck(bin, ld, W, H, cx, y + 0.5, 0, 1, m.unit, m.corner, white, maxUnit, lineMatches);
        if (!v) continue;
        const cy = y + 0.5 + v.offset;
        const h2 = this.crossCheck(bin, ld, W, H, cx, cy, 1, 0, m.unit, m.corner, white, maxUnit, lineMatches);
        if (!h2) continue;
        const fx = cx + h2.offset;
        // Both diagonals through the center: along any line through the center of concentric squares the run
        // ratios hold, while glyph data almost never repeats the pattern in all four directions.
        const d1 = this.crossCheck(bin, ld, W, H, fx, cy, 1, 1, m.unit, m.corner, white, maxUnit, lineMatches);
        if (!d1) continue;
        const d2 = this.crossCheck(bin, ld, W, H, fx, cy, 1, -1, m.unit, m.corner, white, maxUnit, lineMatches);
        if (!d2) continue;
        addHit(clusters, m.corner, fx, cy, (m.unit + v.unit + h2.unit) / 3);
      }
    }
    return selectCornerSets(clusters);
  }

  /** Image white level: 99.5th percentile of luma (subsampled). */
  private whiteLevel(l: LumaPlane): number {
    const d = l.data;
    const hist = new Uint32Array(1024);
    let total = 0;
    for (let i = 0; i < d.length; i += 3) {
      const v = d[i] as number;
      const b = Math.min(1023, Math.max(0, Math.floor(v * 1023)));
      hist[b] = (hist[b] as number) + 1;
      total++;
    }
    let acc = 0;
    for (let b = 1023; b >= 0; b--) {
      acc += hist[b] as number;
      if (acc >= total * 0.005) return b / 1023;
    }
    return 1;
  }

  /** Summed-area table of the luma plane. */
  private integrate(l: LumaPlane): void {
    const W = l.width;
    const H = l.height;
    const d = l.data;
    const S = this.integral as Float64Array;
    const W1 = W + 1;
    for (let x = 0; x <= W; x++) S[x] = 0;
    for (let y = 1; y <= H; y++) {
      let row = 0;
      S[y * W1] = 0;
      for (let x = 1; x <= W; x++) {
        row += d[(y - 1) * W + x - 1] as number;
        S[y * W1 + x] = (S[(y - 1) * W1 + x] as number) + row;
      }
    }
  }

  /**
   * Binarizes luma against the local mean over a (2R+1)² window, with an absolute floor relative to the white level
   * (uniform dark areas stay dark) and a small bias below the mean (uniform light areas stay light under noise).
   */
  private binarize(l: LumaPlane, bin: Uint8Array, R: number, white: number): void {
    const W = l.width;
    const H = l.height;
    const d = l.data;
    const S = this.integral as Float64Array;
    const W1 = W + 1;
    const floor = 0.12 * white;
    const bias = 0.04 * white;
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - R);
      const y1 = Math.min(H, y + R + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - R);
        const x1 = Math.min(W, x + R + 1);
        const sum = (S[y1 * W1 + x1] as number) - (S[y0 * W1 + x1] as number) - (S[y1 * W1 + x0] as number) + (S[y0 * W1 + x0] as number);
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const v = d[y * W + x] as number;
        bin[y * W + x] = v > mean - bias && v > floor ? 1 : 0;
      }
    }
  }

  /**
   * Samples the binarized image along the line through (x, y) with direction (dx, dy) ∈ {(1,0), (0,1), (1,±1)},
   * one sample per step, and returns the offset (in steps from (x, y)) of the center of the matching pattern of the
   * same corner type whose interior contains (x, y). Along a diagonal, one step changes the Chebyshev distance
   * from an axis-aligned anchor's center by one pixel, so run lengths in steps compare directly with `unit`.
   */
  private crossCheck(
    bin: Uint8Array,
    luma: Float32Array,
    W: number,
    H: number,
    x: number,
    y: number,
    dx: number,
    dy: number,
    unit: number,
    corner: Corner,
    white: number,
    maxUnit: number,
    matches: Match[],
  ): { offset: number; unit: number } | null {
    const span = Math.ceil(9 * unit);
    const len = 2 * span + 1;
    if (this.colBin.length < len) {
      this.colBin = new Uint8Array(len);
      this.colLuma = new Float32Array(len);
    }
    let first = -1;
    let count = 0;
    for (let i = 0; i < len; i++) {
      const t = i - span;
      const px = Math.floor(x + dx * t);
      const py = Math.floor(y + dy * t);
      if (px < 0 || py < 0 || px >= W || py >= H) {
        if (first >= 0) break;
        continue;
      }
      if (first < 0) first = i;
      const idx = py * W + px;
      this.colBin[count] = bin[idx] as number;
      this.colLuma[count] = luma[idx] as number;
      count++;
    }
    if (count < 8 || first < 0) return null;
    this.lineRuns.encode(this.colBin, 0, 1, count);
    matches.length = 0;
    const cl = this.colLuma;
    findMatches(this.lineRuns, (i) => cl[i] as number, white, maxUnit, matches);
    let best: Match | null = null;
    let bestD = Infinity;
    const rel = span - first + 0.5;
    for (const m of matches) {
      if (m.corner !== corner || rel < m.a || rel > m.b) continue;
      if (m.unit < unit / 1.8 || m.unit > unit * 1.8) continue;
      const d = Math.abs((m.a + m.b) / 2 - rel);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (!best || bestD > 1.5 * best.unit) return null;
    return { offset: (best.a + best.b) / 2 - rel, unit: best.unit };
  }
}

/** True when a cluster of this corner near (x, y) already holds enough hits to be certain. */
function nearSaturated(clusters: Cluster[], corner: Corner, x: number, y: number): boolean {
  for (const c of clusters) {
    if (c.corner !== corner || c.w < SATURATED_HITS) continue;
    const cu = c.su / c.w;
    const dx = c.sx / c.w - x;
    const dy = c.sy / c.w - y;
    if (dx * dx + dy * dy <= 4 * cu * cu) return true;
  }
  return false;
}

function addHit(clusters: Cluster[], corner: Corner, x: number, y: number, u: number): void {
  for (const c of clusters) {
    if (c.corner !== corner) continue;
    const cu = c.su / c.w;
    const dx = c.sx / c.w - x;
    const dy = c.sy / c.w - y;
    if (dx * dx + dy * dy <= (2 * cu) * (2 * cu)) {
      c.sx += x;
      c.sy += y;
      c.su += u;
      c.w += 1;
      return;
    }
  }
  if (clusters.length < MAX_CLUSTERS) clusters.push({ corner, sx: x, sy: y, su: u, w: 1 });
}

function cross(o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function selectCornerSets(clusters: Cluster[]): CornerSet[] {
  const per: Cluster[][] = [[], [], [], []];
  for (const c of clusters) if (c.w >= 2) (per[c.corner] as Cluster[]).push(c);
  for (const p of per) p.sort((a, b) => b.w - a.w);
  const tops = per.map((p) => p.slice(0, 3));
  if (tops.some((t) => t.length === 0)) return [];
  const minSide = (GRID_SIZES[0] as number) - ANCHOR_CELLS;
  const maxSide = (GRID_SIZES[GRID_SIZES.length - 1] as number) - ANCHOR_CELLS;
  const out: CornerSet[] = [];
  for (const a of tops[0] as Cluster[]) {
    for (const b of tops[1] as Cluster[]) {
      for (const c of tops[2] as Cluster[]) {
        for (const d of tops[3] as Cluster[]) {
          const cs = [a, b, c, d];
          const pts = cs.map((k) => [k.sx / k.w, k.sy / k.w] as [number, number]);
          const units = cs.map((k) => k.su / k.w);
          const umin = Math.min(...units);
          const umax = Math.max(...units);
          if (umax > 1.8 * umin) continue;
          const u = units.reduce((s, v) => s + v, 0) / 4;
          const sides = [0, 1, 2, 3].map((i) => {
            const p = pts[i] as [number, number];
            const q = pts[(i + 1) % 4] as [number, number];
            return Math.hypot(q[0] - p[0], q[1] - p[1]);
          });
          const mean = sides.reduce((s, v) => s + v, 0) / 4;
          if (sides.some((s) => s < 0.6 * mean || s > 1.6 * mean)) continue;
          if (mean / u < 0.6 * minSide || mean / u > 1.5 * maxSide) continue;
          const signs = [0, 1, 2, 3].map((i) => Math.sign(cross(pts[i] as [number, number], pts[(i + 1) % 4] as [number, number], pts[(i + 2) % 4] as [number, number])));
          if (signs.some((s) => s === 0 || s !== signs[0])) continue;
          out.push({ points: pts, unit: u, score: cs.reduce((s, k) => s + k.w, 0) });
        }
      }
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 3);
}

/** Grid sizes to try for a corner set, most plausible first. */
export function gridSizesFor(set: CornerSet): number[] {
  const p = set.points;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i] as readonly [number, number];
    const b = p[(i + 1) % 4] as readonly [number, number];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const cells = sum / 4 / set.unit + ANCHOR_CELLS;
  return GRID_SIZES.slice().sort((a, b) => Math.abs(a - cells) - Math.abs(b - cells));
}

/** Anchor centers in grid units for an N-cell grid (TL, TR, BR, BL). */
export function anchorCenterPoints(n: number): [number, number][] {
  const h = ANCHOR_CELLS / 2;
  return [
    [h, h],
    [n - h, h],
    [n - h, n - h],
    [h, n - h],
  ];
}

/** Homography for an N-cell grid from a corner set, refined on the anchors' band edges. Null if degenerate. */
export function gridHomography(set: CornerSet, n: number, luma: LumaPlane): Homography | null {
  const centers = anchorCenterPoints(n);
  let h = homographyFrom4(centers, set.points);
  if (!h) return null;
  for (let iter = 0; iter < 2; iter++) {
    const refined = refineAnchors(h, n, luma);
    if (!refined) break;
    const h2 = homographyFrom4(centers, refined);
    if (!h2) break;
    h = h2;
  }
  return h;
}

function meanLuma(h: Homography, luma: LumaPlane, cx: number, cy: number, r: number): number {
  let acc = 0;
  let cnt = 0;
  for (let dy = -r; dy <= r + 1e-9; dy += r / 2) {
    for (let dx = -r; dx <= r + 1e-9; dx += r / 2) {
      const [u, v] = project(h, cx + dx, cy + dy);
      const s = sampleLuma(luma, u, v);
      if (Number.isFinite(s)) {
        acc += s;
        cnt++;
      }
    }
  }
  return cnt ? acc / cnt : NaN;
}

function refineAnchors(h: Homography, n: number, luma: LumaPlane): [number, number][] | null {
  const centers = anchorCenterPoints(n);
  const tl = centers[0] as [number, number];
  const bl = centers[3] as [number, number];
  const white = meanLuma(h, luma, tl[0], tl[1], 0.6);
  const dark = meanLuma(h, luma, bl[0], bl[1], 1.2);
  if (!(white > dark + 0.05)) return null;
  const minStep = 0.1 * (white - dark);
  const out: [number, number][] = [];
  for (const [cx, cy] of centers) {
    const dx = axisShift(h, luma, cx, cy, 0, minStep);
    const dy = axisShift(h, luma, cx, cy, 1, minStep);
    out.push(project(h, cx + (dx ?? 0), cy + (dy ?? 0)));
  }
  if (out.some(([u, v]) => !Number.isFinite(u) || !Number.isFinite(v))) return null;
  return out;
}

const PROFILE_STEP = 0.05;
const PROFILE_FROM = 2.3;
const PROFILE_SAMPLES = 29; // 2.3 … 3.7 cells

/**
 * Center correction (grid units) along one axis. On every line through an anchor within ±1.5 cells of its center,
 * band 1 (dark) meets band 0 (light) exactly 3 cells from the center on both sides.
 */
function axisShift(h: Homography, luma: LumaPlane, cx: number, cy: number, axis: 0 | 1, minStep: number): number | null {
  const shifts: number[] = [];
  for (const o of [-1.5, -0.5, 0.5, 1.5]) {
    const plus = risingEdge(h, luma, cx, cy, axis, o, 1, minStep);
    const minus = risingEdge(h, luma, cx, cy, axis, o, -1, minStep);
    if (plus !== null && minus !== null) shifts.push((plus - minus) / 2);
  }
  if (shifts.length === 0) return null;
  shifts.sort((a, b) => a - b);
  const mid = shifts.length >> 1;
  const med = shifts.length % 2 ? (shifts[mid] as number) : ((shifts[mid - 1] as number) + (shifts[mid] as number)) / 2;
  return Math.abs(med) <= 0.6 ? med : null;
}

/** Distance from the center (cells) of the steepest outward rising edge in 2.3…3.7 cells; sub-sample accurate. */
function risingEdge(h: Homography, luma: LumaPlane, cx: number, cy: number, axis: 0 | 1, o: number, dir: 1 | -1, minStep: number): number | null {
  const prof = new Float64Array(PROFILE_SAMPLES);
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const t = PROFILE_FROM + i * PROFILE_STEP;
    const x = axis === 0 ? cx + dir * t : cx + o;
    const y = axis === 0 ? cy + o : cy + dir * t;
    const [u, v] = project(h, x, y);
    const s = sampleLuma(luma, u, v);
    if (!Number.isFinite(s)) return null;
    prof[i] = s;
  }
  let best = -1;
  let bestG = -Infinity;
  for (let i = 1; i < PROFILE_SAMPLES - 1; i++) {
    const g = (prof[i + 1] as number) - (prof[i - 1] as number);
    if (g > bestG) {
      bestG = g;
      best = i;
    }
  }
  if (best < 2 || best > PROFILE_SAMPLES - 3 || bestG < minStep) return null;
  const gm = (prof[best] as number) - (prof[best - 2] as number);
  const gp = (prof[best + 2] as number) - (prof[best] as number);
  const den = gm - 2 * bestG + gp;
  const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (gm - gp)) / den)) : 0;
  return PROFILE_FROM + (best + frac) * PROFILE_STEP;
}

/** Mean anchor-to-anchor distance divided by its length in cells: sensor pixels per grid cell. */
export function pixelsPerCell(h: Homography, n: number): number {
  const c = anchorCenterPoints(n).map(([x, y]) => project(h, x, y));
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i] as [number, number];
    const b = c[(i + 1) % 4] as [number, number];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum / 4 / (n - ANCHOR_CELLS);
}
