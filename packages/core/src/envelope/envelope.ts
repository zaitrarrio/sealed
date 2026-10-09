/**
 * The Envelope (spec §8, ADR-0003): header ∥ sealed manifest ∥ sealed segments ∥ padding.
 * Segments are 1 MiB of compressed payload sealed with AES-256-GCM in the STREAM construction:
 * nonce = 11-byte big-endian counter ∥ last-segment flag, so truncation, reordering and duplication fail.
 */
import { Deflate, Inflate } from "fflate";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { concat, ctEqual, readU32be, u32be, utf8 } from "../bytes";
import { AuthenticationError, aesGcmOpen, aesGcmSeal, hkdf, randomBytes } from "../crypto/primitives";
import { signObject, verifyObject } from "../crypto/sig";
import type { SigningKey } from "../crypto/keys";
import {
  Compression,
  ENVELOPE_VERSION,
  MAX_FILES,
  ManifestError,
  SEGMENT_SIZE,
  decodeManifest,
  encodeManifest,
  manifestSigningObject,
  sizeBucket,
  validatePath,
  type FileEntry,
  type Manifest,
} from "./manifest";

export const MAGIC = utf8("SEAL");
export const HEADER_LENGTH = 4 + 1 + 1 + 16 + 4;
export const TAG_LENGTH = 16;
const FLAG_SIGNED = 0x01;

export interface EnvelopeKeys {
  payloadKey: Uint8Array;
  manifestKey: Uint8Array;
}

export function deriveEnvelopeKeys(cek: Uint8Array, transferId: Uint8Array): EnvelopeKeys {
  if (cek.length !== 32) throw new Error("CEK must be 32 bytes");
  if (transferId.length !== 16) throw new Error("transfer id must be 16 bytes");
  return {
    payloadKey: hkdf(cek, transferId, utf8("sealed/v1/payload"), 32),
    manifestKey: hkdf(cek, transferId, utf8("sealed/v1/manifest"), 32),
  };
}

export function segmentNonce(index: number, last: boolean): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid segment index");
  const n = new Uint8Array(12);
  let v = index;
  for (let i = 10; i >= 0; i--) {
    n[i] = v % 256;
    v = Math.floor(v / 256);
  }
  n[11] = last ? 1 : 0;
  return n;
}

export function encodeHeader(transferId: Uint8Array, manifestCiphertextLength: number, signed: boolean): Uint8Array {
  return concat(MAGIC, new Uint8Array([ENVELOPE_VERSION, signed ? FLAG_SIGNED : 0]), transferId, u32be(manifestCiphertextLength));
}

export interface EnvelopeHeader {
  version: number;
  signed: boolean;
  transferId: Uint8Array;
  manifestLength: number;
}

export function decodeHeader(b: Uint8Array): EnvelopeHeader {
  if (b.length < HEADER_LENGTH || !ctEqual(b.subarray(0, 4), MAGIC)) throw new ManifestError("not a Sealed envelope");
  const version = b[4] as number;
  if (version !== ENVELOPE_VERSION) throw new ManifestError(`unsupported envelope version ${version}`);
  return { version, signed: ((b[5] as number) & FLAG_SIGNED) !== 0, transferId: b.slice(6, 22), manifestLength: readU32be(b, 22) };
}

export interface EnvelopeInput {
  path: string;
  mediaType: string;
  size: number;
  data: Uint8Array | AsyncIterable<Uint8Array>;
  mtime?: number;
}

export interface SealedSegment {
  index: number;
  last: boolean;
  bytes: Uint8Array;
}

export interface BuilderOptions {
  transferId: Uint8Array;
  cek: Uint8Array;
  ttlSeconds: number;
  now?: number;
  compression?: Compression;
  sender?: { key: SigningKey; label: string; fingerprint?: Uint8Array };
  source?: string;
}

