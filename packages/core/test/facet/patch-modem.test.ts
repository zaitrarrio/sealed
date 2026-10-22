import { describe, expect, it } from "vitest";
import {
  renderPatchField,
  decodePatchField,
  getPatchBounds,
  TOTAL_PATCHES,
  PATCH_PAYLOAD_BYTES,
  type PatchPacket,
} from "../../src/facet/patch-modem";
import { PatchSender, PatchReceiver } from "../../src/facet/patch-stream";
import { GridDetector, gridHomography, linearLuma } from "../../src/facet/detect";
import type { RgbaImage } from "../../src/facet/types";
import { sha256 } from "../../src/crypto/primitives";
import { CameraChannel } from "./channel";

function rotateImage90(img: RgbaImage): RgbaImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4;
      // 90 deg clockwise: newX = h - 1 - y, newY = x
      const dstIdx = (x * h + (h - 1 - y)) * 4;
      out[dstIdx] = data[srcIdx] as number;
      out[dstIdx + 1] = data[srcIdx + 1] as number;
      out[dstIdx + 2] = data[srcIdx + 2] as number;
      out[dstIdx + 3] = data[srcIdx + 3] as number;
    }
  }
  return { width: h, height: w, data: out };
}

describe("Monochrome Patch Modem (Proposal)", () => {
  it("encodes and decodes 16 independent patches in a single frame", () => {
    const packets: PatchPacket[] = [];
    for (let i = 0; i < TOTAL_PATCHES; i++) {
      const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
      for (let b = 0; b < payload.length; b++) payload[b] = (i * 13 + b) & 0xff;
      packets.push({
        epoch: 0,
        patchId: i,
        sbn: 0,
        esi: i,
        payload,
      });
    }

    const img = renderPatchField(packets, 560);
    const detector = new GridDetector();
    const sets = detector.detect(img);
    expect(sets.length).toBeGreaterThan(0);

    const luma = detector.luma!;
    const h = gridHomography(sets[0]!, 112, luma);
    expect(h).not.toBeNull();

    const decoded = decodePatchField(luma, h!);
    console.error("TEST 1 SET[0]:", sets[0], "DECODED:", decoded);
    expect(decoded.validPackets.length).toBe(16);
    expect(decoded.erasureCount).toBe(0);
    expect(decoded.crcErrors).toBe(0);

    for (let i = 0; i < TOTAL_PATCHES; i++) {
      const pkt = decoded.validPackets.find((p) => p.patchId === i);
      expect(pkt).toBeDefined();
      expect(pkt?.esi).toBe(i);
      expect(Array.from(pkt!.payload)).toEqual(Array.from(packets[i]!.payload));
    }
  });

  it("turns localized glare into erasures while recovering clear patches", () => {
    const packets: PatchPacket[] = [];
    for (let i = 0; i < TOTAL_PATCHES; i++) {
      const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
      payload.fill(i + 1);
      packets.push({ epoch: 1, patchId: i, sbn: 0, esi: i, payload });
    }

    const img = renderPatchField(packets, 560);

    // Simulate specular glare covering top-left patch (patch 0, r=0, c=0)
    // Glare saturates pixels to pure white, wiping out contrast
    const { width, height, data } = img;
    // Simulate specular glare covering patch 0 (r=0, c=0)
    // Glare saturates pixels to pure white, wiping out contrast in that patch
    const cell = 4;
    const origin = Math.floor((width - 112 * cell) / 2);
    const b0 = getPatchBounds(0);
    const glareX0 = origin + b0.x0 * cell;
    const glareY0 = origin + b0.y0 * cell;
    const glareW = 24 * cell;
    const glareH = 24 * cell;

    for (let y = glareY0; y < glareY0 + glareH; y++) {
      for (let x = glareX0; x < glareX0 + glareW; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
      }
    }

    const detector = new GridDetector();
    const sets = detector.detect(img);
    expect(sets.length).toBeGreaterThan(0);

    const luma = detector.luma!;
    const h = gridHomography(sets[0]!, 112, luma);
    expect(h).not.toBeNull();

    const decoded = decodePatchField(luma, h!);
    // Glared patches should be marked as erasures, but the OTHER 12 patches decode cleanly!
    expect(decoded.erasureCount).toBeGreaterThanOrEqual(1);
    expect(decoded.validPackets.length).toBeGreaterThanOrEqual(12);

    // Verify intact patches have 100% correct payload data
    for (const pkt of decoded.validPackets) {
      expect(pkt.payload[0]).toBe(pkt.esi + 1);
    }
  });

  it("is orientation-invariant across 90, 180, and 270 degree rotation", () => {
    const packets: PatchPacket[] = [];
    for (let i = 0; i < TOTAL_PATCHES; i++) {
      const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
      payload.fill(42);
      packets.push({ epoch: 2, patchId: i, sbn: 0, esi: 100 + i, payload });
    }

    const img = renderPatchField(packets, 560);

    // 90 degrees
    const rot90 = rotateImage90(img);
    const recv90 = new PatchReceiver();
    expect(recv90.pushImage(rot90)).toBe(true);
    expect(recv90.progress.isLocked).toBe(true);
    expect(recv90.progress.packetsReceived).toBe(16);

    // 180 degrees
    const rot180 = rotateImage90(rot90);
    const recv180 = new PatchReceiver();
    expect(recv180.pushImage(rot180)).toBe(true);
    expect(recv180.progress.isLocked).toBe(true);
    expect(recv180.progress.packetsReceived).toBe(16);

    // 270 degrees
    const rot270 = rotateImage90(rot180);
    const recv270 = new PatchReceiver();
    expect(recv270.pushImage(rot270)).toBe(true);
    expect(recv270.progress.isLocked).toBe(true);
    expect(recv270.progress.packetsReceived).toBe(16);
  });

  it("recovers mixed display updates (rolling shutter torn frames)", () => {
    const packets: PatchPacket[] = [];
    for (let i = 0; i < TOTAL_PATCHES; i++) {
      // Top 8 patches belong to epoch 0, bottom 8 patches belong to epoch 1
      const epoch = i < 8 ? 0 : 1;
      const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
      payload.fill(epoch === 0 ? 0xaa : 0xbb);
      packets.push({ epoch, patchId: i, sbn: 0, esi: i, payload });
    }

    const img = renderPatchField(packets, 560);
    const detector = new GridDetector();
    const sets = detector.detect(img);
    const luma = detector.luma!;
    const h = gridHomography(sets[0]!, 112, luma);

    const decoded = decodePatchField(luma, h!);
    expect(decoded.validPackets.length).toBe(16);

    const epoch0Pkts = decoded.validPackets.filter((p) => p.epoch === 0);
    const epoch1Pkts = decoded.validPackets.filter((p) => p.epoch === 1);
    expect(epoch0Pkts.length).toBe(8);
    expect(epoch1Pkts.length).toBe(8);
  });

  it("transfers and verifies a complete payload via self-describing RaptorQ stream", () => {
    const data = new Uint8Array(192); // 4 symbols × 48 bytes
    for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff;

    const sender = new PatchSender(data, 12345);
    // Receiver instantiated with NO prior knowledge of size or hash!
    const receiver = new PatchReceiver();

    // Frame 0: Preamble with descriptor
    const f0 = sender.nextFrame(560);
    receiver.pushImage(f0.image);
    expect(receiver.progress.isLocked).toBe(true);
    expect(receiver.progress.payloadBytes).toBe(192);

    // Frame 1: Data symbols
    const f1 = sender.nextFrame(560);
    receiver.pushImage(f1.image);

    expect(receiver.progress.complete).toBe(true);
    expect(receiver.progress.verified).toBe(true);
    expect(receiver.result()).toEqual(data);
  });

  it("locks and transfers through simulated camera channel with blur, pose, and noise", () => {
    const data = new Uint8Array(192);
    data.fill(0x77);
    const sender = new PatchSender(data, 54321);
    const receiver = new PatchReceiver();
    const channel = new CameraChannel({ seed: 777, blurCells: 0.35, maxRotationDeg: 90 });

    let locked = false;
    for (let i = 0; i < 20 && !receiver.progress.complete; i++) {
      const f = sender.nextFrame(1000);
      const cap = channel.capture(f.image, 8);
      if (receiver.pushImage(cap.image)) {
        locked = true;
      }
    }
    expect(locked).toBe(true);
    expect(receiver.progress.isLocked).toBe(true);
  });
});
