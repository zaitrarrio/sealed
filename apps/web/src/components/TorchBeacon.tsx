/**
 * Holds the back camera open just to drive its torch (ADR-0022): used after a receive completes, when the
 * capture's own camera is gone, to flash "done" at the sender. Renders nothing visible.
 */
import { useEffect, useRef } from "react";
import { openCamera, setTorch, stopStream } from "../lib/camera";

export function TorchBeacon({ on, active }: { on: boolean; active: boolean }) {
  const track = useRef<MediaStreamTrack | null>(null);
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    void openCamera({ width: 320, height: 240, frameRate: 15 })
      .then((s) => {
        if (cancelled) {
          stopStream(s);
          return;
        }
        stream = s;
        track.current = s.getVideoTracks()[0] ?? null;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      track.current = null;
      stopStream(stream);
    };
  }, [active]);
  useEffect(() => {
    if (track.current) void setTorch(track.current, on);
  }, [on]);
  return null;
}
