/**
 * Object Transmission Information (RFC 6330 §3.3.2 Common FEC OTI + §3.3.3 Scheme-Specific OTI)
 * and source block partitioning (RFC 6330 §4.4.1.2).
 */
import { MAX_SOURCE_SYMBOLS_PER_BLOCK } from "./params";

export interface Oti {
  /** F: transfer length in bytes (40-bit). */
  transferLength: number;
  /** T: symbol size in bytes (16-bit, multiple of `alignment`). */
  symbolSize: number;
  /** Z: number of source blocks (8-bit). */
  sourceBlocks: number;
  /** N: number of sub-blocks per source block (16-bit). Only N = 1 is supported by the codec. */
  subBlocks: number;
  /** Al: symbol alignment in bytes (8-bit). */
  alignment: number;
}

/** Largest transfer length allowed by RFC 6330 (errata 5548). */
export const MAX_TRANSFER_LENGTH = 942574504275;

const TWO_32 = 0x1_0000_0000;

function checkInt(v: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${v}`);
}

/** Validate field ranges and the RFC 6330 §4.4.1.2 constraints. Throws on invalid input. */
export function validateOti(oti: Oti): void {
  checkInt(oti.transferLength, "transferLength (F)", 1, MAX_TRANSFER_LENGTH);
  checkInt(oti.symbolSize, "symbolSize (T)", 1, 0xffff);
  checkInt(oti.sourceBlocks, "sourceBlocks (Z)", 1, 0xff);
  checkInt(oti.subBlocks, "subBlocks (N)", 1, 0xffff);
  checkInt(oti.alignment, "alignment (Al)", 1, 0xff);
  if (oti.symbolSize % oti.alignment !== 0) {
    throw new RangeError(`symbolSize (${oti.symbolSize}) must be a multiple of alignment (${oti.alignment})`);
  }
  const kt = Math.ceil(oti.transferLength / oti.symbolSize);
  if (oti.sourceBlocks > kt) {
    throw new RangeError(`sourceBlocks (${oti.sourceBlocks}) exceeds the total symbol count Kt=${kt}`);
  }
  if (Math.ceil(kt / oti.sourceBlocks) > MAX_SOURCE_SYMBOLS_PER_BLOCK) {
    throw new RangeError(`ceil(Kt/Z) = ${Math.ceil(kt / oti.sourceBlocks)} exceeds K'max = ${MAX_SOURCE_SYMBOLS_PER_BLOCK}`);
  }
}

/** Serialize to the 12-byte layout F(40) | reserved(8) | T(16) | Z(8) | N(16) | Al(8). */
export function encodeOti(oti: Oti): Uint8Array {
  validateOti(oti);
  const out = new Uint8Array(12);
  const F = oti.transferLength;
  const hi = Math.floor(F / TWO_32);
  const lo = F - hi * TWO_32;
  out[0] = hi & 0xff;
  out[1] = (lo >>> 24) & 0xff;
  out[2] = (lo >>> 16) & 0xff;
  out[3] = (lo >>> 8) & 0xff;
  out[4] = lo & 0xff;
  out[5] = 0;
  out[6] = (oti.symbolSize >>> 8) & 0xff;
  out[7] = oti.symbolSize & 0xff;
  out[8] = oti.sourceBlocks & 0xff;
  out[9] = (oti.subBlocks >>> 8) & 0xff;
  out[10] = oti.subBlocks & 0xff;
  out[11] = oti.alignment & 0xff;
  return out;
}

/** Parse the 12-byte OTI. Throws if the length is wrong or the fields are invalid. */
export function decodeOti(b: Uint8Array): Oti {
  if (b.length !== 12) throw new RangeError(`OTI must be exactly 12 bytes, got ${b.length}`);
  const byte = (i: number): number => b[i] as number;
  const lo = ((byte(1) << 24) >>> 0) + (byte(2) << 16) + (byte(3) << 8) + byte(4);
  const oti: Oti = {
    transferLength: byte(0) * TWO_32 + lo,
    symbolSize: (byte(6) << 8) | byte(7),
    sourceBlocks: byte(8),
    subBlocks: (byte(9) << 8) | byte(10),
    alignment: byte(11),
  };
  validateOti(oti);
  return oti;
}

/**
 * Plan an OTI with N = 1: Kt = ceil(F/T), Z = ceil(Kt / maxSourceSymbolsPerBlock).
 */
export function planOti(transferLength: number, symbolSize: number, maxSourceSymbolsPerBlock: number, alignment = 8): Oti {
  checkInt(transferLength, "transferLength", 1, MAX_TRANSFER_LENGTH);
  checkInt(symbolSize, "symbolSize", 1, 0xffff);
  checkInt(alignment, "alignment", 1, 0xff);
  checkInt(maxSourceSymbolsPerBlock, "maxSourceSymbolsPerBlock", 1, MAX_SOURCE_SYMBOLS_PER_BLOCK);
  if (symbolSize % alignment !== 0) {
    throw new RangeError(`symbolSize (${symbolSize}) must be a multiple of alignment (${alignment})`);
  }
  const kt = Math.ceil(transferLength / symbolSize);
  const z = Math.ceil(kt / maxSourceSymbolsPerBlock);
  if (z > 255) {
    throw new RangeError(`object needs ${z} source blocks (> 255); increase symbolSize or maxSourceSymbolsPerBlock`);
  }
  const oti: Oti = { transferLength, symbolSize, sourceBlocks: z, subBlocks: 1, alignment };
  validateOti(oti);
  return oti;
}

/** One source block of the partitioned object. */
export interface BlockLayout {
  /** Source symbols in the block (K). */
  readonly symbols: number;
  /** Byte offset of the block within the object. */
  readonly offset: number;
  /** True (unpadded) byte length of the block within the object (may be < symbols*T or 0). */
  readonly length: number;
}

/** Partition[Kt, Z] (RFC 6330 §4.4.1.2): KL, KS, ZL, ZS block layout for an OTI with N = 1. */
export function partitionBlocks(oti: Oti): BlockLayout[] {
  validateOti(oti);
  if (oti.subBlocks !== 1) {
    throw new Error(`RaptorQ sub-blocking is not supported: OTI has N=${oti.subBlocks}, only N=1 is implemented`);
  }
  const F = oti.transferLength;
  const T = oti.symbolSize;
  const Z = oti.sourceBlocks;
  const kt = Math.ceil(F / T);
  const kl = Math.ceil(kt / Z);
  const ks = Math.floor(kt / Z);
  const zl = kt - ks * Z;
  const out: BlockLayout[] = [];
  let off = 0;
  for (let i = 0; i < Z; i++) {
    const k = i < zl ? kl : ks;
    const bytes = k * T;
    const length = Math.max(0, Math.min(off + bytes, F) - off);
    out.push({ symbols: k, offset: off, length });
    off += bytes;
  }
  return out;
}
