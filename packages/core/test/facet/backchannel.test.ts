import { describe, expect, it } from "vitest";
import { BrightnessGate, LossEstimator, RATE_LADDER, ReceiverRateController, TORCH_DONE_MS, TorchDecoder, adaptQrRate, torchSchedule } from "../../src/facet/backchannel";

/** Plays a torch schedule through a decoder as a 30 fps camera would see it. */
function play(dec: TorchDecoder, steps: { on: boolean; ms: number }[], t0 = 0, fps = 30): { msgs: string[]; t: number } {
  const msgs: string[] = [];
  let t = t0;
  for (const s of steps) {
    const end = t + s.ms;
    for (; t < end; t += 1000 / fps) {
      const m = dec.push(s.on, t);
      if (m) msgs.push(m);
    }
  }
  return { msgs, t };
}

describe("torch schedule and decoder", () => {
  it("round-trips every message at 30 fps, including back to back", () => {
    const dec = new TorchDecoder();
    const all: string[] = [];
    let t = 0;
    for (const msg of ["slower", "faster", "done", "slower"] as const) {
      const r = play(dec, torchSchedule(msg), t);
      all.push(...r.msgs);
      t = r.t;
    }
    // Trailing darkness flushes the last burst.
    for (let i = 0; i < 30; i++) {
      const m = dec.push(false, t + i * 33);
      if (m) all.push(m);
    }
    expect(all).toEqual(["slower", "faster", "done", "slower"]);
  });
  it("reports done once while the torch stays on, after the done length", () => {
    const dec = new TorchDecoder();
    const msgs: string[] = [];
    for (let t = 0; t < 4000; t += 33) {
      const m = dec.push(true, t);
      if (m) msgs.push(m);
    }
    expect(msgs).toEqual(["done"]);
    expect(TORCH_DONE_MS).toBe(1500);
  });
  it("ignores a burst of three pulses and single flickers", () => {
    const dec = new TorchDecoder();
    const three = [...Array(3)].flatMap(() => [
      { on: true, ms: 250 },
      { on: false, ms: 250 },
    ]);
    three.push({ on: false, ms: 1000 });
    expect(play(dec, three).msgs).toEqual([]);
    const flicker = [
      { on: true, ms: 33 },
      { on: false, ms: 1000 },
    ];
    expect(play(new TorchDecoder(), flicker, 0, 60).msgs).toEqual([]);
  });
  it("survives one dropped camera frame inside a pulse", () => {
    const dec = new TorchDecoder();
    const msgs: string[] = [];
    const steps = torchSchedule("faster");
    let t = 0;
    let n = 0;
    for (const s of steps) {
      const end = t + s.ms;
      for (; t < end; t += 33) {
        n++;
        if (n === 5) continue; // camera dropped a frame
        const m = dec.push(s.on, t);
        if (m) msgs.push(m);
      }
    }
    for (let i = 0; i < 30; i++) {
      const m = dec.push(false, t + i * 33);
      if (m) msgs.push(m);
    }
    expect(msgs).toEqual(["faster"]);
  });
});

describe("brightness gate", () => {
  it("switches on a fixed step above the ambient floor and tracks a slowly brightening room", () => {
    const g = new BrightnessGate();
    for (let i = 0; i < 30; i++) expect(g.push(40 + (i % 3))).toBe(false);
    expect(g.push(200)).toBe(true);
    expect(g.push(150)).toBe(true); // hysteresis: still well above floor + step/2
    expect(g.push(60)).toBe(false);
    for (let i = 0; i < 400; i++) g.push(120); // the room got brighter and stayed so: that is the new floor
    expect(g.push(130)).toBe(false);
    expect(g.push(255)).toBe(true);
  });
});

describe("loss estimator", () => {
  it("counts gaps in each block's ESI sequence over a window", () => {
    const e = new LossEstimator(48);
    for (let esi = 0; esi < 20; esi++) e.accept(0, esi);
    expect(e.loss).toBe(0);
    for (let esi = 20; esi < 40; esi += 2) e.accept(0, esi); // every other frame missed
    expect(e.loss).toBeCloseTo(9 / 39, 5); // the step from 19 to 20 has no gap
    e.accept(1, 5); // first sight of block 1: no gap counted
    expect(e.observed).toBe(31);
  });
  it("needs a dozen frames before reporting and treats a loop wrap as no loss", () => {
    const e = new LossEstimator();
    for (let esi = 0; esi < 11; esi++) e.accept(0, esi);
    expect(e.loss).toBeNull();
    e.accept(0, 11);
    expect(e.loss).toBe(0);
    e.accept(0, 0);
    expect(e.loss).toBe(0);
  });
});

