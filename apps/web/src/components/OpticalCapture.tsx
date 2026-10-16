/**
 * Camera capture for Facet streams (spec §7.6, ADR-0010). When only QR (T0) frames are expected and the browser
 * has a QR BarcodeDetector, the detector reads each frame's text on the main thread and the decode worker gets
 * only that text — fast, and the code can be anywhere in view. Otherwise raw frames go to the decode worker.
 * Live progress (coverage) comes back from the worker. Camera settings are locked after the stream is detected.
 */
import { useEffect, useRef, useState } from "react";
import { CameraError, feedFrames, lockCameraSettings, openCamera, qrDetector, stopStream, watchQrCodes } from "../lib/camera";
import type { FromWorker, ToWorker, WorkerInit } from "../workers/facet-protocol";
import { Notice } from "./ui";

export type CaptureUpdate = Extract<FromWorker, { type: "progress" }>;
export type CaptureResult = Extract<FromWorker, { type: "complete" }>;

export function OpticalCapture({ init, onProgress, onComplete, onError }: { init: WorkerInit; onProgress: (p: CaptureUpdate) => void; onComplete: (r: CaptureResult) => void; onError: (message: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string[] | null>(null);
  const [reader, setReader] = useState<"detector" | "frames" | null>(null);
  const cbs = useRef({ onProgress, onComplete, onError });
  cbs.current = { onProgress, onComplete, onError };

  useEffect(() => {
    const worker = new Worker(new URL("../workers/facet-decode.worker.ts", import.meta.url), { type: "module" });
    let stream: MediaStream | null = null;
    let stopFeed: (() => void) | null = null;
    let cancelled = false;
    let lockedOnce = false;
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === "progress") {
        cbs.current.onProgress(m);
        if (!lockedOnce && m.progress.calibrated && stream) {
          lockedOnce = true;
          const track = stream.getVideoTracks()[0];
          if (track) void lockCameraSettings(track).then(setLocked);
        }
      } else if (m.type === "complete") {
        stopFeed?.();
        cbs.current.onComplete(m);
      } else {
        cbs.current.onError(m.message);
      }
    };
    worker.onerror = (e) => cbs.current.onError(e.message || "The decoder stopped.");
    worker.postMessage(init satisfies ToWorker);
    void (async () => {
      try {
        stream = await openCamera({ width: 1920, height: 1080, frameRate: 60 });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const qrOnly = init.tiers !== undefined && init.tiers.every((t) => t === 0);
        const detector = qrOnly ? await qrDetector() : null;
        if (cancelled) return;
        if (detector) {
          setReader("detector");
          stopFeed = watchQrCodes(video, detector, (text, timestamp) => {
            const msg: ToWorker = { type: "code", text, timestamp };
            worker.postMessage(msg);
          });
        } else {
          setReader("frames");
          stopFeed = feedFrames(stream, video, (frame, timestamp) => {
            const msg: ToWorker = { type: "frame", frame, timestamp };
            worker.postMessage(msg, [frame as unknown as Transferable]);
          });
        }
      } catch (e) {
        setCameraError(e instanceof CameraError ? e.message : "The camera could not start.");
      }
    })();
    return () => {
      cancelled = true;
      stopFeed?.();
      stopStream(stream);
      worker.terminate();
    };
    // The worker is configured once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="stack">
      {cameraError ? (
        <Notice tone="danger">{cameraError}</Notice>
      ) : (
        <div className="scanner">
          <video ref={videoRef} playsInline muted aria-label="Camera view of the sender's screen" />
        </div>
      )}
      {reader && <p className="subtle">{reader === "detector" ? "Reading with the browser's QR detector — the code can be anywhere in view." : "Reading camera frames in Sealed's decoder (this browser has no QR detector); hold the other screen close and steady."}</p>}
      {locked && <p className="subtle">{locked.length ? `Camera ${locked.join(", ")} locked for the stream.` : "This camera does not allow locking focus or exposure; hold steady."}</p>}
    </div>
  );
}
