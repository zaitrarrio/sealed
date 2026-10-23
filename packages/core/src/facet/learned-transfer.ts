/**
 * LearnedTransfer — End-to-End Streaming Pipeline for the Learned Optical Modem
 *
 * Implements full systematic RaptorQ fountain streaming over learned patch frames:
 * - Systematic RFC 6330 RaptorQ fountain encoding over 48-byte symbol packets.
 * - Self-describing optical stream: descriptor packets carry stream metadata (seed, size, sha256).
 * - Spatial prime-step permutation across patch slots to bypass persistent localized glare.
 * - LearnedTransferReceiver: rotation-invariant anchor detection, homography projection,
 *   probabilistic neural equalization, 2D deconvolution, local pilot contrast estimation,
 *   calibrated soft LLR generation, glare erasure tracking, and RaptorQ block reconstruction.
 */
import { RaptorQEncoder, RaptorQDecoder, planOti, type Oti } from "../fec/index";
import { SymbolSchedule } from "./sender";
import { GridDetector, gridHomography, type LumaPlane } from "./detect";
import {
  PATCH_PAYLOAD_BYTES,
  TOTAL_PATCHES,
  type PatchPacket,
  type PatchType,
} from "./patch-modem";
import { renderLearnedPatchField } from "./learned-encoder";
import {
  ProbabilisticLearnedReceiver,
  type LearnedReceiverOptions,
  type LearnedDecodeResult,
} from "./learned-receiver";
import type { FacetFrame, RgbaImage, Tier } from "./types";
import { sha256 } from "../crypto/primitives";
import { ctEqual } from "../bytes";
import type { PatchStreamProgress } from "./patch-stream";

/** Prime step for spatial permutation of packets across display updates. */
const PERM_PRIME = 7;

/**
 * Sender: encodes arbitrary data with RaptorQ fountain coding into learned optical patch frames.
 * Fully compatible with FacetStream rendering.
 */
export class LearnedTransferSender {
  readonly tier: Tier = 4;
  readonly finished = false;
  readonly oti: Oti;
  readonly encoder: RaptorQEncoder;
  readonly symbolSize = PATCH_PAYLOAD_BYTES; // 48
  private sequence = 0;
  private readonly schedule: SymbolSchedule;
  readonly totalSymbols: number;
  readonly streamId: number;
  private readonly descriptorPayload: Uint8Array;
  private readonly dataLength: number;
  private readonly dataHash: Uint8Array;
  private readonly seed: number;

  constructor(data: Uint8Array, seed = 0, streamId = 0x4c454152) {
    this.streamId = streamId;
    this.seed = seed >>> 0;
    this.dataLength = data.length;
    this.dataHash = sha256(data);
    this.oti = planOti(data.length, this.symbolSize, 256);
    this.encoder = new RaptorQEncoder(data, this.oti);
    this.totalSymbols = Math.ceil(data.length / this.symbolSize);
    this.schedule = new SymbolSchedule(this.encoder, true, 1.0);

    // Build self-describing 48-byte descriptor payload:
    // [0..3]: seed (BE)
    // [4..7]: dataLength (BE)
    // [8..39]: SHA-256 hash (32 bytes)
    // [40..47]: padding
    this.descriptorPayload = new Uint8Array(PATCH_PAYLOAD_BYTES);
    const view = new DataView(this.descriptorPayload.buffer, this.descriptorPayload.byteOffset, 8);
    view.setUint32(0, this.seed, false);
    view.setUint32(4, this.dataLength, false);
    this.descriptorPayload.set(this.dataHash, 8);
  }

  next(): FacetFrame {
    const seq = this.sequence++;
    return {
      tier: 4,
      type: "data",
      holdRefreshes: 2, // 30 fps on 60 Hz display, 60 fps on 120 Hz display
      sequence: seq,
    };
  }

  qrModules(_frame?: FacetFrame): { size: number; modules: Uint8Array } | null {
    return null;
  }

