/**
 * Camera channel simulator for Facet tests (ADR-0008 `facet/roundtrip.synthetic`).
 *
 * A rendered RGBA frame (what the sender's screen shows) becomes a camera capture:
 *   1. the frame is placed on a display (warm near-black surround) inside a larger cluttered scene;
 *   2. a random perspective pose maps it into the capture (rotation, scale relative to the largest size that fits,
 *      perspective skew of the corners, translation), resampled bilinearly in linear light;
 *   3. optical blur: isotropic Gaussian of `blurCells` × the code's cell size at the sensor;
 *   4. sensor: 3 × 3 color mixing near identity, sRGB encode, a tone curve (gamma), additive Gaussian noise,
 *      8-bit quantization.
 * Frames may be dropped, and a capture may be torn: rows above a random scanline show one frame and rows below
 * the next (rolling shutter straddling a display refresh), with a soft transition band.
 *
 * Everything is driven by a seeded PRNG, so a failing case reproduces from its seed.
 */
import { homographyFrom4, invert, project, type Homography } from "../../src/facet/homography";
import type { RgbaImage } from "../../src/facet/types";

/** Small, fast, seedable PRNG (mulberry32) with a Box–Muller normal generator. */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.int(256);
    return out;
  }
}

export interface ChannelOptions {
  seed: number;
  width?: number;
  height?: number;
  /**
   * Capture pixels per displayed frame pixel (the code's size at the sensor relative to its display size). Clamped
   * so the whole code fits the capture at the drawn rotation and skew.
   */
  scale?: readonly [number, number];
  maxRotationDeg?: number;
  /** Perspective: each corner moves by up to this fraction of the code's side. */
  skew?: number;
  /** Gaussian blur σ in cells of the code (at the sensor). */
  blurCells?: number;
  /** Additive sensor noise σ in 8-bit code values. */
  noise?: number;
  /** Tone curve exponent range applied to sRGB code values. */
  gamma?: readonly [number, number];
  /** Off-diagonal / diagonal deviation of the color mixing matrix. */
  colorMix?: number;
  dropRate?: number;
  /** Fraction of delivered captures that straddle two consecutive frames. */
  tearRate?: number;
  /** Per-capture hand-shake: rotation (deg), scale (fraction) and translation (px) jitter. */
  shake?: { rotationDeg: number; scale: number; translatePx: number };
}

export interface Capture {
  image: RgbaImage;
  /** Frame pixel → capture pixel homography used for this capture. */
  h: Homography;
  torn: boolean;
  /** Code cell size at the sensor (capture px per frame cell), from the mean code side. */
  sensorCellPx: number;
}

interface Pose {
  rotation: number;
  scale: number;
  cx: number;
  cy: number;
  /** Corner offsets as fractions of the side, [dx0, dy0, …]. */
  corners: number[];
}

const SRGB_DECODE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

function srgbEncode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Display surround (the screen around the code): the Facet background #0B0908 in linear light. */
const SURROUND = [SRGB_DECODE[0x0b] as number, SRGB_DECODE[0x09] as number, SRGB_DECODE[0x08] as number];

export class CameraChannel {
  readonly width: number;
  readonly height: number;
  readonly rng: Rng;
  readonly gamma: [number, number, number];
  readonly mix: Float64Array;
  private readonly o: Required<ChannelOptions>;
  private readonly scene: Float32Array;
  private readonly pose: Pose;
  /** Tone curve LUT: 4096-step linear → 8-bit float code (before noise). */
  private readonly tone: Float32Array[];

