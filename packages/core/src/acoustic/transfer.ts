/**
 * Acoustic transfer: RaptorQ fountain over the speaker/mic modem. Half-duplex; any enough symbols rebuild
 * the Envelope. The payload is always sealed Envelope bytes — never claim secrets or raw CEKs outside a
 * Broadcast descriptor (which is intentional open).
 */
import { RaptorQEncoder, RaptorQDecoder, planOti, encodeOti, decodeOti } from "../fec/index";
import { encodeDescriptorPayload, decodeDescriptorPayload } from "../facet/descriptor";
import type { StreamDescriptor, ReceiveProgress } from "../facet/types";
import { acousticProfile, type AcousticProfileId } from "./profiles";
import { encodePacket, fragmentPayload, defragmentPayload, type AcousticPacket } from "./packet";
import { modulatePacket, demodulateStream, concatenatePcm } from "./modem";

export interface AcousticSenderOptions {
  envelope: Uint8Array;
  profile: AcousticProfileId;
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
  streamId: Uint8Array;
  /** Broadcast: loop repair forever. */
  loop?: boolean;
  /** Repair symbols after source, as a fraction of K. Default 1.5. */
  repairFraction?: number;
}

export interface AcousticProgress {
  packetsEmitted: number;
  symbolsEmitted: number;
  sourceSymbols: number;
  finished: boolean;
}

/**
 * Emits acoustic packets (and optional PCM) for one Envelope. Call `nextPacket` / `nextPcm` until
 * `finished` (or forever when looping).
 */
export class AcousticSender {
  readonly profile: AcousticProfileId;
  readonly streamId: Uint8Array;
  readonly oti;
  private readonly enc: RaptorQEncoder;
  private readonly descBytes: Uint8Array;
  private readonly descFrags: { payload: Uint8Array; fragIndex: number; fragCount: number }[];
  private readonly loop: boolean;
  private readonly repairBudget: number;
  private phase: "descriptor" | "source" | "repair" = "descriptor";
  private descNext = 0;
  private block = 0;
  private sourceNext: number[];
  private repairNext: number[];
  private repairEmitted = 0;
  private packetsEmitted = 0;
  private ended = false;
  private descRounds = 0;

  constructor(o: AcousticSenderOptions) {
    if (o.streamId.length !== 4) throw new RangeError("streamId must be 4 bytes");
    const p = acousticProfile(o.profile);
    this.profile = o.profile;
    this.streamId = o.streamId.slice();
    this.loop = o.loop === true;
    this.oti = planOti(o.envelope.length, p.symbolSize, 256);
    this.enc = new RaptorQEncoder(o.envelope, this.oti);
    const descriptor: StreamDescriptor = {
      streamId: this.streamId,
      tier: 0,
      oti: encodeOti(this.oti),
      ...o.descriptor,
    };
    // Encode into a flexible buffer: take the CBOR size with a generous ceiling.
    const ceiling = Math.max(512, (o.descriptor.manifestPart?.length ?? 0) + 256);
    this.descBytes = encodeDescriptorPayload(descriptor, ceiling);
    this.descFrags = fragmentPayload(this.descBytes, p.packetPayload);
    this.sourceNext = Array.from({ length: this.enc.blockCount }, () => 0);
    this.repairNext = Array.from({ length: this.enc.blockCount }, (_, b) => this.enc.sourceSymbolCount(b));
    const repairFraction = o.repairFraction ?? 1.5;
    this.repairBudget = Array.from({ length: this.enc.blockCount }, (_, b) =>
      Math.max(4, Math.ceil(this.enc.sourceSymbolCount(b) * repairFraction)),
    ).reduce((a, n) => a + n, 0);
  }

  get finished(): boolean {
    return this.ended;
  }

  get progress(): AcousticProgress {
    const sourceSymbols = Array.from({ length: this.enc.blockCount }, (_, b) => this.enc.sourceSymbolCount(b)).reduce((a, n) => a + n, 0);
    return {
      packetsEmitted: this.packetsEmitted,
      symbolsEmitted: Math.max(0, this.packetsEmitted - this.descFrags.length * Math.max(1, this.descRounds)),
      sourceSymbols,
      finished: this.ended,
    };
  }

