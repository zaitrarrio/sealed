/**
 * Camera access for scanning codes and capturing Facet streams (ADR-0010).
 *   - QR codes: the browser's BarcodeDetector when it supports QR (Chrome on Android and macOS, Edge): fast,
 *     finds a code anywhere in view at any angle. Otherwise a <video> preview sampled onto a canvas a few times
 *     per second and decoded with jsQR.
 *   - Facet: raw frames from MediaStreamTrackProcessor (Chromium) or requestVideoFrameCallback + ImageBitmap,
 *     handed to a worker. Never through a video encoder.
 * Camera settings are locked with applyConstraints where the platform exposes them.
 */
import jsQR from "jsqr";

export class CameraError extends Error {
  constructor(
    message: string,
    readonly reason: "denied" | "missing" | "insecure" | "busy" | "other",
  ) {
    super(message);
    this.name = "CameraError";
  }
}

export function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Opens the rear camera (or the default webcam) at the requested resolution. */
export async function openCamera(opts: { width?: number; height?: number; frameRate?: number } = {}): Promise<MediaStream> {
  if (!window.isSecureContext) throw new CameraError("The camera needs a secure (https) page.", "insecure");
  if (!cameraAvailable()) throw new CameraError("This browser cannot use a camera.", "missing");
  const video: MediaTrackConstraints = {
    facingMode: { ideal: "environment" },
    width: { ideal: opts.width ?? 1280 },
    height: { ideal: opts.height ?? 720 },
    ...(opts.frameRate ? { frameRate: { ideal: opts.frameRate } } : {}),
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") throw new CameraError("Camera access was blocked. Allow it in the browser's site settings.", "denied");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new CameraError("No camera was found.", "missing");
    if (name === "NotReadableError" || name === "AbortError") throw new CameraError("The camera is in use by another app.", "busy");
    throw new CameraError(e instanceof Error ? e.message : "The camera could not start.", "other");
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

type ExtendedCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  torch?: boolean;
};

/**
 * Best-effort lock of focus, exposure and white balance once the stream is aimed (ADR-0010 step 3).
 * Returns which settings were locked.
 */
export async function lockCameraSettings(track: MediaStreamTrack): Promise<string[]> {
  const caps = (typeof track.getCapabilities === "function" ? track.getCapabilities() : {}) as ExtendedCapabilities;
  const locked: string[] = [];
  const tryApply = async (name: string, c: Record<string, unknown>) => {
    try {
      await track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] });
      locked.push(name);
    } catch {
      // not supported on this device
    }
  };
  if (caps.focusMode?.includes("manual")) await tryApply("focus", { focusMode: "manual" });
  if (caps.exposureMode?.includes("manual")) await tryApply("exposure", { exposureMode: "manual" });
  if (caps.whiteBalanceMode?.includes("manual")) await tryApply("white balance", { whiteBalanceMode: "manual" });
  return locked;
}

/** Restores continuous focus for QR scanning where supported. */
export async function continuousFocus(track: MediaStreamTrack): Promise<void> {
  const caps = (typeof track.getCapabilities === "function" ? track.getCapabilities() : {}) as ExtendedCapabilities;
  if (caps.focusMode?.includes("continuous")) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] });
    } catch {
      // ignore
    }
  }
}

/**
 * Samples a playing <video> and resolves each decoded QR text through `onCode`. Returns a stop function.
 * Decoding runs at most every `intervalMs` on a downscaled frame.
 */
// ------------------------------------------------------------------------------------------- BarcodeDetector

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

let detectorPromise: Promise<BarcodeDetectorLike | null> | null = null;

/** The browser's QR detector, or null where BarcodeDetector is missing or lacks QR support. */
export function qrDetector(): Promise<BarcodeDetectorLike | null> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (!Ctor) return null;
      try {
        const formats = await Ctor.getSupportedFormats();
        return formats.includes("qr_code") ? new Ctor({ formats: ["qr_code"] }) : null;
      } catch {
        return null;
      }
    })();
  }
  return detectorPromise;
}

