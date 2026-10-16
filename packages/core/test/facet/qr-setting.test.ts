import { describe, expect, it } from "vitest";
import { DEFAULT_QR_STREAM, describeQrStream, isDefaultQrStream, qrStreamSetting } from "../../src/facet/tiers";

describe("saved QR stream setting", () => {
  it("falls back to the default for missing or invalid storage", () => {
    expect(qrStreamSetting(undefined)).toEqual(DEFAULT_QR_STREAM);
    expect(qrStreamSetting({ symbolSize: 1004, codesPerScreen: 3, holdRefreshes60: 5 })).toEqual(DEFAULT_QR_STREAM);
    expect(isDefaultQrStream(qrStreamSetting("junk"))).toBe(true);
  });
  it("keeps valid fields", () => {
    const s = qrStreamSetting({ symbolSize: 1664, codesPerScreen: 2, holdRefreshes60: 3 });
    expect(s).toEqual({ symbolSize: 1664, codesPerScreen: 2, holdRefreshes60: 3 });
    expect(isDefaultQrStream(s)).toBe(false);
    expect(describeQrStream(s)).toBe("v30 · 1,664 B × 2 at 20/s (≤ 65 KB/s)");
  });
});
