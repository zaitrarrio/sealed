import { PIC_BG, PIC_WHITE, PIC_GRAY_BASE, frameRng, frameMask, encodeStream, encodeDataCells, paddingCells, stripBits, dataPicture, calibrationPicture, streamCells, cellsStream, type FrameIdentity } from "../../src/facet/grid";
import { gridLayout } from "../../src/facet/layout";
import { encodeFrameHeader } from "../../src/facet/header";
import { Xorshift32 } from "../../src/facet/random";
import { b64, bytes, fnv, print } from "./util";

const tier = Number(process.argv[2] ?? "1") as 1 | 2 | 3;
const l = gridLayout(tier);
const rng = new Xorshift32(2000 + tier);
const rand = (n: number) => Uint8Array.from({ length: n }, () => rng.next() & 0xff);
const id: FrameIdentity = { streamId: Uint8Array.from([0xe1, 0xcb, 0x88, 0x16]), tier, type: "data", sbn: 3, esi: 0x010203 };
const payload = rand(l.symbolSize - 100); // shorter than T: exercises the zero fill
const header = encodeFrameHeader({ tier, type: "data", loop: true, signed: false, streamId: id.streamId, sbn: id.sbn, esi: id.esi }, payload);
const calHeader = encodeFrameHeader({ tier, type: "calibration", loop: false, signed: false, streamId: id.streamId, sbn: 0, esi: 0 }, new Uint8Array(0));
const fr = frameRng(id);
const { mask, padding } = frameMask(l, id);
const stream = encodeStream(l, payload, mask);
const cells = encodeDataCells(l, id, payload);
const pad = paddingCells(l, id);
const sb = stripBits(l, header);
const pic = dataPicture(l, header, id, payload);
const calPic = calibrationPicture(l, calHeader);
const sc = streamCells(l, stream);
const cs = cellsStream(l, cells);
print({
  PIC_BG,
  PIC_WHITE,
  PIC_GRAY_BASE,
  id: { ...id, streamId: bytes(id.streamId) },
  frameRng: Array.from({ length: 8 }, () => fr.next()),
  paddingNext: Array.from({ length: 8 }, () => padding.next()),
  payload: b64(payload),
  header: bytes(header),
  calHeader: bytes(calHeader),
  mask: b64(mask),
  stream: b64(stream),
  cells: b64(cells),
  paddingCells: b64(pad),
  stripBits: Array.from(sb).join(""),
  picture: tier === 3 ? null : b64(pic),
  pictureHash: fnv(pic),
  calibrationPicture: tier === 3 ? null : b64(calPic),
  calibrationPictureHash: fnv(calPic),
  streamCellsIsPrefixOfCells: Buffer.from(sc).equals(Buffer.from(cells.subarray(0, l.cellsUsed))),
  cellsStreamEqualsStream: Buffer.from(cs).equals(Buffer.from(stream)),
});
