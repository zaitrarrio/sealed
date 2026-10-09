/**
 * Facet grid geometry (spec §7.2) and the mapping between frame payload bytes and cells (spec §7.4, §7.5).
 *
 * Coordinates: cell (x, y) covers [x, x+1] × [y, y+1] in grid units; the grid spans [0, N]² and is surrounded by
 * a quiet zone of QUIET_CELLS background cells.
 *
 * Anchors (8 × 8 cells at each corner) are concentric square bands one cell wide. Band d (Chebyshev distance d
 * from the anchor's outer edge, d = 0..3; band 3 is the central 2 × 2) is light or dark per ANCHOR_BANDS. The
 * outer two bands are always light, dark; the inner two identify the corner.
 *
 * Deviation from spec §7.2 ("ring count 3/4/5/6"): six rings inside an 8-cell anchor need bands ≤ 0.36 cells
 * wide, which a camera blur of σ ≥ 0.25 cell erases (contrast < 3%). Facet keeps 8 × 8 concentric-square
 * anchors with one-cell bands and identifies the corner by the run pattern *between* the two band-0 squares,
 * which is visible even where band 0 merges with the adjacent data region:
 *   TL  D1 L4 D1        TR  D1 L1 D2 L1 D1        BR  D2 L2 D2        BL  D6
 * Along any line through the center of concentric squares the run lengths scale uniformly, so the ratios hold
 * under rotation and perspective. TL has a 4 × 4 light center that receivers use as their white reference.
 */
import type { Tier } from "./types";
import { TIERS, type GridTier } from "./tiers";
import { Xorshift32, seedFrom, shuffleInPlace } from "./random";
import { GRAY_RAMP } from "./palette";

export const QUIET_CELLS = 2;
export const ANCHOR_CELLS = 8;

export type Corner = 0 | 1 | 2 | 3; // TL, TR, BR, BL
export const CORNER_NAMES = ["TL", "TR", "BR", "BL"] as const;

/** Light (1) / dark (0) for bands 0 (outer) … 3 (center 2 × 2), per corner. */
export const ANCHOR_BANDS: readonly (readonly [number, number, number, number])[] = [
  [1, 0, 1, 1], // TL
  [1, 0, 1, 0], // TR
  [1, 0, 0, 1], // BR
  [1, 0, 0, 0], // BL
];

/**
 * Run lengths (in cells) of the 6-cell interior between the two band-0 squares along a line through the center.
 * The interior always starts and ends dark and alternates dark/light.
 */
export function anchorInteriorRuns(corner: Corner): number[] {
  const b = ANCHOR_BANDS[corner] as readonly number[];
  const seq = [b[1], b[2], b[3], b[3], b[2], b[1]] as number[];
  const runs: number[] = [];
  let prev = -1;
  for (const v of seq) {
    if (v === prev) runs[runs.length - 1] = (runs[runs.length - 1] as number) + 1;
    else runs.push(1);
    prev = v;
  }
  return runs;
}

/** Interior run templates indexed by corner. */
export const ANCHOR_INTERIOR_RUNS: readonly (readonly number[])[] = [0, 1, 2, 3].map((c) => anchorInteriorRuns(c as Corner));

/** Which sides of each anchor face the quiet zone: [x side (-1 or +1), y side (-1 or +1)]. */
export const ANCHOR_QUIET_SIDES: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export const enum CellKind {
  Data = 0,
  Anchor = 1,
  HeaderTop = 2,
  HeaderBottom = 3,
}

export interface GridLayout {
  readonly tier: GridTier;
  readonly n: number;
  /** CellKind per cell, index y * n + x. */
  readonly kind: Uint8Array;
  /** Anchor cells: 1 light, 0 dark (0 for non-anchor cells). */
  readonly anchorLight: Uint8Array;
  /** Header strip cells in bit order (row-major within the strip). */
  readonly headerTop: Int32Array;
  readonly headerBottom: Int32Array;
  /** Data cells in the tier's fixed pseudo-random permutation order. */
  readonly dataOrder: Int32Array;
  /** Anchor centers in grid units, by corner. */
  readonly anchorCenters: readonly (readonly [number, number])[];
  readonly bitsPerCell: number;
  readonly codewords: number;
  /** Cells that carry codeword bits (the rest of `dataOrder` is padding). */
  readonly cellsUsed: number;
  /** Bytes in the interleaved codeword stream (codewords × 255). */
  readonly streamBytes: number;
  /** Systematic bytes (codewords × 207); the payload occupies the first T of them. */
  readonly systematicBytes: number;
  readonly symbolSize: number;
}

