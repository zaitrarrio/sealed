/**
 * Camera frame → RgbaImage for the Facet decoder. VisionCamera delivers 8-bit RGB frames as BGRA on iOS
 * ('rgb-bgra-8-bit') and RGBA or RGB on Android, with row padding (bytesPerRow ≥ width × bpp). The decoder
 * wants tightly packed RGBA and gains nothing above ~1000 px on the long side, so this also box-downsamples by an
 * integer factor. Pure, so it is unit-tested.
 */
import type { RgbaImage } from "@sealed/core";

export type RawPixelFormat = "rgb-bgra-8-bit" | "rgb-rgba-8-bit" | "rgb-rgb-8-bit";

export function isSupportedFormat(f: string): f is RawPixelFormat {
  return f === "rgb-bgra-8-bit" || f === "rgb-rgba-8-bit" || f === "rgb-rgb-8-bit";
}

export function toRgba(src: Uint8Array, width: number, height: number, bytesPerRow: number, format: RawPixelFormat, maxSide = 1024): RgbaImage {
  const bpp = format === "rgb-rgb-8-bit" ? 3 : 4;
  if (bytesPerRow < width * bpp) throw new Error("bytesPerRow is smaller than one row of pixels");
  if (src.length < bytesPerRow * (height - 1) + width * bpp) throw new Error("pixel buffer is shorter than the frame");
  const f = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const [ri, gi, bi] = format === "rgb-bgra-8-bit" ? [2, 1, 0] : [0, 1, 2];
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = (y * f + dy) * bytesPerRow + x * f * bpp;
        for (let dx = 0; dx < f; dx++) {
          r += src[p + ri] as number;
          g += src[p + gi] as number;
          b += src[p + bi] as number;
          p += bpp;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / area;
      out[o + 1] = g / area;
      out[o + 2] = b / area;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