  qrText(_frame?: FacetFrame): string | null {
    return null;
  }

  render(frame: FacetFrame, sizePx = 560): RgbaImage {
    const packets: PatchPacket[] = [];
    const epoch = frame.sequence % 4;
    for (let slot = 0; slot < TOTAL_PATCHES; slot++) {
      const patchId = (slot + epoch * PERM_PRIME) % TOTAL_PATCHES;

      // Frame 0 (preamble) sends all descriptors so receivers immediately lock OTI metadata;
      // Subsequent frames dedicate slot 0 (permuted) to continuous descriptor broadcast
      // and all remaining 15 slots to RaptorQ fountain data symbols.
      const sendDescriptor = frame.sequence === 0 ? true : slot === 0;

      if (sendDescriptor) {
        packets.push({
          epoch,
          type: "descriptor",
          patchId,
          sbn: 0,
          esi: 0,
          payload: this.descriptorPayload,
        });
      } else {
        const s = this.schedule.next() ?? { sbn: 0, esi: 0 };
        const payload = this.encoder.symbol(s.sbn, s.esi);
        packets.push({
          epoch,
          type: "data",
          patchId,
          sbn: s.sbn,
          esi: s.esi,
          payload,
        });
      }
    }

    return renderLearnedPatchField(packets, sizePx);
  }

  nextFrame(sizePx = 560): { frame: FacetFrame; image: RgbaImage } {
    const frame = this.next();
    const image = this.render(frame, sizePx);
    return { frame, image };
  }
}

/**
 * Receiver: captures frames through camera or optical channel, equalizes and decodes learned patches,
 * marks glare erasures, feeds valid symbols to RaptorQ, verifies SHA-256 hash, and reconstructs the data.
 */
export class LearnedTransferReceiver {
  private readonly detector = new GridDetector();
  private readonly receiver: ProbabilisticLearnedReceiver;
  private decoder: RaptorQDecoder | null = null;
  private streamId: number | null = null;
  private readonly receivedSymbols = new Set<string>();
  private readonly pendingData: { sbn: number; esi: number; payload: Uint8Array }[] = [];
  private packetsReceived = 0;
  private glareErasures = 0;
  private crcErrors = 0;
  private totalGmiAcc = 0;
  private gmiSamples = 0;
  private startedAt: number | null = null;
  private firstPacketAt: number | null = null;
  private resultBytes: Uint8Array | null = null;
  private expectedHash: Uint8Array | null = null;
  private payloadBytes: number | null = null;
  private verified: boolean | null = null;
  private oti: Oti | null = null;
  private anchorsSeen = 0;
  private lastAnchorAt: number | null = null;

  constructor(expectedDataLength?: number, expectedHash?: Uint8Array, options?: LearnedReceiverOptions) {
    this.receiver = new ProbabilisticLearnedReceiver(options);
    if (expectedDataLength) {
      this.payloadBytes = expectedDataLength;
      this.oti = planOti(expectedDataLength, PATCH_PAYLOAD_BYTES, 256);
      this.decoder = new RaptorQDecoder(this.oti);
    }
    this.expectedHash = expectedHash ?? null;
  }

  get isLocked(): boolean {
    return this.packetsReceived > 0 || this.decoder !== null || this.anchorsSeen > 0;
  }

  get complete(): boolean {
    return this.decoder !== null && this.decoder.isComplete();
  }

