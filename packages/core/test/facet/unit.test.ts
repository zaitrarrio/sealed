import { describe, expect, it } from "vitest";
import { randomBytes } from "../../src/crypto/primitives";
import { HEADER_BYTES, decodeHeaderStrip, encodeFrameHeader, headerCrcMatches, headerStripBits, parseFrameHeader } from "../../src/facet/header";
import { GLYPH_COUNT, blurredTemplate, minPairwiseDistance } from "../../src/facet/glyphs";
import { encodeDataCells, gridLayout } from "../../src/facet/grid";
import { TIERS, chooseTier } from "../../src/facet/tiers";
import { FacetSender } from "../../src/facet/sender";

describe("Facet header", () => {
  it("round-trips, binds the payload with CRC, and corrects 4 byte errors per strip", () => {
    const streamId = randomBytes(4);
    const payload = randomBytes(TIERS[1].symbolSize);
    const h = encodeFrameHeader({ tier: 1, type: "data", loop: false, signed: true, streamId, sbn: 3, esi: 70_000 }, payload);
    expect(h.length).toBe(HEADER_BYTES);
    const parsed = parseFrameHeader(h)!;
    expect(parsed).toMatchObject({ tier: 1, type: "data", sbn: 3, esi: 70_000, signed: true });
    expect(parsed.streamId).toEqual(streamId);
    expect(headerCrcMatches(h, payload)).toBe(true);
    const other = payload.slice();
    other[5] = (other[5] as number) ^ 1;
    expect(headerCrcMatches(h, other)).toBe(false);

    const bits = headerStripBits(h);
    const damaged = bits.slice();
    for (const byte of [0, 7, 13, 19]) for (let b = 0; b < 8; b++) damaged[byte * 8 + b] = (damaged[byte * 8 + b] as number) ^ 1;
    expect(decodeHeaderStrip(damaged)).toEqual(h);
    for (let b = 0; b < 8; b++) damaged[3 * 8 + b] = (damaged[3 * 8 + b] as number) ^ 1;
    const fiveErrors = decodeHeaderStrip(damaged);
    expect(fiveErrors === null || !fiveErrors.every((v, i) => v === h[i])).toBe(true);
  });
});

describe("Facet symbol alphabet and layout", () => {
  it("keeps all 16 glyphs separable under camera blur", () => {
    for (const colors of [4, 8]) {
      const templates = Array.from({ length: GLYPH_COUNT }, (_, s) => blurredTemplate(s, colors, 8, 0.35));
      expect(minPairwiseDistance(templates)).toBeGreaterThan(0.02);
    }
  });

  it("is deterministic per tier and frame identity", () => {
    for (const tier of [1, 2, 3] as const) {
      const layout = gridLayout(tier);
      const id = { streamId: new Uint8Array([1, 2, 3, 4]), tier, type: "data" as const, sbn: 0, esi: 5 };
      const payload = randomBytes(TIERS[tier].symbolSize);
      expect(encodeDataCells(layout, id, payload)).toEqual(encodeDataCells(gridLayout(tier), id, payload));
      expect(layout.n).toBe(TIERS[tier].grid);
    }
  });

  it("matches the spec's per-frame capacity table", () => {
    expect([TIERS[0].symbolSize, TIERS[1].symbolSize, TIERS[2].symbolSize, TIERS[3].symbolSize]).toEqual([840, 7240, 8280, 14072]);
    expect([TIERS[1].grid, TIERS[2].grid, TIERS[3].grid]).toEqual([112, 112, 144]);
  });

  it("chooses tiers from measured capability (spec §7.7)", () => {
    expect(chooseTier({ captureFps: 120, pixelsPerCell: 6, decodeMsPerFrame: 30 })).toBe(3);
    expect(chooseTier({ captureFps: 60, pixelsPerCell: 5, decodeMsPerFrame: 50 })).toBe(2);
    expect(chooseTier({ captureFps: 30, pixelsPerCell: 4.2, decodeMsPerFrame: 80 })).toBe(1);
    expect(chooseTier({ captureFps: 15, pixelsPerCell: 3, decodeMsPerFrame: 200 })).toBe(0);
  });

  it("schedules calibration, descriptors and unlimited repair symbols", () => {
    const s = new FacetSender({ envelope: randomBytes(20_000), tier: 1, descriptor: { cek: randomBytes(32) } });
    const types = Array.from({ length: 200 }, () => s.next().type);
    expect(types.slice(0, 6)).toEqual(["calibration", "calibration", "calibration", "descriptor", "descriptor", "descriptor"]);
    expect(types.filter((t) => t === "data").length).toBeGreaterThan(180);
    expect(types).not.toContain("end");
    expect(s.finished).toBe(false);
  });
});
