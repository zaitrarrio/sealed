/**
 * Public contract of the Facet optical codec (spec §7, ADR-0008–0010). UI layers (web canvas, React Native)
 * depend only on these types; the implementation lives alongside in this folder.
 */

export type Tier = 0 | 1 | 2 | 3;

/** An RGBA image, 4 bytes per pixel, row-major, as produced by canvas getImageData or a camera frame. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** A luma-only image (Y plane) for decoders that do not need color, e.g. T0 QR or header strips. */
export interface LumaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type FrameType = "calibration" | "descriptor" | "data" | "end";

/** One frame ready to show; `pixels` is rendered at the requested size by `renderFrame`. */
export interface FacetFrame {
  tier: Tier;
  type: FrameType;
  /** Number of display refreshes (at 60 Hz) to hold this frame; double on 120 Hz displays. */
  holdRefreshes: number;
  sequence: number;
}

/** Decoded stream descriptor (spec §7.5): everything a receiver needs besides the data frames. */
export interface StreamDescriptor {
  streamId: Uint8Array; // 4 bytes
  tier: Tier;
  /** RaptorQ object transmission information, encoded (12 bytes). */
  oti: Uint8Array;
  /** Air-gap secure: sender agreement public key and HPKE wrap of the CEK to the receiver. */
  senderPublicKey?: Uint8Array;
  wrap?: Uint8Array;
  /** Broadcast (open): the CEK in clear. */
  cek?: Uint8Array;
  /** Publisher identity for signed broadcasts. */
  publisherFingerprint?: Uint8Array;
  publisherSigningKey?: Uint8Array;
  /** Signature (type "broadcast") over {stream_id, oti, manifest digest}. */
  signature?: Uint8Array;
  /** SHA-256 of the Envelope's manifest part, bound by the signature. */
  manifestDigest?: Uint8Array;
  /**
   * The Envelope's manifest part (header ∥ sealed manifest), when it fits in a descriptor frame, so a receiver
   * can show file names before the data completes (spec §6.5 step 4).
   */
  manifestPart?: Uint8Array;
  /** Sender's display label (Air-gap without a device identity; otherwise the signed manifest carries it). */
  senderLabel?: string;
}

export interface ReceiveProgress {
  streamId: Uint8Array | null;
  tier: Tier | null;
  framesSeen: number;
  framesDecoded: number;
  symbolsReceived: number;
  symbolsNeeded: number;
  blocksComplete: number;
  blockCount: number;
  /** 0–1 estimate of completion. */
  fraction: number;
  /** Bytes per symbol of the stream being decoded, once its descriptor is known. */
  symbolSize: number | null;
  calibrated: boolean;
  complete: boolean;
}

export interface CapabilityMeasurement {
  captureFps: number;
  /** Code width in sensor pixels divided by grid cells, measured from detected anchors. */
  pixelsPerCell: number;
  decodeMsPerFrame: number;
}
