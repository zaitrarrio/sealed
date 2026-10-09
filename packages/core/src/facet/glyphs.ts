/**
 * The 16 Facet glyphs (spec §7.4, 4 shape bits per cell).
 *
 * The glyph occupies the central 80% of the cell, split into four quadrants (TL, TR, BL, BR). Each quadrant is
 * lit at full intensity or at DIM (in linear light); shape bit i (LSB = TL, then TR, BL, BR) selects full.
 * This family contains the spec's candidates that survive downsampling — filled square (0b1111), quarter
 * blocks (one bit), half-bars (0b0011 horizontal, 0b0101 vertical), diagonal pairs (0b1001, 0b0110) and
 * L-shapes/triangles (three bits) — and replaces circle/plus/cross/ring/diamond, whose distinguishing energy
 * sits at spatial frequencies above one cycle per cell and is lost first under camera blur. Quadrant patterns
 * are the lowest-frequency 4-bit alphabet that fits in a cell, so their minimum template distance under blur is
 * maximal (verified in test/facet/codec.test.ts against the spec's shape list).
 *
 * The DIM floor keeps every glyph colored, so color decisions never depend on the shape.
 */

/** Linear-light level of an unlit quadrant relative to a lit one. */
export const DIM = 0.3;
/** Glyph margin inside the cell (fraction of cell size on each side): glyph = 80% of the cell. */
export const GLYPH_MARGIN = 0.1;
/** Sample offset of each quadrant center from the cell center, in cells. */
export const QUADRANT_OFFSET = 0.2;

export const GLYPH_COUNT = 16;

/** Quadrant order: 0 TL, 1 TR, 2 BL, 3 BR; x = q & 1, y = q >> 1. */
export function quadrantFill(shape: number, q: number): number {
  return (shape >> q) & 1 ? 1 : DIM;
}

/** fills[s * 4 + q] = linear level of quadrant q of glyph s. */
export const GLYPH_FILLS: Float32Array = (() => {
  const f = new Float32Array(GLYPH_COUNT * 4);
  for (let s = 0; s < GLYPH_COUNT; s++) for (let q = 0; q < 4; q++) f[s * 4 + q] = quadrantFill(s, q);
  return f;
})();

export const GLYPH_NAMES: readonly string[] = [
  "dim square",
  "top-left block",
  "top-right block",
  "top bar",
  "bottom-left block",
  "left bar",
  "anti-diagonal",
  "top-left triangle",
  "bottom-right block",
  "diagonal",
  "right bar",
  "top-right triangle",
  "bottom bar",
  "bottom-left triangle",
  "bottom-right triangle",
  "filled square",
];

/**
 * Coverage tiles for rendering: for a cell of `cellPx` pixels, tile[s][py * cellPx + px] is the glyph's mean
 * linear level over that pixel (exact box-filter coverage of the axis-aligned quadrant rectangles).
 */
export function glyphTiles(cellPx: number): Float32Array[] {
  if (!Number.isInteger(cellPx) || cellPx < 1) throw new RangeError("cellPx must be a positive integer");
  const lo = GLYPH_MARGIN * cellPx;
  const mid = 0.5 * cellPx;
  const hi = (1 - GLYPH_MARGIN) * cellPx;
  const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  // Per-axis coverage of the low half [lo, mid] and high half [mid, hi] for each pixel column.
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
        for (let q = 0; q < 4; q++) v += (xs[q & 1] as number) * (ys[q >> 1] as number) * quadrantFill(s, q);
        t[py * cellPx + px] = v;
      }
    }
    tiles.push(t);
  }
  return tiles;
}

/**
 * Luminance template of glyph `s` at `res`×`res` resolution after a Gaussian blur of `sigmaCells` (in cells),
 * sampled at sub-cell resolution `res`. Used by tests and to report separability.
 */
export function blurredTemplate(s: number, res: number, sigmaCells: number, oversample = 16): Float32Array {
  const n = res * oversample;
  const img = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      if (u < GLYPH_MARGIN || u >= 1 - GLYPH_MARGIN || v < GLYPH_MARGIN || v >= 1 - GLYPH_MARGIN) continue;
      img[y * n + x] = quadrantFill(s, (u < 0.5 ? 0 : 1) | (v < 0.5 ? 0 : 2));
    }
  }
  return downsampleBlurred(img, n, res, sigmaCells);
}

/** Blurs an n×n single-cell image (zero outside, i.e. background neighbors) and box-downsamples to res×res. */
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
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        a += (k[i + r] as number) * (src[y * w + xx] as number);
      }
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        a += (k[i + r] as number) * (tmp[yy * w + x] as number);
      }
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
