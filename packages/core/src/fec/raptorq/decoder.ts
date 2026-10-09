/**
 * RaptorQ decoder (RFC 6330 §5.4) compatible with the `raptorq` crate's encoding.
 */
import type { BlockLayout, Oti } from "./oti";
import { partitionBlocks } from "./oti";
import type { BlockParams } from "./params";
import { blockParams } from "./params";
import { applyPlan, planSolve } from "./solver";
import { encodeIsi, MAX_ESI } from "./encoder";

interface DecodingBlock {
  readonly params: BlockParams;
  readonly layout: BlockLayout;
  readonly received: Map<number, Uint8Array>;
  sourceReceived: number;
  /** Decoded K * T source bytes once complete. */
  decoded: Uint8Array | null;
  /** Count of received symbols at the last failed solve attempt (avoid identical retries). */
  lastAttempt: number;
}

export class RaptorQDecoder {
  readonly oti: Oti;
  readonly blockCount: number;
  private readonly blocks: DecodingBlock[];
  private completeBlocks = 0;

  constructor(oti: Oti) {
    const layout = partitionBlocks(oti);
    this.oti = { ...oti };
    this.blockCount = layout.length;
    this.blocks = layout.map((l) => ({
      params: blockParams(l.symbols),
      layout: l,
      received: new Map<number, Uint8Array>(),
      sourceReceived: 0,
      decoded: null,
      lastAttempt: -1,
    }));
  }

  private block(sbn: number): DecodingBlock {
    const b = this.blocks[sbn];
    if (!Number.isInteger(sbn) || !b) throw new RangeError(`source block number ${sbn} out of range 0..${this.blockCount - 1}`);
    return b;
  }

  /**
   * Add encoding symbol `esi` of block `sbn`. Duplicates and symbols for already-decoded blocks
   * are ignored. Returns true if the block is decoded (now or previously).
   */
  add(sbn: number, esi: number, symbol: Uint8Array): boolean {
    const b = this.block(sbn);
    if (b.decoded) return true;
    if (!Number.isInteger(esi) || esi < 0 || esi > MAX_ESI) throw new RangeError(`ESI must be an integer in 0..${MAX_ESI}, got ${esi}`);
    const T = this.oti.symbolSize;
    if (symbol.length !== T) throw new RangeError(`symbol must be ${T} bytes, got ${symbol.length}`);
    if (b.received.has(esi)) return false;
    b.received.set(esi, symbol.slice());
    if (esi < b.params.K) b.sourceReceived++;
    if (b.received.size >= b.params.K) this.tryDecode(b);
    return b.decoded !== null;
  }

  isBlockComplete(sbn: number): boolean {
    return this.block(sbn).decoded !== null;
  }

  receivedCount(sbn: number): number {
    return this.block(sbn).received.size;
  }

  sourceSymbolCount(sbn: number): number {
    return this.block(sbn).params.K;
  }

  isComplete(): boolean {
    return this.completeBlocks === this.blockCount;
  }

  /** Decoded bytes of block `sbn`, trimmed to its true length within the object. */
  blockData(sbn: number): Uint8Array | null {
    const b = this.block(sbn);
    if (!b.decoded) return null;
    return b.decoded.slice(0, b.layout.length);
  }

  /** The full object (length F) once every block is decoded. */
  result(): Uint8Array | null {
    if (!this.isComplete()) return null;
    const out = new Uint8Array(this.oti.transferLength);
    for (const b of this.blocks) {
      const d = b.decoded as Uint8Array;
      out.set(d.subarray(0, b.layout.length), b.layout.offset);
    }
    return out;
  }

  private finish(b: DecodingBlock, data: Uint8Array): void {
    b.decoded = data;
    b.received.clear();
    this.completeBlocks++;
  }

  private tryDecode(b: DecodingBlock): void {
    const p = b.params;
    const T = this.oti.symbolSize;
    const K = p.K;
    if (b.sourceReceived === K) {
      const out = new Uint8Array(K * T);
      for (let i = 0; i < K; i++) out.set(b.received.get(i) as Uint8Array, i * T);
      this.finish(b, out);
      return;
    }
    if (b.received.size === b.lastAttempt) return;
    b.lastAttempt = b.received.size;

    // Rows of D: S LDPC zeros, H HDPC zeros, then received source ISIs, padding ISIs K..K'-1
    // (zero symbols) and repair ISIs (ESI + K' - K).
    const pad = p.Kp - K;
    const m = b.received.size + pad;
    const isis = new Int32Array(m);
    const datas: (Uint8Array | null)[] = new Array<Uint8Array | null>(m);
    let r = 0;
    const repair: number[] = [];
    for (const esi of b.received.keys()) {
      if (esi < K) {
        isis[r] = esi;
        datas[r] = b.received.get(esi) as Uint8Array;
        r++;
      } else {
        repair.push(esi);
      }
    }
    for (let i = K; i < p.Kp; i++) {
      isis[r] = i;
      datas[r] = null;
      r++;
    }
    for (const esi of repair) {
      isis[r] = esi + pad;
      datas[r] = b.received.get(esi) as Uint8Array;
      r++;
    }

    const plan = planSolve(p, isis, null);
    if (!plan) return;
    const slab = new Uint8Array(plan.rowCount * T);
    const base = p.S + p.H;
    for (let i = 0; i < m; i++) {
      const d = datas[i];
      if (d) slab.set(d, (base + i) * T);
    }
    applyPlan(plan, slab, T);
    const C = new Uint8Array(p.L * T);
    for (let c = 0; c < p.L; c++) {
      const row = plan.colRow[c] as number;
      C.set(slab.subarray(row * T, row * T + T), c * T);
    }
    const out = new Uint8Array(K * T);
    for (let i = 0; i < K; i++) {
      const got = b.received.get(i);
      if (got) out.set(got, i * T);
      else encodeIsi(p, C, T, i, out.subarray(i * T, i * T + T));
    }
    this.finish(b, out);
  }
}
