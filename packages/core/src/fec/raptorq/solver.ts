/**
 * Inactivation-decoding solver for the RaptorQ constraint system A * C = D (RFC 6330 §5.4).
 *
 * Planning works on the matrix only and emits a straight-line program of symbol operations
 * ("dst ^= c * src" and "dst *= c") over the rows of D. The program is pruned by a backward
 * liveness pass so only operations that influence the requested intermediate symbols survive,
 * then replayed on the symbol data. Plans for the systematic encoder depend only on K and are
 * cached by the encoder.
 *
 * Phases:
 *  1. Peeling with inactivation over the sparse binary rows (LDPC + LT). The P PI columns are
 *     permanently inactivated up front (as in the RFC); when no row of active degree 1 is left,
 *     a minimum-degree row is chosen and all but one of its active columns are inactivated.
 *     This yields a lower-triangular "solved" part plus u inactive columns.
 *  2. Each pivot row is reduced to "its column + a combination of inactive columns" by forward
 *     substitution (bit-packed inactive parts).
 *  3. The remaining binary rows and the H dense GF(256) HDPC rows are reduced onto the inactive
 *     columns, giving a small dense GF(256) system (rows x u) solved by Gaussian elimination.
 *  4. Back-substitution of the inactive values into the pivot rows.
 */
import { GF256_INV, GF256_MUL } from "../gf256";
import type { BinaryRows } from "./constraints";
import { buildBinaryRows, buildHdpcRows } from "./constraints";
import type { BlockParams } from "./params";

/** A compiled solve: replay `ops` on D, then intermediate symbol c lives in D row `colRow[c]`. */
export interface SolvePlan {
  /** Number of rows of D the plan expects (S + H + number of encoding rows). */
  readonly rowCount: number;
  /** Triples (dst, src, coef). src = -1 means dst *= coef; otherwise dst ^= coef * src. */
  readonly ops: Int32Array;
  /** For each intermediate column, the D row holding it after the ops run (-1 if not needed). */
  readonly colRow: Int32Array;
}

