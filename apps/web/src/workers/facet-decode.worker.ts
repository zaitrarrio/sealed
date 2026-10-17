/// <reference lib="webworker" />
/**
 * Facet decode worker (spec §7.6, ADR-0010). Receives raw camera frames (never encoded video), rasterizes them
 * on an OffscreenCanvas, and feeds RGBA pixels to FacetReceiver. Frames are queued with a small bound; when the
 * decoder falls behind, the oldest queued frames are dropped (Facet's RaptorQ repair symbols cover the loss).
 * On completion it unwraps (Air-gap) or reads the in-clear key (Broadcast), opens and verifies the Envelope, and
 * posts the files back.
 */
import { EnvelopeReader, FacetReceiver, airgapReceiverSas, loadNativeDecoder, openOpticalEnvelope, unwrapKey, type DeviceKeys, type FileEntry, type NativeDecoderFactory, type NativeGridDecoder, type ReceiveProgress } from "@sealed/core";
import { deviceKeysFromStored } from "../lib/webcrypto-keys";
import { nativeWasmUrl } from "../lib/native-wasm";
import type { FromWorker, OpenedFileMessage, ToWorker, WorkerInit } from "./facet-protocol";

declare const self: DedicatedWorkerGlobalScope;

const MAX_QUEUE = 4;
/** Longest edge fed to the decoder; larger camera frames are downscaled to bound per-frame work. */
const MAX_EDGE = 1920;

let receiver = new FacetReceiver();

/**
 * Native grid decoder (ADR-0023): the Rust decoder as WebAssembly, loaded once per worker when a grid tier is
 * allowed. Missing (not built) or failing to load → the JavaScript decoder in FacetReceiver, as before.
 */
let nativeFactory: Promise<NativeDecoderFactory | null> | null = null;
let native: NativeGridDecoder | null = null;
let nativeTiers: number[] = [];
function loadNative(): Promise<NativeDecoderFactory | null> {
  nativeFactory ??= (async () => {
    try {
      return await loadNativeDecoder(fetch(nativeWasmUrl));
    } catch (e) {
      console.warn("native grid decoder unavailable; using the JavaScript decoder", e);
      post({ type: "note", message: `native grid decoder unavailable (${e instanceof Error ? e.message : String(e)}); using the JavaScript decoder` });
      return null;
    }
  })();
  return nativeFactory;
}
async function setupNative(tiers: number[] | undefined): Promise<void> {
  native?.dispose();
  native = null;
  nativeTiers = (tiers ?? [0, 1, 2, 3]).filter((t) => t >= 1 && t <= 3);
  if (nativeTiers.length === 0) return;
  const f = await loadNative();
  if (f) {
    native = f.create(nativeTiers);
    receiver.setGridFromImages(false);
    post({ type: "note", message: `native grid decoder ready for tiers ${nativeTiers.join(",")}` });
  }
}
let init: WorkerInit | null = null;
let device: DeviceKeys | null = null;
let queue: { frame: VideoFrame | ImageBitmap; timestamp: number }[] = [];
let busy = false;
let finished = false;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let manifestFiles: { path: string; size: number }[] | null = null;
/** Descriptor whose manifest part was already tried, so a failing unwrap is not repeated every frame. */
let manifestTried: object | null = null;
let lastPost = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function frameSize(f: VideoFrame | ImageBitmap): { w: number; h: number } {
  if ("displayWidth" in f) return { w: f.displayWidth, h: f.displayHeight };
  return { w: f.width, h: f.height };
}

function closeFrame(f: VideoFrame | ImageBitmap): void {
  try {
    f.close();
  } catch {
    // already closed
  }
}

