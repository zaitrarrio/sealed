import { describe, expect, it } from "vitest";
import { BenchmarkMeter, benchmarkFileName, benchmarkPayload, formatBenchmarkReport, parseBenchmarkFileName, prepareBenchmarkStream } from "../../src/facet/bench";

/** A fake clock the meter reads: each detector read advances it by `stepMs`. */
function clock(stepMs: number) {
  let t = 1000;
  return { now: () => t, tick: () => (t += stepMs) };
}

describe("optical benchmark", () => {
  it("names and regenerates payloads deterministically", () => {
    expect(parseBenchmarkFileName(benchmarkFileName(42, 65536))).toEqual({ seed: 42, size: 65536 });
    expect(parseBenchmarkFileName("holiday.jpg")).toBeNull();
    expect(benchmarkPayload(7, 64)).toEqual(benchmarkPayload(7, 64));
    expect(benchmarkPayload(7, 64)).not.toEqual(benchmarkPayload(8, 64));
  });

  it("reports the stage a run reached: nothing, non-Sealed codes, receiving, verified", async () => {
    const c = clock(100);
    const meter = new BenchmarkMeter(c.now);
    expect(meter.report().stage).toBe("no-input");
    meter.pushCode("https://example.com/menu");
    c.tick();
    expect(meter.report().stage).toBe("no-sealed-frames");

    const { sender, size } = await prepareBenchmarkStream({ size: 16 * 1024, tier: 0, seed: 1234 });
    for (let i = 0; i < 400 && !meter.complete; i++) {
      const text = sender.qrText(sender.next());
      if (text && i % 4 !== 1) meter.pushCode(text); // 25% of frames missed
      c.tick();
      if (i === 3) expect(meter.report().stage).toBe("receiving");
    }
    expect(meter.complete).toBe(true);
    await meter.finished();
    const r = meter.report();
    expect(r.stage).toBe("verified");
    expect(r.verified).toBe(true);
    expect(r.payloadBytes).toBe(size);
    expect(r.tier).toBe(0);
    expect(r.goodputBytesPerSecond).toBeGreaterThan(0);
    expect(r.timeToFirstFrameMs).toBe(100);
    expect(formatBenchmarkReport(r)).toContain("verified        yes");
  });

  it("streams and verifies Tier 4 Monochrome Patch Modem through BenchmarkMeter", async () => {
    const c = clock(33); // ~30 fps
    const meter = new BenchmarkMeter(c.now);

    const { sender, size } = await prepareBenchmarkStream({ size: 16 * 1024, tier: 4, seed: 9999 });
    expect(sender.tier).toBe(4);

    for (let i = 0; i < 400 && !meter.complete; i++) {
      const frame = sender.next();
      const img = sender.render(frame, 560);
      meter.pushImage(img);
      c.tick();
      if (i === 1) {
        const rep = meter.report();
        expect(rep.stage).toBe("receiving");
        expect(rep.tier).toBe(4);
      }
    }

    expect(meter.complete).toBe(true);
    await meter.finished();
    const r = meter.report();
    expect(r.stage).toBe("verified");
    expect(r.verified).toBe(true);
    expect(r.payloadBytes).toBe(size);
    expect(r.tier).toBe(4);
    expect(r.goodputBytesPerSecond).toBeGreaterThan(0);
    expect(r.verdict).toContain("Monochrome Patch Modem");
  });

  it("feeds raw BGRA camera buffers through pushRaw to lock and decode Tier 4", async () => {
    const c = clock(33);
    const meter = new BenchmarkMeter(c.now);

    const { sender, size } = await prepareBenchmarkStream({ size: 16 * 1024, tier: 4, seed: 777 });

    for (let i = 0; i < 400 && !meter.complete; i++) {
      const frame = sender.next();
      const img = sender.render(frame, 560);

      // Simulate an iOS VisionCamera frame: BGRA 8-bit with row padding
      const stride = img.width * 4 + 64; // stride > width * 4
      const bgra = new Uint8Array(stride * img.height);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const srcIdx = (y * img.width + x) * 4;
          const dstIdx = y * stride + x * 4;
          bgra[dstIdx] = img.data[srcIdx + 2] as number; // B
          bgra[dstIdx + 1] = img.data[srcIdx + 1] as number; // G
          bgra[dstIdx + 2] = img.data[srcIdx] as number; // R
          bgra[dstIdx + 3] = 255;
        }
      }

      meter.pushRaw(bgra, img.width, img.height, stride, "bgra");
      c.tick();
      if (i === 1) {
        const rep = meter.report();
        expect(rep.stage).toBe("receiving");
        expect(rep.tier).toBe(4);
      }
    }

    expect(meter.complete).toBe(true);
    await meter.finished();
    const r = meter.report();
    expect(r.stage).toBe("verified");
    expect(r.verified).toBe(true);
    expect(r.payloadBytes).toBe(size);
    expect(r.tier).toBe(4);
  });

  it("streams and verifies Tier 5 Learned Optical Modem through BenchmarkMeter", async () => {
    const c = clock(33);
    const meter = new BenchmarkMeter(c.now);

    const { sender, size } = await prepareBenchmarkStream({ size: 16 * 1024, tier: 5, seed: 5555 });
    expect(sender.tier).toBe(5);

    for (let i = 0; i < 400 && !meter.complete; i++) {
      const frame = sender.next();
      const img = sender.render(frame, 560);
      meter.pushImage(img);
      c.tick();
      if (i === 1) {
        const rep = meter.report();
        expect(rep.stage).toBe("receiving");
        expect(rep.tier).toBe(5);
      }
    }

    expect(meter.complete).toBe(true);
    await meter.finished();
    const r = meter.report();
    expect(r.stage).toBe("verified");
    expect(r.verified).toBe(true);
    expect(r.payloadBytes).toBe(size);
    expect(r.tier).toBe(5);
    expect(r.goodputBytesPerSecond).toBeGreaterThan(0);
    expect(r.verdict).toContain("Learned Optical Modem");
  });
});
