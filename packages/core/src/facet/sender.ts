/**
 * FacetSender: turns an Envelope into an endless or finite sequence of frames (spec §7.5).
 *
 * Schedule (per tier stream):
 *   - 3 × calibration (grid tiers only; T0 has no palette), 3 × descriptor, then data;
 *   - calibration every 64 frames, descriptor every 32 frames (positions counted within the stream);
 *   - data: all source symbols of block 0, then source symbols of block b+1 interleaved 3:1 with repair symbols
 *     of blocks ≤ b, then repair symbols round-robin over all blocks.
 *   - Without `loop`, after the source phase the sender emits repair for `repairRounds` passes and then an
 *     end-of-stream frame; with `loop` (Broadcast) repair continues forever.
 *
 * Interleave-compatible Broadcast (spec §7.7): a second, independent T0 stream of the same Envelope (its own OTI
 * with T = 840 and its own descriptor) shares the stream_id; frames alternate grid, grid, T0. The header tier
 * field tells receivers which stream a frame belongs to, so a T0-only receiver simply ignores grid frames.
 */
import { RaptorQEncoder, encodeOti, type Oti } from "../fec/index";
import { randomBytes } from "../crypto/primitives";
import type { FacetFrame, FrameType, RgbaImage, StreamDescriptor, Tier } from "./types";
import { TIERS, planStreamOti, type GridTier } from "./tiers";
import { encodeFrameHeader } from "./header";
import { encodeDescriptorPayload } from "./descriptor";
import { calibrationPicture, dataPicture, gridLayout } from "./grid";
import { renderPicture } from "./render";
import { qrFrameText, renderQrFrame } from "./qr";
import { isGridTier } from "./layout";
import { Xorshift32, seedFrom } from "./random";

export interface FacetSenderOptions {
  envelope: Uint8Array;
  tier: Tier;
  descriptor: {
    senderPublicKey?: Uint8Array;
    wrap?: Uint8Array;
    cek?: Uint8Array;
    publisherFingerprint?: Uint8Array;
    publisherSigningKey?: Uint8Array;
    signature?: Uint8Array;
    manifestDigest?: Uint8Array;
    manifestPart?: Uint8Array;
    senderLabel?: string;
  };
  streamId?: Uint8Array;
  /** Broadcast: also emit a T0 stream of the same Envelope, grid:T0 = 2:1. Ignored when `tier` is 0. */
  interleaveCompatible?: boolean;
  /** Broadcast: repeat forever and set the loop flag. */
  loop?: boolean;
  /** Optional finite budget: repair symbols sent after the source phase, as a fraction of K per block. Default: unlimited (spec §7.5). */
  repairFraction?: number;
  /**
   * Signature for the interleaved T0 descriptor. A Broadcast signature binds the descriptor's own OTI, and the T0
   * sub-stream has a different OTI (T = 840), so it needs its own signature over that OTI (`planStreamOti(envelope.length, 0)`).
   */
  compatibleSignature?: Uint8Array;
}

/** A frame with everything needed to render it. */
interface InternalFrame extends FacetFrame {
  readonly header: Uint8Array;
  readonly payload: Uint8Array;
  readonly sbn: number;
  readonly esi: number;
  readonly streamId: Uint8Array;
}

const CALIBRATION_EVERY = 64;
const DESCRIPTOR_EVERY = 32;
const PREAMBLE = 3;

/** Generates the data symbol schedule (SBN, ESI) for one tier stream. */
class SymbolSchedule {
  private readonly k: number[];
  private phase: "source" | "repair" = "source";
  private block = 0;
  private sourceNext: number[];
  private repairNext: number[];
  private interleaveCounter = 0;
  private repairBlock = 0;
  private repairEmitted = 0;
  readonly repairBudget: number;
  private ended = false;

  constructor(
    private readonly enc: RaptorQEncoder,
    private readonly loop: boolean,
    repairFraction: number,
  ) {
    this.k = Array.from({ length: enc.blockCount }, (_, b) => enc.sourceSymbolCount(b));
    this.sourceNext = this.k.map(() => 0);
    this.repairNext = this.k.slice();
    this.repairBudget = this.k.reduce((a, k) => a + Math.max(4, Math.ceil(k * repairFraction)), 0);
  }

  get finished(): boolean {
    return this.ended;
  }

