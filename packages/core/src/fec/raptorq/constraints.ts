/**
 * Constraint matrix generation, RFC 6330 §5.3.3.3 - §5.3.3.4.2.
 *
 * The L columns are the intermediate symbols C[0..L-1]. Rows are:
 *   - S LDPC rows   (binary: G_LDPC,1 | I_S | G_LDPC,2)
 *   - H HDPC rows   (GF(256): G_HDPC | I_H) - returned separately as dense rows
 *   - one LT row per encoding symbol ISI (binary: G_ENC), produced by Enc[] index selection
 *
 * Binary rows are returned in CSR form (row pointers + column indices), which is what the
 * inactivation solver consumes.
 */
import { GF256_EXP, GF256_MUL } from "../gf256";
import type { BlockParams } from "./params";
import { encIndices, MAX_ENC_INDICES, rand } from "./rand";

export interface BinaryRows {
  /** Number of rows. */
  readonly count: number;
  /** CSR row pointers, length count + 1. */
  readonly ptr: Int32Array;
  /** CSR column indices (distinct within a row). */
  readonly cols: Int32Array;
}

class CsrBuilder {
  private ptr: number[] = [0];
  private cols: number[] = [];
  push(row: ArrayLike<number>, len: number): void {
    for (let i = 0; i < len; i++) this.cols.push(row[i] as number);
    this.ptr.push(this.cols.length);
  }
  build(): BinaryRows {
    return { count: this.ptr.length - 1, ptr: Int32Array.from(this.ptr), cols: Int32Array.from(this.cols) };
  }
}

/**
 * Binary rows: the S LDPC rows followed by one LT row per entry of `isis` (internal symbol ids).
 * Matches the reference implementation's "set" semantics: an entry hit more than once is 1.
 */
export function buildBinaryRows(p: BlockParams, isis: ArrayLike<number>): BinaryRows {
  const { S, B, W, P } = p;
  const ldpc: number[][] = [];
  for (let i = 0; i < S; i++) ldpc.push([]);
  const setOne = (row: number, col: number): void => {
    const r = ldpc[row] as number[];
    if (r.length === 0 || r[r.length - 1] !== col) {
      if (!r.includes(col)) r.push(col);
    }
  };
  // G_LDPC,1 (column-wise circulant construction)
  for (let i = 0; i < B; i++) {
    const a = 1 + Math.floor(i / S);
    let b = i % S;
    setOne(b, i);
    b = (b + a) % S;
    setOne(b, i);
    b = (b + a) % S;
    setOne(b, i);
  }
  // I_S
  for (let i = 0; i < S; i++) setOne(i, B + i);
  // G_LDPC,2
  for (let i = 0; i < S; i++) {
    setOne(i, (i % P) + W);
    setOne(i, ((i + 1) % P) + W);
  }

  const csr = new CsrBuilder();
  for (const r of ldpc) csr.push(r, r.length);
  const tuple = new Uint32Array(6);
  const idx = new Int32Array(MAX_ENC_INDICES);
  for (let k = 0; k < isis.length; k++) {
    const n = encIndices(isis[k] as number, p, tuple, idx);
    csr.push(idx, n);
  }
  return csr.build();
}

/**
 * Dense HDPC rows (H x L, row-major bytes): G_HDPC = MT * GAMMA over the first K' + S columns,
 * then I_H on the last H columns. Computed with the right-to-left recurrence
 * G[i][j] = MT[i][j] + alpha * G[i][j+1], which equals the RFC's matrix product.
 */
export function buildHdpcRows(p: BlockParams): Uint8Array {
  const { Kp, S, H, L } = p;
  const out = new Uint8Array(H * L);
  const ks = Kp + S;
  for (let i = 0; i < H; i++) out[i * L + ks - 1] = GF256_EXP[i] as number;
  const alphaRow = 2 << 8;
  for (let j = ks - 2; j >= 0; j--) {
    for (let i = 0; i < H; i++) {
      out[i * L + j] = GF256_MUL[alphaRow | (out[i * L + j + 1] as number)] as number;
    }
    const r6 = rand(j + 1, 6, H);
    const r7 = rand(j + 1, 7, H - 1);
    const i1 = r6;
    const i2 = (r6 + r7 + 1) % H;
    out[i1 * L + j] = (out[i1 * L + j] as number) ^ 1;
    out[i2 * L + j] = (out[i2 * L + j] as number) ^ 1;
  }
  for (let i = 0; i < H; i++) out[i * L + ks + i] = 1;
  return out;
}
