/**
 * Torch back-channel (ADR-0022): one bit of light from the receiver to the sender.
 *
 * The receiver films the sender's screen with its back camera, so its torch LED points straight at the sender's
 * front camera. Blinking it gives the sender three things it otherwise has to guess: that the receiver is done,
 * that it is dropping frames (slow down), or that it is reading everything (speed up).
 *
 * Signalling is on-off keying at 2 pulses per second, chosen so a 30 fps camera sees each pulse and each gap
 * for 7–8 frames and so phone torches (which switch in tens of milliseconds) keep up:
 *
 *   done     torch on for TORCH_DONE_MS (1.5 s), repeated
 *   slower   2 pulses (250 ms on, 250 ms off)
 *   faster   4 pulses
 *
 * Bursts are separated by at least TORCH_GAP_MS of darkness. The decoder counts pulses in a burst and maps the
 * count; a burst of 3 (one pulse missed or added) is ignored rather than guessed.
 *
 * Everything here is pure: the apps feed brightness samples and (sbn, esi) pairs in and get messages out.
 */
import { QR_HOLDS } from "./tiers";

export type TorchMessage = "done" | "slower" | "faster";

export const TORCH_PULSE_MS = 250;
export const TORCH_DONE_MS = 1500;
export const TORCH_GAP_MS = 800;
/** A pulse shorter than this is noise (a reflection, a flicker). */
const MIN_PULSE_MS = 80;
/** A pulse longer than this and shorter than `done` is neither. */
const MAX_PULSE_MS = 600;
/** Gap longer than this ends a burst. */
const BURST_END_MS = 600;

const PULSES: Record<Exclude<TorchMessage, "done">, number> = { slower: 2, faster: 4 };

export interface TorchStep {
  on: boolean;
  ms: number;
}

/** The on/off timeline the receiver's torch plays for `msg`, ending with the inter-burst gap. */
export function torchSchedule(msg: TorchMessage): TorchStep[] {
  if (msg === "done") return [{ on: true, ms: TORCH_DONE_MS }, { on: false, ms: TORCH_GAP_MS }];
  const out: TorchStep[] = [];
  for (let i = 0; i < PULSES[msg]; i++) out.push({ on: true, ms: TORCH_PULSE_MS }, { on: false, ms: TORCH_PULSE_MS });
  (out[out.length - 1] as TorchStep).ms = TORCH_GAP_MS;
  return out;
}

/**
 * Turns brightness samples into on/off. The floor is the darkest recent value (ambient light with the torch
 * off), tracked downward at once and upward slowly, and "on" means a fixed step above it. Samples are the mean
 * of the brightest pixels of a front-camera frame, 0–255: a torch at arm's length drives that to saturation
 * whatever the room looks like. Nothing the torch sends stays on longer than `done` (1.5 s), so a level held
 * for `settleSamples` is a brighter room, not a signal, and becomes the new floor.
 */
export class BrightnessGate {
  private floor: number | null = null;
  private on = false;
  private onRun = 0;

  constructor(
    private readonly step = 60,
    private readonly floorRise = 0.005,
    private readonly settleSamples = 90,
  ) {}

  push(value: number): boolean {
    if (this.floor === null) this.floor = value;
    else if (value < this.floor) this.floor = value;
    else this.floor += (value - this.floor) * this.floorRise;
    // Hysteresis: switch on above floor + step, off below floor + step / 2.
    const threshold = this.floor + (this.on ? this.step / 2 : this.step);
    this.on = value > threshold;
    this.onRun = this.on ? this.onRun + 1 : 0;
    if (this.onRun > this.settleSamples) {
      this.floor = value;
      this.on = false;
      this.onRun = 0;
    }
    return this.on;
  }
}

/** Decodes torch messages from a thresholded brightness series with timestamps (ms, monotonic). */
export class TorchDecoder {
  private on = false;
  private onSince = 0;
  private lastOff = 0;
  private pulses = 0;
  private doneReported = false;

  /** Feed one sample; returns a message when a burst completes. */
  push(bright: boolean, tMs: number): TorchMessage | null {
    let out: TorchMessage | null = null;
    if (bright && !this.on) {
      // Rising edge. A long gap since the last pulse ends the previous burst first.
      if (this.pulses > 0 && tMs - this.lastOff > BURST_END_MS) out = this.flush();
      this.on = true;
      this.onSince = tMs;
      this.doneReported = false;
    } else if (bright && this.on) {
      if (!this.doneReported && tMs - this.onSince >= TORCH_DONE_MS) {
        this.doneReported = true;
        this.pulses = 0;
        return "done";
      }
    } else if (!bright && this.on) {
      // Falling edge.
      this.on = false;
      const len = tMs - this.onSince;
      this.lastOff = tMs;
      if (this.doneReported) return out;
      if (len >= MIN_PULSE_MS && len <= MAX_PULSE_MS) this.pulses++;
      else if (len >= TORCH_DONE_MS * 0.8) {
        // The torch went off just before the full done length was sampled.
        this.pulses = 0;
        return "done";
      } else this.pulses = 0; // too short (noise) or too long (not a pulse): discard the burst
    } else if (this.pulses > 0 && tMs - this.lastOff > BURST_END_MS) {
      out = this.flush();
    }
    return out;
  }

  private flush(): TorchMessage | null {
    const n = this.pulses;
    this.pulses = 0;
    if (n === PULSES.slower) return "slower";
    if (n >= PULSES.faster) return "faster";
    return null;
  }
}

