/**
 * PatchStream — Fountain Stream Pipeline for the Monochrome Patch Modem
 *
 * Implements:
 * - Systematic RFC 6330 RaptorQ fountain encoding over 48-byte symbol packets.
 * - Self-describing optical stream: descriptor packets carry stream metadata (seed, size, sha256).
 * - Spatial interleaving across patch slots to bypass persistent localized glare.
 * - PatchReceiver: rotation-invariant anchor detection, homography projection,
 *   mixed-epoch packet recovery, glare erasure tracking, and block reconstruction.
 */
import { RaptorQEncoder, RaptorQDecoder, planOti, type Oti } from "../fec/index";
import { SymbolSchedule } from "./sender";
import { GridDetector, gridHomography, type LumaPlane } from "./detect";
import {
  PATCH_PAYLOAD_BYTES,
  TOTAL_PATCHES,
  renderPatchField,
  decodePatchField,
  type PatchPacket,
  type PatchType,
  type PatchDecodeResult,
} from "./patch-modem";
import type { FacetFrame, FrameType, RgbaImage, Tier } from "./types";
import { sha256 } from "../crypto/primitives";
import { ctEqual } from "../bytes";

export interface PatchStreamProgress {
  streamId: number;
  isLocked: boolean;
  anchorsSeen: number;
  packetsReceived: number;
  packetsNeeded: number;
  glareErasures: number;
  crcErrors: number;
  fraction: number;
  complete: boolean;
  goodputBytesPerSecond: number;
  verified: boolean | null;
  payloadBytes: number | null;
}

/** Prime step for spatial permutation of packets across display updates. */
const PERM_PRIME = 7;

/**
 * Sender: encodes arbitrary data with RaptorQ fountain coding into monochrome patch frames.
 * Fully compatible with FacetStream rendering (exposes tier, finished, next, render).
 */
export class PatchSender {
  readonly tier: Tier = 4;
  readonly finished = false;
  readonly oti: Oti;
  readonly encoder: RaptorQEncoder;
  readonly symbolSize = PATCH_PAYLOAD_BYTES; // 48
  private epoch = 0;
  private sequence = 0;
  private readonly schedule: SymbolSchedule;
  readonly totalSymbols: number;
  readonly streamId: number;
  private readonly descriptorPayload: Uint8Array;
  private readonly dataLength: number;
  private readonly dataHash: Uint8Array;
  private readonly seed: number;

  constructor(data: Uint8Array, seed = 0, streamId = 0x50415443) {
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

      // Slot 0 (permuted) always carries the descriptor so receivers can join at any instant;
      // All other slots carry continuous RaptorQ data symbols!
      const sendDescriptor = slot === 0 || (frame.sequence === 0 && slot < 2);

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

    return renderPatchField(packets, sizePx);
  }

  /** Direct helper for testing or single-step execution. */
  nextFrame(sizePx = 560): { image: RgbaImage; epoch: number } {
    const f = this.next();
    return { image: this.render(f, sizePx), epoch: f.sequence % 4 };
  }
}

/**
 * Receiver: decodes camera images, recovers valid packets even from torn or glare-affected frames,
 * and reconstructs the original file.
 */
export class PatchReceiver {
  private readonly detector = new GridDetector();
  private decoder: RaptorQDecoder | null = null;
  private streamId: number | null = null;
  private readonly receivedSymbols = new Set<string>();
  private readonly pendingData: { sbn: number; esi: number; payload: Uint8Array }[] = [];
  private packetsReceived = 0;
  private glareErasures = 0;
  private crcErrors = 0;
  private startedAt: number | null = null;
  private firstPacketAt: number | null = null;
  private resultBytes: Uint8Array | null = null;
  private expectedHash: Uint8Array | null = null;
  private payloadBytes: number | null = null;
  private verified: boolean | null = null;
  private oti: Oti | null = null;
  private anchorsSeen = 0;
  private lastAnchorAt: number | null = null;

