/**
 * Synthetic acoustic channel for modem tests: additive noise, a short echo, sample-clock skew, and dropouts.
 * Rates measured here are design gates, not shipping UI promises (ADR-0024).
 */
import type { AcousticProfile } from "./profiles";

export interface AcousticChannelOptions {
  /** Gaussian noise std-dev relative to full scale (0..1). Default 0.02. */
  noiseStd?: number;
  /** Echo delay in milliseconds. Default 0 (off). */
  echoMs?: number;
  /** Echo amplitude relative to the direct path. Default 0.2 when echoMs > 0. */
  echoGain?: number;
  /** Sample-clock skew as a fraction (e.g. 0.0002 = 200 ppm). Default 0. */
  clockSkew?: number;
  /** Probability each packet-length window is zeroed (dropout). Default 0. */
  dropoutProb?: number;
  /** Deterministic seed for reproducible tests. */
  seed?: number;
}

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s = (Math.imul(1664525, this.s) + 1013904223) >>> 0;
    return this.s / 0x100000000;
  }
  gauss(): number {
    // Box–Muller
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Applies channel impairments to mono PCM. */
export function applyAcousticChannel(pcm: Float32Array, profile: AcousticProfile, opts: AcousticChannelOptions = {}): Float32Array {
  const noiseStd = opts.noiseStd ?? 0.02;
  const echoMs = opts.echoMs ?? 0;
  const echoGain = opts.echoGain ?? (echoMs > 0 ? 0.2 : 0);
  const clockSkew = opts.clockSkew ?? 0;
  const dropoutProb = opts.dropoutProb ?? 0;
  const rng = new Rng(opts.seed ?? 0x51a1);

  // Clock skew via linear resampling.
  let work: Float32Array;
  if (clockSkew !== 0) {
    const ratio = 1 + clockSkew;
    const outLen = Math.max(1, Math.floor(pcm.length / ratio));
    work = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const f = src - i0;
      const a = pcm[i0] ?? 0;
      const b = pcm[i0 + 1] ?? a;
      work[i] = a + (b - a) * f;
    }
  } else {
    work = pcm.slice();
  }

  // Echo
  if (echoMs > 0 && echoGain !== 0) {
    const delay = Math.round((echoMs / 1000) * profile.sampleRate);
    const echoed = new Float32Array(work.length);
    for (let i = 0; i < work.length; i++) {
      echoed[i] = work[i]! + (i >= delay ? echoGain * work[i - delay]! : 0);
    }
    work = echoed;
  }

  // Dropouts over ~packet-sized windows
  if (dropoutProb > 0) {
    const win = Math.max(1, Math.floor(profile.sampleRate * 0.05));
    for (let i = 0; i < work.length; i += win) {
      if (rng.next() < dropoutProb) {
        for (let j = i; j < Math.min(work.length, i + win); j++) work[j] = 0;
      }
    }
  }

  // Noise
  if (noiseStd > 0) {
    for (let i = 0; i < work.length; i++) {
      work[i] = Math.max(-1, Math.min(1, work[i]! + rng.gauss() * noiseStd));
    }
  }

  return work;
}