class OpList {
  private buf = new Int32Array(3 * 1024);
  length = 0;
  push(dst: number, src: number, coef: number): void {
    if (this.length + 3 > this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = dst;
    this.buf[this.length++] = src;
    this.buf[this.length++] = coef;
  }
  view(): Int32Array {
    return this.buf.subarray(0, this.length);
  }
}

const ACTIVE = 0;
const SOLVED = 1;
const INACTIVE = 2;

/**
 * Plan the solve for encoding rows with internal symbol ids `isis` (rows of D are laid out as
 * S LDPC rows, H HDPC rows, then one row per ISI, in order).
 *
 * @param needed optional mask over the L intermediate columns; only those are guaranteed to be
 *               produced (others get colRow -1). Null means all columns.
 * @returns the plan, or null if the system is rank deficient (more symbols are required).
 */
export function planSolve(p: BlockParams, isis: ArrayLike<number>, needed: Uint8Array | null): SolvePlan | null {
  const { S, H, L, W } = p;
  const m = isis.length;
  if (S + H + m < L) return null;
  const rows: BinaryRows = buildBinaryRows(p, isis);
  const nBin = rows.count;
  const ptr = rows.ptr;
  const cols = rows.cols;
  /** D row index of binary row k. */
  const dRow = (k: number): number => (k < S ? k : k + H);

  // ---- column -> rows adjacency (active columns only matter, but build for all) ----
  const colCount = new Int32Array(L + 1);
  for (let i = 0; i < cols.length; i++) {
    const ci = (cols[i] as number) + 1;
    colCount[ci] = (colCount[ci] as number) + 1;
  }
  for (let c = 0; c < L; c++) colCount[c + 1] = (colCount[c + 1] as number) + (colCount[c] as number);
  const colPtr = colCount;
  const colRows = new Int32Array(cols.length);
  {
    const fill = colPtr.slice(0, L);
    for (let r = 0; r < nBin; r++) {
      for (let q = ptr[r] as number, e = ptr[r + 1] as number; q < e; q++) {
        const c = cols[q] as number;
        colRows[fill[c] as number] = r;
        fill[c] = (fill[c] as number) + 1;
      }
    }
  }

  // ---- phase 1: peeling with inactivation ----
  const state = new Uint8Array(L);
  for (let c = W; c < L; c++) state[c] = INACTIVE;
  const deg = new Int32Array(nBin);
  /** live occurrence count of each column among unused rows (inactivation heuristic). */
  const occ = new Int32Array(L);
  for (let r = 0; r < nBin; r++) {
    let d = 0;
    for (let q = ptr[r] as number, e = ptr[r + 1] as number; q < e; q++) {
      const c = cols[q] as number;
      occ[c] = (occ[c] as number) + 1;
      if (state[c] === ACTIVE) d++;
    }
    deg[r] = d;
  }
  const used = new Uint8Array(nBin);
  const stack: number[] = [];
  for (let r = 0; r < nBin; r++) if (deg[r] === 1) stack.push(r);

  const pivRow = new Int32Array(L);
  const pivCol = new Int32Array(L);
  const colPivot = new Int32Array(L).fill(-1);
  let s = 0;
  const inactCols: number[] = [];
  for (let c = W; c < L; c++) inactCols.push(c);

  const removeColumn = (c: number): void => {
    for (let q = colPtr[c] as number, e = colPtr[c + 1] as number; q < e; q++) {
      const r = colRows[q] as number;
      if (used[r]) continue;
      const d = (deg[r] as number) - 1;
      deg[r] = d;
      if (d === 1) stack.push(r);
    }
  };

  let remainingActive = W;
  while (remainingActive > 0) {
    let r = -1;
    while (stack.length > 0) {
      const cand = stack.pop() as number;
      if (!used[cand] && deg[cand] === 1) {
        r = cand;
        break;
      }
    }
    if (r < 0) {
      // Stuck: choose an unused row of minimum active degree >= 2.
      let best = -1;
      let bestDeg = 0x7fffffff;
      for (let k = 0; k < nBin; k++) {
        if (used[k]) continue;
        const d = deg[k] as number;
        if (d >= 2 && d < bestDeg) {
          bestDeg = d;
          best = k;
          if (d === 2) break;
        }
      }
      if (best < 0) {
        // No binary row constrains the remaining active columns; they can still be pinned down
        // by the HDPC rows, so move them all into the inactive (dense) part.
        for (let c = 0; c < W; c++) {
          if (state[c] === ACTIVE) {
            state[c] = INACTIVE;
            inactCols.push(c);
          }
        }
        remainingActive = 0;
        break;
      }
      // Keep the active column with the fewest live occurrences; inactivate the rest.
      let keep = -1;
      let keepOcc = 0x7fffffff;
      for (let q = ptr[best] as number, e = ptr[best + 1] as number; q < e; q++) {
        const c = cols[q] as number;
        if (state[c] === ACTIVE && (occ[c] as number) < keepOcc) {
          keepOcc = occ[c] as number;
          keep = c;
        }
      }
      for (let q = ptr[best] as number, e = ptr[best + 1] as number; q < e; q++) {
        const c = cols[q] as number;
        if (state[c] === ACTIVE && c !== keep) {
          state[c] = INACTIVE;
          inactCols.push(c);
          remainingActive--;
          removeColumn(c);
        }
      }
      r = best;
    }
    // Row r has exactly one active column.
    let c = -1;
    for (let q = ptr[r] as number, e = ptr[r + 1] as number; q < e; q++) {
      const cc = cols[q] as number;
      occ[cc] = (occ[cc] as number) - 1;
      if (state[cc] === ACTIVE) c = cc;
    }
    used[r] = 1;
    state[c] = SOLVED;
    pivRow[s] = r;
    pivCol[s] = c;
    colPivot[c] = s;
    s++;
    remainingActive--;
    removeColumn(c);
  }

  const u = inactCols.length;
  const colInact = new Int32Array(L).fill(-1);
  for (let t = 0; t < u; t++) colInact[inactCols[t] as number] = t;

  const ops = new OpList();

  // ---- phase 2: reduce pivot rows to (own column) + (inactive combination) ----
  const wU = (u + 31) >>> 5;
  const pivBits = new Uint32Array(Math.max(1, s * wU));
  for (let i = 0; i < s; i++) {
    const r = pivRow[i] as number;
    const own = pivCol[i] as number;
    const bi = i * wU;
    for (let q = ptr[r] as number, e = ptr[r + 1] as number; q < e; q++) {
      const c = cols[q] as number;
      if (c === own) continue;
      const t = colInact[c] as number;
      if (t >= 0) {
        pivBits[bi + (t >>> 5)] = (pivBits[bi + (t >>> 5)] as number) ^ (1 << (t & 31));
      } else {
        const j = colPivot[c] as number;
        const bj = j * wU;
        for (let w = 0; w < wU; w++) pivBits[bi + w] = (pivBits[bi + w] as number) ^ (pivBits[bj + w] as number);
        ops.push(dRow(r), dRow(pivRow[j] as number), 1);
      }
    }
  }

  // ---- phase 3: reduce remaining rows onto the inactive columns ----
  const denseRows: Uint8Array[] = [];
  const denseD: number[] = [];
  const tmpBits = new Uint32Array(Math.max(1, wU));
  for (let r = 0; r < nBin; r++) {
    if (used[r]) continue;
    tmpBits.fill(0);
    const dr = dRow(r);
    for (let q = ptr[r] as number, e = ptr[r + 1] as number; q < e; q++) {
      const c = cols[q] as number;
      const t = colInact[c] as number;
      if (t >= 0) {
        tmpBits[t >>> 5] = (tmpBits[t >>> 5] as number) ^ (1 << (t & 31));
      } else {
        const j = colPivot[c] as number;
        const bj = j * wU;
        for (let w = 0; w < wU; w++) tmpBits[w] = (tmpBits[w] as number) ^ (pivBits[bj + w] as number);
        ops.push(dr, dRow(pivRow[j] as number), 1);
      }
    }
    const row = new Uint8Array(u);
    for (let t = 0; t < u; t++) if (((tmpBits[t >>> 5] as number) >>> (t & 31)) & 1) row[t] = 1;
    denseRows.push(row);
    denseD.push(dr);
  }
  const hdpc = buildHdpcRows(p);
  for (let h = 0; h < H; h++) {
    const row = new Uint8Array(u);
    const dr = S + h;
    const base = h * L;
    for (let c = 0; c < L; c++) {
      const v = hdpc[base + c] as number;
      if (v === 0) continue;
      const t = colInact[c] as number;
      if (t >= 0) {
        row[t] = (row[t] as number) ^ v;
        continue;
      }
      const j = colPivot[c] as number;
      ops.push(dr, dRow(pivRow[j] as number), v);
      const bj = j * wU;
      for (let w = 0; w < wU; w++) {
        let bits = pivBits[bj + w] as number;
        while (bits !== 0) {
          const low = bits & -bits;
          const t2 = (w << 5) + (31 - Math.clz32(low));
          row[t2] = (row[t2] as number) ^ v;
          bits ^= low;
        }
      }
    }
    denseRows.push(row);
    denseD.push(dr);
  }

  // ---- dense GF(256) elimination on the u inactive columns ----
  const nDense = denseRows.length;
  if (nDense < u) return null;
  const pivoted = new Uint8Array(nDense);
  const inactRow = new Int32Array(u); // dense row index that holds inactive column t
  for (let t = 0; t < u; t++) {
    let pick = -1;
    for (let k = 0; k < nDense; k++) {
      if (pivoted[k]) continue;
      const v = (denseRows[k] as Uint8Array)[t] as number;
      if (v === 1) {
        pick = k;
        break;
      }
      if (v !== 0 && pick < 0) pick = k;
    }
    if (pick < 0) return null;
    pivoted[pick] = 1;
    inactRow[t] = pick;
    const prow = denseRows[pick] as Uint8Array;
    const pv = prow[t] as number;
    if (pv !== 1) {
      const iv = GF256_INV[pv] as number;
      const mb = iv << 8;
      for (let x = t; x < u; x++) prow[x] = GF256_MUL[mb | (prow[x] as number)] as number;
      ops.push(denseD[pick] as number, -1, iv);
    }
    const pd = denseD[pick] as number;
    for (let k = 0; k < nDense; k++) {
      if (pivoted[k]) continue;
      const row = denseRows[k] as Uint8Array;
      const f = row[t] as number;
      if (f === 0) continue;
      if (f === 1) {
        for (let x = t; x < u; x++) row[x] = (row[x] as number) ^ (prow[x] as number);
      } else {
        const fb = f << 8;
        for (let x = t; x < u; x++) row[x] = (row[x] as number) ^ (GF256_MUL[fb | (prow[x] as number)] as number);
      }
      ops.push(denseD[k] as number, pd, f);
    }
  }
  // back-substitution within the dense block
  for (let t = u - 1; t >= 0; t--) {
    const src = denseD[inactRow[t] as number] as number;
    for (let t2 = 0; t2 < t; t2++) {
      const row = denseRows[inactRow[t2] as number] as Uint8Array;
      const f = row[t] as number;
      if (f !== 0) {
        row[t] = 0;
        ops.push(denseD[inactRow[t2] as number] as number, src, f);
      }
    }
  }

  // ---- phase 4: back-substitute inactive values into pivot rows ----
  for (let i = 0; i < s; i++) {
    const dr = dRow(pivRow[i] as number);
    const bi = i * wU;
    for (let w = 0; w < wU; w++) {
      let bits = pivBits[bi + w] as number;
      while (bits !== 0) {
        const low = bits & -bits;
        const t = (w << 5) + (31 - Math.clz32(low));
        ops.push(dr, denseD[inactRow[t] as number] as number, 1);
        bits ^= low;
      }
    }
  }

  // ---- column -> D row map and liveness pruning ----
  const rowCount = S + H + m;
  const colRow = new Int32Array(L).fill(-1);
  const live = new Uint8Array(rowCount);
  for (let c = 0; c < L; c++) {
    if (needed && !needed[c]) continue;
    const t = colInact[c] as number;
    const dr = t >= 0 ? (denseD[inactRow[t] as number] as number) : dRow(pivRow[colPivot[c] as number] as number);
    colRow[c] = dr;
    live[dr] = 1;
  }
  const all = ops.view();
  const keep = new Uint8Array(all.length / 3);
  let kept = 0;
  for (let o = all.length - 3; o >= 0; o -= 3) {
    const dst = all[o] as number;
    if (!live[dst]) continue;
    keep[o / 3] = 1;
    kept++;
    const src = all[o + 1] as number;
    if (src >= 0) live[src] = 1;
  }
  const pruned = new Int32Array(kept * 3);
  let w = 0;
  for (let o = 0; o < all.length; o += 3) {
    if (!keep[o / 3]) continue;
    pruned[w++] = all[o] as number;
    pruned[w++] = all[o + 1] as number;
    pruned[w++] = all[o + 2] as number;
  }
  return { rowCount, ops: pruned, colRow };
}

/**
 * Replay a plan on D, stored as `rowCount` consecutive symbols of `T` bytes in `slab`.
 */
export function applyPlan(plan: SolvePlan, slab: Uint8Array, T: number): void {
  if (slab.length < plan.rowCount * T) throw new RangeError("symbol slab is smaller than the plan's row count");
  const ops = plan.ops;
  const n = ops.length;
  const wordPath = (T & 3) === 0 && (slab.byteOffset & 3) === 0;
  const w32 = wordPath ? new Int32Array(slab.buffer, slab.byteOffset, (plan.rowCount * T) >>> 2) : null;
  const tw = T >>> 2;
  const MUL = GF256_MUL;
  for (let o = 0; o < n; o += 3) {
    const dst = ops[o] as number;
    const src = ops[o + 1] as number;
    const coef = ops[o + 2] as number;
    if (src < 0) {
      const base = coef << 8;
      const d0 = dst * T;
      for (let i = 0; i < T; i++) slab[d0 + i] = MUL[base | (slab[d0 + i] as number)] as number;
    } else if (coef === 1) {
      if (w32) {
        const d0 = dst * tw;
        const s0 = src * tw;
        for (let i = 0; i < tw; i++) w32[d0 + i] = (w32[d0 + i] as number) ^ (w32[s0 + i] as number);
      } else {
        const d0 = dst * T;
        const s0 = src * T;
        for (let i = 0; i < T; i++) slab[d0 + i] = (slab[d0 + i] as number) ^ (slab[s0 + i] as number);
      }
    } else {
      const base = coef << 8;
      const d0 = dst * T;
      const s0 = src * T;
      for (let i = 0; i < T; i++) slab[d0 + i] = (slab[d0 + i] as number) ^ (MUL[base | (slab[s0 + i] as number)] as number);
    }
  }
}