  constructor(expectedDataLength?: number, expectedHash?: Uint8Array) {
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

  get progress(): PatchStreamProgress {
    const now = performance.now();
    const elapsed = this.firstPacketAt ? (now - this.firstPacketAt) / 1000 : 0;
    const bytesDecoded = this.packetsReceived * PATCH_PAYLOAD_BYTES;
    const goodput = elapsed > 0 ? bytesDecoded / elapsed : 0;
    const totalNeeded = this.oti ? Math.ceil(this.oti.transferLength / PATCH_PAYLOAD_BYTES) : 0;

    return {
      streamId: this.streamId ?? 0x50415443,
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
    };
  }

  /**
   * Processes one camera frame (at any rotation: 0°, 90°, 180°, 270°).
   * Returns true if at least one valid packet was decoded from this frame.
   */
  pushPacketBytes(bytes: Uint8Array, now = performance.now()): boolean {
    if (this.startedAt === null) this.startedAt = now;
    if (this.complete) return false;
    if (bytes.length !== 55) return false;

    this.anchorsSeen++;
    this.lastAnchorAt = now;

    const headerByte0 = bytes[0] as number;
    const typeCode = (headerByte0 >> 4) & 0x03;
    const type: PatchType = typeCode === 1 ? "descriptor" : typeCode === 2 ? "end" : "data";
    const sbn = bytes[1] as number;
    const esi = ((bytes[2] as number) << 8) | (bytes[3] as number);
    const len = bytes[4] as number;
    if (len !== PATCH_PAYLOAD_BYTES) return false;

    const payload = bytes.slice(5, 5 + len);
    if (this.firstPacketAt === null) this.firstPacketAt = now;

    if (type === "descriptor") {
      this.handleDescriptor(payload);
      this.packetsReceived++;
      return true;
    }

    const symKey = `${sbn}:${esi}`;
    if (this.receivedSymbols.has(symKey)) return true;
    this.receivedSymbols.add(symKey);
    this.packetsReceived++;

    if (this.decoder) {
      this.decoder.add(sbn, esi, payload);
      this.checkCompletion();
    } else {
      this.pendingData.push({ sbn, esi, payload });
    }
    return true;
  }

  pushImage(image: RgbaImage, now = performance.now()): boolean {
    if (this.startedAt === null) this.startedAt = now;
    if (this.complete) return false;

    // 1. Detect rotation-invariant corner anchors
    const sets = this.detector.detect(image);
    const luma = this.detector.luma;
    if (!luma || sets.length === 0) return false;

    this.anchorsSeen++;
    this.lastAnchorAt = now;

    let anyValidInFrame = false;

    for (const set of sets) {
      const h = gridHomography(set, 112, luma);
      if (!h) continue;

      // 2. Decode independent patches from this homography
      const result = decodePatchField(luma, h);
      this.glareErasures += result.erasureCount;
      this.crcErrors += result.crcErrors;

      if (result.validPackets.length > 0) {
        anyValidInFrame = true;
        if (this.firstPacketAt === null) this.firstPacketAt = now;

        for (const pkt of result.validPackets) {
          if (pkt.type === "descriptor") {
            this.handleDescriptor(pkt.payload);
            this.packetsReceived++;
            continue;
          }

          const symKey = `${pkt.sbn}:${pkt.esi}`;
          if (this.receivedSymbols.has(symKey)) continue; // de-duplicate identical packets
          this.receivedSymbols.add(symKey);
          this.packetsReceived++;

          if (this.decoder) {
            this.decoder.add(pkt.sbn, pkt.esi, pkt.payload);
            this.checkCompletion();
          } else {
            this.pendingData.push({ sbn: pkt.sbn, esi: pkt.esi, payload: pkt.payload });
          }
        }
      }
    }

    return anyValidInFrame;
  }

  private handleDescriptor(payload: Uint8Array): void {
    if (this.decoder) return;
    try {
      const view = new DataView(payload.buffer, payload.byteOffset, 8);
      const dataLen = view.getUint32(4, false);
      if (dataLen > 0 && dataLen <= 134217728) {
        this.payloadBytes = dataLen;
        this.expectedHash = payload.slice(8, 40);
        this.oti = planOti(dataLen, PATCH_PAYLOAD_BYTES, 256);
        this.decoder = new RaptorQDecoder(this.oti);

        // Flush pending symbols
        for (const p of this.pendingData) {
          this.decoder.add(p.sbn, p.esi, p.payload);
        }
        this.pendingData.length = 0;
        this.checkCompletion();
      }
    } catch {
      // Ignore malformed descriptor
    }
  }

  private checkCompletion(): void {
    if (this.decoder && this.decoder.isComplete() && !this.resultBytes) {
      this.resultBytes = this.decoder.result();
      if (this.expectedHash && this.resultBytes) {
        const actualHash = sha256(this.resultBytes);
        this.verified = ctEqual(actualHash, this.expectedHash);
      } else {
        this.verified = true;
      }
    }
  }

  result(): Uint8Array | null {
    return this.resultBytes;
  }
}
