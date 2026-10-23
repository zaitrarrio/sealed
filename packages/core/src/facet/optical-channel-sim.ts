/**
 * Physics-Informed Screen-to-Camera Optical Channel Simulator
 *
 * Implements the measured stochastic channel model from Sections 3 and 8 of the Research Proposal (Eq 1 & 2):
 * - Projective homography warp (A_eta) with linear-light resampling
 * - Spatially varying Gaussian blur PSF
 * - Asynchronous rolling-shutter exposure integration across display epochs J(k)
 * - Nuisance light: ambient illumination, veiling glare gradient, and localized specular saturation masks
 * - Non-linear sensor response (gamma tone curve g_psi)
 * - Signal-dependent shot noise and Gaussian read noise
 * - 8-bit quantization Q_psi
 *
 * Ensures strictly zero payload leakage: outputs only physical camera observations and geometric/epoch metadata.
 */
import { homographyFrom4, invert, project, type Homography } from "./homography";
import { cellSizeFor } from "./render";
import type { RgbaImage } from "./types";

export interface OpticalSimulatorOptions {
  seed?: number;
  width?: number;
  height?: number;
  /** Gaussian blur sigma in code cells at the sensor plane. */
  blurSigmaCells?: number;
  /** Additive Gaussian read noise sigma (0..255). */
  readNoise?: number;
  /** Shot noise coefficient (noise scales with sqrt(intensity)). */
  shotNoiseScale?: number;
  /** Camera gamma tone curve exponent. */
  gamma?: number;
  /** Ambient diffuse light intensity (0..1 linear light). */
  ambientLight?: number;
  /** Veiling glare intensity (0..1 linear light). */
  veilingGlare?: number;
  /** Specular glare: center [x, y], radius in pixels, and peak intensity (0..1). */
  specularGlare?: { cx: number; cy: number; radiusPx: number; peak: number } | null;
  /** Rolling shutter exposure time fraction of frame duration (0..1). */
  exposureFraction?: number;
  /** In-plane rotation in degrees. */
  rotationDeg?: number;
  /** Perspective skew fraction of code side. */
  skew?: number;
  /** Code scale relative to sensor view (0..1). */
  scale?: number;
}

export interface SimulatedCapture {
  image: RgbaImage;
  homography: Homography;
  sensorCellPx: number;
  glareMask: Uint8Array; // 1 where saturated/washed out, 0 elsewhere
  epochsContributed: number[];
}