describe("rate control", () => {
  it("asks for slower above 35 % loss, faster below 6 % while far from done, with a cooldown", () => {
    const c = new ReceiverRateController();
    expect(c.decide(null, 0, 0)).toBeNull();
    expect(c.decide(0.5, 0.1, 1000)).toBe("slower");
    expect(c.decide(0.5, 0.1, 2000)).toBeNull(); // cooling down
    expect(c.decide(0.01, 0.1, 7000)).toBe("faster");
    expect(c.decide(0.01, 0.9, 13000)).toBeNull(); // nearly done
    expect(c.decide(0.2, 0.1, 19000)).toBeNull(); // in the dead band
  });
  it("walks the ladder one rung at a time and clamps at both ends", () => {
    expect(RATE_LADDER[0]).toEqual({ holdRefreshes60: 6, codesPerScreen: 1 });
    expect(adaptQrRate({ holdRefreshes60: 6, codesPerScreen: 1 }, "faster")).toEqual({ holdRefreshes60: 4, codesPerScreen: 1 });
    expect(adaptQrRate({ holdRefreshes60: 6, codesPerScreen: 1 }, "slower")).toEqual({ holdRefreshes60: 6, codesPerScreen: 1 });
    expect(adaptQrRate({ holdRefreshes60: 2, codesPerScreen: 1 }, "faster")).toEqual({ holdRefreshes60: 2, codesPerScreen: 2 });
    expect(adaptQrRate({ holdRefreshes60: 2, codesPerScreen: 4 }, "faster")).toEqual({ holdRefreshes60: 2, codesPerScreen: 4 });
    expect(adaptQrRate({ holdRefreshes60: 2, codesPerScreen: 1 }, "faster", 1)).toEqual({ holdRefreshes60: 2, codesPerScreen: 1 });
  });
  it("places an off-ladder rate at the nearest rung", () => {
    // hold 3 × 2 codes ≈ 40 frames/s sits nearest the 30/s rung, so "slower" lands on 20/s.
    expect(adaptQrRate({ holdRefreshes60: 3, codesPerScreen: 2 }, "slower")).toEqual({ holdRefreshes60: 3, codesPerScreen: 1 });
  });
});

describe("receiver loss and sender hold through the codec", () => {
  it("reports recent loss when every other T0 frame is skipped, and the sender can change its hold live", async () => {
    const { prepareAirgapStream, createReverseKeyOffer, FacetReceiver, SoftwareAgreementKey } = await import("../../src/index");
    const rx = new SoftwareAgreementKey();
    const offer = createReverseKeyOffer("https://sealed.to", { agreement: rx }, "rx", 0);
    const { parseCode } = await import("../../src/index");
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected reverse key");
    const bytes = new Uint8Array(30_000);
    for (let i = 0, x = 12345; i < bytes.length; i++) bytes[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >>> 16; // incompressible
    const p = await prepareAirgapStream({ files: [{ path: "a.bin", mediaType: "application/octet-stream", size: bytes.length, data: bytes }], reverseKey: rk, senderLabel: "tx" });
    const receiver = new FacetReceiver({ tiers: [0] });
    p.sender.setQrHold(2);
    for (let i = 0; i < 60; i++) {
      const f = p.sender.next();
      expect(f.holdRefreshes).toBe(2);
      if (f.type === "data" && i % 2 === 1) continue; // the camera missed it
      receiver.pushQrCode(p.sender.qrText(f) as string, i * 33);
    }
    const loss = receiver.progress.recentLoss;
    expect(loss).not.toBeNull();
    expect(loss as number).toBeGreaterThan(0.3);
    expect(loss as number).toBeLessThan(0.6);
    expect(() => p.sender.setQrHold(5)).toThrow(RangeError);
  });
});

describe("torch player", () => {
  it("plays bursts back to back and repeats done, driving the torch through apply()", async () => {
    const { TorchPlayer } = await import("../../src/facet/backchannel");
    const vi = await import("vitest");
    vi.vi.useFakeTimers();
    const log: [number, boolean][] = [];
    const player = new TorchPlayer((on) => log.push([Date.now(), on]));
    const t0 = Date.now();
    player.play("slower");
    player.play("done");
    vi.vi.advanceTimersByTime(20_000);
    expect(player.busy).toBe(false);
    const rel = log.map(([t, on]) => [t - t0, on]);
    // "done" replaced the pending part of the queue: the pulse in flight ends at 250, a pause, then 3 × (on 1500, off 800).
    expect(rel.slice(0, 4)).toEqual([
      [0, true],
      [250, false],
      [500, true],
      [2000, false],
    ]);
    expect(rel.filter(([, on]) => on).length).toBe(1 + TorchPlayer.DONE_REPEATS);
    vi.vi.useRealTimers();
  });
});
