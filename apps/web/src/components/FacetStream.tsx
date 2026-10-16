/**
 * Full-screen Facet stream (spec §7.3, §10.3). Frames advance by counting presented refreshes in
 * requestAnimationFrame, with holds scaled to the measured refresh rate (120 Hz doubles holds). A screen Wake
 * Lock keeps the display on. With prefers-reduced-motion the stream stays paused behind a confirmation with a
 * flashing-content warning.
 *
 * QR (T0) streams are drawn as rectangles straight from each code's module matrix and may show several codes
 * per screen (ADR-0019), each a different frame; the next batch is encoded right after a batch is shown, while
 * the display holds it. Grid streams are rasterized.
 */
import type { FacetFrame, FacetSender } from "@sealed/core";
import { FACET_BACKGROUND } from "@sealed/core";
import { useEffect, useRef, useState } from "react";
import { FrameScheduler, layoutCodes, streamSizePx, type CodeSlot } from "../lib/frame-scheduler";

const QUIET = 4;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function FacetStream({ sender, onStop, caption, codesPerScreen = 1 }: { sender: FacetSender; onStop: () => void; caption?: string; codesPerScreen?: number }) {
  const codes = sender.tier === 0 ? Math.max(1, Math.min(4, Math.floor(codesPerScreen))) : 1;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [confirmed, setConfirmed] = useState(() => !prefersReducedMotion());
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ hz: 60, fps: 0, frames: 0, hold: 0, encodeMs: 0, finished: false });
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
    const dark = `rgb(${FACET_BACKGROUND[0]} ${FACET_BACKGROUND[1]} ${FACET_BACKGROUND[2]})`;
    let shown: FacetFrame[] = [];
    let next: FacetFrame[] = [];
    let raf = 0;
    let lastStats = 0;
    let shownAtStats = 0;
    let encodeMs = 0;
    let slots: CodeSlot[] = [];
    let image: ImageData | null = null;
    // Module matrices of the prepared batch (QR streams), computed while the current batch is held.
    let prepared: ({ size: number; modules: Uint8Array } | null)[] = [];

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      if (codes > 1) {
        const w = Math.floor((window.innerWidth - 24) * dpr);
        const h = Math.floor(window.innerHeight * 0.8 * dpr);
        slots = layoutCodes(codes, w, h, Math.round(16 * dpr));
        const bottom = Math.max(...slots.map((sl) => sl.y + sl.side));
        canvas.width = w;
        canvas.height = bottom;
      } else {
        const side = streamSizePx(window.innerWidth, window.innerHeight, dpr, 12);
        slots = [{ x: 0, y: 0, side }];
        canvas.width = side;
        canvas.height = side;
      }
      canvas.style.width = `${canvas.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      image = null;
      if (shown.length) draw(shown, shown.map((f) => (sender.tier === 0 ? sender.qrModules(f) : null)));
    };

    const drawQr = (m: { size: number; modules: Uint8Array }, slot: CodeSlot) => {
      const span = m.size + 2 * QUIET;
      const unit = Math.max(1, Math.floor(slot.side / span));
      const off = Math.floor((slot.side - span * unit) / 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(slot.x, slot.y, slot.side, slot.side);
      ctx.fillStyle = dark;
      const x0 = slot.x + off + QUIET * unit;
      const y0 = slot.y + off + QUIET * unit;
      const n = m.size;
      for (let y = 0; y < n; y++) {
        let x = 0;
        while (x < n) {
          if (m.modules[y * n + x]) {
            let w = 1;
            while (x + w < n && m.modules[y * n + x + w]) w++;
            ctx.fillRect(x0 + x * unit, y0 + y * unit, w * unit, unit);
            x += w;
          } else x++;
        }
      }
    };

    const draw = (frames: FacetFrame[], mods: ({ size: number; modules: Uint8Array } | null)[]) => {
      if (sender.tier === 0) {
        frames.forEach((_, i) => {
          const m = mods[i];
          const slot = slots[i];
          if (m && slot) drawQr(m, slot);
        });
        return;
      }
      const f = frames[0];
      const slot = slots[0];
      if (!f || !slot) return;
      const rgba = sender.render(f, slot.side);
      if (!image || image.width !== rgba.width || image.height !== rgba.height) image = new ImageData(rgba.width, rgba.height);
      image.data.set(rgba.data);
      const off = Math.floor((slot.side - rgba.width) / 2);
      ctx.putImageData(image, off, off);
    };

    const prepare = () => {
      const t0 = performance.now();
      next = [];
      for (let i = 0; i < codes && !sender.finished; i++) next.push(sender.next());
      prepared = sender.tier === 0 ? next.map((f) => sender.qrModules(f)) : [];
      encodeMs = encodeMs * 0.8 + (performance.now() - t0) * 0.2;
    };

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      scheduler.observe(ts);
      if (!scheduler.tick()) return;
      if (next.length === 0) {
        setStats((st) => ({ ...st, finished: true }));
        return;
      }
      shown = next;
      draw(shown, prepared);
      scheduler.beginFrame((shown[0] as FacetFrame).holdRefreshes);
      prepare();
      if (ts - lastStats > 500) {
        const count = scheduler.framesShown;
        const fps = lastStats > 0 ? ((count - shownAtStats) * 1000) / (ts - lastStats) : 0;
        lastStats = ts;
        shownAtStats = count;
        setStats({ hz: scheduler.refreshRate, fps, frames: count * codes, hold: scheduler.hold, encodeMs, finished: sender.finished });
      }
    };

    prepare();
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
  }, [sender, confirmed, paused, codes]);

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
          {stats.fps.toFixed(0)}/{stats.hold ? (stats.hz / stats.hold).toFixed(0) : "–"} frames/s · {codes} per screen · encode {stats.encodeMs.toFixed(0)} ms · {stats.frames} shown
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