/** Media types that are already compressed; DEFLATE is skipped when every file is one of these. */
const INCOMPRESSIBLE = /^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/|audio\/(mpeg|aac|mp4|ogg|opus)|application\/(zip|gzip|x-7z-compressed|x-rar-compressed|zstd|x-xz|pdf))/;

export function chooseCompression(inputs: readonly { mediaType: string }[]): Compression {
  return inputs.length > 0 && inputs.every((f) => INCOMPRESSIBLE.test(f.mediaType)) ? Compression.None : Compression.Deflate;
}

/**
 * Streams files into sealed segments with bounded memory (≈ 2 segments). Iterate `build()` to receive each
 * sealed segment, then call `manifestPart()` and `padding()`.
 */
export class EnvelopeBuilder {
  private readonly keys: EnvelopeKeys;
  private manifest: Manifest | null = null;
  private manifestBytes: Uint8Array | null = null;
  private sealedLength = 0;

  constructor(private readonly opts: BuilderOptions) {
    this.keys = deriveEnvelopeKeys(opts.cek, opts.transferId);
  }

  async *build(inputs: readonly EnvelopeInput[]): AsyncGenerator<SealedSegment, void, void> {
    if (inputs.length === 0) throw new ManifestError("an envelope needs at least one file");
    if (inputs.length > MAX_FILES) throw new ManifestError("too many files");
    const seen = new Set<string>();
    const compression = this.opts.compression ?? chooseCompression(inputs);
    const files: FileEntry[] = [];

    const pendingOut: Uint8Array[] = [];
    let pendingLen = 0;
    let payloadLength = 0;
    let index = 0;
    let held: Uint8Array | null = null; // one full plaintext segment held back until we know whether it is last
    const sealed: SealedSegment[] = [];

    const toSeal: { pt: Uint8Array; last: boolean }[] = [];
    const sealSegment = (pt: Uint8Array, last: boolean): void => {
      toSeal.push({ pt, last });
    };
    const drain = async (): Promise<void> => {
      while (toSeal.length) {
        const { pt, last } = toSeal.shift()!;
        const ct = await aesGcmSeal(this.keys.payloadKey, segmentNonce(index, last), pt, MAGIC);
        sealed.push({ index, last, bytes: ct });
        this.sealedLength += ct.length;
        index++;
      }
    };
    const take = (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      let off = 0;
      while (off < n) {
        const head = pendingOut[0]!;
        const need = n - off;
        if (head.length <= need) {
          out.set(head, off);
          off += head.length;
          pendingOut.shift();
        } else {
          out.set(head.subarray(0, need), off);
          pendingOut[0] = head.subarray(need);
          off += need;
        }
      }
      pendingLen -= n;
      return out;
    };
    const onOutput = (chunk: Uint8Array): void => {
      if (chunk.length === 0) return;
      pendingOut.push(chunk);
      pendingLen += chunk.length;
      payloadLength += chunk.length;
      while (pendingLen >= SEGMENT_SIZE + 1 || (pendingLen >= SEGMENT_SIZE && held === null)) {
        if (held) sealSegment(held, false);
        held = take(SEGMENT_SIZE);
      }
    };

    const deflate = compression === Compression.Deflate ? new Deflate({ level: 6 }) : null;
    if (deflate) deflate.ondata = (data) => onOutput(data);

    for (const input of inputs) {
      const path = validatePath(input.path);
      if (seen.has(path)) throw new ManifestError(`duplicate path ${path}`);
      seen.add(path);
      const hasher = nobleSha256.create();
      let size = 0;
      const feed = (chunk: Uint8Array): void => {
        if (chunk.length === 0) return;
        hasher.update(chunk);
        size += chunk.length;
        if (deflate) deflate.push(chunk, false);
        else onOutput(chunk.slice());
      };
      if (input.data instanceof Uint8Array) {
        for (let off = 0; off < input.data.length; off += SEGMENT_SIZE) {
          feed(input.data.subarray(off, off + SEGMENT_SIZE));
          await drain();
          while (sealed.length) yield sealed.shift()!;
        }
      } else {
        for await (const chunk of input.data) {
          feed(chunk);
          await drain();
          while (sealed.length) yield sealed.shift()!;
        }
      }
      if (size !== input.size) throw new ManifestError(`size mismatch for ${path}: declared ${input.size}, read ${size}`);
      files.push({ path, size, mediaType: input.mediaType || "application/octet-stream", sha256: hasher.digest(), ...(input.mtime !== undefined ? { mtime: input.mtime } : {}) });
      await drain();
      while (sealed.length) yield sealed.shift()!;
    }
    if (deflate) deflate.push(new Uint8Array(0), true);

    // Flush: held + remaining pending form the final one or two segments.
    const rest = pendingLen > 0 ? take(pendingLen) : new Uint8Array(0);
    if (held && rest.length > 0) {
      sealSegment(held, false);
      sealSegment(rest, true);
    } else if (held) {
      sealSegment(held, true);
    } else {
      sealSegment(rest, true);
    }
    await drain();
    while (sealed.length) yield sealed.shift()!;

    const now = this.opts.now ?? Math.floor(Date.now() / 1000);
    const manifest: Manifest = {
      version: ENVELOPE_VERSION,
      transferId: this.opts.transferId,
      created: now,
      expires: now + this.opts.ttlSeconds,
      files,
      compression,
      segmentSize: SEGMENT_SIZE,
      segmentCount: index,
      payloadLength,
      ...(this.opts.sender
        ? { sender: { signingPublicKey: this.opts.sender.key.publicKey, label: this.opts.sender.label, ...(this.opts.sender.fingerprint ? { fingerprint: this.opts.sender.fingerprint } : {}) } }
        : {}),
      ...(this.opts.source ? { source: this.opts.source } : {}),
    };
    if (this.opts.sender) manifest.signature = await signObject(this.opts.sender.key, "manifest", manifestSigningObject(manifest));
    this.manifest = manifest;
    const mct = await aesGcmSeal(this.keys.manifestKey, new Uint8Array(12), encodeManifest(manifest), encodeHeader(this.opts.transferId, 0, Boolean(manifest.signature)).subarray(0, 22));
    this.manifestBytes = concat(encodeHeader(this.opts.transferId, mct.length, Boolean(manifest.signature)), mct);
  }

