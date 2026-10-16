import { describe, expect, it } from "vitest";
import { TARGET_EXPOSURE_S, screenBias, shortenedExposure } from "../src/lib/camera-lock";

const range = { minExposureDuration: 1 / 8000, maxExposureDuration: 1 / 3, minISO: 32, maxISO: 3200 };

describe("shortened exposure for reading a screen", () => {
  it("shortens a long auto exposure to the target and raises ISO to compensate", () => {
    const r = shortenedExposure({ ...range, exposureDuration: 1 / 60, iso: 100 });
    expect(r).not.toBeNull();
    expect(r!.durationS).toBeCloseTo(TARGET_EXPOSURE_S, 6);
    expect(r!.iso).toBe(Math.round(100 * (500 / 60)));
  });
  it("leaves an already short exposure alone", () => {
    expect(shortenedExposure({ ...range, exposureDuration: 1 / 1000, iso: 50 })).toBeNull();
  });
  it("clamps ISO to the device range instead of failing", () => {
    const r = shortenedExposure({ ...range, exposureDuration: 1 / 15, iso: 800 });
    expect(r!.iso).toBe(3200);
  });
  it("returns null without a usable range", () => {
    expect(shortenedExposure({ exposureDuration: 0, iso: 0, minExposureDuration: 0, maxExposureDuration: 0, minISO: 0, maxISO: 0 })).toBeNull();
  });
});

describe("exposure bias before metering", () => {
  it("is -1.5 EV on iOS, clamped to the device range", () => {
    expect(screenBias({ supportsExposureBias: true, minExposureBias: -8, maxExposureBias: 8 }, "ios")).toBe(-1.5);
    expect(screenBias({ supportsExposureBias: true, minExposureBias: -1, maxExposureBias: 1 }, "ios")).toBe(-1);
  });
  it("is half the negative range in steps on Android", () => {
    expect(screenBias({ supportsExposureBias: true, minExposureBias: -12, maxExposureBias: 12 }, "android")).toBe(-6);
    expect(screenBias({ supportsExposureBias: true, minExposureBias: -3, maxExposureBias: 3 }, "android")).toBe(-2);
  });
  it("is null without bias support", () => {
    expect(screenBias({ supportsExposureBias: false, minExposureBias: 0, maxExposureBias: 0 }, "ios")).toBeNull();
  });
});
