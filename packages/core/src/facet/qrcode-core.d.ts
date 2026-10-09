/**
 * Types for the platform-neutral core of `qrcode` (1.5.x). Facet imports `qrcode/lib/core/qrcode` directly
 * instead of the package entry, whose Node build pulls in fs/png renderers that do not exist in browsers,
 * Workers or Hermes.
 */
declare module "qrcode/lib/core/qrcode.js" {
  export interface QrBitMatrix {
    readonly size: number;
    /** size × size modules, row-major, 1 = dark. */
    readonly data: Uint8Array;
  }
  export interface QrSymbol {
    readonly modules: QrBitMatrix;
    readonly version: number;
  }
  export interface QrByteSegment {
    data: Uint8Array;
    mode: "byte";
  }
  export interface QrCreateOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    version?: number;
    maskPattern?: number;
  }
  const QRCodeCore: {
    create(data: readonly QrByteSegment[], options?: QrCreateOptions): QrSymbol;
  };
  export default QRCodeCore;
}
