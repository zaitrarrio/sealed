/**
 * Full-screen Facet stream (spec §7.3, §10.3). Frames advance by counting presented refreshes in
 * requestAnimationFrame, with holds scaled to the measured refresh rate (120 Hz doubles holds). A screen Wake
 * Lock keeps the display on. With prefers-reduced-motion the stream stays paused behind a confirmation with a
 * flashing-content warning.
 */
import type { FacetFrame, FacetSender } from "@sealed/core";
import { FACET_BACKGROUND } from "@sealed/core";
import { useEffect, useRef, useState } from "react";
import { FrameScheduler, streamSizePx } from "../lib/frame-scheduler";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function FacetStream({ sender, onStop, caption }: { sender: FacetSender; onStop: () => void; caption?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [confirmed, setConfirmed] = useState(() => !prefersReducedMotion());
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ hz: 60, frames: 0, hold: 0, finished: false });
  const [wake, setWake] = useState<"on" | "unavailable">("unavailable");

  useEffect(() => {
    if (!confirmed || paused) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      try {
        if (!("wakeLock" in navigator)) return;
        lock = await navigator.wakeLock.request("screen");
        if (disposed) void lock.release();
        else setWake("on");
      } catch {
        setWake("unavailable");
      }
    };
    void acquire();
    const onVis = () => {
      if (document.visibilityState === "visible" && !disposed) void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [confirmed, paused]);

  useEffect(() => {
    if (!confirmed || paused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const scheduler = new FrameScheduler();
    let current: FacetFrame | null = null;
    let raf = 0;
    let lastStats = 0;
    let size = 0;
    let image: ImageData | null = null;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      size = streamSizePx(window.innerWidth, window.innerHeight, dpr, 12);
      canvas.width = size;
      canvas.height = size;
      canvas.style.width = `${size / dpr}px`;
      canvas.style.height = `${size / dpr}px`;
      ctx.fillStyle = `rgb(${FACET_BACKGROUND[0]} ${FACET_BACKGROUND[1]} ${FACET_BACKGROUND[2]})`;
      ctx.fillRect(0, 0, size, size);
      image = null;
      if (current) draw(current);
    };

    const draw = (f: FacetFrame) => {
      const rgba = sender.render(f, size);
      if (!image || image.width !== rgba.width || image.height !== rgba.height) image = new ImageData(rgba.width, rgba.height);
      image.data.set(rgba.data);
      const off = Math.floor((size - rgba.width) / 2);
      ctx.putImageData(image, off, off);
    };

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      scheduler.observe(ts);
      if (!scheduler.tick()) return;
      if (sender.finished) {
        setStats((s) => ({ ...s, finished: true }));
        return;
      }
      current = sender.next();
      draw(current);
      scheduler.beginFrame(current.holdRefreshes);
      if (ts - lastStats > 500) {
        lastStats = ts;
        setStats({ hz: scheduler.refreshRate, frames: scheduler.framesShown, hold: scheduler.hold, finished: sender.finished });
      }
    };

    const onVis = () => scheduler.resetTiming();
    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [sender, confirmed, paused]);

  if (!confirmed) {
    return (
      <div className="card warn stack" role="alertdialog" aria-labelledby="flash-title">
        <h2 id="flash-title">This screen will flash</h2>
        <p>
          The stream shows rapidly changing colored patterns, about 10 frames per second. Your device asks for reduced motion, so the stream is paused. Start it only if flashing content is safe for
          you, and look away from the screen while it runs.
        </p>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => setConfirmed(true)} data-testid="confirm-flashing">
            Start the stream
          </button>
          <button type="button" className="btn ghost" onClick={onStop}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stream-stage" role="region" aria-label="Optical stream. Point the receiving camera at this screen.">
      <canvas ref={canvasRef} data-testid="facet-canvas" aria-hidden="true" />
      <div className="stream-hud">
        <span className="mono">
          {caption ? `${caption} · ` : ""}
          {stats.hz} Hz · hold {stats.hold} · frame {stats.frames}
          {wake === "on" ? " · screen kept on" : ""}
          {stats.finished ? " · stream complete" : ""}
        </span>
        <span className="row">
          <button type="button" className="btn small" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="btn small danger" onClick={onStop} data-testid="stop-stream">
            Stop
          </button>
        </span>
      </div>
    </div>
  );
}