  constructor(opts: ChannelOptions) {
    this.o = {
      seed: opts.seed,
      width: opts.width ?? 1280,
      height: opts.height ?? 960,
      scale: opts.scale ?? [0.6, 1.0],
      maxRotationDeg: opts.maxRotationDeg ?? 15,
      skew: opts.skew ?? 0.04,
      blurCells: opts.blurCells ?? 0.6,
      noise: opts.noise ?? 6,
      gamma: opts.gamma ?? [0.8, 1.25],
      colorMix: opts.colorMix ?? 0.08,
      dropRate: opts.dropRate ?? 0.2,
      tearRate: opts.tearRate ?? 0.15,
      shake: opts.shake ?? { rotationDeg: 0.5, scale: 0.01, translatePx: 3 },
    };
    this.width = this.o.width;
    this.height = this.o.height;
    this.rng = new Rng(opts.seed);
    const r = this.rng;
    // Same tone curve family per channel with slight per-channel differences (sensor + ISP).
    const g = r.range(this.o.gamma[0], this.o.gamma[1]);
    this.gamma = [g * r.range(0.97, 1.03), g, g * r.range(0.97, 1.03)];
    const m = this.o.colorMix;
    this.mix = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.mix[i * 3 + j] = (i === j ? 1 : 0) + r.range(-m, m);
    this.tone = this.gamma.map((gm) => {
      const t = new Float32Array(4097);
      for (let i = 0; i <= 4096; i++) t[i] = 255 * Math.pow(srgbEncode(i / 4096), gm);
      return t;
    });
    this.scene = this.makeScene();
    const rot = (r.range(-1, 1) * this.o.maxRotationDeg * Math.PI) / 180;
    this.pose = {
      rotation: rot,
      scale: r.range(this.o.scale[0], this.o.scale[1]),
      cx: 0,
      cy: 0,
      corners: Array.from({ length: 8 }, () => r.range(-this.o.skew, this.o.skew)),
    };
  }

