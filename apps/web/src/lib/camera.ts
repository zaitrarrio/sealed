/**
 * Camera access for scanning codes and capturing Facet streams (ADR-0010).
 *   - QR codes: a <video> preview sampled onto a canvas a few times per second and decoded with jsQR.
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
export function scanQr(video: HTMLVideoElement, onCode: (text: string) => void, intervalMs = 120): () => void {
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