const cache = new Map<GridTier, GridLayout>();

export function gridLayout(tier: GridTier): GridLayout {
  const hit = cache.get(tier);
  if (hit) return hit;
  const spec = TIERS[tier];
  const n = spec.grid;
  const kind = new Uint8Array(n * n);
  const anchorLight = new Uint8Array(n * n);
  const origins: [number, number][] = [
    [0, 0],
    [n - ANCHOR_CELLS, 0],
    [n - ANCHOR_CELLS, n - ANCHOR_CELLS],
    [0, n - ANCHOR_CELLS],
  ];
  origins.forEach(([ox, oy], corner) => {
    const bands = ANCHOR_BANDS[corner] as readonly number[];
    for (let ay = 0; ay < ANCHOR_CELLS; ay++) {
      for (let ax = 0; ax < ANCHOR_CELLS; ax++) {
        const d = Math.min(ax, ANCHOR_CELLS - 1 - ax, ay, ANCHOR_CELLS - 1 - ay);
        const idx = (oy + ay) * n + ox + ax;
        kind[idx] = CellKind.Anchor;
        anchorLight[idx] = bands[d] as number;
      }
    }
  });
  const top: number[] = [];
  const bottom: number[] = [];
  for (let r = 0; r < 2; r++) {
    for (let x = 9; x <= n - 10; x++) {
      const t = r * n + x;
      const b = (n - 2 + r) * n + x;
      kind[t] = CellKind.HeaderTop;
      kind[b] = CellKind.HeaderBottom;
      top.push(t);
      bottom.push(b);
    }
  }
  const data: number[] = [];
  for (let i = 0; i < n * n; i++) if (kind[i] === CellKind.Data) data.push(i);
  const dataOrder = Int32Array.from(data);
  shuffleInPlace(dataOrder, new Xorshift32(seedFrom(new TextEncoder().encode("facet/v1/cells"), tier)));

  const bpc = spec.bitsPerCell;
  const streamBytes = spec.codewords * spec.rsN;
  const cellsUsed = Math.ceil((streamBytes * 8) / bpc);
  if (cellsUsed > dataOrder.length) throw new Error(`tier ${tier}: ${cellsUsed} cells needed, ${dataOrder.length} available`);
  if (spec.codewords * spec.rsK < spec.symbolSize) throw new Error(`tier ${tier}: symbol does not fit the codewords`);
  const half = ANCHOR_CELLS / 2;
  const layout: GridLayout = {
    tier,
    n,
    kind,
    anchorLight,
    headerTop: Int32Array.from(top),
    headerBottom: Int32Array.from(bottom),
    dataOrder,
    anchorCenters: [
      [half, half],
      [n - half, half],
      [n - half, n - half],
      [half, n - half],
    ],
    bitsPerCell: bpc,
    codewords: spec.codewords,
    cellsUsed,
    streamBytes,
    systematicBytes: spec.codewords * spec.rsK,
    symbolSize: spec.symbolSize,
  };
  cache.set(tier, layout);
  return layout;
}

export function gridTierForSize(n: number): GridTier[] {
  return ([1, 2, 3] as const).filter((t) => TIERS[t].grid === n);
}

export function isGridTier(t: Tier): t is GridTier {
  return t === 1 || t === 2 || t === 3;
}

/**
 * Codeword stream byte j belongs to codeword j mod C at position floor(j / C), so the first C·207 stream bytes are
 * the (zero-filled) payload in order and adjacent bytes always belong to different codewords.
 */
