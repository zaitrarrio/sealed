/**
 * Planar homographies (grid coordinates → image pixels) and small dense linear solvers.
 * H is a row-major 3 × 3 matrix with H[8] = 1.
 */

export type Homography = Float64Array; // length 9

/** Solves A x = b (n × n, row-major, copied) by Gaussian elimination with partial pivoting. Null if singular. */
export function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(m[col * n + col] as number);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * n + col] as number);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (!(best > 1e-12)) return null;
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = m[col * n + c] as number;
        m[col * n + c] = m[piv * n + c] as number;
        m[piv * n + c] = t;
      }
      const t = x[col] as number;
      x[col] = x[piv] as number;
      x[piv] = t;
    }
    const d = m[col * n + col] as number;
    for (let r = col + 1; r < n; r++) {
      const f = (m[r * n + col] as number) / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) m[r * n + c] = (m[r * n + c] as number) - f * (m[col * n + c] as number);
      x[r] = (x[r] as number) - f * (x[col] as number);
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r] as number;
    for (let c = r + 1; c < n; c++) s -= (m[r * n + c] as number) * (x[c] as number);
    x[r] = s / (m[r * n + r] as number);
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i] as number)) return null;
  return x;
}

/** Exact homography from four point correspondences (DLT with h33 = 1). Null if degenerate. */
export function homographyFrom4(src: readonly (readonly [number, number])[], dst: readonly (readonly [number, number])[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) throw new RangeError("need exactly four correspondences");
  const a = new Float64Array(64);
  const b = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as readonly [number, number];
    const [u, v] = dst[i] as readonly [number, number];
    const r0 = i * 2;
    const r1 = r0 + 1;
    a.set([x, y, 1, 0, 0, 0, -x * u, -y * u], r0 * 8);
    a.set([0, 0, 0, x, y, 1, -x * v, -y * v], r1 * 8);
    b[r0] = u;
    b[r1] = v;
  }
  const h = solveLinear(a, b, 8);
  if (!h) return null;
  const out = new Float64Array(9);
  out.set(h);
  out[8] = 1;
  return out;
}

/** Maps a grid point through H; returns [NaN, NaN] behind the camera (w ≤ 0). */
export function project(h: Homography, x: number, y: number): [number, number] {
  const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
  if (!(w > 1e-12)) return [NaN, NaN];
  return [((h[0] as number) * x + (h[1] as number) * y + (h[2] as number)) / w, ((h[3] as number) * x + (h[4] as number) * y + (h[5] as number)) / w];
}

/** Composes H = A · B. */
export function compose(a: Homography, b: Homography): Homography {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (a[r * 3 + k] as number) * (b[k * 3 + c] as number);
      o[r * 3 + c] = s;
    }
  }
  const n = o[8] as number;
  if (Math.abs(n) > 1e-15) for (let i = 0; i < 9; i++) o[i] = (o[i] as number) / n;
  return o;
}

/** Inverse of a homography (adjugate), normalized to h33 = 1 when possible. */
export function invert(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, hh, i] = Array.from(h) as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * hh;
  const B = -(d * i - f * g);
  const C = d * hh - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-15)) return null;
  const o = new Float64Array([A, -(b * i - c * hh), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * hh - b * g), a * e - b * d]);
  const n = o[8] as number;
  const s = Math.abs(n) > 1e-15 ? n : det;
  for (let k = 0; k < 9; k++) o[k] = (o[k] as number) / s;
  return o;
}