/**
 * Reads every QR code the camera sees with the browser's detector, once per video frame (skipping frames while
 * a detection is still running). Calls `onCode` once for each code while it stays in view (several may be). Returns a stop
 * function. Use only when `qrDetector()` resolved to a detector.
 */
export function watchQrCodes(video: HTMLVideoElement, detector: BarcodeDetectorLike, onCode: (text: string, timestampMs: number) => void, dedupe = true): () => void {
  let stopped = false;
  let busy = false;
  // Several codes may be in view at once; remember the recent ones so each is reported once while visible.
  const recent: string[] = [];
  let handle = 0;
  const run = (t: number) => {
    if (stopped || busy || video.readyState < 2) return;
    busy = true;
    detector
      .detect(video)
      .then((codes) => {
        for (const c of codes) {
          if (!c.rawValue || (dedupe && recent.includes(c.rawValue))) continue;
          recent.push(c.rawValue);
          if (recent.length > 16) recent.shift();
          onCode(c.rawValue, t);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    const cb = (now: number) => {
      if (stopped) return;
      handle = video.requestVideoFrameCallback(cb);
      run(now);
    };
    handle = video.requestVideoFrameCallback(cb);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
    };
  }
  const tick = (t: number) => {
    if (stopped) return;
    handle = requestAnimationFrame(tick);
    run(t);
  };
  handle = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(handle);
  };
}

/** Scans for one QR code at a time (handshake codes): the browser's detector when present, else jsQR. */
export function scanQr(video: HTMLVideoElement, onCode: (text: string) => void, intervalMs = 120): () => void {
  let inner: (() => void) | null = null;
  let stopped = false;
  void qrDetector().then((d) => {
    if (stopped) return;
    // Handshake codes are re-reported while visible (the caller de-duplicates), so a code shown again after a
    // cancelled prompt is read again.
    inner = d ? watchQrCodes(video, d, (text) => onCode(text), false) : scanQrJs(video, onCode, intervalMs);
  });
  return () => {
    stopped = true;
    inner?.();
  };
}

function scanQrJs(video: HTMLVideoElement, onCode: (text: string) => void, intervalMs: number): () => void {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let last = 0;
  let raf = 0;
  const tick = (t: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (t - last < intervalMs || !ctx || video.readyState < 2 || !video.videoWidth) return;
    last = t;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const r = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
    if (r?.data) onCode(r.data);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
}

/** True when raw frames can be read with MediaStreamTrackProcessor (Chromium). */
export function hasTrackProcessor(): boolean {
  return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === "function";
}

/**
 * Delivers raw camera frames to `onFrame` (which takes ownership and must close them). Uses
 * MediaStreamTrackProcessor when present, else requestVideoFrameCallback on `video` with createImageBitmap.
 * Returns a stop function.
 */
export function feedFrames(stream: MediaStream, video: HTMLVideoElement, onFrame: (frame: VideoFrame | ImageBitmap, timestampMs: number) => void): () => void {
  let stopped = false;
  const track = stream.getVideoTracks()[0];
  if (!track) throw new CameraError("The camera produced no video.", "other");
  const Ctor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
  if (Ctor) {
    const processor = new Ctor({ track: track.clone(), maxBufferSize: 2 });
    const reader = processor.readable.getReader();
    void (async () => {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        if (stopped) {
          value.close();
          break;
        }
        onFrame(value, value.timestamp / 1000);
      }
    })().catch(() => undefined);
    return () => {
      stopped = true;
      void reader.cancel().catch(() => undefined);
    };
  }
  if (typeof video.requestVideoFrameCallback === "function") {
    let handle = 0;
    const cb = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      handle = video.requestVideoFrameCallback(cb);
      void createImageBitmap(video).then(
        (bmp) => (stopped ? bmp.close() : onFrame(bmp, meta.mediaTime * 1000 || meta.expectedDisplayTime)),
        () => undefined,
      );
    };
    handle = video.requestVideoFrameCallback(cb);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
    };
  }
  // Last resort: animation frames (no per-frame timestamps from the camera).
  let raf = 0;
  const tick = (t: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (video.readyState >= 2) void createImageBitmap(video).then((bmp) => (stopped ? bmp.close() : onFrame(bmp, t)), () => undefined);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
