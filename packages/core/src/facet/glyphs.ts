/**
 * The 16 Facet glyphs (spec §7.4, 4 shape bits per cell).
 *
 * A glyph divides its cell into four quadrants (TL, TR, BL, BR) and lights each with a fill level in [0, 1] (linear
 * light, multiplying the cell's palette color). Glyph s is the fill vector GLYPH_FILLS[s·4 … s·4+3].
 *
 * Deviation from spec §7.4 ("16 glyphs drawn at 80% of cell size: filled square, circle, quarter-triangles,
 * half-bars, plus, cross, ring, corner dots, diamond"): the spec selects the final set "by maximizing minimum
 * distance of downsampled luminance templates under blur σ = 0.6 cell". Under that blur everything above one cycle
 * per cell is gone (the camera's transfer function at 1 cycle/cell is e^(−2π²σ²) ≈ 0.08 at σ = 0.6), so circle,
 * ring, plus, cross and diamond collapse onto the filled square and the 80% margin only throws away signal. What
 * survives is the four-quadrant (2 × 2) low-frequency structure, so Facet's glyphs are optimized directly in that
 * space: the fill vectors below maximize the minimum blurred distance between any two *(glyph, color)* symbols —
 * d²(x, x′) = Σ_ch (x − x′)ᵀ M (x − x′), with M the Gram matrix of the receiver's blur model at σ = 0.6 (weighted
 * with σ = 0.45) — jointly with the tier's palette, by projected gradient ascent on a soft-min (offline, seeded,
 * many restarts). Compared with binary quadrant blocks over a 30% floor at 80% size, the minimum symbol distance
 * at σ = 0.6 rises from 3.9e-4 to 2.1e-2 (4 colors) and 1.1e-2 (8 colors). Verified in test/facet/codec.test.ts.
 *
 * Symbol bits: shape index s carries the 4 shape bits; colors are chosen independently (spec §7.4 bit order: color
 * bits most significant). Glyphs need not keep a lit floor: color decisions are made jointly with shape.
 */
import type { Tier } from "./types";

/** Glyphs fill their whole cell (no margin): blur makes inner detail useless and a margin only costs energy. */
export const GLYPH_MARGIN = 0;

export const GLYPH_COUNT = 16;

/** Fill vectors [TL, TR, BL, BR] for the 4-color palette (T1). */
const FILLS_4: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0.0, 0.98, 0.0],
  [0.0, 0.0, 1.0, 0.72],
  [0.0, 0.142, 0.063, 1.0],
  [0.0, 0.501, 0.974, 1.0],
  [0.0, 1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0, 1.0],
  [0.231, 1.0, 1.0, 1.0],
  [0.735, 1.0, 0.0, 1.0],
  [0.75, 1.0, 0.0, 0.0],
  [1.0, 0.0, 1.0, 0.0],
  [1.0, 0.0, 1.0, 0.753],
  [1.0, 0.019, 0.023, 1.0],
  [1.0, 0.07, 0.163, 0.0],
  [1.0, 0.948, 0.551, 0.0],
  [1.0, 1.0, 1.0, 0.261],
  [1.0, 1.0, 1.0, 1.0],
];

/** Fill vectors [TL, TR, BL, BR] for the 8-color palette (T2, T3). */
const FILLS_8: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0.0, 1.0, 0.758],
  [0.0, 0.382, 1.0, 1.0],
  [0.0, 1.0, 0.277, 1.0],
  [0.053, 1.0, 1.0, 1.0],
  [0.271, 1.0, 0.0, 0.493],
  [0.344, 1.0, 0.884, 0.363],
  [0.775, 0.0, 1.0, 0.0],
  [0.893, 0.0, 1.0, 0.904],
  [0.959, 0.0, 0.1, 1.0],
  [1.0, 0.402, 1.0, 0.0],
  [1.0, 0.421, 1.0, 1.0],
  [1.0, 0.575, 0.197, 0.0],
  [1.0, 1.0, 0.0, 0.334],
  [1.0, 1.0, 0.062, 1.0],
  [1.0, 1.0, 1.0, 0.05],
  [1.0, 1.0, 1.0, 1.0],
];

function flatten(t: readonly (readonly number[])[]): Float32Array {
  const f = new Float32Array(GLYPH_COUNT * 4);
  t.forEach((row, s) => row.forEach((v, q) => (f[s * 4 + q] = v)));
  return f;
}

const TABLE_4 = flatten(FILLS_4);
const TABLE_8 = flatten(FILLS_8);