  nextPacket(): AcousticPacket {
    if (this.ended) throw new Error("acoustic sender has finished");
    let packet: AcousticPacket;
    if (this.phase === "descriptor") {
      const frag = this.descFrags[this.descNext]!;
      packet = {
        profile: this.profile,
        type: "descriptor",
        flags: 0,
        streamId: this.streamId,
        sbn: frag.fragIndex,
        esi: frag.fragCount,
        payload: frag.payload,
      };
      this.descNext++;
      if (this.descNext >= this.descFrags.length) {
        this.descNext = 0;
        this.descRounds++;
        // After three full descriptor passes, start source symbols.
        if (this.descRounds >= 3) this.phase = "source";
      }
    } else if (this.phase === "source") {
      const sbn = this.block;
      const esi = this.sourceNext[sbn]!;
      const symbol = this.enc.symbol(sbn, esi);
      packet = { profile: this.profile, type: "data", flags: 0, streamId: this.streamId, sbn, esi, payload: symbol };
      this.sourceNext[sbn] = esi + 1;
      if (this.sourceNext[sbn]! >= this.enc.sourceSymbolCount(sbn)) {
        this.block++;
        if (this.block >= this.enc.blockCount) {
          this.block = 0;
          this.phase = "repair";
        }
      }
    } else {
      // repair round-robin
      const sbn = this.block;
      const esi = this.repairNext[sbn]!;
      const symbol = this.enc.symbol(sbn, esi);
      packet = { profile: this.profile, type: "data", flags: 0, streamId: this.streamId, sbn, esi, payload: symbol };
      this.repairNext[sbn] = esi + 1;
      this.repairEmitted++;
      this.block = (this.block + 1) % this.enc.blockCount;
      if (!this.loop && this.repairEmitted >= this.repairBudget) {
        this.ended = true;
        this.packetsEmitted++;
        return {
          profile: this.profile,
          type: "end",
          flags: 0,
          streamId: this.streamId,
          sbn: 0,
          esi: 0,
          payload: new Uint8Array(0),
        };
      }
      // Periodically re-emit a descriptor fragment so late joiners can lock on.
      if (this.repairEmitted % 32 === 0) {
        this.phase = "descriptor";
        this.descRounds = 2; // one more full pass then back to repair
      }
    }
    this.packetsEmitted++;
    return packet;
  }

  /** Modulates the next packet to PCM. */
  nextPcm(): Float32Array {
    return modulatePacket(this.nextPacket(), this.profile);
  }

  /** Renders a contiguous PCM buffer covering `count` packets (or until finished). */
  renderPcm(count: number): Float32Array {
    const parts: Float32Array[] = [];
    for (let i = 0; i < count && !this.ended; i++) parts.push(this.nextPcm());
    return concatenatePcm(parts);
  }
}

function emptyProgress(): ReceiveProgress {
  return {
    streamId: null,
    tier: null,
    framesSeen: 0,
    framesDecoded: 0,
    symbolsReceived: 0,
    symbolsNeeded: 0,
    blocksComplete: 0,
    blockCount: 0,
    fraction: 0,
    symbolSize: null,
    recentLoss: null,
    calibrated: false,
    complete: false,
  };
}

/** Reconstructs an Envelope from demodulated acoustic packets. */
export class AcousticReceiver {
  private readonly profile: AcousticProfileId;
  private streamId: Uint8Array | null = null;
  private descriptor: StreamDescriptor | null = null;
  private decoder: RaptorQDecoder | null = null;
  private descFrags = new Map<number, Uint8Array>();
  private descCount = 0;
  private resultBytes: Uint8Array | null = null;
  private pcmCursor = 0;
  private leftover = new Float32Array(0);
  private _progress: ReceiveProgress = emptyProgress();
  private framesSeen = 0;
  private framesDecoded = 0;
  private pending: { sbn: number; esi: number; symbol: Uint8Array }[] = [];

  constructor(profile: AcousticProfileId = 0) {
    this.profile = profile;
  }

  get progress(): ReceiveProgress {
    return this._progress;
  }

  get streamDescriptor(): StreamDescriptor | null {
    return this.descriptor;
  }

  result(): Uint8Array | null {
    return this.resultBytes;
  }