  get progress(): PatchStreamProgress & { meanGmi: number } {
    const now = performance.now();
    const elapsed = this.firstPacketAt ? (now - this.firstPacketAt) / 1000 : 0;
    const bytesDecoded = this.packetsReceived * PATCH_PAYLOAD_BYTES;
    const goodput = elapsed > 0 ? bytesDecoded / elapsed : 0;
    const totalNeeded = this.oti ? Math.ceil(this.oti.transferLength / PATCH_PAYLOAD_BYTES) : 0;

    return {
      streamId: this.streamId ?? 0x4c454152,
      isLocked: this.isLocked,
      anchorsSeen: this.anchorsSeen,
      packetsReceived: this.packetsReceived,
      packetsNeeded: totalNeeded,
      glareErasures: this.glareErasures,
      crcErrors: this.crcErrors,
      fraction: totalNeeded > 0 ? Math.min(1, this.packetsReceived / totalNeeded) : 0,
      complete: this.complete,
      goodputBytesPerSecond: Math.round(goodput),
      verified: this.verified,
      payloadBytes: this.payloadBytes,
      meanGmi: this.gmiSamples > 0 ? this.totalGmiAcc / this.gmiSamples : 1.0,
    };
  }

  /**
   * Processes one camera frame or simulated capture.
   * Returns true if at least one valid packet was decoded.
   */
  pushImage(image: RgbaImage, now = performance.now()): boolean {
    if (this.startedAt === null) this.startedAt = now;
    if (this.complete) return false;

    // 1. Detect rotation-invariant corner concentric anchors
    const sets = this.detector.detect(image);
    const luma = this.detector.luma;
    if (!luma || sets.length === 0) return false;

    this.anchorsSeen++;
    this.lastAnchorAt = now;

    let anyValidInFrame = false;

    for (const set of sets) {
      const h = gridHomography(set, 112, luma);
      if (!h) continue;

      const decoded = this.receiver.decodeFrame(luma, h);
      this.glareErasures += decoded.erasureCount;
      this.crcErrors += decoded.crcErrors;
      if (Number.isFinite(decoded.meanGmi)) {
        this.totalGmiAcc += decoded.meanGmi;
        this.gmiSamples++;
      }

      for (const pkt of decoded.validPackets) {
        if (this.firstPacketAt === null) this.firstPacketAt = now;

        if (pkt.type === "descriptor") {
          this.handleDescriptor(pkt.payload);
          this.packetsReceived++;
          anyValidInFrame = true;
          continue;
        }

        const symKey = `${pkt.sbn}:${pkt.esi}`;
        if (this.receivedSymbols.has(symKey)) continue;
        this.receivedSymbols.add(symKey);
        this.packetsReceived++;
        anyValidInFrame = true;

        if (this.decoder) {
          this.decoder.add(pkt.sbn, pkt.esi, pkt.payload);
          this.checkCompletion();
        } else {
          this.pendingData.push({ sbn: pkt.sbn, esi: pkt.esi, payload: pkt.payload });
        }
      }

      if (anyValidInFrame) break;
    }

    return anyValidInFrame;
  }

  private handleDescriptor(payload: Uint8Array): void {
    if (this.decoder !== null) return;
    const view = new DataView(payload.buffer, payload.byteOffset, 8);
    const seed = view.getUint32(0, false);
    const dataLength = view.getUint32(4, false);
    const hash = payload.slice(8, 40);

    if (dataLength === 0 || dataLength > 256 * 1024 * 1024) return;

    this.payloadBytes = dataLength;
    this.expectedHash = hash;
    this.oti = planOti(dataLength, PATCH_PAYLOAD_BYTES, 256);
    this.decoder = new RaptorQDecoder(this.oti);

    // Flush any pending data symbols
    for (const p of this.pendingData) {
      this.decoder.add(p.sbn, p.esi, p.payload);
    }
    this.pendingData.length = 0;
    this.checkCompletion();
  }

  private checkCompletion(): void {
    if (!this.decoder || !this.decoder.isComplete()) return;
    try {
      const data = this.decoder.result();
      if (!data) return;
      this.resultBytes = data;
      if (this.expectedHash) {
        const computed = sha256(data);
        this.verified = ctEqual(computed, this.expectedHash);
      } else {
        this.verified = true;
      }
    } catch {
      this.verified = false;
    }
  }

  result(): Uint8Array | null {
    return this.resultBytes;
  }
}
