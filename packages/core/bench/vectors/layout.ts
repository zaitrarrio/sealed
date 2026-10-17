import { QUIET_CELLS, ANCHOR_CELLS, ANCHOR_BANDS, anchorInteriorRuns, ANCHOR_INTERIOR_RUNS, ANCHOR_QUIET_SIDES, gridLayout, gridTierForSize, streamPosition, streamToCells, cellsToStream, cellsOfByte, type Corner } from "../../src/facet/layout";
import { Xorshift32 } from "../../src/facet/random";
import { b64, digits, fnv, print } from "./util";

const tier = Number(process.argv[2] ?? "1") as 1 | 2 | 3;
const l = gridLayout(tier);
const rng = new Xorshift32(1000 + tier);
const stream = Uint8Array.from({ length: l.streamBytes }, () => rng.next() & 0xff);
const cells = streamToCells(stream, l, new Xorshift32(77));
const back = cellsToStream(cells, l);
const noisy = Uint8Array.from(cells, (v) => (v + 1) & ((1 << l.bitsPerCell) - 1));
print({
  QUIET_CELLS,
  ANCHOR_CELLS,
  ANCHOR_BANDS,
  interiorRuns: [0, 1, 2, 3].map((c) => anchorInteriorRuns(c as Corner)),
  ANCHOR_INTERIOR_RUNS,
  ANCHOR_QUIET_SIDES,
  gridTierForSize: [0, 112, 144, 100].map((n) => gridTierForSize(n)),
  streamPosition: [0, 1, 34, 35, 36, 1000, 8924].map((j) => streamPosition(j, l.codewords)),
  cellsOfByte: [0, 1, 2, 3, 100, 8924].map((j) => cellsOfByte(j, l.bitsPerCell)),
  layout: {
    tier: l.tier,
    n: l.n,
    kind: digits(l.kind),
    anchorLight: digits(l.anchorLight),
    headerTop: Array.from(l.headerTop),
    headerBottom: Array.from(l.headerBottom),
    dataOrder: b64(Uint16Array.from(l.dataOrder)),
    anchorCenters: l.anchorCenters,
    bitsPerCell: l.bitsPerCell,
    codewords: l.codewords,
    cellsUsed: l.cellsUsed,
    streamBytes: l.streamBytes,
    systematicBytes: l.systematicBytes,
    symbolSize: l.symbolSize,
  },
  stream: b64(stream),
  cells: b64(cells),
  backEqualsStream: Buffer.from(back).equals(Buffer.from(stream)),
  noisyBackHash: fnv(cellsToStream(noisy, l)),
});
