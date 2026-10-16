import { describe, expect, it } from "vitest";
import { TARGET_EXPOSURE_UNITS, shortenedExposure } from "../src/lib/camera";

describe("shortened exposure for reading a screen (web)", () => {
  const caps = { exposureTime: { min: 1, max: 5000 }, iso: { min: 50, max: 3200 } };
  it("shortens to 1/500 s and raises ISO proportionally", () => {
    expect(shortenedExposure(caps, { exposureTime: 166, iso: 100 })).toEqual({ exposureTime: TARGET_EXPOSURE_UNITS, iso: 830 });
  });
  it("leaves a short exposure alone and copes with missing ISO", () => {
    expect(shortenedExposure(caps, { exposureTime: 10, iso: 100 })).toBeNull();
    expect(shortenedExposure({ exposureTime: caps.exposureTime }, { exposureTime: 200 })).toEqual({ exposureTime: 20 });
    expect(shortenedExposure({}, { exposureTime: 200 })).toBeNull();
  });
});