  next(): { sbn: number; esi: number } | null {
    if (this.ended) return null;
    if (this.phase === "source") {
      const b = this.block;
      // After block 0, interleave 3 new-source : 1 repair of an earlier block.
      if (b > 0 && this.interleaveCounter === 3) {
        this.interleaveCounter = 0;
        const rb = this.repairBlock % b;
        this.repairBlock++;
        const esi = this.repairNext[rb] as number;
        this.repairNext[rb] = esi + 1;
        return { sbn: rb, esi };
      }
      const esi = this.sourceNext[b] as number;
      this.sourceNext[b] = esi + 1;
      if (b > 0) this.interleaveCounter++;
      if (esi + 1 >= (this.k[b] as number)) {
        this.block++;
        this.interleaveCounter = 0;
        if (this.block >= this.k.length) {
          this.phase = "repair";
          this.repairBlock = 0;
        }
      }
      return { sbn: b, esi };
    }
    if (!this.loop && this.repairEmitted >= this.repairBudget) {
      this.ended = true;
      return null;
    }
    const rb = this.repairBlock % this.k.length;
    this.repairBlock++;
    const esi = this.repairNext[rb] as number;
    // ESIs are 24-bit; wrap repair back to the first repair ESI long before overflow (only reachable by loops).
    this.repairNext[rb] = esi + 1 >= 0xffffff ? (this.k[rb] as number) : esi + 1;
    this.repairEmitted++;
    return { sbn: rb, esi };
  }
}

class TierStream {
  readonly enc: RaptorQEncoder;
  readonly oti: Oti;
  readonly descriptor: StreamDescriptor;
  private readonly schedule: SymbolSchedule;
  private position = 0;
  private dataSent = 0;
  private endSent = false;
  private descriptorPayload: Uint8Array;

  constructor(
    readonly tier: Tier,
    envelope: Uint8Array,
    readonly streamId: Uint8Array,
    base: FacetSenderOptions["descriptor"],
    private readonly loop: boolean,
    repairFraction: number,
  ) {
    this.oti = planStreamOti(envelope.length, tier);
    this.enc = new RaptorQEncoder(envelope, this.oti);
    this.schedule = new SymbolSchedule(this.enc, loop, repairFraction);
    const d: StreamDescriptor = { streamId, tier, oti: encodeOti(this.oti) };
    if (base.senderPublicKey) d.senderPublicKey = base.senderPublicKey;
    if (base.wrap) d.wrap = base.wrap;
    if (base.cek) d.cek = base.cek;
    if (base.publisherFingerprint) d.publisherFingerprint = base.publisherFingerprint;
    if (base.publisherSigningKey) d.publisherSigningKey = base.publisherSigningKey;
    if (base.signature) d.signature = base.signature;
    if (base.manifestDigest) d.manifestDigest = base.manifestDigest;
    if (base.manifestPart) d.manifestPart = base.manifestPart;
    if (base.senderLabel !== undefined) d.senderLabel = base.senderLabel;
    this.descriptor = d;
    this.descriptorPayload = encodeDescriptorPayload(d, TIERS[tier].symbolSize);
  }

  get signed(): boolean {
    return this.descriptor.signature !== undefined;
  }

  get done(): boolean {
    return this.endSent;
  }

  /** Next frame type for this stream. */
  private nextType(): FrameType {
    const p = this.position;
    const hasCal = isGridTier(this.tier);
    const pre = hasCal ? PREAMBLE * 2 : PREAMBLE;
    if (p < pre) return hasCal && p < PREAMBLE ? "calibration" : "descriptor";
    const q = p - pre;
    if (hasCal && q > 0 && q % CALIBRATION_EVERY === 0) return "calibration";
    if (q > 0 && q % DESCRIPTOR_EVERY === 0) return "descriptor";
    return "data";
  }

  next(sequence: number): InternalFrame {
    let type = this.nextType();
    this.position++;
    let sbn = 0;
    let esi = 0;
    let payload: Uint8Array;
    if (type === "data") {
      const s = this.schedule.next();
      if (s) {
        sbn = s.sbn;
        esi = s.esi;
        payload = this.enc.symbol(sbn, esi);
        this.dataSent++;
      } else {
        type = "end";
        this.endSent = true;
        payload = this.descriptorPayload;
      }
    } else if (type === "descriptor") {
      payload = this.descriptorPayload;
    } else {
      payload = new Uint8Array(0);
    }
    const header = encodeFrameHeader({ tier: this.tier, type, loop: this.loop, signed: this.signed, streamId: this.streamId, sbn, esi }, payload);
    const hold = TIERS[this.tier].holdRefreshes60;
    return { tier: this.tier, type, holdRefreshes: hold, sequence, header, payload, sbn, esi, streamId: this.streamId };
  }
}