  getManifest(): Manifest {
    if (!this.manifest) throw new Error("build() has not completed");
    return this.manifest;
  }

  /** Header ∥ sealed manifest. */
  manifestPart(): Uint8Array {
    if (!this.manifestBytes) throw new Error("build() has not completed");
    return this.manifestBytes;
  }

  /** Number of padding bytes that bring the total ciphertext length to its size bucket. */
  paddingLength(): number {
    const total = this.manifestPart().length + this.sealedLength;
    return sizeBucket(total) - total;
  }

  /** Random padding bytes (indistinguishable from ciphertext), all at once. */
  padding(): Uint8Array {
    return randomBytes(this.paddingLength());
  }

  /** Random padding in chunks of at most `chunkSize`, for streaming uploads of large buckets. */
  *paddingChunks(chunkSize = SEGMENT_SIZE): Generator<Uint8Array, void, void> {
    for (let left = this.paddingLength(); left > 0; left -= chunkSize) yield randomBytes(Math.min(chunkSize, left));
  }
}

export interface OpenOptions {
  expectedTransferId?: Uint8Array;
  /** Require a valid sender signature by exactly this signing public key. */
  requireSigner?: Uint8Array;
}

/** Opens an Envelope's manifest part and decrypts its segments one at a time. */
export class EnvelopeReader {
  private constructor(
    readonly header: EnvelopeHeader,
    readonly manifest: Manifest,
    private readonly keys: EnvelopeKeys,
    readonly manifestPartLength: number,
  ) {}