/**
 * Estimates the fraction of recent data frames the receiver missed, from gaps in the ESI sequence of each
 * block (senders emit symbols of a block in increasing ESI order; a looping stream wraps back to 0, which
 * resets without counting). Over the last `window` observed frames.
 */
export class LossEstimator {
  private readonly last = new Map<number, number>();
  private readonly events: { missed: number }[] = [];
  private received = 0;
  private missed = 0;

  constructor(private readonly window = 48) {}

  accept(sbn: number, esi: number): void {
    const prev = this.last.get(sbn);
    this.last.set(sbn, esi);
    let gap = 0;
    if (prev !== undefined && esi > prev + 1) gap = Math.min(esi - prev - 1, this.window);
    if (prev !== undefined && esi <= prev) return; // repeat or wrap: no information
    this.events.push({ missed: gap });
    this.received++;
    this.missed += gap;
    while (this.events.length > this.window) {
      const e = this.events.shift() as { missed: number };
      this.received--;
      this.missed -= e.missed;
    }
  }

  /** Null until enough frames have been seen to say anything. */
  get loss(): number | null {
    if (this.received < 12) return null;
    return this.missed / (this.missed + this.received);
  }

  get observed(): number {
    return this.received;
  }
}

/**
 * Receiver side: decides when to ask the sender to change speed. Hysteresis and a cooldown keep the torch quiet
 * most of the time; "faster" is only sent while the stream is far from complete, since a near-done stream gains
 * nothing from a change.
 */
export class ReceiverRateController {
  private lastSentAt = -Infinity;

  constructor(
    private readonly opts = { slowerAbove: 0.35, fasterBelow: 0.06, cooldownMs: 5000 },
  ) {}

  decide(loss: number | null, fraction: number, nowMs: number): Exclude<TorchMessage, "done"> | null {
    if (loss === null || nowMs - this.lastSentAt < this.opts.cooldownMs) return null;
    let msg: Exclude<TorchMessage, "done"> | null = null;
    if (loss > this.opts.slowerAbove) msg = "slower";
    else if (loss < this.opts.fasterBelow && fraction < 0.8) msg = "faster";
    if (msg) this.lastSentAt = nowMs;
    return msg;
  }
}

/** A sender's live QR rate: frame hold and codes on screen (bytes per code cannot change mid-stream). */
export interface QrRate {
  holdRefreshes60: number;
  codesPerScreen: 1 | 2 | 4;
}

/** Rates from slowest to fastest; "faster"/"slower" move one rung. */
export const RATE_LADDER: readonly QrRate[] = [
  ...QR_HOLDS.map((h) => ({ holdRefreshes60: h, codesPerScreen: 1 as const })),
  { holdRefreshes60: 2, codesPerScreen: 2 },
  { holdRefreshes60: 2, codesPerScreen: 4 },
];

export function rateIndex(r: QrRate): number {
  const i = RATE_LADDER.findIndex((x) => x.holdRefreshes60 === r.holdRefreshes60 && x.codesPerScreen === r.codesPerScreen);
  if (i >= 0) return i;
  // Off-ladder (a saved setting such as hold 3 × 2): the nearest rung by nominal rate.
  const rate = (x: QrRate) => (x.codesPerScreen * 60) / x.holdRefreshes60;
  let best = 0;
  for (let k = 1; k < RATE_LADDER.length; k++) if (Math.abs(rate(RATE_LADDER[k] as QrRate) - rate(r)) < Math.abs(rate(RATE_LADDER[best] as QrRate) - rate(r))) best = k;
  return best;
}

/** The next rate after `msg`, or the same rate at the end of the ladder. `maxCodes` caps codes on screen. */
export function adaptQrRate(current: QrRate, msg: Exclude<TorchMessage, "done">, maxCodes: 1 | 2 | 4 = 4): QrRate {
  let i = rateIndex(current);
  i = msg === "faster" ? i + 1 : i - 1;
  i = Math.max(0, Math.min(RATE_LADDER.length - 1, i));
  let r = RATE_LADDER[i] as QrRate;
  while (r.codesPerScreen > maxCodes && i > 0) r = RATE_LADDER[--i] as QrRate;
  return r;
}

/**
 * Plays torch schedules through `apply(on)`, one burst after another, with `setTimeout`. "done" repeats
 * `DONE_REPEATS` times so the sender's camera has several chances to see it.
 */
export class TorchPlayer {
  static readonly DONE_REPEATS = 3;
  private queue: TorchStep[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private on = false;

  constructor(private readonly apply: (on: boolean) => void) {}

  /** Queues a message; a "done" clears anything pending first. */
  play(msg: TorchMessage): void {
    if (msg === "done") {
      // A pause first, so a pulse in flight does not merge into the first long "on".
      this.queue = [{ on: false, ms: TORCH_PULSE_MS }];
      for (let i = 0; i < TorchPlayer.DONE_REPEATS; i++) this.queue.push(...torchSchedule("done"));
    } else {
      this.queue.push(...torchSchedule(msg));
    }
    if (this.timer === null) this.step();
  }

  get busy(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    this.queue = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.set(false);
  }

  private step(): void {
    const s = this.queue.shift();
    if (!s) {
      this.timer = null;
      this.set(false);
      return;
    }
    this.set(s.on);
    this.timer = setTimeout(() => this.step(), s.ms);
  }

  private set(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    this.apply(on);
  }
}
