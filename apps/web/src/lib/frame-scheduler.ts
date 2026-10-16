/**
 * Facet sender timing (spec §7.3): frames advance by counting presented display refreshes (one
 * requestAnimationFrame callback per refresh), never by timers. A frame's hold count is given at 60 Hz; on other
 * refresh rates it scales with the measured rate, so 120 Hz doubles every hold (6 → 12) and keeps the data rate.
 *
 * Pure logic, independent of the DOM, so it is unit-tested with synthetic timestamps.
 */

export interface SchedulerOptions {
  /** Number of recent refresh intervals used for the rate estimate. */
  window?: number;
  /** Refresh intervals outside this range (ms) are ignored as stalls or duplicate callbacks. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

/** Common panel rates; the measured median snaps to the nearest one within 6%. */
const KNOWN_RATES = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

export function snapRefreshRate(hz: number): number {
  let best = hz;
  let bestErr = Infinity;
  for (const r of KNOWN_RATES) {
    const err = Math.abs(hz - r) / r;
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  return bestErr <= 0.06 ? best : Math.round(hz);
}

/** Refreshes to hold a frame specified as `hold60` refreshes at 60 Hz, on a display running at `hz`. */
export function holdFor(hold60: number, hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return Math.max(1, hold60);
  return Math.max(1, Math.round((hold60 * hz) / 60));
}

export class FrameScheduler {
  private readonly window: number;
  private readonly minInterval: number;
  private readonly maxInterval: number;
  private intervals: number[] = [];
  private lastTs: number | null = null;
  private presented = 0;
  private currentHold = 0;
  /** Total refreshes observed (diagnostics). */
  refreshes = 0;
  /** Frames advanced (diagnostics). */
  framesShown = 0;

  constructor(opts: SchedulerOptions = {}) {
    this.window = opts.window ?? 90;
    this.minInterval = opts.minIntervalMs ?? 2;
    this.maxInterval = opts.maxIntervalMs ?? 100;
  }

  /** Estimated display refresh rate in Hz (60 until enough samples exist). */
  get refreshRate(): number {
    if (this.intervals.length < 8) return 60;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] as number;
    return snapRefreshRate(1000 / median);
  }

  /** Records one presented refresh at `ts` (the rAF timestamp). */
  observe(ts: number): void {
    this.refreshes++;
    if (this.lastTs !== null) {
      const dt = ts - this.lastTs;
      if (dt >= this.minInterval && dt <= this.maxInterval) {
        this.intervals.push(dt);
        if (this.intervals.length > this.window) this.intervals.shift();
      }
    }
    this.lastTs = ts;
  }

  /**
   * Called once per presented refresh (after `observe`). Returns true when the frame on screen has been held for
   * its full count, so the caller should present the next frame on this refresh and then call `beginFrame`.
   */
  tick(): boolean {
    if (this.framesShown === 0) return true;
    this.presented++;
    return this.presented >= this.currentHold;
  }

  /** Starts holding a newly presented frame whose hold is `hold60` refreshes at 60 Hz. */
  beginFrame(hold60: number): void {
    this.presented = 0;
    this.currentHold = holdFor(hold60, this.refreshRate);
    this.framesShown++;
  }

  /** Refreshes the current frame will be held for. */
  get hold(): number {
    return this.currentHold;
  }

  /** Clears timing history (e.g. after the tab was hidden and rAF paused). */
  resetTiming(): void {
    this.lastTs = null;
  }
}

/** Display size of a square Facet frame: the largest square that fits, in device pixels. */
export function streamSizePx(cssWidth: number, cssHeight: number, dpr: number, marginCss = 16): number {
  const side = Math.max(0, Math.min(cssWidth, cssHeight) - marginCss * 2);
  return Math.floor(side * Math.max(1, dpr));
}

export interface CodeSlot {
  x: number;
  y: number;
  side: number;
}

/**
 * Places `n` square codes in a `width` × `height` area with `gap` between them, choosing the column count that
 * makes each code largest (2 codes stack in portrait and sit side by side in landscape; 4 make a 2 × 2 grid).
 * The block is centred. Codes carry their own quiet zone, so a small gap is enough.
 */
export function layoutCodes(n: number, width: number, height: number, gap = 8): CodeSlot[] {
  if (n < 1 || width <= 0 || height <= 0) return [];
  let best = { cols: 1, rows: n, side: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const side = Math.floor(Math.min((width - gap * (cols - 1)) / cols, (height - gap * (rows - 1)) / rows));
    if (side > best.side) best = { cols, rows, side };
  }
  const { cols, rows, side } = best;
  const blockW = cols * side + gap * (cols - 1);
  const blockH = rows * side + gap * (rows - 1);
  const x0 = Math.floor((width - blockW) / 2);
  const y0 = Math.floor((height - blockH) / 2);
  const out: CodeSlot[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: x0 + c * (side + gap), y: y0 + r * (side + gap), side });
  }
  return out;
}