  static async open(manifestPart: Uint8Array, cek: Uint8Array, opts: OpenOptions = {}): Promise<EnvelopeReader> {
    const header = decodeHeader(manifestPart);
    if (opts.expectedTransferId && !ctEqual(opts.expectedTransferId, header.transferId)) throw new ManifestError("transfer id mismatch");
    const keys = deriveEnvelopeKeys(cek, header.transferId);
    const end = HEADER_LENGTH + header.manifestLength;
    if (manifestPart.length < end) throw new ManifestError("truncated manifest");
    const plain = await aesGcmOpen(keys.manifestKey, new Uint8Array(12), manifestPart.subarray(HEADER_LENGTH, end), manifestPart.subarray(0, 22));
    const manifest = decodeManifest(plain);
    if (!ctEqual(manifest.transferId, header.transferId)) throw new ManifestError("manifest transfer id mismatch");
    if (header.signed !== Boolean(manifest.signature)) throw new ManifestError("signature flag mismatch");
    if (manifest.signature) {
      if (!manifest.sender || !verifyObject(manifest.sender.signingPublicKey, "manifest", manifestSigningObject(manifest), manifest.signature)) {
        throw new AuthenticationError("manifest signature invalid");
      }
    }
    if (opts.requireSigner) {
      if (!manifest.sender || !manifest.signature || !ctEqual(manifest.sender.signingPublicKey, opts.requireSigner)) {
        throw new AuthenticationError("manifest not signed by the expected sender");
      }
    }
    return new EnvelopeReader(header, manifest, keys, end);
  }

  segmentPlainLength(index: number): number {
    const m = this.manifest;
    if (index < 0 || index >= m.segmentCount) throw new RangeError("segment index out of range");
    return index === m.segmentCount - 1 ? m.payloadLength - index * m.segmentSize : m.segmentSize;
  }

  segmentCipherLength(index: number): number {
    return this.segmentPlainLength(index) + TAG_LENGTH;
  }

  /** Byte offset of a segment in the contiguous Envelope form. */
  segmentOffset(index: number): number {
    return this.manifestPartLength + index * (this.manifest.segmentSize + TAG_LENGTH);
  }

  /** Decrypts one segment; trailing padding after the last segment is ignored. */
  decryptSegment(index: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    const len = this.segmentCipherLength(index);
    if (ciphertext.length < len) throw new ManifestError("truncated segment");
    const last = index === this.manifest.segmentCount - 1;
    if (!last && ciphertext.length !== len) throw new ManifestError("segment length mismatch");
    return aesGcmOpen(this.keys.payloadKey, segmentNonce(index, last), ciphertext.subarray(0, len), MAGIC);
  }

  /** Total length of the contiguous Envelope without padding. */
  contiguousLength(): number {
    return this.segmentOffset(this.manifest.segmentCount - 1) + this.segmentCipherLength(this.manifest.segmentCount - 1);
  }
}

export interface ExtractSink {
  onFileStart?(entry: FileEntry, index: number): void | Promise<void>;
  onFileData(entry: FileEntry, chunk: Uint8Array, index: number): void | Promise<void>;
  onFileEnd?(entry: FileEntry, index: number): void | Promise<void>;
}

/**
 * Splits the decompressed payload into files, verifying each file's size and SHA-256.
 * Feed decrypted segments in order with `push`; call `finish` after the last.
 */
export class PayloadExtractor {
  private fileIndex = 0;
  private remaining: number;
  private hasher = nobleSha256.create();
  private readonly inflate: Inflate | null;
  private queue: Uint8Array[] = [];
  private started = false;
  private done = false;

  constructor(
    private readonly manifest: Manifest,
    private readonly sink: ExtractSink,
  ) {
    this.remaining = manifest.files[0]?.size ?? 0;
    if (manifest.compression === Compression.Deflate) {
      this.inflate = new Inflate();
      this.inflate.ondata = (data) => this.queue.push(data);
    } else {
      this.inflate = null;
    }
  }

