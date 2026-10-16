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
});