  /** A cluttered, smoothly varying scene in linear light (desk, wall, keyboard…). */
  private makeScene(): Float32Array {
    const W = this.width;
    const H = this.height;
    const r = this.rng;
    const out = new Float32Array(W * H * 3);
    const base = [r.range(0.05, 0.3), r.range(0.05, 0.3), r.range(0.05, 0.3)];
    const gx = [r.range(-0.1, 0.1), r.range(-0.1, 0.1), r.range(-0.1, 0.1)];
    const gy = [r.range(-0.1, 0.1), r.range(-0.1, 0.1), r.range(-0.1, 0.1)];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3;
        for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.max(0, (base[ch] as number) + ((gx[ch] as number) * x) / W + ((gy[ch] as number) * y) / H);
      }
    }
    // Clutter: rectangles with high-contrast edges, some of them white, some dark stripes.
    for (let k = 0; k < 40; k++) {
      const w = r.int(W / 6) + 4;
      const h = r.int(H / 6) + 4;
      const x0 = r.int(W - w);
      const y0 = r.int(H - h);
      const c = r.next() < 0.3 ? [0.9, 0.9, 0.9] : [r.next() * 0.8, r.next() * 0.8, r.next() * 0.8];
      const stripes = r.next() < 0.3 ? 2 + r.int(6) : 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          if (stripes && Math.floor((x - x0) / stripes) % 2 === 0) continue;
          const o = (y * W + x) * 3;
          out[o] = c[0] as number;
          out[o + 1] = c[1] as number;
          out[o + 2] = c[2] as number;
        }
      }
    }
    return out;
  }

  /** Decides whether the next frame is delivered (false = dropped). */
  delivered(): boolean {
    return this.rng.next() >= this.o.dropRate;
  }

  /** Decides whether a delivered capture is torn with the following frame. */
  torn(): boolean {
    return this.rng.next() < this.o.tearRate;
  }

  /** Homography frame px → capture px for a frame of `size` px under the session pose plus shake. */
  homography(size: number, jitter = true): Homography {
    const p = this.pose;
    const r = this.rng;
    const sh = this.o.shake;
    const rot = p.rotation + (jitter ? (r.range(-1, 1) * sh.rotationDeg * Math.PI) / 180 : 0);
    // Largest side that fits at this rotation (with the skew margin).
    const c = Math.abs(Math.cos(rot)) + Math.abs(Math.sin(rot));
    const fit = (Math.min(this.width, this.height) * 0.94) / (c * (1 + 2 * this.o.skew) * (1 + sh.scale));
    const side = Math.min(fit, size * p.scale) * (jitter ? 1 + r.range(-1, 1) * sh.scale : 1);
    const free = [this.width - side * c * (1 + 2 * this.o.skew), this.height - side * c * (1 + 2 * this.o.skew)];
    if (p.cx === 0 && p.cy === 0) {
      p.cx = this.width / 2 + r.range(-0.5, 0.5) * Math.max(0, free[0] as number);
      p.cy = this.height / 2 + r.range(-0.5, 0.5) * Math.max(0, free[1] as number);
    }
    const tx = p.cx + (jitter ? r.range(-1, 1) * sh.translatePx : 0);
    const ty = p.cy + (jitter ? r.range(-1, 1) * sh.translatePx : 0);
    const src: [number, number][] = [
      [0, 0],
      [size, 0],
      [size, size],
      [0, size],
    ];
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const dst = src.map(([x, y], i) => {
      const u = (x / size - 0.5 + (p.corners[i * 2] as number)) * side;
      const v = (y / size - 0.5 + (p.corners[i * 2 + 1] as number)) * side;
      return [tx + cs * u - sn * v, ty + sn * u + cs * v] as [number, number];
    });
    const h = homographyFrom4(src, dst);
    if (!h) throw new Error("degenerate simulated pose");
    return h;
  }

  /**
   * Captures `frame` (square RGBA, `cellPx` frame pixels per code cell). With `next`, the capture is torn: rows
   * below a random scanline show `next`. Returns the 8-bit RGBA capture.
   */
  capture(frame: RgbaImage, cellPx: number, next?: RgbaImage, overrideH?: Homography): Capture {
    const W = this.width;
    const H = this.height;
    const h = overrideH ?? this.homography(frame.width);
    const hinv = invert(h);
    if (!hinv) throw new Error("singular pose");
    const lin = this.scene.slice();
    // Bounding box of the warped display (frame plus a 6% surround), with blur margin.
    const size = frame.width;
    const m = 0.06 * size;
    const corners = [
      [-m, -m],
      [size + m, -m],
      [size + m, size + m],
      [-m, size + m],
    ].map(([x, y]) => project(h, x as number, y as number));
    const sides = [0, 1, 2, 3].map((i) => {
      const a = project(h, [0, size, size, 0][i] as number, [0, 0, size, size][i] as number);
      const b = project(h, [size, size, 0, 0][i] as number, [0, size, size, 0][i] as number);
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    });
    const sensorCellPx = ((sides.reduce((s, v) => s + v, 0) / 4) * cellPx) / size;
    const sigmaPx = this.o.blurCells * sensorCellPx;
    const pad = Math.ceil(3 * sigmaPx) + 2;
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const bx0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
    const bx1 = Math.min(W, Math.ceil(Math.max(...xs)) + pad);
    const by0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const by1 = Math.min(H, Math.ceil(Math.max(...ys)) + pad);
    const tearY = next ? this.rng.range(by0 + 0.15 * (by1 - by0), by1 - 0.15 * (by1 - by0)) : Infinity;
    const band = next ? this.rng.range(2, 12) : 1;
    const fa = frame.data;
    const fb = next?.data;
    const h0 = hinv[0] as number, h1 = hinv[1] as number, h2 = hinv[2] as number;
    const h3 = hinv[3] as number, h4 = hinv[4] as number, h5 = hinv[5] as number;
    const h6 = hinv[6] as number, h7 = hinv[7] as number, h8 = hinv[8] as number;
    const sampleInto = (d: ArrayLike<number>, u: number, v: number, out: Float64Array): void => {
      // Bilinear in linear light; outside the frame (within the surround) is the display background.
      const x = u - 0.5;
      const y = v - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      for (let j = 0; j < 4; j++) {
        const xx = x0 + (j & 1);
        const yy = y0 + (j >> 1);
        const w = (j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy);
        if (w === 0) continue;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) {
          for (let ch = 0; ch < 3; ch++) out[ch] = (out[ch] as number) + w * (SURROUND[ch] as number);
        } else {
          const p = (yy * size + xx) * 4;
          for (let ch = 0; ch < 3; ch++) out[ch] = (out[ch] as number) + w * (SRGB_DECODE[d[p + ch] as number] as number);
        }
      }
    };
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    for (let y = by0; y < by1; y++) {
      const wb = next ? Math.min(1, Math.max(0, (y - tearY) / band + 0.5)) : 0;
      for (let x = bx0; x < bx1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w = h6 * px + h7 * py + h8;
        const u = (h0 * px + h1 * py + h2) / w;
        const v = (h3 * px + h4 * py + h5) / w;
        if (u < -m || v < -m || u > size + m || v > size + m) continue;
        sampleInto(fa, u, v, a);
        if (fb && wb > 0) {
          sampleInto(fb, u, v, b);
          for (let ch = 0; ch < 3; ch++) a[ch] = (1 - wb) * (a[ch] as number) + wb * (b[ch] as number);
        }
        const o = (y * W + x) * 3;
        lin[o] = a[0] as number;
        lin[o + 1] = a[1] as number;
        lin[o + 2] = a[2] as number;
      }
    }
    if (sigmaPx > 0.05) blurRegion(lin, W, bx0, by0, bx1, by1, sigmaPx);
    // Sensor: mixing, tone, noise, quantization.
    const out = new Uint8ClampedArray(W * H * 4);
    const mx = this.mix;
    const t0 = this.tone[0] as Float32Array;
    const t1 = this.tone[1] as Float32Array;
    const t2 = this.tone[2] as Float32Array;
    const noise = this.o.noise;
    const r = this.rng;
    const toneAt = (t: Float32Array, v: number): number => t[v <= 0 ? 0 : v >= 1 ? 4096 : Math.round(v * 4096)] as number;
    for (let i = 0, o = 0; i < W * H; i++, o += 4) {
      const R = lin[i * 3] as number;
      const G = lin[i * 3 + 1] as number;
      const B = lin[i * 3 + 2] as number;
      const r2 = (mx[0] as number) * R + (mx[1] as number) * G + (mx[2] as number) * B;
      const g2 = (mx[3] as number) * R + (mx[4] as number) * G + (mx[5] as number) * B;
      const b2 = (mx[6] as number) * R + (mx[7] as number) * G + (mx[8] as number) * B;
      out[o] = Math.round(toneAt(t0, r2) + noise * r.normal());
      out[o + 1] = Math.round(toneAt(t1, g2) + noise * r.normal());
      out[o + 2] = Math.round(toneAt(t2, b2) + noise * r.normal());
      out[o + 3] = 255;
    }
    return { image: { width: W, height: H, data: out }, h, torn: next !== undefined, sensorCellPx };
  }
}

/** Separable Gaussian blur of an interleaved RGB float image restricted to a rectangle (clamped edges). */
function blurRegion(img: Float32Array, W: number, x0: number, y0: number, x1: number, y1: number, sigma: number): void {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / sum;
  const w = x1 - x0;
  const h = y1 - y0;
  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = (y + y0) * W;
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(x1 - 1, Math.max(x0, x + x0 + i));
        const kk = k[i + r] as number;
        const o = (row + xx) * 3;
        a0 += kk * (img[o] as number);
        a1 += kk * (img[o + 1] as number);
        a2 += kk * (img[o + 2] as number);
      }
      const t = (y * w + x) * 3;
      tmp[t] = a0;
      tmp[t + 1] = a1;
      tmp[t + 2] = a2;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        const kk = k[i + r] as number;
        const t = (yy * w + x) * 3;
        a0 += kk * (tmp[t] as number);
        a1 += kk * (tmp[t + 1] as number);
        a2 += kk * (tmp[t + 2] as number);
      }
      const o = ((y + y0) * W + x + x0) * 3;
      img[o] = a0;
      img[o + 1] = a1;
      img[o + 2] = a2;
    }
  }
}
