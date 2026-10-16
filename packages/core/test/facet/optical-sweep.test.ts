import { describe, expect, it } from "vitest";
import { runSimulatedBenchmark } from "../../bench/optical-sweep";

describe("optical benchmark sweep runner", () => {
  it("runs a simulated benchmark scenario and verifies the payload", async () => {
    const res = await runSimulatedBenchmark({
      size: 16 * 1024,
      symbolSize: 840,
      qrVersion: 21,
      codesPerScreen: 1,
      fps: 10,
      dropRate: 0.1,
    });

    expect(res.verified).toBe(true);
    expect(res.screensToComplete).toBeGreaterThan(0);
    expect(res.goodputKBps).toBeGreaterThan(0);
    expect(res.error).toBeNull();
  });

  it("handles multi-code and high loss scenarios gracefully", async () => {
    const res = await runSimulatedBenchmark({
      size: 16 * 1024,
      symbolSize: 1216,
      qrVersion: 25,
      codesPerScreen: 2,
      fps: 20,
      dropRate: 0.3,
    });

    expect(res.verified).toBe(true);
    expect(res.screensToComplete).toBeLessThan(100);
    expect(res.goodputKBps).toBeGreaterThan(10);
  });
});
