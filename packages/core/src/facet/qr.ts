/// <reference path="./qrcode-core.d.ts" />
/**
 * T0 "Compatible" frames (spec §7.1, §7.3): a standard QR Code, error correction L, holding header (12 bytes,
 * same layout as the grid header but without RS(20,12) — QR has its own EC) ∥ payload (840 bytes: a RaptorQ
 * symbol, or a length-prefixed CBOR descriptor).
 *
 * The 852 frame bytes are written as Base45 text in one alphanumeric segment (QR version 21). Phone system
 * detectors (AVFoundation, ML Kit) and the web BarcodeDetector return only text, and do not round-trip binary
 * byte-mode payloads reliably; Base45 text does, so a receiver can use the platform's fast, rotation- and
 * position-independent QR detector instead of decoding camera frames itself. Readers also accept the original
 * byte-mode encoding (raw 852 bytes).
 */
import QRCodeCore from "qrcode/lib/core/qrcode.js";
import jsQR from "jsqr";
import type { RgbaImage } from "./types";
import { HEADER_BYTES } from "./header";
import { renderQrMatrix } from "./render";
import { TIERS } from "./tiers";
import { gaussianBlur } from "./glyphs";
import { base45Decode, base45Encode } from "./base45";

/** QR version of a T0 frame: v21-L holds 1352 alphanumeric characters; a frame is 1278. */
export const QR_VERSION = 21;
/** Bytes carried by every T0 frame. */
export const QR_FRAME_BYTES = HEADER_BYTES + TIERS[0].symbolSize;

/** The text content of one T0 frame (what a QR reader returns): Base45 of header ∥ payload. */
export function qrFrameText(header: Uint8Array, payload: Uint8Array): string {
  if (header.length !== HEADER_BYTES) throw new RangeError("header must be 12 bytes");
  if (payload.length > TIERS[0].symbolSize) throw new RangeError(`T0 payload exceeds ${TIERS[0].symbolSize} bytes`);
  const bytes = new Uint8Array(QR_FRAME_BYTES);
  bytes.set(header, 0);
  bytes.set(payload, HEADER_BYTES);
  return base45Encode(bytes);
}

/**
 * Frame bytes from what a QR reader returned: Base45 text (current senders) or the raw 852 bytes of a byte-mode
 * frame (earlier senders, readers that return bytes). Null if it is neither.
 */
export function qrFrameBytes(content: string | Uint8Array): Uint8Array | null {
  if (typeof content === "string") {
    const fromText = base45Decode(content);
    if (fromText && fromText.length === QR_FRAME_BYTES) return fromText;
    return null;
  }
  if (content.length === QR_FRAME_BYTES) return content;
  // A byte array that is really ASCII Base45 (some readers expose text as its bytes).
  if (content.length > QR_FRAME_BYTES && content.every((b) => b < 128)) return qrFrameBytes(String.fromCharCode(...content));
  return null;
}

/** QR module matrix for one T0 frame. */
export function qrMatrix(header: Uint8Array, payload: Uint8Array): { size: number; modules: Uint8Array } {
  const sym = QRCodeCore.create([{ data: qrFrameText(header, payload), mode: "alphanumeric" }], { errorCorrectionLevel: "L", version: QR_VERSION });
  return { size: sym.modules.size, modules: Uint8Array.from(sym.modules.data) };
}

export function renderQrFrame(header: Uint8Array, payload: Uint8Array, sizePx: number): RgbaImage {
  const m = qrMatrix(header, payload);
  return renderQrMatrix(m.modules, m.size, sizePx);
}

/**
 * Unsharp mask on luma (gray RGBA out). Camera optics blur QR modules beyond what jsQR's binarizer tolerates
 * (about σ = 0.25 module); restoring edge contrast first extends the usable blur range.
 */
function sharpened(image: RgbaImage, sigma: number, amount: number): Uint8ClampedArray {
  const { width: w, height: h, data: d } = image;
  const luma = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) luma[p] = 0.299 * (d[p * 4] as number) + 0.587 * (d[p * 4 + 1] as number) + 0.114 * (d[p * 4 + 2] as number);
  // Denoise slightly first so the mask sharpens edges rather than sensor noise.
  const smooth = gaussianBlur(luma, w, h, 0.8);
  const blurred = gaussianBlur(smooth, w, h, sigma);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const v = (smooth[p] as number) + amount * ((smooth[p] as number) - (blurred[p] as number));
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v;
    out[p * 4 + 3] = 255;
  }
  return out;
}

/** Decodes a QR code in the image; returns the frame bytes (Base45 decoded when applicable), or null. Never throws. */
export function readQr(image: RgbaImage): Uint8Array | null {
  try {
    const d = image.data;
    const clamped = d instanceof Uint8ClampedArray ? d : new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
    let r = jsQR(clamped, image.width, image.height, { inversionAttempts: "attemptBoth" });
    for (const [sigma, amount] of [
      [2, 1.5],
      [4, 2.5],
    ] as const) {
      if (r) break;
      r = jsQR(sharpened(image, sigma, amount), image.width, image.height, { inversionAttempts: "dontInvert" });
    }
    if (!r) return null;
    return qrFrameBytes(r.data) ?? Uint8Array.from(r.binaryData);
  } catch {
    return null;
  }
}