function rasterize(f: VideoFrame | ImageBitmap): ImageData | null {
  const { w, h } = frameSize(f);
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

/** File names from the descriptor's manifest part, once it can be opened (Air-gap needs the unwrapped key). */
async function tryManifest(): Promise<void> {
  if (manifestFiles) return;
  const d = receiver.descriptor;
  if (!d?.manifestPart || manifestTried === d) return;
  manifestTried = d;
  try {
    let cek: Uint8Array | null = null;
    if (d.cek) cek = d.cek;
    else if (d.wrap && device) {
      cek = await unwrapKey(d.wrap, device.agreement, { kind: "airgap", streamId: d.streamId });
    }
    if (!cek) return;
    const reader = await EnvelopeReader.open(d.manifestPart, cek);
    manifestFiles = reader.manifest.files.map((f: FileEntry) => ({ path: f.path, size: f.size }));
  } catch {
    // Not decodable yet (or not for this device); the final open reports real errors.
  }
}

function currentSas(): string | null {
  if (!init?.airgap) return null;
  return airgapReceiverSas(receiver, init.airgap.nonce, init.airgap.agreementPublic);
}

async function complete(): Promise<void> {
  finished = true;
  try {
    const opened = await openOpticalEnvelope(receiver, device ? { device } : {});
    const files: OpenedFileMessage[] = opened.files.map((f) => ({
      path: f.entry.path,
      size: f.entry.size,
      mediaType: f.entry.mediaType,
      ...(f.entry.mtime !== undefined ? { mtime: f.entry.mtime } : {}),
      data: f.data,
    }));
    const s = opened.manifest.sender;
    post(
      {
        type: "complete",
        mode: opened.mode,
        files,
        sender: s ? { label: s.label, signingPublicKey: s.signingPublicKey, ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}) } : null,
        publisher: opened.publisher ?? null,
      },
      files.map((f) => f.data.buffer as ArrayBuffer),
    );
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (queue.length > 0 && !finished) {
      const item = queue.shift()!;
      let img: ImageData | null = null;
      try {
        img = rasterize(item.frame);
      } finally {
        closeFrame(item.frame);
      }
      if (!img) continue;
      const image = { width: img.width, height: img.height, data: img.data };
      let progress: ReceiveProgress;
      if (native) {
        // Grid frames natively; the receiver then only looks for QR codes in the image (when tier 0 is allowed).
        const frames = native.push(image);
        for (const f of frames) receiver.pushFrameBytes(f, item.timestamp);
        progress = frames.length > 0 ? receiver.progress : receiver.push(image, item.timestamp);
      } else {
        progress = receiver.push(image, item.timestamp);
      }
      await tryManifest();
      const now = performance.now();
      if (progress.complete || now - lastPost > 100) {
        lastPost = now;
        const d = receiver.descriptor;
        post({ type: "progress", progress, sas: currentSas(), senderLabel: d?.senderLabel ?? null, files: manifestFiles, queue: queue.length, measurement: receiver.measure(), nativeDecoder: native !== null });
      }
      if (progress.complete) {
        for (const q of queue) closeFrame(q.frame);
        queue = [];
        await complete();
      }
    }
  } finally {
    busy = false;
  }
}

/** A code read by the browser's detector: no pixels to decode; same bookkeeping as a frame. */
async function handleCode(text: string, timestamp: number): Promise<void> {
  const progress = receiver.pushQrCode(text, timestamp);
  await tryManifest();
  const now = performance.now();
  if (progress.complete || now - lastPost > 100) {
    lastPost = now;
    const d = receiver.descriptor;
    post({ type: "progress", progress, sas: currentSas(), senderLabel: d?.senderLabel ?? null, files: manifestFiles, queue: queue.length, measurement: receiver.measure(), nativeDecoder: native !== null });
  }
  if (progress.complete && !finished) {
    for (const q of queue) closeFrame(q.frame);
    queue = [];
    await complete();
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      init = msg;
      receiver = new FacetReceiver(msg.tiers ? { tiers: msg.tiers } : {});
      void setupNative(msg.tiers);
      finished = false;
      manifestFiles = null;
      manifestTried = null;
      device = msg.airgap
        ? deviceKeysFromStored({ agreementPrivate: msg.airgap.agreementPrivate, agreementPublic: msg.airgap.agreementPublic, signingPrivate: msg.airgap.signingPrivate, signingPublic: msg.airgap.signingPublic, createdAt: 0 })
        : null;
      return;
    case "reset":
      for (const q of queue) closeFrame(q.frame);
      queue = [];
      receiver = new FacetReceiver(init?.tiers ? { tiers: init.tiers } : {});
      void setupNative(init?.tiers);
      finished = false;
      manifestFiles = null;
      manifestTried = null;
      return;
    case "code":
      if (finished || !init) return;
      void handleCode(msg.text, msg.timestamp);
      return;
    case "frame":
      if (finished || !init) {
        closeFrame(msg.frame);
        return;
      }
      queue.push({ frame: msg.frame, timestamp: msg.timestamp });
      while (queue.length > MAX_QUEUE) closeFrame(queue.shift()!.frame);
      void pump();
      return;
  }
};