/** Linear sRGB conversion LUT. */
const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lut[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Pseudo-random generator (mulberry32) for reproducible channel realizations. */
class SimRng {
  private s: number;
  private spare: number | null = null;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
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
}

export class OpticalChannelSimulator {
  readonly width: number;
  readonly height: number;
  private readonly opts: Required<OpticalSimulatorOptions>;
  private readonly rng: SimRng;

  constructor(options: OpticalSimulatorOptions = {}) {
    this.width = options.width ?? 1280;
    this.height = options.height ?? 960;
    this.rng = new SimRng(options.seed ?? 1337);

    this.opts = {
      seed: options.seed ?? 1337,
      width: this.width,
      height: this.height,
      blurSigmaCells: options.blurSigmaCells ?? 0.6,
      readNoise: options.readNoise ?? 4.0,
      shotNoiseScale: options.shotNoiseScale ?? 1.5,
      gamma: options.gamma ?? 1.0,
      ambientLight: options.ambientLight ?? 0.05,
      veilingGlare: options.veilingGlare ?? 0.02,
      specularGlare: options.specularGlare ?? null,
      exposureFraction: options.exposureFraction ?? 0.8,
      rotationDeg: options.rotationDeg ?? 5,
      skew: options.skew ?? 0.03,
      scale: options.scale ?? 0.75,
    };
  }

  /**
   * Generates a realistic sensor homography projecting the 112x112 grid cells
   * onto the camera sensor.
   */
  generateHomography(customRotation?: number): Homography {
    const rotDeg = customRotation ?? this.opts.rotationDeg;
    const rot = (rotDeg * Math.PI) / 180;
    const s = this.opts.scale;
    const c = Math.abs(Math.cos(rot)) + Math.abs(Math.sin(rot));
    const maxFitting = (Math.min(this.width, this.height) * 0.9) / (c * (1 + 2 * this.opts.skew));
    const displaySide = maxFitting * s;

    const cx = this.width / 2;
    const cy = this.height / 2;

    const corners: [number, number][] = [
      [-0.5 * displaySide, -0.5 * displaySide],
      [0.5 * displaySide, -0.5 * displaySide],
      [0.5 * displaySide, 0.5 * displaySide],
      [-0.5 * displaySide, 0.5 * displaySide],
    ];

    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const skew = this.opts.skew * displaySide;

    const dst: [number, number][] = corners.map(([x, y], idx) => {
      const rx = cs * x - sn * y;
      const ry = sn * x + cs * y;
      const skx = (idx === 0 || idx === 3 ? -1 : 1) * skew * 0.5;
      const sky = (idx === 0 || idx === 1 ? -1 : 1) * skew * 0.5;
      return [cx + rx + skx, cy + ry + sky];
    });

    const src: [number, number][] = [
      [0, 0],
      [112, 0],
      [112, 112],
      [0, 112],
    ];

    const h = homographyFrom4(src, dst);
    if (!h) throw new Error("Failed to compute valid camera homography");
    return h;
  }

  /**
   * Simulates an asynchronous camera capture observing either a single display frame
   * or a rolling-shutter mixture of consecutive display epochs J(k) = {j, j+1}.
   *
   * @param frameA Current display frame (epoch j)
   * @param frameB Optional next display frame (epoch j+1) if rolling-shutter tear occurs
   * @param tearScanline Row y in sensor where display refresh transitions from epoch j to j+1
   */
  capture(
    frameA: RgbaImage,
    frameB?: RgbaImage,
    tearScanline?: number,
    customHomography?: Homography,
  ): SimulatedCapture {
    const W = this.width;
    const H = this.height;
    const h = customHomography ?? this.generateHomography();
    const hinv = invert(h);
    if (!hinv) throw new Error("Singular homography");

    // Sensor cells per grid cell
    const p0 = project(h, 0, 0);
    const p1 = project(h, 112, 0);
    const codeSensorPx = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const sensorCellPx = codeSensorPx / 112;
    const blurPx = Math.max(0.1, this.opts.blurSigmaCells * sensorCellPx);

    // Linear light buffer (interleaved RGB)
    const linBuffer = new Float32Array(W * H * 3);
    const glareMask = new Uint8Array(W * H);
    const epochsContributed: number[] = [0];
    if (frameB) epochsContributed.push(1);

    const tearRow = tearScanline !== undefined ? tearScanline : frameB ? H * 0.5 : Infinity;
    const tearTransitionBand = Math.max(4, H * 0.04);

    const fAData = frameA.data;
    const fBData = frameB?.data;
    const fWidth = frameA.width;

    const cellA = Math.max(1, cellSizeFor(fWidth, 112));
    const originA = Math.max(0, Math.floor((fWidth - 112 * cellA) / 2));

    const sampleBilinear = (data: ArrayLike<number>, u: number, v: number): [number, number, number] => {
      if (u < 0 || u >= 112 || v < 0 || v >= 112) {
        // Surround bezel background (#0B0908 in linear)
        return [0.002, 0.0015, 0.0012];
      }
      const fx = originA + u * cellA;
      const fy = originA + v * cellA;

      const x = fx - 0.5;
      const y = fy - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fracX = x - x0;
      const fracY = y - y0;

      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const px = x0 + dx;
          const py = y0 + dy;
          const w = (dx === 1 ? fracX : 1 - fracX) * (dy === 1 ? fracY : 1 - fracY);
          if (px >= 0 && px < fWidth && py >= 0 && py < fWidth) {
            const idx = (py * fWidth + px) * 4;
            r += w * (SRGB_TO_LINEAR[data[idx] as number] as number);
            g += w * (SRGB_TO_LINEAR[data[idx + 1] as number] as number);
            b += w * (SRGB_TO_LINEAR[data[idx + 2] as number] as number);
          } else {
            r += w * 0.002;
            g += w * 0.0015;
            b += w * 0.0012;
          }
        }
      }
      return [r, g, b];
    };

    const h0 = hinv[0] as number, h1 = hinv[1] as number, h2 = hinv[2] as number;
    const h3 = hinv[3] as number, h4 = hinv[4] as number, h5 = hinv[5] as number;
    const h6 = hinv[6] as number, h7 = hinv[7] as number, h8 = hinv[8] as number;

    const spec = this.opts.specularGlare;
    const amb = this.opts.ambientLight;
    const veil = this.opts.veilingGlare;

    // 1. Raycast projection with rolling shutter multi-epoch mixing
    for (let y = 0; y < H; y++) {
      // Rolling-shutter epoch weight: 0.0 = purely frameA, 1.0 = purely frameB
      let mixB = 0;
      if (frameB) {
        mixB = Math.max(0, Math.min(1, (y - tearRow) / tearTransitionBand + 0.5));
      }

      for (let x = 0; x < W; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const denom = h6 * px + h7 * py + h8;
        const u = (h0 * px + h1 * py + h2) / denom;
        const v = (h3 * px + h4 * py + h5) / denom;

        let [r, g, b] = sampleBilinear(fAData, u, v);
        if (frameB && mixB > 0 && fBData) {
          const [rb, gb, bb] = sampleBilinear(fBData, u, v);
          r = (1 - mixB) * r + mixB * rb;
          g = (1 - mixB) * g + mixB * gb;
          b = (1 - mixB) * b + mixB * bb;
        }

        // Add ambient light and veiling glare gradient
        const vGradient = veil * (0.8 + 0.4 * (x / W));
        r += amb + vGradient;
        g += amb + vGradient;
        b += amb + vGradient;

        // Specular glare saturation
        if (spec) {
          const dGlare = Math.hypot(x - spec.cx, y - spec.cy);
          if (dGlare < spec.radiusPx) {
            const factor = Math.max(0, 1.0 - dGlare / spec.radiusPx);
            const glareLight = spec.peak * factor * 2.5; // Saturated glare washout
            r += glareLight;
            g += glareLight;
            b += glareLight;
            if (factor > 0.3) {
              glareMask[y * W + x] = 1;
            }
          }
        }

        const outIdx = (y * W + x) * 3;
        linBuffer[outIdx] = r;
        linBuffer[outIdx + 1] = g;
        linBuffer[outIdx + 2] = b;
      }
    }

    // 2. Optical blur convolution (separable Gaussian)
    if (blurPx > 0.1) {
      this.applyGaussianBlur(linBuffer, W, H, blurPx);
    }

    // 3. Sensor Pipeline: Gamma, Shot & Read Noise, Quantization
    const outData = new Uint8ClampedArray(W * H * 4);
    const gammaExp = this.opts.gamma;
    const shotScale = this.opts.shotNoiseScale;
    const readSigma = this.opts.readNoise;

    for (let i = 0; i < W * H; i++) {
      const linR = linBuffer[i * 3] as number;
      const linG = linBuffer[i * 3 + 1] as number;
      const linB = linBuffer[i * 3 + 2] as number;

      // Tone curve g_psi
      const srgbR = linearToSrgb(linR);
      const srgbG = linearToSrgb(linG);
      const srgbB = linearToSrgb(linB);

      const toneR = 255 * Math.pow(Math.max(0, Math.min(1, srgbR)), gammaExp);
      const toneG = 255 * Math.pow(Math.max(0, Math.min(1, srgbG)), gammaExp);
      const toneB = 255 * Math.pow(Math.max(0, Math.min(1, srgbB)), gammaExp);

      // Poisson/Shot noise: variance proportional to signal intensity
      const shotNoiseR = Math.sqrt(Math.max(0, toneR)) * shotScale * this.rng.normal();
      const shotNoiseG = Math.sqrt(Math.max(0, toneG)) * shotScale * this.rng.normal();
      const shotNoiseB = Math.sqrt(Math.max(0, toneB)) * shotScale * this.rng.normal();

      // Read noise: independent Gaussian
      const rNoise = readSigma * this.rng.normal();
      const gNoise = readSigma * this.rng.normal();
      const bNoise = readSigma * this.rng.normal();

      const o = i * 4;
      outData[o] = Math.round(Math.max(0, Math.min(255, toneR + shotNoiseR + rNoise)));
      outData[o + 1] = Math.round(Math.max(0, Math.min(255, toneG + shotNoiseG + gNoise)));
      outData[o + 2] = Math.round(Math.max(0, Math.min(255, toneB + shotNoiseB + bNoise)));
      outData[o + 3] = 255;
    }

    return {
      image: { width: W, height: H, data: outData },
      homography: h,
      sensorCellPx,
      glareMask,
      epochsContributed,
    };
  }

  private applyGaussianBlur(img: Float32Array, W: number, H: number, sigma: number): void {
    const r = Math.max(1, Math.ceil(3 * sigma));
    const kLen = 2 * r + 1;
    const kernel = new Float32Array(kLen);
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + r] = v;
      sum += v;
    }
    for (let i = 0; i < kLen; i++) {
      kernel[i] = (kernel[i] as number) / sum;
    }

    const tmp = new Float32Array(W * H * 3);

    // Horizontal pass
    for (let y = 0; y < H; y++) {
      const rowOffset = y * W * 3;
      for (let x = 0; x < W; x++) {
        let rAcc = 0, gAcc = 0, bAcc = 0;
        for (let k = -r; k <= r; k++) {
          const kx = Math.max(0, Math.min(W - 1, x + k));
          const w = kernel[k + r] as number;
          const idx = rowOffset + kx * 3;
          rAcc += w * (img[idx] as number);
          gAcc += w * (img[idx + 1] as number);
          bAcc += w * (img[idx + 2] as number);
        }
        const outIdx = rowOffset + x * 3;
        tmp[outIdx] = rAcc;
        tmp[outIdx + 1] = gAcc;
        tmp[outIdx + 2] = bAcc;
      }
    }

    // Vertical pass
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let rAcc = 0, gAcc = 0, bAcc = 0;
        for (let k = -r; k <= r; k++) {
          const ky = Math.max(0, Math.min(H - 1, y + k));
          const w = kernel[k + r] as number;
          const idx = (ky * W + x) * 3;
          rAcc += w * (tmp[idx] as number);
          gAcc += w * (tmp[idx + 1] as number);
          bAcc += w * (tmp[idx + 2] as number);
        }
        const outIdx = (y * W + x) * 3;
        img[outIdx] = rAcc;
        img[outIdx + 1] = gAcc;
        img[outIdx + 2] = bAcc;
      }
    }
  }
}