/** fills[s * 4 + q] = linear fill of quadrant q (0 TL, 1 TR, 2 BL, 3 BR; x = q & 1, y = q >> 1) of glyph s. */
export function glyphFills(colors: number): Float32Array {
  return colors <= 4 ? TABLE_4 : TABLE_8;
}

export function glyphFillsForTier(tier: Tier): Float32Array {
  return glyphFills(tier === 1 ? 4 : 8);
}

/** Mean fill over glyphs and quadrants (expected level of an unknown data cell). */
export function meanFill(colors: number): number {
  const f = glyphFills(colors);
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] as number;
  return s / f.length;
}

/**
 * Coverage tiles for rendering: for a cell of `cellPx` pixels, tile[s][py * cellPx + px] is the glyph's mean linear
 * fill over that pixel (exact box-filter coverage of the quadrant rectangles, so odd cell sizes stay unbiased).
 */
export function glyphTiles(cellPx: number, colors: number): Float32Array[] {
  if (!Number.isInteger(cellPx) || cellPx < 1) throw new RangeError("cellPx must be a positive integer");
  const fills = glyphFills(colors);
  const lo = GLYPH_MARGIN * cellPx;
  const mid = 0.5 * cellPx;
  const hi = (1 - GLYPH_MARGIN) * cellPx;
  const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const covLo = new Float32Array(cellPx);
  const covHi = new Float32Array(cellPx);
  for (let p = 0; p < cellPx; p++) {
    covLo[p] = overlap(p, p + 1, lo, mid);
    covHi[p] = overlap(p, p + 1, mid, hi);
  }
  const tiles: Float32Array[] = [];
  for (let s = 0; s < GLYPH_COUNT; s++) {
    const t = new Float32Array(cellPx * cellPx);
    for (let py = 0; py < cellPx; py++) {
      const ys = [covLo[py] as number, covHi[py] as number];
      for (let px = 0; px < cellPx; px++) {
        const xs = [covLo[px] as number, covHi[px] as number];
        let v = 0;
        for (let q = 0; q < 4; q++) v += (xs[q & 1] as number) * (ys[q >> 1] as number) * (fills[s * 4 + q] as number);
        t[py * cellPx + px] = v;
      }
    }
    tiles.push(t);
  }
  return tiles;
}

/**
 * Luminance template of glyph `s` at `res` × `res` resolution after a Gaussian blur of `sigmaCells`, with background
 * neighbors. Used by tests to report separability in the spec's own terms.
 */
export function blurredTemplate(s: number, colors: number, res: number, sigmaCells: number, oversample = 16): Float32Array {
  const fills = glyphFills(colors);
  const n = res * oversample;
  const img = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      if (u < GLYPH_MARGIN || u >= 1 - GLYPH_MARGIN || v < GLYPH_MARGIN || v >= 1 - GLYPH_MARGIN) continue;
      img[y * n + x] = fills[s * 4 + ((u < 0.5 ? 0 : 1) | (v < 0.5 ? 0 : 2))] as number;
    }
  }
  return downsampleBlurred(img, n, res, sigmaCells);
}

/** Blurs an n × n single-cell image (zero outside) and box-downsamples the cell area to res × res. */
export function downsampleBlurred(img: Float32Array, n: number, res: number, sigmaCells: number): Float32Array {
  const pad = Math.ceil(3 * sigmaCells * n) + 1;
  const m = n + 2 * pad;
  let buf: Float32Array = new Float32Array(m * m);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) buf[(y + pad) * m + x + pad] = img[y * n + x] as number;
  if (sigmaCells > 0) buf = gaussianBlur(buf, m, m, sigmaCells * n);
  const out = new Float32Array(res * res);
  const step = n / res;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let acc = 0;
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) acc += buf[(pad + y * step + dy) * m + pad + x * step + dx] as number;
      out[y * res + x] = acc / (step * step);
    }
  }
  return out;
}

/** Separable Gaussian blur with clamped edges. */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += (k[i + r] as number) * (src[y * w + Math.min(w - 1, Math.max(0, x + i))] as number);
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += (k[i + r] as number) * (tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] as number);
      out[y * w + x] = a;
    }
  }
  return out;
}

/** Euclidean distance between two templates. */
export function templateDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const e = (a[i] as number) - (b[i] as number);
    d += e * e;
  }
  return Math.sqrt(d);
}

/** Minimum pairwise distance of a template set. */
export function minPairwiseDistance(templates: readonly Float32Array[]): number {
  let best = Infinity;
  for (let i = 0; i < templates.length; i++) {
    for (let j = i + 1; j < templates.length; j++) best = Math.min(best, templateDistance(templates[i] as Float32Array, templates[j] as Float32Array));
  }
  return best;
}
