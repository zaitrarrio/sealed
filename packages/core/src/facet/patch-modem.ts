/**
 * Patch Modem ("Packet Grid") — Alternative Monochrome Optical Modem
 *
 * Implements the methodology from the Engineering Proposal (21 Oct 2026):
 * 1. Monochrome Spatial Modulation: strictly binary cells (black/white) for maximum SNR and zero color confusion.
 * 2. Independent Spatial Patches: divides the active display area into self-contained patches/packets.
 * 3. Glare-to-Erasures: local reference cells calibrate black/white levels per patch; washed-out patches are
 *    marked as erasures without invalidating the rest of the frame.
 * 4. Mixed Display Update Recovery: each patch carries a local epoch timing pilot so rolling-shutter torn frames
 *    yield valid packets from both display updates.
 * 5. Spatial Interleaving: packet symbols cycle across patch positions over time so static reflections do not
 *    block any part of the stream.
 * 6. Fountain Coding: systematic RaptorQ blocks fed by individual valid patch packets.
 */
import { crc16CcittFalse } from "./header";
import { ANCHOR_CELLS, ANCHOR_BANDS, type Corner } from "./layout";
import { cellSizeFor } from "./render";
import { BACKGROUND } from "./palette";
import { homographyFrom4, project, type Homography } from "./homography";
import { sampleLuma, type LumaPlane } from "./detect";
import type { RgbaImage } from "./types";
import type { NativePixelFormat } from "./native";

/** Total grid side N (cells). Matches standard 112x112 layout for full compatibility with native/SIMD anchors. */
export const PATCH_GRID_N = 112;

/** Patch layout: 4 rows × 4 columns = 16 independent patches per frame. */
export const PATCH_ROWS = 4;
export const PATCH_COLS = 4;
export const TOTAL_PATCHES = PATCH_ROWS * PATCH_COLS; // 16

/** Margin inside the anchor boundary (cells): active data spans 8..104 (96 cells wide & high). */
export const ACTIVE_START = 8;
export const ACTIVE_SIZE = 96;

/** Each patch is 24 × 24 cells. */
export const PATCH_CELLS = ACTIVE_SIZE / PATCH_ROWS; // 24

/** Payload bytes per patch symbol. 48 bytes = 384 bits (multiple of 8 for RaptorQ alignment). */
export const PATCH_PAYLOAD_BYTES = 48;

/** Header: epoch (2 bits), patchId (6 bits), SBN (8 bits), ESI (16 bits), len (8 bits) = 40 bits = 5 bytes. */
export const PATCH_HEADER_BYTES = 5;

/** Minimum luminance contrast (W - B) required to consider a patch non-glared. */
export const MIN_PATCH_CONTRAST = 0.05;

export type PatchType = "data" | "descriptor" | "end";

export interface PatchPacket {
  epoch: number;
  type?: PatchType;
  patchId: number;
  sbn: number;
  esi: number;
  payload: Uint8Array;
}

export interface PatchDecodeResult {
  validPackets: PatchPacket[];
  erasureCount: number;
  crcErrors: number;
  totalPatches: number;
}

/** Precomputed coordinate bounds for a patch (r, c) within the 112×112 grid. */
export interface PatchBounds {
  patchId: number;
  r: number;
  c: number;
  x0: number;
  y0: number;
  size: number;
}

export function getPatchBounds(patchId: number): PatchBounds {
  const r = Math.floor(patchId / PATCH_COLS);
  const c = patchId % PATCH_COLS;
  const x0 = ACTIVE_START + c * PATCH_CELLS;
  const y0 = ACTIVE_START + r * PATCH_CELLS;
  return { patchId, r, c, x0, y0, size: PATCH_CELLS };
}

/**
 * Encodes a patch packet into a 24×24 binary bit matrix (1 = white, 0 = black).
 *
 * Layout inside each 24×24 patch:
 * - Perimeter (1-cell border): alternating reference pilot cells for local contrast estimation:
 *   Top & bottom: [W, B, W, B...]
 *   Left & right: [B, W, B, W...]
 * - Interior (22×22 = 484 cells):
 *   - 40 bits (5 bytes) header
 *   - 416 bits (52 bytes) payload
 *   - 16 bits (2 bytes) CRC-16
 *   - 12 bits padding
 */
