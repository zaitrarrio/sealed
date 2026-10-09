/**
 * Facet colors (spec §7.4). Rendering and the receiver's channel model both work in *linear light*: blur,
 * glyph coverage and color mixing are linear there, so the receiver's inter-symbol-interference model is exact.
 * Palette entries are sRGB code values; `linear()` converts with the sRGB EOTF.
 */
import type { Tier } from "./types";

export type Rgb = readonly [number, number, number];

/** Background #0B0908 (warm near-black). */
export const BACKGROUND: Rgb = [0x0b, 0x09, 0x08];
/** Light elements: anchors, header "1" bits, T0 quiet zone. */
export const WHITE: Rgb = [0xf5, 0xf5, 0xf5];

/** Spec §7.4 candidates, in index order. T1 uses the first four. */
export const PALETTE_8: readonly Rgb[] = [
  [0x00, 0xe5, 0xff], // cyan
  [0xff, 0x2b, 0xd6], // magenta
  [0xff, 0xe6, 0x00], // yellow
  [0xf5, 0xf5, 0xf5], // white
  [0xff, 0x3b, 0x30], // red
  [0x34, 0xff, 0x5c], // green
  [0x2f, 0x6b, 0xff], // blue
  [0xff, 0x9f, 0x0a], // amber
];

export function paletteFor(tier: Tier): readonly Rgb[] {
  if (tier === 0) return [];
  return tier === 1 ? PALETTE_8.slice(0, 4) : PALETTE_8;
}

/** sRGB EOTF: code value in [0, 1] → linear light in [0, 1]. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB EOTF: linear light in [0, 1] → code value in [0, 1]. */
export function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** 8-bit code → linear light. */
export const SRGB_TO_LINEAR_8: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

const ENC_STEPS = 4096;
const LINEAR_TO_SRGB_8: Uint8Array = (() => {
  const t = new Uint8Array(ENC_STEPS + 1);
  for (let i = 0; i <= ENC_STEPS; i++) t[i] = Math.round(linearToSrgb(i / ENC_STEPS) * 255);
  return t;
})();

/** Linear light in [0, 1] → nearest 8-bit sRGB code (table lookup, 1/4096 resolution). */
export function encodeLinear8(v: number): number {
  const i = v <= 0 ? 0 : v >= 1 ? ENC_STEPS : Math.round(v * ENC_STEPS);
  return LINEAR_TO_SRGB_8[i] as number;
}

export function linear(c: Rgb): [number, number, number] {
  return [SRGB_TO_LINEAR_8[c[0]] as number, SRGB_TO_LINEAR_8[c[1]] as number, SRGB_TO_LINEAR_8[c[2]] as number];
}

export const LINEAR_BACKGROUND = linear(BACKGROUND);
export const LINEAR_WHITE = linear(WHITE);

/** Linear-light excess of a color over the background: what a fully covered glyph adds to a pixel. */
export function excess(c: Rgb): [number, number, number] {
  const l = linear(c);
  return [l[0] - LINEAR_BACKGROUND[0], l[1] - LINEAR_BACKGROUND[1], l[2] - LINEAR_BACKGROUND[2]];
}

/** Excess vectors of a tier's palette, flattened [k*3 + ch]. */
export function paletteExcess(tier: Tier): Float32Array {
  const p = paletteFor(tier);
  const out = new Float32Array(p.length * 3);
  p.forEach((c, k) => out.set(excess(c), k * 3));
  return out;
}

/** Gray levels of the calibration ramp, as fractions of the white excess in linear light. */
export const GRAY_RAMP: readonly number[] = [0, 0.02, 0.05, 0.1, 0.16, 0.24, 0.33, 0.44, 0.57, 0.72, 0.86, 1];
