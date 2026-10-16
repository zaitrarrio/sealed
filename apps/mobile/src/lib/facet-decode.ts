/**
 * Facet decode session (spec §7.6, ADR-0010) — the mobile counterpart of the web decode worker. Camera frames
 * arrive already converted to RGBA (frame-convert.ts); the session feeds FacetReceiver, opens the manifest part
 * as soon as it can (to show file names), and on completion unwraps (Air-gap, using the hardware device key)
 * or reads the in-clear key (Broadcast), then opens and verifies the Envelope.
 *
 * Frames are processed one at a time; the camera side drops frames while a decode is running, and RaptorQ
 * repair symbols cover what is missed.
 */
import {
  EnvelopeReader,
  FacetReceiver,
  airgapReceiverSas,
  openOpticalEnvelope,
  unwrapKey,
  type DeviceKeys,
  type FileEntry,
  type ReceiveProgress,
  type RgbaImage,
} from "@sealed/core";

export type DecodeMode = "airgap" | "broadcast";

export interface DecodeProgress {
  progress: ReceiveProgress;
  sas: string | null;
  senderLabel: string | null;
  files: { path: string; size: number }[] | null;
  measurement: { captureFps: number; pixelsPerCell: number; decodeMsPerFrame: number };
}

export interface OpenedFile {
  entry: FileEntry;
  data: Uint8Array;
}

export interface DecodeResult {
  mode: DecodeMode;
  files: OpenedFile[];
  sender: { label: string; signingPublicKey: Uint8Array; fingerprint?: Uint8Array } | null;
  publisher: { fingerprint: Uint8Array; signingKey: Uint8Array; signatureValid: boolean } | null;
}

export interface DecodeSessionOptions {
  mode: DecodeMode;
  /** Air-gap: this device's keys and the nonce of the reverse key code it displayed. */
  airgap?: { device: DeviceKeys; nonce: Uint8Array };
}

export class FacetDecodeSession {
  private receiver = new FacetReceiver();
  private manifestFiles: { path: string; size: number }[] | null = null;
  private manifestTried: object | null = null;
  private done = false;

  constructor(private readonly opts: DecodeSessionOptions) {}

  get finished(): boolean {
    return this.done;
  }

  reset(): void {
    this.receiver = new FacetReceiver();
    this.manifestFiles = null;
    this.manifestTried = null;
    this.done = false;
  }

  /** Feeds one camera frame (pixel path). Returns the progress, and the result once the stream is complete. */
  async push(image: RgbaImage, timestampMs: number): Promise<{ update: DecodeProgress; result?: DecodeResult }> {
    return this.after(this.receiver.push(image, timestampMs));
  }

  /**
   * Feeds one QR code read by the platform detector (detector path) — the usual way on phones: no pixels are
   * decoded in JavaScript.
   */
  async pushCode(text: string, timestampMs: number): Promise<{ update: DecodeProgress; result?: DecodeResult }> {
    return this.after(this.receiver.pushQrCode(text, timestampMs));
  }

  private async after(progress: ReceiveProgress): Promise<{ update: DecodeProgress; result?: DecodeResult }> {
    await this.tryManifest();
    const update: DecodeProgress = {
      progress,
      sas: this.sas(),
      senderLabel: this.receiver.descriptor?.senderLabel ?? null,
      files: this.manifestFiles,
      measurement: this.receiver.measure(),
    };
    if (!progress.complete || this.done) return { update };
    this.done = true;
    return { update, result: await this.open() };
  }

  private sas(): string | null {
    const a = this.opts.airgap;
    if (!a) return null;
    return airgapReceiverSas(this.receiver, a.nonce, a.device.agreement.publicKey);
  }

  private async tryManifest(): Promise<void> {
    if (this.manifestFiles) return;
    const d = this.receiver.descriptor;
    if (!d?.manifestPart || this.manifestTried === d) return;
    this.manifestTried = d;
    try {
      let cek: Uint8Array | null = null;
      if (d.cek) cek = d.cek;
      else if (d.wrap && this.opts.airgap) cek = await unwrapKey(d.wrap, this.opts.airgap.device.agreement, { kind: "airgap", streamId: d.streamId });
      if (!cek) return;
      const reader = await EnvelopeReader.open(d.manifestPart, cek);
      this.manifestFiles = reader.manifest.files.map((f: FileEntry) => ({ path: f.path, size: f.size }));
    } catch {
      // Not decodable yet (or not for this device); the final open reports real errors.
    }
  }

  private async open(): Promise<DecodeResult> {
    const opened = await openOpticalEnvelope(this.receiver, this.opts.airgap ? { device: this.opts.airgap.device } : {});
    const s = opened.manifest.sender;
    return {
      mode: opened.mode,
      files: opened.files.map((f) => ({ entry: f.entry, data: f.data })),
      sender: s ? { label: s.label, signingPublicKey: s.signingPublicKey, ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}) } : null,
      publisher: opened.publisher ?? null,
    };
  }
}
