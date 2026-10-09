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
