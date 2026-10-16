import { describe, expect, it } from "vitest";
import { FacetReceiver, FacetSender } from "../../src/facet/index";
import { cellSizeFor, QR_QUIET_MODULES } from "../../src/facet/render";
import { QR_VERSION } from "../../src/facet/qr";
import type { Tier } from "../../src/facet/types";
import { CameraChannel, Rng, type ChannelOptions } from "./channel";

function same(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * ADR-0008 `facet/roundtrip.synthetic`: frames → simulated camera (perspective pose up to 15°, perspective skew,
 * scale 0.6–1.0 in a cluttered 1280×960 scene, optical blur, color mixing ±8 %, tone curve 0.8–1.25, noise σ 6,
 * 20 % dropped and 15 % torn captures, hand shake) → receiver must rebuild the exact Envelope.
 *
 * Grid tiers run at blur σ = 0.35 cell. T0 is plain QR read with jsQR, whose binarizer limits it to milder
 * conditions (blur σ 0.15 module, ≤ 5° rotation); that is the compatibility tier's documented envelope.
 */
const CASES: { tier: Tier; bytes: number; channel: Partial<ChannelOptions>; maxFrames: number }[] = [
  { tier: 1, bytes: 30_000, channel: { blurCells: 0.35 }, maxFrames: 40 },
  { tier: 2, bytes: 30_000, channel: { blurCells: 0.35 }, maxFrames: 40 },
  { tier: 3, bytes: 40_000, channel: { blurCells: 0.35 }, maxFrames: 40 },
  { tier: 0, bytes: 2_500, channel: { blurCells: 0.15, maxRotationDeg: 5 }, maxFrames: 120 },
];

describe("Facet synthetic camera round trip", () => {
  for (const c of CASES) {
    it(`tier ${c.tier}`, { timeout: 240_000 }, () => {
      const rng = new Rng(100 + c.tier);
      const envelope = rng.bytes(c.bytes);
      const sender = new FacetSender({ envelope, tier: c.tier, descriptor: { cek: rng.bytes(32) } });
      const receiver = new FacetReceiver();
      const channel = new CameraChannel({ seed: 200 + c.tier, ...c.channel });
      const size = 1000;
      const cellPx = c.tier === 0 ? Math.floor(size / (QR_VERSION * 4 + 17 + 2 * QR_QUIET_MODULES)) : cellSizeFor(size, c.tier === 3 ? 144 : 112);
      let frames = 0;
      let decodeMs = 0;
      while (frames < c.maxFrames && !receiver.progress.complete) {
        const frame = sender.next();
        frames++;
        if (!channel.delivered()) continue;
        const capture = channel.capture(sender.render(frame, size), cellPx);
        const t = performance.now();
        receiver.push(capture.image);
        decodeMs += performance.now() - t;
      }
      const p = receiver.progress;
      const perFrame = decodeMs / Math.max(1, p.framesSeen);
      console.log(`tier ${c.tier}: ${frames} frames shown, ${p.framesDecoded}/${p.framesSeen} captures decoded, ${perFrame.toFixed(0)} ms/capture`);
      expect(same(receiver.result(), envelope)).toBe(true);
      if (c.tier === 2) expect(perFrame).toBeLessThan(1500);
    });
  }
});