  /** Push raw PCM samples from the microphone. */
  pushPcm(pcm: Float32Array): void {
    const merged = new Float32Array(this.leftover.length + pcm.length);
    merged.set(this.leftover);
    merged.set(pcm, this.leftover.length);
    const { packets, nextFrom } = demodulateStream(merged, this.profile, 0);
    for (const pkt of packets) this.pushPacket(pkt);
    // Keep a trailing window so a preamble straddling the boundary is not lost.
    const keep = acousticProfile(this.profile).sampleRate; // 1 s
    const cut = Math.max(0, nextFrom - keep);
    this.leftover = merged.subarray(cut);
    this.pcmCursor = nextFrom;
  }

  pushPacket(pkt: AcousticPacket): void {
    this.framesSeen++;
    if (pkt.profile !== this.profile) return;
    if (this.streamId && !bytesEq(this.streamId, pkt.streamId)) return;
    if (!this.streamId) this.streamId = pkt.streamId.slice();

    if (pkt.type === "descriptor") {
      this.ingestDescriptor(pkt);
      this.framesDecoded++;
      this.refreshProgress();
      return;
    }
    if (pkt.type === "end") {
      this.refreshProgress();
      return;
    }
    if (pkt.type !== "data") return;

    if (!this.decoder) {
      this.pending.push({ sbn: pkt.sbn, esi: pkt.esi, symbol: pkt.payload });
      if (this.pending.length > 512) this.pending.shift();
      return;
    }
    this.acceptSymbol(pkt.sbn, pkt.esi, pkt.payload);
    this.framesDecoded++;
    this.refreshProgress();
  }

  private ingestDescriptor(pkt: AcousticPacket): void {
    if (pkt.payload.length < 2) return;
    const fragIndex = pkt.payload[0]!;
    const fragCount = pkt.payload[1]!;
    if (fragCount < 1 || fragIndex >= fragCount) return;
    // Prefer packet sbn/esi as authoritative when present; payload also carries them.
    const index = pkt.sbn;
    const count = pkt.esi || fragCount;
    this.descCount = count;
    this.descFrags.set(index, pkt.payload.subarray(2).slice());
    const assembled = defragmentPayload(this.descFrags, count);
    if (!assembled) return;
    const d = decodeDescriptorPayload(assembled);
    if (!d) return;
    this.descriptor = d;
    if (!this.decoder) {
      try {
        const oti = decodeOti(d.oti);
        this.decoder = new RaptorQDecoder(oti);
        for (const p of this.pending) this.acceptSymbol(p.sbn, p.esi, p.symbol);
        this.pending = [];
      } catch {
        this.decoder = null;
      }
    }
  }

  private acceptSymbol(sbn: number, esi: number, symbol: Uint8Array): void {
    if (!this.decoder || this.resultBytes) return;
    try {
      this.decoder.add(sbn, esi, symbol);
    } catch {
      return;
    }
    if (this.decoder.isComplete()) {
      this.resultBytes = this.decoder.result();
    }
  }

  private refreshProgress(): void {
    const d = this.decoder;
    const desc = this.descriptor;
    let symbolsNeeded = 0;
    let symbolsReceived = 0;
    let blocksComplete = 0;
    let blockCount = 0;
    if (d) {
      blockCount = d.blockCount;
      for (let b = 0; b < d.blockCount; b++) {
        symbolsNeeded += d.sourceSymbolCount(b);
        symbolsReceived += d.receivedCount(b);
        if (d.isBlockComplete(b)) blocksComplete++;
      }
    }
    this._progress = {
      streamId: this.streamId,
      tier: 0,
      framesSeen: this.framesSeen,
      framesDecoded: this.framesDecoded,
      symbolsReceived,
      symbolsNeeded,
      blocksComplete,
      blockCount,
      fraction: this.resultBytes ? 1 : symbolsNeeded > 0 ? Math.min(0.99, symbolsReceived / symbolsNeeded) : desc ? 0.05 : 0,
      symbolSize: d?.oti.symbolSize ?? null,
      recentLoss: null,
      calibrated: desc !== null,
      complete: this.resultBytes !== null,
    };
  }
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Estimates wall-clock seconds to send `bytes` at the profile's target goodput. */
export function estimateAcousticSeconds(bytes: number, profile: AcousticProfileId): number {
  const p = acousticProfile(profile);
  return Math.ceil(bytes / Math.max(1, p.targetGoodputBps));
}