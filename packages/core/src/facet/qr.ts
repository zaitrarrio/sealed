/// <reference path="./qrcode-core.d.ts" />
/**
 * T0 "Compatible" frames (spec §7.1, §7.3): standard QR Code version 20, error correction L, one byte-mode
 * segment holding header (12 bytes, same layout as the grid header but without RS(20,12) — QR has its own EC)
 * ∥ payload (840 bytes: a RaptorQ symbol, or a length-prefixed CBOR descriptor). Any QR decoder can read them.
 */
import QRCodeCore from "qrcode/lib/core/qrcode";
import jsQR from "jsqr";
import type { RgbaImage } from "./types";
import { HEADER_BYTES } from "./header";
import { renderQrMatrix } from "./render";
import { TIERS } from "./tiers";

export const QR_VERSION = 20;
/** Bytes carried by every T0 frame. QR v20-L holds 858 bytes in byte mode. */
export const QR_FRAME_BYTES = HEADER_BYTES + TIERS[0].symbolSize;

/** QR module matrix for one T0 frame. */
export function qrMatrix(header: Uint8Array, payload: Uint8Array): { size: number; modules: Uint8Array } {
  if (header.length !== HEADER_BYTES) throw new RangeError("header must be 12 bytes");
  if (payload.length > TIERS[0].symbolSize) throw new RangeError(`T0 payload exceeds ${TIERS[0].symbolSize} bytes`);
  const bytes = new Uint8Array(QR_FRAME_BYTES);
  bytes.set(header, 0);
  bytes.set(payload, HEADER_BYTES);
  const sym = QRCodeCore.create([{ data: bytes, mode: "byte" }], { errorCorrectionLevel: "L", version: QR_VERSION });
  return { size: sym.modules.size, modules: Uint8Array.from(sym.modules.data) };
}

export function renderQrFrame(header: Uint8Array, payload: Uint8Array, sizePx: number): RgbaImage {
  const m = qrMatrix(header, payload);
  return renderQrMatrix(m.modules, m.size, sizePx);
}

/** Decodes a QR code in the image; returns its raw bytes, or null. Never throws. */
export function readQr(image: RgbaImage): Uint8Array | null {
  try {
    const d = image.data;
    const clamped = d instanceof Uint8ClampedArray ? d : new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
    const r = jsQR(clamped, image.width, image.height, { inversionAttempts: "attemptBoth" });
    if (!r) return null;
    return Uint8Array.from(r.binaryData);
  } catch {
    return null;
  }
}
