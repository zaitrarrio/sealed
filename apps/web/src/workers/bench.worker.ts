/// <reference lib="webworker" />
/**
 * Benchmark worker: owns a BenchmarkMeter so decoding never blocks the page. Accepts either QR text read by the
 * browser's BarcodeDetector (fast path) or raw camera frames (fallback: rasterized and decoded here, newest
 * frame wins while a decode is running). Posts a report four times a second and once more after verification.
 */
import { BenchmarkMeter, loadNativeDecoder, type BenchmarkReport, type NativeDecoderFactory } from "@sealed/core";

import { nativeWasmUrl } from "../lib/native-wasm";

declare const self: DedicatedWorkerGlobalScope;

export type ToBenchWorker =
  | { type: "start"; tiers?: number[] }
  | { type: "code"; text: string }
  | { type: "frame"; frame: VideoFrame | ImageBitmap }
  | { type: "stop" };
export type FromBenchWorker = { type: "report"; report: BenchmarkReport };

const MAX_EDGE = 1280;
let meter = new BenchmarkMeter();
let running = false;
let nativeFactory: Promise<NativeDecoderFactory | null> | null = null;
function loadNative(): Promise<NativeDecoderFactory | null> {
  nativeFactory ??= loadNativeDecoder(fetch(nativeWasmUrl)).catch((e: unknown) => {
    console.warn("native grid decoder unavailable; using the JavaScript decoder", e);
    return null;
  });
  return nativeFactory;
}
let timer: ReturnType<typeof setInterval> | null = null;
let pending: VideoFrame | ImageBitmap | null = null;
let decoding = false;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function post(): void {
  self.postMessage({ type: "report", report: meter.report() } satisfies FromBenchWorker);
}

function close(f: VideoFrame | ImageBitmap | null): void {
  try {
    f?.close();
  } catch {
    // already closed
  }
}

function rasterize(f: VideoFrame | ImageBitmap): ImageData | null {
  const w = "displayWidth" in f ? f.displayWidth : f.width;
  const h = "displayHeight" in f ? f.displayHeight : f.height;
  if (!w || !h) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  if (!canvas || canvas.width !== cw || canvas.height !== ch) {
    canvas = new OffscreenCanvas(cw, ch);
    ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
  }
  if (!ctx) return null;
  ctx.drawImage(f, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

async function drain(): Promise<void> {
  if (decoding) return;
  decoding = true;
  try {
    while (pending && running && !meter.complete) {
      const f = pending;
      pending = null;
      let img: ImageData | null = null;
      try {
        img = rasterize(f);
      } finally {
        close(f);
      }
      if (img) meter.pushImage({ width: img.width, height: img.height, data: img.data });
      // Yield so new frames and the report timer get a turn.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    decoding = false;
  }
  if (meter.complete) await finish();
}

async function finish(): Promise<void> {
  await meter.finished();
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  post();
}

self.onmessage = (ev: MessageEvent<ToBenchWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "start": {
      const started = new BenchmarkMeter();
      meter = started;
      // Grid tiers through the native module when it is available (ADR-0023); frames before it loads use JavaScript.
      const grid = (m.tiers ?? [0, 1, 2, 3]).filter((t) => t >= 1 && t <= 3);
      if (grid.length) {
        void loadNative().then((f) => {
          if (f && meter === started && running) started.useNative(f.create(grid));
        });
      }
      running = true;
      close(pending);
      pending = null;
      if (timer) clearInterval(timer);
      timer = setInterval(post, 250);
      post();
      return;
    }
    case "code":
      if (!running) return;
      meter.pushCode(m.text);
      if (meter.complete) void finish();
      return;
    case "frame":
      if (!running) {
        close(m.frame);
        return;
      }
      close(pending);
      pending = m.frame;
      void drain();
      return;
    case "stop":
      running = false;
      close(pending);
      pending = null;
      if (timer) clearInterval(timer);
      timer = null;
      post();
      return;
  }
};