export function encodePatchBits(packet: PatchPacket): Uint8Array {
  const bits = new Uint8Array(PATCH_CELLS * PATCH_CELLS);

  // 1. Perimeter reference cells
  for (let x = 0; x < PATCH_CELLS; x++) {
    bits[0 * PATCH_CELLS + x] = x % 2 === 0 ? 1 : 0; // top border
    bits[(PATCH_CELLS - 1) * PATCH_CELLS + x] = x % 2 === 1 ? 1 : 0; // bottom border
  }
  for (let y = 1; y < PATCH_CELLS - 1; y++) {
    bits[y * PATCH_CELLS + 0] = y % 2 === 1 ? 1 : 0; // left border
    bits[y * PATCH_CELLS + (PATCH_CELLS - 1)] = y % 2 === 0 ? 1 : 0; // right border
  }

  // 2. Header bytes (5 bytes)
  const header = new Uint8Array(PATCH_HEADER_BYTES);
  const typeCode = packet.type === "descriptor" ? 1 : packet.type === "end" ? 2 : 0;
  header[0] = ((packet.epoch & 0x03) << 6) | ((typeCode & 0x03) << 4) | (packet.patchId & 0x0f);
  header[1] = packet.sbn & 0xff;
  header[2] = (packet.esi >> 8) & 0xff;
  header[3] = packet.esi & 0xff;
  header[4] = packet.payload.length & 0xff;

  // 3. CRC-16 (2 bytes) over header and payload
  const crc = crc16CcittFalse(header, packet.payload);

  // 4. Assemble interior bitstream
  const interiorBytes = new Uint8Array(PATCH_HEADER_BYTES + packet.payload.length + 2);
  interiorBytes.set(header, 0);
  interiorBytes.set(packet.payload, PATCH_HEADER_BYTES);
  interiorBytes[PATCH_HEADER_BYTES + packet.payload.length] = (crc >> 8) & 0xff;
  interiorBytes[PATCH_HEADER_BYTES + packet.payload.length + 1] = crc & 0xff;

  let bitIdx = 0;
  for (let i = 0; i < interiorBytes.length; i++) {
    const b = interiorBytes[i] as number;
    for (let bit = 7; bit >= 0; bit--) {
      const val = (b >> bit) & 1;
      const ix = 1 + (bitIdx % (PATCH_CELLS - 2));
      const iy = 1 + Math.floor(bitIdx / (PATCH_CELLS - 2));
      if (iy < PATCH_CELLS - 1) {
        bits[iy * PATCH_CELLS + ix] = val;
      }
      bitIdx++;
    }
  }

  return bits;
}

/**
 * Renders the full 112×112 monochrome packet grid onto an RGBA image buffer.
 *
 * Includes:
 * - Pure black quiet zone
 * - 4 rotation-invariant corner concentric ring anchors
 * - 16 independent patches
 */
export function renderPatchField(packets: PatchPacket[], sizePx: number): RgbaImage {
  const n = PATCH_GRID_N;
  const grid = new Uint8Array(n * n); // 0 = black, 1 = white

  // 1. Draw the 4 corner anchors (8x8 concentric rings with distinct band signatures)
  drawAnchors(grid, n);

  // 2. Draw each patch into its designated bounds
  for (const pkt of packets) {
    if (pkt.patchId >= TOTAL_PATCHES) continue;
    const b = getPatchBounds(pkt.patchId);
    const pbits = encodePatchBits(pkt);
    for (let py = 0; py < PATCH_CELLS; py++) {
      for (let px = 0; px < PATCH_CELLS; px++) {
        grid[(b.y0 + py) * n + (b.x0 + px)] = pbits[py * PATCH_CELLS + px] as number;
      }
    }
  }

  // 3. Rasterize to RGBA with integer cell size and standard quiet zone
  const out = new Uint8ClampedArray(sizePx * sizePx * 4);
  const cell = Math.max(1, cellSizeFor(sizePx, n));
  const origin = Math.max(0, Math.floor((sizePx - n * cell) / 2));

  // Fill entire background with near-black (#0B0908) quiet zone
  for (let i = 0; i < sizePx * sizePx; i++) {
    const o = i * 4;
    out[o] = BACKGROUND[0];
    out[o + 1] = BACKGROUND[1];
    out[o + 2] = BACKGROUND[2];
    out[o + 3] = 255;
  }

  for (let gy = 0; gy < n; gy++) {
    const y0 = origin + gy * cell;
    if (y0 >= sizePx) break;
    for (let gx = 0; gx < n; gx++) {
      const x0 = origin + gx * cell;
      if (x0 >= sizePx) break;
      const isWhite = grid[gy * n + gx] === 1;
      const r = isWhite ? 255 : BACKGROUND[0];
      const g = isWhite ? 255 : BACKGROUND[1];
      const b = isWhite ? 255 : BACKGROUND[2];
      const maxPy = Math.min(cell, sizePx - y0);
      const maxPx = Math.min(cell, sizePx - x0);
      for (let py = 0; py < maxPy; py++) {
        let o = ((y0 + py) * sizePx + x0) * 4;
        for (let px = 0; px < maxPx; px++, o += 4) {
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
        }
      }
    }
  }

  return { width: sizePx, height: sizePx, data: out };
}