  async push(plainSegment: Uint8Array, last: boolean): Promise<void> {
    if (this.done) throw new ManifestError("payload continues after the last segment");
    if (this.inflate) this.inflate.push(plainSegment, last);
    else this.queue.push(plainSegment);
    const chunks = this.queue;
    this.queue = [];
    for (const c of chunks) await this.consume(c);
    if (last) await this.finish();
  }

  private async consume(chunk: Uint8Array): Promise<void> {
    let off = 0;
    while (off < chunk.length || (this.fileIndex < this.manifest.files.length && this.remaining === 0)) {
      const entry = this.manifest.files[this.fileIndex];
      if (!entry) throw new ManifestError("payload longer than declared files");
      if (!this.started) {
        this.started = true;
        await this.sink.onFileStart?.(entry, this.fileIndex);
      }
      const n = Math.min(this.remaining, chunk.length - off);
      if (n > 0) {
        const piece = chunk.subarray(off, off + n);
        this.hasher.update(piece);
        await this.sink.onFileData(entry, piece, this.fileIndex);
        off += n;
        this.remaining -= n;
      }
      if (this.remaining === 0) {
        if (!ctEqual(this.hasher.digest(), entry.sha256)) throw new AuthenticationError(`hash mismatch for ${entry.path}`);
        await this.sink.onFileEnd?.(entry, this.fileIndex);
        this.fileIndex++;
        this.hasher = nobleSha256.create();
        this.started = false;
        const next = this.manifest.files[this.fileIndex];
        this.remaining = next?.size ?? 0;
        if (!next) {
          if (off < chunk.length) throw new ManifestError("payload longer than declared files");
          return;
        }
      }
    }
  }

  private async finish(): Promise<void> {
    if (this.done) return;
    // Zero-length trailing files still need start/end callbacks.
    await this.consume(new Uint8Array(0));
    if (this.fileIndex !== this.manifest.files.length) throw new ManifestError("payload shorter than declared files");
    this.done = true;
  }

  get complete(): boolean {
    return this.done;
  }
}

/** Builds a contiguous Envelope in memory (used by the optical transports and tests). */
export async function sealEnvelope(inputs: readonly EnvelopeInput[], opts: BuilderOptions & { pad?: boolean }): Promise<{ bytes: Uint8Array; manifest: Manifest }> {
  const b = new EnvelopeBuilder(opts);
  const segs: Uint8Array[] = [];
  for await (const s of b.build(inputs)) segs.push(s.bytes);
  const parts = [b.manifestPart(), ...segs];
  if (opts.pad !== false) parts.push(b.padding());
  return { bytes: concat(...parts), manifest: b.getManifest() };
}

export interface OpenedFile {
  entry: FileEntry;
  data: Uint8Array;
}

/** Opens a contiguous Envelope fully in memory. */
export async function openEnvelope(bytes: Uint8Array, cek: Uint8Array, opts: OpenOptions = {}): Promise<{ manifest: Manifest; files: OpenedFile[] }> {
  const reader = await EnvelopeReader.open(bytes, cek, opts);
  const out: OpenedFile[] = [];
  let current: Uint8Array[] = [];
  const ex = new PayloadExtractor(reader.manifest, {
    onFileStart: () => {
      current = [];
    },
    onFileData: (_e, chunk) => {
      current.push(chunk.slice());
    },
    onFileEnd: (entry) => {
      out.push({ entry, data: concat(...current) });
    },
  });
  for (let i = 0; i < reader.manifest.segmentCount; i++) {
    const off = reader.segmentOffset(i);
    const last = i === reader.manifest.segmentCount - 1;
    const end = off + reader.segmentCipherLength(i);
    if (end > bytes.length) throw new ManifestError("truncated envelope");
    await ex.push(await reader.decryptSegment(i, bytes.subarray(off, end)), last);
  }
  return { manifest: reader.manifest, files: out };
}
