import { CodeError, claimCode, createReverseKeyOffer, randomBytes, SoftwareAgreementKey, toB64url } from "@sealed/core";
import { describe, expect, it } from "vitest";
import { tierForMeasurement } from "../src/lib/capability";
import { inAppRouteFor, peekCode, takeCode } from "../src/lib/code-stash";
import { isSupportedFormat, toRgba } from "../src/lib/frame-convert";

const ORIGIN = "https://sealed.to";

describe("frame conversion", () => {
  it("unpacks padded BGRA rows into tight RGBA", () => {
    const w = 3;
    const h = 2;
    const stride = 16; // 12 bytes of pixels + 4 padding
    const src = new Uint8Array(stride * h).fill(0xee);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * stride + x * 4;
        src[p] = 10 * x; // B
        src[p + 1] = 100 + y; // G
        src[p + 2] = 200; // R
        src[p + 3] = 7; // A (ignored)
      }
    const img = toRgba(src, w, h, stride, "rgb-bgra-8-bit");
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect([...img.data.slice(0, 4)]).toEqual([200, 100, 0, 255]);
    expect([...img.data.slice(20, 24)]).toEqual([200, 101, 20, 255]);
  });

  it("reads RGBA and packed RGB, and box-downsamples large frames", () => {
    const rgb = new Uint8Array([1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]);
    const one = toRgba(rgb, 2, 2, 6, "rgb-rgb-8-bit", 1);
    expect(one.width).toBe(1);
    expect([...one.data]).toEqual([7, 8, 9, 255]);
    const rgba = new Uint8Array([9, 8, 7, 0]);
    expect([...toRgba(rgba, 1, 1, 4, "rgb-rgba-8-bit").data]).toEqual([9, 8, 7, 255]);
  });

  it("rejects short buffers and unknown formats", () => {
    expect(() => toRgba(new Uint8Array(10), 4, 4, 16, "rgb-rgba-8-bit")).toThrow(/shorter/);
    expect(() => toRgba(new Uint8Array(64), 4, 4, 8, "rgb-rgba-8-bit")).toThrow(/bytesPerRow/);
    expect(isSupportedFormat("yuv-420-8-bit-video")).toBe(false);
    expect(isSupportedFormat("rgb-bgra-8-bit")).toBe(true);
  });
});

describe("capability tier", () => {
  it("defaults to T1 and follows measured decode speed", () => {
    expect(tierForMeasurement(undefined)).toBe(1);
    expect(tierForMeasurement({ captureFps: 60, decodeMsPerFrame: 100 })).toBe(3);
    expect(tierForMeasurement({ captureFps: 30, decodeMsPerFrame: 250 })).toBe(2);
    expect(tierForMeasurement({ captureFps: 30, decodeMsPerFrame: 800 })).toBe(1);
    expect(tierForMeasurement({ captureFps: 30, decodeMsPerFrame: 3000 })).toBe(0);
    expect(tierForMeasurement({ captureFps: 12, decodeMsPerFrame: 100 })).toBe(0);
  });
});

describe("code stash and routing", () => {
  it("routes each code kind to its screen without putting the secret in the route", () => {
    const tid = randomBytes(16);
    const claim = claimCode(ORIGIN, tid, randomBytes(16));
    const route = inAppRouteFor(claim, [ORIGIN]);
    expect(route.startsWith(`/c/${toB64url(tid)}?ref=`)).toBe(true);
    expect(route).not.toContain("#");
    expect(route).not.toContain(claim.split("#")[1]!);
    const ref = route.split("ref=")[1]!;
    expect(peekCode(ref)).toBe(claim);
    expect(takeCode(ref)).toBe(claim);
    expect(takeCode(ref)).toBeNull();

    const rk = createReverseKeyOffer(ORIGIN, { agreement: new SoftwareAgreementKey() }, "Phone", 1);
    expect(inAppRouteFor(rk.code, [ORIGIN]).startsWith("/k?ref=")).toBe(true);
  });

  it("rejects codes from untrusted origins", () => {
    const claim = claimCode("https://evil.example", randomBytes(16), randomBytes(16));
    expect(() => inAppRouteFor(claim, [ORIGIN])).toThrow(CodeError);
  });
});
