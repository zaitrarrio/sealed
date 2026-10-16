/** Brightness measurement for the torch back-channel (ADR-0022); pure, mirrored inline in the TorchWatcher worklet. */
/**
 * Mean of the brightest 1 % of sampled pixels (0–255) from a packed 8-bit RGB(A/BGRA) buffer, via a histogram of
 * per-pixel maxima. The TorchWatcher worklet repeats it inline because worklets cannot call
 * ordinary module functions.
 */
export function topBrightness(px: Uint8Array, width: number, height: number, bytesPerRow: number, bpp: number, stride = 2): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = 0; y < height; y += stride) {
    let o = y * bytesPerRow;
    for (let x = 0; x < width; x += stride, o += bpp * stride) {
      const r = px[o] as number;
      const g = px[o + 1] as number;
      const b = px[o + 2] as number;
      const m = r > g ? (r > b ? r : b) : g > b ? g : b;
      hist[m] = (hist[m] as number) + 1;
      n++;
    }
  }
  const want = Math.max(1, Math.floor(n / 100));
  let sum = 0;
  let count = 0;
  for (let v = 255; v >= 0 && count < want; v--) {
    const take = Math.min(hist[v] as number, want - count);
    sum += take * v;
    count += take;
  }
  return count ? sum / count : 0;
}