/** Draws standard Facet rotation-invariant concentric square ring anchors in the 4 corners. */
function drawAnchors(grid: Uint8Array, n: number): void {
  const corners: [number, number, Corner][] = [
    [0, 0, 0], // TL
    [n - ANCHOR_CELLS, 0, 1], // TR
    [n - ANCHOR_CELLS, n - ANCHOR_CELLS, 2], // BR
    [0, n - ANCHOR_CELLS, 3], // BL
  ];

  for (const [x0, y0, c] of corners) {
    const bands = ANCHOR_BANDS[c];
    if (!bands) continue;
    for (let dy = 0; dy < ANCHOR_CELLS; dy++) {
      for (let dx = 0; dx < ANCHOR_CELLS; dx++) {
        // Distance from anchor center in cells (max norm)
        const d = Math.max(Math.abs(dx - 3.5), Math.abs(dy - 3.5));
        let ring = 0;
        if (d <= 1.0) ring = 3;
        else if (d <= 2.0) ring = 2;
        else if (d <= 3.0) ring = 1;
        else ring = 0;

        const isLight = ring === 0 || (ring <= 3 && bands[ring] === 1);
        grid[(y0 + dy) * n + (x0 + dx)] = isLight ? 1 : 0;
      }
    }
  }
}

/**
 * Decodes all patches from a camera luma plane given the estimated homography.
 *
 * Implements:
 * - Local reference cell sampling
 * - Glare detection & erasure handling
 * - Local threshold binarization
 * - Header decoding and CRC-16 verification
 * - Mixed display update acceptance
 */