export class FacetSender {
  readonly streamId: Uint8Array;
  readonly descriptor: StreamDescriptor;
  readonly tier: Tier;
  /** Descriptor of the interleaved T0 stream, when enabled. */
  readonly compatibleDescriptor: StreamDescriptor | null;
  private readonly primary: TierStream;
  private readonly compatible: TierStream | null;
  private sequence = 0;
  private readonly frames = new Map<number, InternalFrame>();

  constructor(opts: FacetSenderOptions) {
    if (!(opts.envelope instanceof Uint8Array) || opts.envelope.length === 0) throw new RangeError("envelope must be non-empty bytes");
    if (!TIERS[opts.tier]) throw new RangeError(`unknown tier ${String(opts.tier)}`);
    this.streamId = opts.streamId ? opts.streamId.slice() : randomBytes(4);
    if (this.streamId.length !== 4) throw new RangeError("streamId must be 4 bytes");
    this.tier = opts.tier;
    const loop = opts.loop === true;
    // Spec §7.5: after the source symbols, repair symbols continue indefinitely until the user stops the stream.
    // A finite budget is opt-in (fixtures, recordings).
    const repairFraction = opts.repairFraction ?? Number.POSITIVE_INFINITY;
    this.primary = new TierStream(opts.tier, opts.envelope, this.streamId, opts.descriptor, loop, repairFraction);
    this.descriptor = this.primary.descriptor;
    if (opts.interleaveCompatible && opts.tier !== 0) {
      const base = { ...opts.descriptor };
      if (opts.compatibleSignature) base.signature = opts.compatibleSignature;
      else delete base.signature;
      // The manifest part rarely fits an 840-byte T0 descriptor; TierStream drops it when it does not.
      this.compatible = new TierStream(0, opts.envelope, this.streamId, base, loop, repairFraction);
    } else {
      this.compatible = null;
    }
    this.compatibleDescriptor = this.compatible?.descriptor ?? null;
  }

  /** True once a finite stream has emitted its end frame(s). Always false for looping streams. */
  get finished(): boolean {
    return this.primary.done && (this.compatible === null || this.compatible.done);
  }

  /** Object transmission information of the primary stream. */
  get oti(): Oti {
    return this.primary.oti;
  }

  next(): FacetFrame {
    const seq = this.sequence++;
    let stream = this.primary;
    if (this.compatible) {
      const useCompat = seq % 3 === 2;
      stream = useCompat ? this.compatible : this.primary;
      if (stream.done && !(useCompat ? this.primary : this.compatible).done) stream = useCompat ? this.primary : this.compatible;
    }
    const f = stream.next(seq);
    // Keep only a short history for render(); UIs render a frame right after next().
    this.frames.set(seq, f);
    if (this.frames.size > 8) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
    return { tier: f.tier, type: f.type, holdRefreshes: f.holdRefreshes, sequence: f.sequence };
  }

  /**
   * The QR text of a T0 frame returned by a recent `next()` call (null for grid frames), for UIs that draw QR
   * codes with a native renderer instead of `render()`.
   */
  qrText(frame: FacetFrame): string | null {
    const f = this.frames.get(frame.sequence);
    if (!f) throw new RangeError(`frame ${frame.sequence} is no longer available; use frames right after next()`);
    return f.tier === 0 ? qrFrameText(f.header, f.payload) : null;
  }

  /** Renders a frame returned by a recent `next()` call as a square RGBA image. */
  render(frame: FacetFrame, sizePx: number): RgbaImage {
    const f = this.frames.get(frame.sequence);
    if (!f) throw new RangeError(`frame ${frame.sequence} is no longer available; render frames right after next()`);
    if (f.tier === 0) return renderQrFrame(f.header, f.payload, sizePx);
    const tier = f.tier as GridTier;
    const layout = gridLayout(tier);
    const pic =
      f.type === "calibration"
        ? calibrationPicture(layout, f.header)
        : dataPicture(layout, f.header, { streamId: f.streamId, tier, type: f.type, sbn: f.sbn, esi: f.esi }, f.payload);
    return renderPicture(pic, layout.n, tier, sizePx);
  }
}

/** Random-looking but reproducible stream id (tests and deterministic fixtures). */
export function deterministicStreamId(seed: number): Uint8Array {
  const r = new Xorshift32(seedFrom(seed));
  const v = r.next();
  return new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}
