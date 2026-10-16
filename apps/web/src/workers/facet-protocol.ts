/** Messages between the capture page and the Facet decode worker. */
import type { ReceiveProgress, Tier } from "@sealed/core";

export type DecodeMode = "airgap" | "broadcast";

export interface WorkerInit {
  type: "init";
  mode: DecodeMode;
  /**
   * Tiers to decode from camera frames (default all). [0] skips the colour-grid search, which costs hundreds of
   * milliseconds per frame, when only QR frames are expected.
   */
  tiers?: Tier[];
  /** Air-gap: this device's keys (non-extractable CryptoKeys clone into the worker) and the reverse-key nonce. */
  airgap?: {
    agreementPrivate: CryptoKey;
    agreementPublic: Uint8Array;
    signingPrivate: CryptoKey;
    signingPublic: Uint8Array;
    nonce: Uint8Array;
  };
}

/** A captured frame: a VideoFrame (MediaStreamTrackProcessor) or an ImageBitmap (rVFC fallback). */
export interface WorkerFrame {
  type: "frame";
  frame: VideoFrame | ImageBitmap;
  timestamp: number;
}

/** A QR code read on the main thread by the browser's BarcodeDetector (its text). */
export interface WorkerCode {
  type: "code";
  text: string;
  timestamp: number;
}

export type ToWorker = WorkerInit | WorkerFrame | WorkerCode | { type: "reset" };

export interface OpenedFileMessage {
  path: string;
  size: number;
  mediaType: string;
  mtime?: number;
  data: Uint8Array;
}

export type FromWorker =
  | { type: "progress"; progress: ReceiveProgress; sas: string | null; senderLabel: string | null; files: { path: string; size: number }[] | null; queue: number; measurement: { captureFps: number; pixelsPerCell: number; decodeMsPerFrame: number } }
  | {
      type: "complete";
      mode: DecodeMode;
      files: OpenedFileMessage[];
      sender: { label: string; signingPublicKey: Uint8Array; fingerprint?: Uint8Array } | null;
      publisher: { fingerprint: Uint8Array; signingKey: Uint8Array; signatureValid: boolean } | null;
    }
  | { type: "error"; message: string };
