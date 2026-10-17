/**
 * Optical benchmark (shared by the web page, the phone screen and the CLI).
 *
 * One device shows a looping, unencrypted test stream of deterministic bytes; the other films it. The file
 * name carries the seed and size, so the receiver regenerates the expected bytes and checks the result without
 * any prior agreement — "show, then film" with nothing to pair or type. The meter records what each stage of
 * the pipeline achieved, so a failed run says where it failed: the camera saw no codes, codes were seen but none
 * were Sealed frames, frames arrived but too slowly, or everything arrived but did not verify.
 */
import { sha256 } from "../crypto/primitives";
import { ctEqual } from "../bytes";
import { FacetReceiver } from "./receiver";
import { openOpticalEnvelope, prepareBroadcastStream, type QrStreamOptions } from "./optical";
import type { FacetSender } from "./sender";
import { TIERS } from "./tiers";
import type { RgbaImage, Tier } from "./types";
import type { GridFrameDecoder, NativePixelFormat } from "./native";

const NAME = /^sealed-bench-(\d{1,10})-(\d{1,9})\.bin$/;
export const BENCHMARK_SIZES = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024] as const;

/** Deterministic test bytes (xorshift32 from `seed`). */
export function benchmarkPayload(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export function benchmarkFileName(seed: number, size: number): string {
  return `sealed-bench-${seed >>> 0}-${size}.bin`;
}

export function parseBenchmarkFileName(name: string): { seed: number; size: number } | null {
  const m = NAME.exec(name);
  return m ? { seed: Number(m[1]), size: Number(m[2]) } : null;
}

export interface BenchmarkStream {
  sender: FacetSender;
  seed: number;
  size: number;
  tier: Tier;
  /** T0 only: bytes per QR code and display refreshes per frame at 60 Hz. */
  qr: { symbolSize: number; holdRefreshes60: number };
}

/** The sender side: a looping Broadcast stream of benchmark bytes. Incompressible, so size = bytes on screen. */
export async function prepareBenchmarkStream(o: { size: number; tier: Tier; seed?: number; qr?: QrStreamOptions }): Promise<BenchmarkStream> {
  const seed = (o.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const data = benchmarkPayload(seed, o.size);
  const qr = { symbolSize: o.qr?.symbolSize ?? TIERS[0].symbolSize, holdRefreshes60: o.qr?.holdRefreshes60 ?? TIERS[0].holdRefreshes60 };
  const { sender } = await prepareBroadcastStream({
    files: [{ path: benchmarkFileName(seed, o.size), mediaType: "application/octet-stream", size: o.size, data }],
    tier: o.tier,
    ...(o.tier === 0 ? { qr } : {}),
  });
  return { sender, seed, size: o.size, tier: o.tier, qr };
}

/** Where the run got to; the first stage that did not happen is where to look. */
export type BenchmarkStage = "no-input" | "no-sealed-frames" | "receiving" | "complete" | "verified" | "failed";

export interface BenchmarkReport {
  stage: BenchmarkStage;
  /** Human summary of the stage, for the UI. */
  verdict: string;
  tier: Tier | null;
  /** Bytes per frame (per QR code for T0) of the stream received. */
  symbolSize: number | null;
  payloadBytes: number | null;
  /** Capture inputs given to the meter: camera frames (image path) or detector reads (code path). */
  inputs: number;
  /** Inputs that were valid Sealed frames of this stream. */
  validFrames: number;
  symbolsReceived: number;
  symbolsNeeded: number;
  fraction: number;
  elapsedMs: number;
  /** From the first input to the first valid frame. */
  timeToFirstFrameMs: number | null;
  inputsPerSecond: number;
  validFramesPerSecond: number;
  /** Payload bytes per second, counted from the first valid frame to completion (or to now). */
  goodputBytesPerSecond: number;
  /** Measured decode time per camera frame (image path only). */
  decodeMsPerFrame: number | null;
  /** Which decoder handled camera frames: the native module (ADR-0023) or the JavaScript one. */
  decoder: "native" | "javascript" | null;
  verified: boolean | null;
  error: string | null;
  device?: string;
}

/** Records one receive. Feed it camera frames (`pushImage`) or a platform detector's reads (`pushCode`). */
export class BenchmarkMeter {
  private readonly receiver = new FacetReceiver();
  private inputs = 0;
  private startedAt: number | null = null;
  private firstValidAt: number | null = null;
  private completeAt: number | null = null;
  private lastValid = 0;
  private verified: boolean | null = null;
  private error: string | null = null;
  private payloadBytes: number | null = null;
  private finishing: Promise<void> | null = null;
  private native: GridFrameDecoder | null = null;
  private nativeMs: number[] = [];

  constructor(private readonly now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {}

  get complete(): boolean {
    return this.completeAt !== null;
  }

  pushCode(content: string | Uint8Array): void {
    this.track(() => this.receiver.pushQrCode(content, this.now()));
  }

  pushImage(image: RgbaImage): void {
    const native = this.native;
    if (!native) {
      this.track(() => this.receiver.push(image, this.now()));
      return;
    }
    this.track(() => {
      const t0 = this.now();
      const frames = native.push(image);
      this.nativeMs.push(this.now() - t0);
      if (this.nativeMs.length > 120) this.nativeMs.shift();
      let p = this.receiver.progress;
      for (const f of frames) p = this.receiver.pushFrameBytes(f, this.now());
      // No grid frame: the receiver may still find a QR code in the image.
      return frames.length ? p : this.receiver.push(image, this.now());
    });
  }

  /** A raw camera buffer for the native decoder (no RGBA conversion); falls back to `pushImage` semantics without one. */
  pushRaw(data: Uint8Array, width: number, height: number, stride: number, format: NativePixelFormat): void {
    const native = this.native;
    if (!native) return;
    this.track(() => {
      const t0 = this.now();
      const frames = native.pushRaw(data, width, height, stride, format);
      this.nativeMs.push(this.now() - t0);
      if (this.nativeMs.length > 120) this.nativeMs.shift();
      let p = this.receiver.progress;
      if (frames.length === 0) p = this.receiver.pushFrameBytes(new Uint8Array(0), this.now());
      for (const f of frames) p = this.receiver.pushFrameBytes(f, this.now());
      return p;
    });
  }

  /** Decodes grid tiers with the native module from now on; the receiver keeps QR from images. */
  useNative(decoder: GridFrameDecoder): void {
    this.native = decoder;
    this.receiver.setGridFromImages(false);
  }

  private track(push: () => { framesDecoded: number; complete: boolean }): void {
    const t = this.now();
    if (this.startedAt === null) this.startedAt = t;
    this.inputs++;
    if (this.completeAt !== null) return;
    const p = push();
    if (p.framesDecoded > this.lastValid) {
      this.lastValid = p.framesDecoded;
      if (this.firstValidAt === null) this.firstValidAt = t;
    }
    if (p.complete) {
      this.completeAt = t;
      this.finishing = this.verify();
    }
  }

  /** Resolves once a completed stream has been opened and checked. */
  async finished(): Promise<void> {
    await this.finishing;
  }

  private async verify(): Promise<void> {
    try {
      const opened = await openOpticalEnvelope(this.receiver, {});
      const file = opened.files[0];
      const spec = file ? parseBenchmarkFileName(file.entry.path) : null;
      if (!file || !spec) throw new Error("this stream is not a Sealed benchmark");
      this.payloadBytes = spec.size;
      this.verified = file.data.length === spec.size && ctEqual(sha256(file.data), sha256(benchmarkPayload(spec.seed, spec.size)));
    } catch (e) {
      this.verified = false;
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  report(): BenchmarkReport {
    const p = this.receiver.progress;
    const t = this.completeAt ?? this.now();
    const elapsed = this.startedAt === null ? 0 : t - this.startedAt;
    const secs = elapsed / 1000;
    const tier = p.tier;
    // Before the manifest is opened, estimate payload from the symbols the stream needs.
    const symbolSize = p.symbolSize ?? (tier !== null ? TIERS[tier].symbolSize : 0);
    const bytes = this.payloadBytes ?? (p.symbolsNeeded ? p.symbolsNeeded * symbolSize : 0);
    const activeSecs = this.firstValidAt === null ? 0 : (t - this.firstValidAt) / 1000;
    const goodput = activeSecs > 0 ? (bytes * Math.min(1, p.fraction)) / activeSecs : 0;
    const stage: BenchmarkStage =
      this.inputs === 0
        ? "no-input"
        : this.verified === true
          ? "verified"
          : this.verified === false
            ? "failed"
            : this.completeAt !== null
              ? "complete"
              : p.framesDecoded === 0
                ? "no-sealed-frames"
                : "receiving";
    const m = this.receiver.measure();
    return {
      stage,
      verdict: verdictFor(stage, this.error),
      tier,
      symbolSize: p.symbolSize,
      payloadBytes: this.payloadBytes,
      inputs: this.inputs,
      validFrames: p.framesDecoded,
      symbolsReceived: p.symbolsReceived,
      symbolsNeeded: p.symbolsNeeded,
      fraction: p.fraction,
      elapsedMs: Math.round(elapsed),
      timeToFirstFrameMs: this.firstValidAt === null || this.startedAt === null ? null : Math.round(this.firstValidAt - this.startedAt),
      inputsPerSecond: secs > 0 ? this.inputs / secs : 0,
      validFramesPerSecond: secs > 0 ? p.framesDecoded / secs : 0,
      goodputBytesPerSecond: Math.round(goodput),
      decodeMsPerFrame: this.native ? (this.nativeMs.length ? Math.round(this.nativeMs.reduce((a, b) => a + b, 0) / this.nativeMs.length) : null) : m.decodeMsPerFrame > 0 ? Math.round(m.decodeMsPerFrame) : null,
      decoder: this.native ? "native" : m.decodeMsPerFrame > 0 ? "javascript" : null,
      verified: this.verified,
      error: this.error,
    };
  }
}

function verdictFor(stage: BenchmarkStage, error: string | null): string {
  switch (stage) {
    case "no-input":
      return "Nothing captured yet. Is the camera running?";
    case "no-sealed-frames":
      return "The camera is running but has not read a Sealed frame. Fill more of the view with the other screen, raise its brightness, or hold steadier.";
    case "receiving":
      return "Receiving.";
    case "complete":
      return "All data received; checking it.";
    case "verified":
      return "Received and verified byte for byte.";
    case "failed":
      return `Received, but it did not verify: ${error ?? "the data differs"}.`;
  }
}

/** Plain-text report for copying into an issue or a chat. */
export function formatBenchmarkReport(r: BenchmarkReport): string {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const lines = [
    `Sealed optical benchmark — ${r.stage}`,
    r.verdict,
    `tier            T${r.tier ?? "?"}${r.symbolSize ? ` · ${r.symbolSize} B per ${r.tier === 0 ? "code" : "frame"}` : ""}`,
    `payload         ${r.payloadBytes !== null ? kb(r.payloadBytes) : "unknown yet"}`,
    `elapsed         ${(r.elapsedMs / 1000).toFixed(1)} s`,
    `first frame     ${r.timeToFirstFrameMs !== null ? `${(r.timeToFirstFrameMs / 1000).toFixed(1)} s` : "none"}`,
    `inputs          ${r.inputs} (${r.inputsPerSecond.toFixed(1)}/s)`,
    `valid frames    ${r.validFrames} (${r.validFramesPerSecond.toFixed(1)}/s)`,
    `symbols         ${r.symbolsReceived}/${r.symbolsNeeded || "?"} (${Math.round(r.fraction * 100)}%)`,
    `goodput         ${kb(r.goodputBytesPerSecond)}/s`,
    `decode/frame    ${r.decodeMsPerFrame !== null ? `${r.decodeMsPerFrame} ms (${r.decoder ?? "javascript"})` : "n/a (platform detector)"}`,
    `verified        ${r.verified === null ? "not yet" : r.verified ? "yes" : "NO"}`,
  ];
  if (r.device) lines.push(`device          ${r.device}`);
  return lines.join("\n");
}
