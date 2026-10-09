import { asMap, decodeCbor, encodeCbor, getArray, getBytes, getOptBytes, getOptText, getText, getUint, type CborMap, type CborValue } from "../cbor";

export const ENVELOPE_VERSION = 1;
export const SEGMENT_SIZE = 1024 * 1024;
export const MAX_FILES = 10_000;
export const MAX_PATH_BYTES = 4096;

export enum Compression {
  None = 0,
  /** Reserved by spec §8.2; not produced by this implementation (ADR-0016). */
  Zstd = 1,
  /** Raw DEFLATE (RFC 1951) via fflate; portable to browsers, Workers and Hermes. */
  Deflate = 2,
}

export interface FileEntry {
  path: string;
  size: number;
  mediaType: string;
  sha256: Uint8Array;
  mtime?: number;
}

export interface SenderInfo {
  fingerprint?: Uint8Array;
  signingPublicKey: Uint8Array;
  label: string;
}

export interface Manifest {
  version: number;
  transferId: Uint8Array;
  created: number;
  expires: number;
  files: FileEntry[];
  compression: Compression;
  segmentSize: number;
  segmentCount: number;
  payloadLength: number;
  sender?: SenderInfo;
  signature?: Uint8Array;
  source?: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** Rejects absolute paths, traversal, NUL and oversized names (spec §8.2). Returns the NFC-normalized path. */
export function validatePath(path: string): string {
  const p = path.normalize("NFC");
  const bytes = new TextEncoder().encode(p).length;
  if (bytes === 0 || bytes > MAX_PATH_BYTES) throw new ManifestError("path length out of range");
  if (p.includes("\0") || p.includes("\\")) throw new ManifestError("path contains forbidden characters");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new ManifestError("absolute paths are not allowed");
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new ManifestError("path contains empty, '.' or '..' segments");
  }
  return p;
}

/** The fields covered by the sender signature (keys 1–10). */
export function manifestSigningObject(m: Manifest): CborValue {
  const o = manifestCbor(m);
  const { 11: _sig, 12: _src, ...rest } = o as Record<string, CborValue | undefined>;
  return rest as CborValue;
}

function manifestCbor(m: Manifest): Record<string, CborValue | undefined> {
  return {
    1: m.version,
    2: m.transferId,
    3: m.created,
    4: m.expires,
    5: m.files.map((f) => ({ 1: f.path, 2: f.size, 3: f.mediaType, 4: f.sha256, 5: f.mtime })),
    6: m.compression,
    7: m.segmentSize,
    8: m.segmentCount,
    9: m.payloadLength,
    10: m.sender ? { 1: m.sender.fingerprint, 2: m.sender.signingPublicKey, 3: m.sender.label } : undefined,
    11: m.signature,
    12: m.source ? { 1: m.source } : undefined,
  };
}

export function encodeManifest(m: Manifest): Uint8Array {
  return encodeCbor(manifestCbor(m) as CborValue);
}

export function decodeManifest(bytes: Uint8Array): Manifest {
  const m = asMap(decodeCbor(bytes), "manifest");
  const version = getUint(m, 1, "manifest");
  if (version !== ENVELOPE_VERSION) throw new ManifestError(`unsupported manifest version ${version}`);
  const filesRaw = getArray(m, 5, "manifest");
  if (filesRaw.length > MAX_FILES) throw new ManifestError("too many files");
  const files: FileEntry[] = filesRaw.map((fv, i) => {
    const f = asMap(fv, `manifest.files[${i}]`);
    const mtime = f["5"];
    return {
      path: validatePath(getText(f, 1, "file")),
      size: getUint(f, 2, "file"),
      mediaType: getText(f, 3, "file"),
      sha256: getBytes(f, 4, "file", 32),
      ...(typeof mtime === "number" ? { mtime } : {}),
    };
  });
  const senderRaw = m["10"];
  let sender: SenderInfo | undefined;
  if (senderRaw !== undefined) {
    const s = asMap(senderRaw, "manifest.sender") as CborMap;
    const fp = getOptBytes(s, 1, "sender");
    sender = { signingPublicKey: getBytes(s, 2, "sender", 65), label: getText(s, 3, "sender"), ...(fp ? { fingerprint: fp } : {}) };
  }
  const compression = getUint(m, 6, "manifest");
  if (compression !== Compression.None && compression !== Compression.Deflate) throw new ManifestError(`unsupported compression ${compression}`);
  const signature = getOptBytes(m, 11, "manifest");
  const sourceRaw = m["12"];
  const source = sourceRaw !== undefined ? getOptText(asMap(sourceRaw, "manifest.source"), 1, "source") : undefined;
  const out: Manifest = {
    version,
    transferId: getBytes(m, 2, "manifest", 16),
    created: getUint(m, 3, "manifest"),
    expires: getUint(m, 4, "manifest"),
    files,
    compression,
    segmentSize: getUint(m, 7, "manifest"),
    segmentCount: getUint(m, 8, "manifest"),
    payloadLength: getUint(m, 9, "manifest"),
    ...(sender ? { sender } : {}),
    ...(signature ? { signature } : {}),
    ...(source ? { source } : {}),
  };
  if (out.segmentSize !== SEGMENT_SIZE) throw new ManifestError("unexpected segment size");
  const expectedSegments = Math.max(1, Math.ceil(out.payloadLength / out.segmentSize));
  if (out.segmentCount !== expectedSegments) throw new ManifestError("segment count does not match payload length");
  return out;
}

/** Size buckets for ciphertext padding (spec §8.3). */
export function sizeBucket(n: number): number {
  const KiB = 1024;
  const MiB = 1024 * KiB;
  const GiB = 1024 * MiB;
  if (n <= 64 * KiB) return 64 * KiB;
  if (n <= 256 * KiB) return 256 * KiB;
  if (n <= GiB) {
    let b = MiB;
    while (b < n) b *= 2;
    return b;
  }
  const step = 256 * MiB;
  return Math.ceil(n / step) * step;
}
