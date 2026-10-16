/**
 * Sender side of the torch back-channel (ADR-0022) on the web: the front camera watches for the receiver's
 * torch. Frames are sampled at 30 Hz into a small canvas; the mean of the brightest 1 % of pixels goes through
 * the gate and pulse decoder. Nothing is shown.
 */
import { BrightnessGate, TorchDecoder, type TorchMessage } from "@sealed/core";
import { useEffect, useMemo, useRef } from "react";
import { topBrightness } from "../lib/brightness";
import { CameraError, stopStream } from "../lib/camera";

const W = 160;
const H = 120;

export function TorchWatcher({ onMessage, onSample, onError, active = true }: { onMessage: (m: TorchMessage) => void; onSample?: (brightness: number, on: boolean) => void; onError?: (message: string) => void; active?: boolean }) {
  const gate = useMemo(() => new BrightnessGate(), []);
  const decoder = useMemo(() => new TorchDecoder(), []);
  const cbs = useRef({ onMessage, onSample, onError });
  cbs.current = { onMessage, onSample, onError };

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("This browser cannot use a camera.", "missing");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "user" }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } }, audio: false });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        timer = setInterval(() => {
          if (!ctx || video.readyState < 2) return;
          ctx.drawImage(video, 0, 0, W, H);
          const img = ctx.getImageData(0, 0, W, H);
          const brightness = topBrightness(new Uint8Array(img.data.buffer), W, H, W * 4, 4, 1);
          const on = gate.push(brightness);
          cbs.current.onSample?.(brightness, on);
          const m = decoder.push(on, performance.now());
          if (m) cbs.current.onMessage(m);
        }, 1000 / 30);
      } catch (e) {
        cbs.current.onError?.(e instanceof Error ? e.message : "The front camera could not start.");
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stopStream(stream);
    };
  }, [active, gate, decoder]);
  return null;
}
