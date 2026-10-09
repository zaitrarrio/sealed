import { TIERS } from "@sealed/core";
import { describe, expect, it } from "vitest";
import { FrameScheduler, holdFor, snapRefreshRate, streamSizePx } from "../src/lib/frame-scheduler";

/** Drives the scheduler like requestAnimationFrame at `hz` and returns how many refreshes each frame was held. */
function run(hz: number, refreshes: number, hold60: number, jitterMs = 0): { holds: number[]; s: FrameScheduler } {
  const s = new FrameScheduler();
  const holds: number[] = [];
  let since = 0;
  let t = 0;
  for (let i = 0; i < refreshes; i++) {
    t += 1000 / hz + (jitterMs ? (i % 2 ? jitterMs : -jitterMs) : 0);
    s.observe(t);
    if (s.tick()) {
      if (s.framesShown > 0) holds.push(since);
      s.beginFrame(hold60);
      since = 0;
    }
    since++;
  }
  return { holds, s };
}

describe("frame scheduler (spec §7.3)", () => {
  it("snaps measured rates to common panel rates", () => {
    expect(snapRefreshRate(59.94)).toBe(60);
    expect(snapRefreshRate(119.6)).toBe(120);
    expect(snapRefreshRate(143.2)).toBe(144);
    expect(snapRefreshRate(37)).toBe(37);
  });

  it("scales holds with refresh rate: 120 Hz doubles every hold", () => {
    expect(holdFor(6, 60)).toBe(6);
    expect(holdFor(6, 120)).toBe(12);
    expect(holdFor(4, 120)).toBe(8);
    expect(holdFor(3, 120)).toBe(6);
    expect(holdFor(6, 144)).toBe(14);
    expect(holdFor(6, 30)).toBe(3);
    expect(holdFor(1, 24)).toBe(1);
    expect(holdFor(6, NaN)).toBe(6);
  });

  it("holds T1 frames for 6 refreshes at 60 Hz (10 data fps)", () => {
    const { holds, s } = run(60, 600, TIERS[1].holdRefreshes60);
    expect(s.refreshRate).toBe(60);
    // After the warm-up, every frame is held exactly 6 refreshes.
    expect(holds.slice(3).every((h) => h === 6)).toBe(true);
    expect(s.framesShown).toBeGreaterThanOrEqual(99);
    expect(s.framesShown).toBeLessThanOrEqual(101);
  });

  it("holds 12 refreshes at 120 Hz, keeping the same frame rate in wall-clock time", () => {
    const { holds, s } = run(120, 1200, TIERS[1].holdRefreshes60);
    expect(s.refreshRate).toBe(120);
    expect(holds.slice(10).every((h) => h === 12)).toBe(true);
    // 10 s at 120 Hz → about 100 frames, same as 10 s at 60 Hz.
    expect(Math.abs(s.framesShown - 100)).toBeLessThanOrEqual(4);
  });

  it("tolerates timestamp jitter and ignores stalls when estimating the rate", () => {
    const s = new FrameScheduler();
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += i === 100 ? 900 : 1000 / 120 + (i % 3 === 0 ? 0.6 : -0.3);
      s.observe(t);
    }
    expect(s.refreshRate).toBe(120);
  });

  it("starts at 60 Hz before enough samples exist and counts refreshes, not time", () => {
    const s = new FrameScheduler();
    expect(s.refreshRate).toBe(60);
    expect(s.tick()).toBe(true);
    s.beginFrame(6);
    // Even with long gaps between callbacks (e.g. a slow refresh), a frame advances only after 6 refreshes.
    let t = 0;
    let advanced = 0;
    for (let i = 0; i < 6; i++) {
      t += 50;
      s.observe(t);
      if (s.tick()) advanced = i + 1;
    }
    expect(advanced).toBe(6);
  });

  it("sizes the stream to the largest square that fits, in device pixels", () => {
    expect(streamSizePx(390, 844, 3, 12)).toBe(Math.floor((390 - 24) * 3));
    expect(streamSizePx(1920, 1080, 1, 12)).toBe(1080 - 24);
    expect(streamSizePx(10, 10, 1, 12)).toBe(0);
  });
});
