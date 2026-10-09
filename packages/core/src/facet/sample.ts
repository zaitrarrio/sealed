/**
 * Rectified sampling of the grid (spec §7.6 step 4): for every cell, every quadrant feature is the mean of 3 × 3
 * bilinear samples around the quadrant center (model.ts SAMPLE_OFFSETS). Pixel codes are mapped
 * through a per-channel lookup table *before* interpolation so tone-curve correction acts per pixel.
 */
import type { RgbaImage } from "./types";
import { project, type Homography } from "./homography";
import { SAMPLE_OFFSETS } from "./model";
import { SRGB_TO_LINEAR_8 } from "./palette";

/** Per-channel code → value table: lut[ch * 256 + code]. */
export type ChannelLut = Float32Array;

/** sRGB EOTF for all three channels. */
export const LINEAR_LUT: ChannelLut = (() => {
  const t = new Float32Array(768);
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < 256; i++) t[ch * 256 + i] = SRGB_TO_LINEAR_8[i] as number;
  return t;
})();

/** Code values scaled to [0, 1] (used to measure tone curves). */
export const CODE_LUT: ChannelLut = (() => {
  const t = new Float32Array(768);
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < 256; i++) t[ch * 256 + i] = i / 255;
  return t;
})();

export interface CellSamples {
  readonly n: number;
  /** [cell * 12 + q * 3 + ch]; NaN where a sample fell outside the image. */
  readonly feat: Float32Array;
  /** 1 where all of the cell's samples were inside the image. */
  readonly valid: Uint8Array;
}

const SUB: readonly number[] = (() => {
  // Per axis: quadrant half qa, sub-sample index → offset from the cell center.
  const out: number[] = [];
  for (let qa = 0; qa < 2; qa++) for (const o of SAMPLE_OFFSETS[qa] as readonly number[]) out.push(o);
  return out;
})();
const PER_HALF = (SAMPLE_OFFSETS[0] as readonly number[]).length;
const NSUB = SUB.length;

/**
 * Samples all N × N cells through homography `h` (grid units → image pixels; pixel i spans [i, i + 1]).
 * `cells` optionally restricts sampling to a subset (others are left NaN / invalid).
 */
export function sampleCells(img: RgbaImage, h: Homography, n: number, lut: ChannelLut, cells?: ArrayLike<number>): CellSamples {
  const feat = new Float32Array(n * n * 12).fill(NaN);
  const valid = new Uint8Array(n * n);
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const h0 = h[0] as number, h1 = h[1] as number, h2 = h[2] as number;
  const h3 = h[3] as number, h4 = h[4] as number, h5 = h[5] as number;
  const h6 = h[6] as number, h7 = h[7] as number, h8 = h[8] as number;
  const acc = new Float64Array(12);
  const count = cells ? cells.length : n * n;
  for (let k = 0; k < count; k++) {
    const c = cells ? (cells[k] as number) : k;
    const cx = c % n;
    const cy = (c - cx) / n;
    acc.fill(0);
    let ok = true;
    for (let sy = 0; sy < NSUB && ok; sy++) {
      const gy = cy + 0.5 + (SUB[sy] as number);
      const qy = sy < PER_HALF ? 0 : 1;
      for (let sx = 0; sx < NSUB; sx++) {
        const gx = cx + 0.5 + (SUB[sx] as number);
        const qx = sx < PER_HALF ? 0 : 1;
        const w = h6 * gx + h7 * gy + h8;
        if (!(w > 1e-12)) {
          ok = false;
          break;
        }
        const x = (h0 * gx + h1 * gy + h2) / w - 0.5;
        const y = (h3 * gx + h4 * gy + h5) / w - 0.5;
        if (!(x >= 0 && y >= 0 && x < W - 1 && y < H - 1)) {
          ok = false;
          break;
        }
        const x0 = x | 0;
        const y0 = y | 0;
        const fx = x - x0;
        const fy = y - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const p00 = (y0 * W + x0) * 4;
        const p10 = p00 + 4;
        const p01 = p00 + W * 4;
        const p11 = p01 + 4;
        const o = (qy * 2 + qx) * 3;
        for (let ch = 0; ch < 3; ch++) {
          const base = ch * 256;
          acc[o + ch] =
            (acc[o + ch] as number) +
            w00 * (lut[base + (d[p00 + ch] as number)] as number) +
            w10 * (lut[base + (d[p10 + ch] as number)] as number) +
            w01 * (lut[base + (d[p01 + ch] as number)] as number) +
            w11 * (lut[base + (d[p11 + ch] as number)] as number);
        }
      }
    }
    if (!ok) continue;
    valid[c] = 1;
    const fo = c * 12;
    for (let i = 0; i < 12; i++) feat[fo + i] = (acc[i] as number) / (PER_HALF * PER_HALF);
  }
  return { n, feat, valid };
}

/** Image position of a grid point (convenience re-export for UIs drawing overlays). */
export function gridToImage(h: Homography, x: number, y: number): [number, number] {
  return project(h, x, y);
}
