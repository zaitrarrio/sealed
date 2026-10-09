/**
 * Rasterizes Facet grid pictures and T0 QR matrices into RGBA images (sender side).
 *
 * Grid frames: square image, background #0B0908, integer cell size = floor(size / (N + 2·quiet)), grid centered.
 * Compositing happens in linear light (glyph coverage × palette excess + background) and is then sRGB-encoded,
 * which is what the receiver's channel model assumes.
 */
import type { RgbaImage } from "./types";
import { GLYPH_COUNT, glyphTiles } from "./glyphs";
import { QUIET_CELLS } from "./layout";
import { BACKGROUND, GRAY_RAMP, LINEAR_BACKGROUND, LINEAR_WHITE, WHITE, encodeLinear8, linear, paletteFor } from "./palette";
import { PIC_BG, PIC_GRAY_BASE, PIC_WHITE } from "./grid";
import type { GridTier } from "./tiers";

/** Minimum display size per spec §7.2 (6 px per cell). */
export const MIN_CELL_PX = 6;

export function cellSizeFor(sizePx: number, n: number, quiet = QUIET_CELLS): number {
  return Math.floor(sizePx / (n + 2 * quiet));
}

const tileCache = new Map<string, Float32Array[]>();
function tiles(cellPx: number, colors: number): Float32Array[] {
  const key = `${cellPx}/${colors}`;
  let t = tileCache.get(key);
  if (!t) {
    t = glyphTiles(cellPx, colors);
    tileCache.set(key, t);
  }
  return t;
}

/** Precomputed 8-bit pixels for every glyph tile × palette color. */
const glyphPixelCache = new Map<string, Uint8Array[]>();
function glyphPixels(tier: GridTier, cellPx: number): Uint8Array[] {
  const key = `${tier}/${cellPx}`;
  const hit = glyphPixelCache.get(key);
  if (hit) return hit;
  const pal = paletteFor(tier).map(linear);
  const ts = tiles(cellPx, pal.length);
  const out: Uint8Array[] = [];
  for (const c of pal) {
    for (let s = 0; s < GLYPH_COUNT; s++) {
      const t = ts[s] as Float32Array;
      const px = new Uint8Array(cellPx * cellPx * 3);
      for (let i = 0; i < t.length; i++) {
        const cov = t[i] as number;
        for (let ch = 0; ch < 3; ch++) px[i * 3 + ch] = encodeLinear8((LINEAR_BACKGROUND[ch] as number) + ((c[ch] as number) - (LINEAR_BACKGROUND[ch] as number)) * cov);
      }
      out.push(px);
    }
  }
  glyphPixelCache.set(key, out);
  return out;
}

function grayCode(level: number): [number, number, number] {
  const f = GRAY_RAMP[level] ?? 0;
  return [0, 1, 2].map((ch) => encodeLinear8((LINEAR_BACKGROUND[ch] as number) + ((LINEAR_WHITE[ch] as number) - (LINEAR_BACKGROUND[ch] as number)) * f)) as [number, number, number];
}

/** Renders a cell picture (see grid.ts PIC_* codes) to an RGBA image of `sizePx` × `sizePx`. */
export function renderPicture(pic: Int16Array, n: number, tier: GridTier, sizePx: number): RgbaImage {
  if (!Number.isInteger(sizePx) || sizePx <= 0) throw new RangeError("sizePx must be a positive integer");
  const cell = cellSizeFor(sizePx, n);
  if (cell < 1) throw new RangeError(`sizePx ${sizePx} is too small for a ${n}-cell grid`);
  const data = new Uint8ClampedArray(sizePx * sizePx * 4);
  for (let i = 0; i < sizePx * sizePx; i++) {
    data[i * 4] = BACKGROUND[0];
    data[i * 4 + 1] = BACKGROUND[1];
    data[i * 4 + 2] = BACKGROUND[2];
    data[i * 4 + 3] = 255;
  }
  const origin = Math.floor((sizePx - n * cell) / 2);
  const glyphs = glyphPixels(tier, cell);
  const grays = GRAY_RAMP.map((_, l) => grayCode(l));
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const v = pic[cy * n + cx] as number;
      if (v === PIC_BG) continue;
      const x0 = origin + cx * cell;
      const y0 = origin + cy * cell;
      if (v >= 0) {
        const g = glyphs[v];
        if (!g) throw new RangeError(`symbol ${v} out of range for tier ${tier}`);
        for (let py = 0; py < cell; py++) {
          let o = ((y0 + py) * sizePx + x0) * 4;
          let s = py * cell * 3;
          for (let px = 0; px < cell; px++, o += 4, s += 3) {
            data[o] = g[s] as number;
            data[o + 1] = g[s + 1] as number;
            data[o + 2] = g[s + 2] as number;
          }
        }
      } else {
        const rgb: readonly number[] = v === PIC_WHITE ? WHITE : (grays[PIC_GRAY_BASE - v] ?? BACKGROUND);
        for (let py = 0; py < cell; py++) {
          let o = ((y0 + py) * sizePx + x0) * 4;
          for (let px = 0; px < cell; px++, o += 4) {
            data[o] = rgb[0] as number;
            data[o + 1] = rgb[1] as number;
            data[o + 2] = rgb[2] as number;
          }
        }
      }
    }
  }
  return { width: sizePx, height: sizePx, data };
}

/** QR quiet zone in modules (ISO/IEC 18004 requires 4). */
export const QR_QUIET_MODULES = 4;

/** Renders a QR module matrix (1 = dark) as dark modules on a light field filling the square image. */
export function renderQrMatrix(modules: Uint8Array, size: number, sizePx: number): RgbaImage {
  const scale = Math.floor(sizePx / (size + 2 * QR_QUIET_MODULES));
  if (scale < 1) throw new RangeError(`sizePx ${sizePx} is too small for a ${size}-module QR code`);
  const data = new Uint8ClampedArray(sizePx * sizePx * 4);
  for (let i = 0; i < sizePx * sizePx; i++) {
    data[i * 4] = WHITE[0];
    data[i * 4 + 1] = WHITE[1];
    data[i * 4 + 2] = WHITE[2];
    data[i * 4 + 3] = 255;
  }
  const origin = Math.floor((sizePx - size * scale) / 2);
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my * size + mx]) continue;
      for (let py = 0; py < scale; py++) {
        let o = ((origin + my * scale + py) * sizePx + origin + mx * scale) * 4;
        for (let px = 0; px < scale; px++, o += 4) {
          data[o] = BACKGROUND[0];
          data[o + 1] = BACKGROUND[1];
          data[o + 2] = BACKGROUND[2];
        }
      }
    }
  }
  return { width: sizePx, height: sizePx, data };
}
