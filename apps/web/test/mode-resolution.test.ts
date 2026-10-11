import { describe, expect, it } from "vitest";
import { resolveSendMode, sendModeLabel } from "../src/lib/mode-resolution";

describe("resolveSendMode", () => {
  it("defaults to direct when online", () => {
    expect(resolveSendMode({ online: true, allowRoom: false, preferOffline: false, anyoneWatching: false })).toBe("direct");
  });

  it("uses room when the multiple-people toggle is on", () => {
    expect(resolveSendMode({ online: true, allowRoom: true, preferOffline: false, anyoneWatching: false })).toBe("room");
  });

  it("falls back to airgap when offline", () => {
    expect(resolveSendMode({ online: false, allowRoom: false, preferOffline: false, anyoneWatching: false })).toBe("airgap");
  });

  it("uses broadcast when offline and anyone-watching", () => {
    expect(resolveSendMode({ online: false, allowRoom: false, preferOffline: true, anyoneWatching: true })).toBe("broadcast");
  });

  it("labels modes without jargon", () => {
    expect(sendModeLabel("direct")).not.toMatch(/SAS|DAK|Facet|CEK/i);
    expect(sendModeLabel("airgap")).toMatch(/screen/i);
  });
});
