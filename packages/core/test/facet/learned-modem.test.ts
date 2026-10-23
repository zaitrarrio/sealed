import { describe, expect, it } from "vitest";
import {
  OpticalChannelSimulator,
  renderLearnedPatchField,
  encodeLearnedPatchBits,
  ProbabilisticLearnedReceiver,
  evaluateBaseline,
  runExperimentABlurSweep,
  runExperimentBGlareSweep,
  runExperimentCDeadlineSimulation,
  runActualTransferBenchmark,
  LearnedTransferSender,
  LearnedTransferReceiver,
  TOTAL_PATCHES,
  PATCH_PAYLOAD_BYTES,
  type PatchPacket,
} from "../../src/facet/index";
import { linearLuma } from "../../src/facet/detect";

describe("Learned Optical Transfer Methodology", () => {
  describe("OpticalChannelSimulator (Physics-Informed Channel)", () => {
    it("simulates blur, geometry, noise, and localized specular glare", () => {
      const packets: PatchPacket[] = [];
      for (let pid = 0; pid < TOTAL_PATCHES; pid++) {
        const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
        for (let i = 0; i < PATCH_PAYLOAD_BYTES; i++) payload[i] = (pid + i) & 0xff;
        packets.push({
          epoch: 0,
          type: "data",
          patchId: pid,
          sbn: 0,
          esi: pid,
          payload,
        });
      }

      const frameImg = renderLearnedPatchField(packets, 560);
      const sim = new OpticalChannelSimulator({
        blurSigmaCells: 0.5,
        readNoise: 3.0,
        specularGlare: { cx: 640, cy: 480, radiusPx: 60, peak: 1.0 },
      });

      const capture = sim.capture(frameImg);
      expect(capture.image.width).toBe(1280);
      expect(capture.image.height).toBe(960);
      expect(capture.sensorCellPx).toBeGreaterThan(0);
      // Glare mask contains saturated pixels
      const saturatedPixels = capture.glareMask.reduce((a, b) => a + b, 0);
      expect(saturatedPixels).toBeGreaterThan(0);
    });

    it("simulates rolling-shutter multi-epoch exposure transition", () => {
      const packetsA: PatchPacket[] = [];
      const packetsB: PatchPacket[] = [];
      for (let pid = 0; pid < TOTAL_PATCHES; pid++) {
        const payloadA = new Uint8Array(PATCH_PAYLOAD_BYTES).fill(0xaa);
        const payloadB = new Uint8Array(PATCH_PAYLOAD_BYTES).fill(0xbb);
        packetsA.push({ epoch: 0, type: "data", patchId: pid, sbn: 0, esi: pid, payload: payloadA });
        packetsB.push({ epoch: 1, type: "data", patchId: pid, sbn: 0, esi: pid, payload: payloadB });
      }

      const frameA = renderLearnedPatchField(packetsA, 560);
      const frameB = renderLearnedPatchField(packetsB, 560);

      const sim = new OpticalChannelSimulator();
      const capture = sim.capture(frameA, frameB, 480);
      expect(capture.epochsContributed).toEqual([0, 1]);
    });
  });

  describe("Probabilistic Neural Receiver & Equalizer", () => {
    it("decodes patches and produces calibrated soft LLRs", () => {
      const packets: PatchPacket[] = [];
      for (let pid = 0; pid < TOTAL_PATCHES; pid++) {
        const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
        for (let i = 0; i < PATCH_PAYLOAD_BYTES; i++) payload[i] = (pid * 7 + i) & 0xff;
        packets.push({
          epoch: 0,
          type: "data",
          patchId: pid,
          sbn: 0,
          esi: pid,
          payload,
        });
      }

      const frameImg = renderLearnedPatchField(packets, 560);
      const sim = new OpticalChannelSimulator({
        blurSigmaCells: 0.4,
        readNoise: 2.0,
        rotationDeg: 0,
        scale: 0.85,
      });

      const capture = sim.capture(frameImg);
      const receiver = new ProbabilisticLearnedReceiver({ temporalWindow: 1 });
      const luma = linearLuma(capture.image);

      const result = receiver.decodeFrame(luma, capture.homography);
      expect(result.validPackets.length).toBe(TOTAL_PATCHES);
      expect(result.erasureCount).toBe(0);
      expect(result.crcErrors).toBe(0);

      // Verify soft results have calibrated LLRs
      for (const soft of result.softResults) {
        expect(soft.crcPassed).toBe(true);
        expect(soft.llrs.length).toBeGreaterThan(0);
        expect(soft.reliability).toBeGreaterThan(0.25);
      }
    });

    it("marks washed-out patches as erasures while preserving valid clear patches under glare", () => {
      const packets: PatchPacket[] = [];
      for (let pid = 0; pid < TOTAL_PATCHES; pid++) {
        const payload = new Uint8Array(PATCH_PAYLOAD_BYTES);
        for (let i = 0; i < PATCH_PAYLOAD_BYTES; i++) payload[i] = (pid + i) & 0xff;
        packets.push({
          epoch: 0,
          type: "data",
          patchId: pid,
          sbn: 0,
          esi: pid,
          payload,
        });
      }

      const frameImg = renderLearnedPatchField(packets, 560);
      const sim = new OpticalChannelSimulator({
        blurSigmaCells: 0.4,
        specularGlare: { cx: 640, cy: 480, radiusPx: 250, peak: 1.0 }, // Central glare wiping out central patches
        rotationDeg: 0,
        scale: 0.85,
      });

      const capture = sim.capture(frameImg);
      const receiver = new ProbabilisticLearnedReceiver();
      const luma = linearLuma(capture.image);

      const result = receiver.decodeFrame(luma, capture.homography);
      expect(result.erasureCount).toBeGreaterThan(0);
      expect(result.validPackets.length).toBeGreaterThan(0);
    });
  });

  describe("Baseline Ladder & Controlled Experiments", () => {
    it("evaluates baselines under matched channel conditions", () => {
      const packets: PatchPacket[] = [];
      for (let pid = 0; pid < TOTAL_PATCHES; pid++) {
        const payload = new Uint8Array(PATCH_PAYLOAD_BYTES).fill(pid);
        packets.push({ epoch: 0, type: "data", patchId: pid, sbn: 0, esi: pid, payload });
      }

      const frameImg = renderLearnedPatchField(packets, 560);
      const sim = new OpticalChannelSimulator({ blurSigmaCells: 0.4, scale: 0.85 });
      const capture = sim.capture(frameImg);

      const resB1 = evaluateBaseline("B1", packets, capture.image, capture.homography);
      const resB5 = evaluateBaseline("B5", packets, capture.image, capture.homography);

      expect(resB1.totalPackets).toBe(TOTAL_PATCHES);
      expect(resB5.totalPackets).toBe(TOTAL_PATCHES);
      expect(resB5.gmi).toBeGreaterThanOrEqual(resB1.gmi);
    });

    it("runs Experiment A (Blur Sweep) across varying optical blur sigmas", () => {
      const points = runExperimentABlurSweep([0.3, 0.7, 1.2]);
      expect(points.length).toBe(3);
      for (const pt of points) {
        expect(pt.results.B1).toBeDefined();
        expect(pt.results.B2).toBeDefined();
        expect(pt.results.B5).toBeDefined();
      }
    });

    it("runs Experiment B (Glare Sweep) showing spatial erasure resilience", () => {
      const points = runExperimentBGlareSweep([0, 50]);
      expect(points.length).toBe(2);
      expect(points[1]!.glareSaturationFraction).toBeGreaterThan(0);
    });

    it("runs Experiment C (128 MiB Deadline Simulation & Certification)", () => {
      const result = runExperimentCDeadlineSimulation(134217728, 30);
      expect(result.targetPayloadBytes).toBe(134217728);
      expect(result.deadlineSeconds).toBe(120);
      expect(result.sampleSizeRequired).toBe(59);
      expect(result.confidenceLowerBound95).toBeGreaterThan(0.95);
      expect(result.timeToEventProfile.acquisitionMs).toBeGreaterThan(0);
      expect(result.timeToEventProfile.transferMs).toBeGreaterThan(0);
    });
  });

  describe("Actual End-to-End Streaming Transfer", () => {
    it("streams, decodes, and verifies data payload with LearnedTransferSender/Receiver", () => {
      const data = new Uint8Array(192); // 4 RaptorQ symbols
      for (let i = 0; i < data.length; i++) data[i] = (i * 19 + 7) & 0xff;

      const sender = new LearnedTransferSender(data, 9999);
      const receiver = new LearnedTransferReceiver();

      // Preamble frame with descriptor
      const f0 = sender.nextFrame(560);
      expect(receiver.pushImage(f0.image)).toBe(true);
      expect(receiver.isLocked).toBe(true);

      // Data frame
      const f1 = sender.nextFrame(560);
      expect(receiver.pushImage(f1.image)).toBe(true);

      expect(receiver.complete).toBe(true);
      expect(receiver.progress.verified).toBe(true);
      expect(receiver.result()).toEqual(data);
    });

    it("runs actual transfer benchmark through physics optical channel simulation", async () => {
      const res = await runActualTransferBenchmark({
        payloadBytes: 192,
        modemType: "learned",
        seed: 42,
        frameSizePx: 560,
        channel: { blurSigmaCells: 0.3, readNoise: 1.0, scale: 0.85 },
      });

      expect(res.verified).toBe(true);
      expect(res.packetsRecovered).toBeGreaterThan(0);
      expect(res.goodputBytesPerSecond).toBeGreaterThan(0);
      expect(res.deadlineMet).toBe(true);
      expect(res.sha256Hex.length).toBe(64);
    });
  });
});