export function decodePatchField(luma: LumaPlane, h: Homography): PatchDecodeResult {
  const validPackets: PatchPacket[] = [];
  let erasureCount = 0;
  let crcErrors = 0;

  for (let pid = 0; pid < TOTAL_PATCHES; pid++) {
    const b = getPatchBounds(pid);

    // 1. Measure local white and black levels from all 4 perimeter reference borders
    let whiteAcc = 0;
    let whiteCount = 0;
    let blackAcc = 0;
    let blackCount = 0;

    const samplePilot = (gx: number, gy: number, isWhite: boolean) => {
      const [u, v] = project(h, b.x0 + gx + 0.5, b.y0 + gy + 0.5);
      const s = sampleLuma(luma, u, v);
      if (Number.isFinite(s)) {
        if (isWhite) {
          whiteAcc += s;
          whiteCount++;
        } else {
          blackAcc += s;
          blackCount++;
        }
      }
    };

    // Top border (y = 0): even = white, odd = black
    for (let px = 0; px < PATCH_CELLS; px++) {
      samplePilot(px, 0, px % 2 === 0);
    }
    // Bottom border (y = PATCH_CELLS - 1): even = black, odd = white
    for (let px = 0; px < PATCH_CELLS; px++) {
      samplePilot(px, PATCH_CELLS - 1, px % 2 === 1);
    }
    // Left border (x = 0): odd = white, even = black (interior points)
    for (let py = 1; py < PATCH_CELLS - 1; py++) {
      samplePilot(0, py, py % 2 === 1);
    }
    // Right border (x = PATCH_CELLS - 1): even = white, odd = black (interior points)
    for (let py = 1; py < PATCH_CELLS - 1; py++) {
      samplePilot(PATCH_CELLS - 1, py, py % 2 === 0);
    }

    if (whiteCount < 8 || blackCount < 8) {
      erasureCount++;
      continue;
    }

    const localWhite = whiteAcc / whiteCount;
    const localBlack = blackAcc / blackCount;
    const contrast = localWhite - localBlack;

    // 2. Glare erasure check: if local contrast is too low, screen reflection/glare has washed it out
    if (contrast < MIN_PATCH_CONTRAST) {
      erasureCount++;
      continue;
    }

    // 3. Local threshold for this patch
    const localThreshold = (localWhite + localBlack) / 2;

    // 4. Sample interior cells (22×22 = 484 cells)
    const expectedBytes = PATCH_HEADER_BYTES + PATCH_PAYLOAD_BYTES + 2;
    const totalBitsNeeded = expectedBytes * 8;
    const interiorBytes = new Uint8Array(expectedBytes);

    let bitIdx = 0;
    for (let bytePos = 0; bytePos < expectedBytes; bytePos++) {
      let byteVal = 0;
      for (let bit = 7; bit >= 0; bit--) {
        const ix = 1 + (bitIdx % (PATCH_CELLS - 2));
        const iy = 1 + Math.floor(bitIdx / (PATCH_CELLS - 2));
        const [u, v] = project(h, b.x0 + ix + 0.5, b.y0 + iy + 0.5);
        const lum = sampleLuma(luma, u, v);
        if (Number.isFinite(lum) && lum > localThreshold) {
          byteVal |= 1 << bit;
        }
        bitIdx++;
      }
      interiorBytes[bytePos] = byteVal;
    }

    // 5. Unpack header
    const headerByte0 = interiorBytes[0] as number;
    const epoch = (headerByte0 >> 6) & 0x03;
    const typeCode = (headerByte0 >> 4) & 0x03;
    const decodedPatchId = headerByte0 & 0x0f;
    const type: PatchType = typeCode === 1 ? "descriptor" : typeCode === 2 ? "end" : "data";
    const sbn = interiorBytes[1] as number;
    const esi = ((interiorBytes[2] as number) << 8) | (interiorBytes[3] as number);
    const len = interiorBytes[4] as number;

    if (decodedPatchId !== pid || len !== PATCH_PAYLOAD_BYTES) {
      crcErrors++;
      continue;
    }

    // 6. Verify CRC-16
    const header = interiorBytes.subarray(0, PATCH_HEADER_BYTES);
    const payload = interiorBytes.subarray(PATCH_HEADER_BYTES, PATCH_HEADER_BYTES + len);
    const receivedCrc =
      ((interiorBytes[PATCH_HEADER_BYTES + len] as number) << 8) |
      (interiorBytes[PATCH_HEADER_BYTES + len + 1] as number);

    const calculatedCrc = crc16CcittFalse(header, payload);
    if (receivedCrc !== calculatedCrc) {
      crcErrors++;
      continue;
    }

    // Valid packet recovered!
    validPackets.push({
      epoch,
      type,
      patchId: pid,
      sbn,
      esi,
      payload: Uint8Array.from(payload),
    });
  }

  return {
    validPackets,
    erasureCount,
    crcErrors,
    totalPatches: TOTAL_PATCHES,
  };
}

/**
 * Converts a raw camera buffer (BGRA/RGBA/RGB with row padding) to an RgbaImage,
 * optionally box-downsampling to maxSide for fast JavaScript anchor and patch processing.
 */
export function rawToRgba(
  src: Uint8Array,
  width: number,
  height: number,
  stride: number,
  format: NativePixelFormat,
  maxSide = 960,
): RgbaImage {
  const f = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const bpp = format === "rgb" ? 3 : 4;
  const [ri, gi, bi] = format === "bgra" ? [2, 1, 0] : [0, 1, 2];
  const out = new Uint8ClampedArray(w * h * 4);

  if (f === 1) {
    for (let y = 0; y < h; y++) {
      let p = y * stride;
      let o = y * w * 4;
      for (let x = 0; x < w; x++) {
        out[o] = src[p + ri] as number;
        out[o + 1] = src[p + gi] as number;
        out[o + 2] = src[p + bi] as number;
        out[o + 3] = 255;
        p += bpp;
        o += 4;
      }
    }
    return { width: w, height: h, data: out };
  }

  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = (y * f + dy) * stride + x * f * bpp;
        for (let dx = 0; dx < f; dx++) {
          r += src[p + ri] as number;
          g += src[p + gi] as number;
          b += src[p + bi] as number;
          p += bpp;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
