/**
 * RaptorQ systematic encoder (RFC 6330 §5.3), bit-exact with the `raptorq` crate.
 */
import { addAssign } from "../gf256";
import type { BlockLayout, Oti } from "./oti";
import { partitionBlocks } from "./oti";
import type { BlockParams } from "./params";
import { blockParams } from "./params";
import { encIndices, MAX_ENC_INDICES } from "./rand";
import type { SolvePlan } from "./solver";
import { applyPlan, planSolve } from "./solver";

/** Largest encoding symbol id representable in the 24-bit ESI field. */
export const MAX_ESI = 0xffffff;

const PLAN_CACHE_CAPACITY = 32;
const planCache = new Map<number, SolvePlan>();

/** Solve plan for the systematic system of a K-symbol block (depends only on K). */
function systematicPlan(p: BlockParams): SolvePlan {
  const hit = planCache.get(p.K);
  if (hit) {
    planCache.delete(p.K);
    planCache.set(p.K, hit);
    return hit;
  }
  const isis = new Int32Array(p.Kp);
  for (let i = 0; i < p.Kp; i++) isis[i] = i;
  const plan = planSolve(p, isis, null);
  if (!plan) throw new Error(`RaptorQ constraint matrix is singular for K'=${p.Kp} (table corruption?)`);
  if (planCache.size >= PLAN_CACHE_CAPACITY) {
    const oldest = planCache.keys().next();
    if (!oldest.done) planCache.delete(oldest.value);
  }
  planCache.set(p.K, plan);
  return plan;
}

/**
 * Compute the L intermediate symbols C[0..L-1] (concatenated, T bytes each) of a block whose
 * K source symbols are given in `source` (K * T bytes).
 */
export function intermediateSymbols(p: BlockParams, source: Uint8Array, T: number): Uint8Array {
  const plan = systematicPlan(p);
  const slab = new Uint8Array(plan.rowCount * T);
  slab.set(source.subarray(0, p.K * T), (p.S + p.H) * T);
  applyPlan(plan, slab, T);
  const out = new Uint8Array(p.L * T);
  for (let c = 0; c < p.L; c++) {
    const r = plan.colRow[c] as number;
    out.set(slab.subarray(r * T, r * T + T), c * T);
  }
  return out;
}

/** Enc[] for internal symbol id `isi` over intermediate symbols `C`, written to `dst`. */
export function encodeIsi(p: BlockParams, C: Uint8Array, T: number, isi: number, dst: Uint8Array): void {
  const tuple = new Uint32Array(6);
  const idx = new Int32Array(MAX_ENC_INDICES);
  const n = encIndices(isi, p, tuple, idx);
  const first = idx[0] as number;
  dst.set(C.subarray(first * T, first * T + T));
  for (let j = 1; j < n; j++) {
    const c = idx[j] as number;
    addAssign(dst, C.subarray(c * T, c * T + T));
  }
}

interface EncodedBlock {
  readonly params: BlockParams;
  /** K * T bytes of (zero-padded) source symbols. */
  readonly source: Uint8Array;
  /** Lazily computed intermediate symbols. */
  intermediate: Uint8Array | null;
}

export class RaptorQEncoder {
  readonly oti: Oti;
  readonly blockCount: number;
  private readonly blocks: EncodedBlock[];
  private readonly layout: BlockLayout[];

  constructor(data: Uint8Array, oti: Oti) {
    const layout = partitionBlocks(oti);
    if (data.length !== oti.transferLength) {
      throw new RangeError(`data length ${data.length} does not match OTI transferLength ${oti.transferLength}`);
    }
    this.oti = { ...oti };
    this.layout = layout;
    this.blockCount = layout.length;
    const T = oti.symbolSize;
    this.blocks = layout.map((b) => {
      const source = new Uint8Array(b.symbols * T);
      source.set(data.subarray(b.offset, b.offset + b.length));
      return { params: blockParams(b.symbols), source, intermediate: null };
    });
  }

  private block(sbn: number): EncodedBlock {
    const b = this.blocks[sbn];
    if (!Number.isInteger(sbn) || !b) throw new RangeError(`source block number ${sbn} out of range 0..${this.blockCount - 1}`);
    return b;
  }

  /** K (source symbol count) of block `sbn`. */
  sourceSymbolCount(sbn: number): number {
    return this.block(sbn).params.K;
  }

  /** Byte layout of block `sbn` within the object. */
  blockLayout(sbn: number): BlockLayout {
    this.block(sbn);
    return this.layout[sbn] as BlockLayout;
  }

  /**
   * Encoding symbol `esi` of block `sbn` (T bytes). ESI < K yields the (zero-padded) source
   * symbol; ESI >= K yields repair symbol ISI = ESI + K' - K.
   */
  symbol(sbn: number, esi: number): Uint8Array {
    const b = this.block(sbn);
    const T = this.oti.symbolSize;
    if (!Number.isInteger(esi) || esi < 0 || esi > MAX_ESI) throw new RangeError(`ESI must be an integer in 0..${MAX_ESI}, got ${esi}`);
    const p = b.params;
    if (esi < p.K) return b.source.slice(esi * T, esi * T + T);
    const isi = esi + p.Kp - p.K;
    if (isi > MAX_ESI + p.Kp) throw new RangeError("ISI overflow");
    if (!b.intermediate) b.intermediate = intermediateSymbols(p, b.source, T);
    const out = new Uint8Array(T);
    encodeIsi(p, b.intermediate, T, isi, out);
    return out;
  }
}