export function streamPosition(j: number, codewords: number): { codeword: number; position: number } {
  return { codeword: j % codewords, position: Math.floor(j / codewords) };
}

/** Packs the codeword stream into cell values (color bits most significant), in permutation order. */
export function streamToCells(stream: Uint8Array, layout: GridLayout, padding: Xorshift32): Uint8Array {
  const bpc = layout.bitsPerCell;
  const out = new Uint8Array(layout.dataOrder.length);
  const totalBits = layout.streamBytes * 8;
  let bit = 0;
  for (let c = 0; c < out.length; c++) {
    let v = 0;
    for (let b = 0; b < bpc; b++, bit++) {
      const value = bit < totalBits ? ((stream[bit >> 3] as number) >> (7 - (bit & 7))) & 1 : padding.next() & 1;
      v = (v << 1) | value;
    }
    out[c] = v;
  }
  return out;
}

/** Inverse of streamToCells for the used cells. */
export function cellsToStream(cells: Uint8Array, layout: GridLayout): Uint8Array {
  const bpc = layout.bitsPerCell;
  const out = new Uint8Array(layout.streamBytes);
  const totalBits = layout.streamBytes * 8;
  let bit = 0;
  for (let c = 0; c < layout.cellsUsed; c++) {
    const v = cells[c] as number;
    for (let b = bpc - 1; b >= 0 && bit < totalBits; b--, bit++) {
      if ((v >> b) & 1) out[bit >> 3] = (out[bit >> 3] as number) | (0x80 >> (bit & 7));
    }
  }
  return out;
}

/** Cells (indices into the permutation order) that hold bits of stream byte j. */
export function cellsOfByte(j: number, bpc: number): [number, number] {
  return [Math.floor((8 * j) / bpc), Math.floor((8 * j + 7) / bpc)];
}

/** Calibration frame content (spec §7.5): gray ramp patches plus every palette color in every shape. */
export interface CalibrationLayout {
  /** Symbol (color · 16 + shape) per data cell, index y * n + x; -1 for ramp cells and non-data cells. */
  readonly symbols: Int16Array;
  /** Gray level index into GRAY_RAMP per cell (-1 when not a ramp cell). */
  readonly ramp: Int8Array;
  /** Center cell index of each ramp patch, and its gray level index. */
  readonly rampCenters: readonly { cell: number; level: number }[];
}

const calCache = new Map<GridTier, CalibrationLayout>();
export const RAMP_PATCH = 3;

export function calibrationLayout(tier: GridTier): CalibrationLayout {
  const hit = calCache.get(tier);
  if (hit) return hit;
  const layout = gridLayout(tier);
  const n = layout.n;
  const colors = TIERS[tier].colors;
  const symbols = new Int16Array(n * n).fill(-1);
  const ramp = new Int8Array(n * n).fill(-1);
  const centers: { cell: number; level: number }[] = [];
  const rows = [Math.round(n * 0.27), Math.round(n * 0.7)];
  rows.forEach((row, band) => {
    GRAY_RAMP.forEach((_, level) => {
      // The second band runs the ramp in reverse so each level appears at two distinct positions.
      const slot = band === 0 ? level : GRAY_RAMP.length - 1 - level;
      const x0 = 10 + slot * 8;
      for (let dy = 0; dy < RAMP_PATCH; dy++) {
        for (let dx = 0; dx < RAMP_PATCH; dx++) {
          const idx = (row + dy) * n + x0 + dx;
          if (layout.kind[idx] !== CellKind.Data) throw new Error("ramp patch overlaps a reserved cell");
          ramp[idx] = level;
        }
      }
      centers.push({ cell: (row + 1) * n + x0 + 1, level });
    });
  });
  const rng = new Xorshift32(seedFrom(new TextEncoder().encode("facet/v1/calibration"), tier));
  for (let i = 0; i < n * n; i++) {
    if (layout.kind[i] === CellKind.Data && ramp[i] === -1) symbols[i] = rng.below(colors * 16);
  }
  const cal: CalibrationLayout = { symbols, ramp, rampCenters: centers };
  calCache.set(tier, cal);
  return cal;
}
