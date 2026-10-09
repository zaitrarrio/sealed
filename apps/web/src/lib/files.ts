/**
 * Local file sources (spec §6.7): files from an <input>, drag-and-drop (including folders via the File System
 * entries API) and folder pickers (webkitdirectory). Each becomes an EnvelopeInput that streams from the Blob,
 * so large selections are never fully buffered.
 */
import type { EnvelopeInput } from "@sealed/core";

export interface PickedFile {
  /** Relative path inside the selection, '/'-separated, validated by the Envelope builder. */
  path: string;
  size: number;
  mediaType: string;
  mtime?: number;
  source: "local" | "gdrive";
  blob: Blob;
}

const CHUNK = 1024 * 1024;

/** Streams a Blob in 1 MiB chunks without loading it whole. */
export async function* blobChunks(blob: Blob, chunkSize = CHUNK): AsyncGenerator<Uint8Array> {
  for (let off = 0; off < blob.size; off += chunkSize) {
    yield new Uint8Array(await blob.slice(off, Math.min(blob.size, off + chunkSize)).arrayBuffer());
  }
}

export function toEnvelopeInputs(files: readonly PickedFile[]): EnvelopeInput[] {
  return files.map((f) => ({
    path: f.path,
    size: f.size,
    mediaType: f.mediaType || "application/octet-stream",
    data: blobChunks(f.blob),
    ...(f.mtime !== undefined ? { mtime: Math.floor(f.mtime / 1000) } : {}),
  }));
}

/** Removes characters the manifest rejects and collapses empty segments. */
export function sanitizePath(p: string): string {
  const segs = p
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.replace(/[\0]/g, "").trim())
    .filter((s) => s !== "" && s !== "." && s !== "..");
  return segs.join("/") || "file";
}

export function fromFileList(list: FileList | readonly File[]): PickedFile[] {
  return Array.from(list).map((f) => ({
    path: sanitizePath(f.webkitRelativePath || f.name),
    size: f.size,
    mediaType: f.type || "application/octet-stream",
    mtime: f.lastModified,
    source: "local" as const,
    blob: f,
  }));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const f = await entryFile(entry as FileSystemFileEntry);
    out.push({ path: sanitizePath(prefix + f.name), size: f.size, mediaType: f.type || "application/octet-stream", mtime: f.lastModified, source: "local", blob: f });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches; keep reading until it returns an empty batch.
    for (;;) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Collects files (and whole folders) from a drop event. */
export async function fromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const e = item.webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length === 0) return fromFileList(dt.files);
  const out: PickedFile[] = [];
  for (const e of entries) await walk(e, "", out);
  return out;
}

/** Ensures every path is unique by suffixing duplicates (the manifest rejects duplicate paths). */
export function dedupePaths(files: readonly PickedFile[]): PickedFile[] {
  const seen = new Map<string, number>();
  return files.map((f) => {
    const n = seen.get(f.path) ?? 0;
    seen.set(f.path, n + 1);
    if (n === 0) return f;
    const dot = f.path.lastIndexOf(".");
    const slash = f.path.lastIndexOf("/");
    const path = dot > slash + 1 ? `${f.path.slice(0, dot)} (${n + 1})${f.path.slice(dot)}` : `${f.path} (${n + 1})`;
    return { ...f, path };
  });
}

export function totalSize(files: readonly PickedFile[]): number {
  return files.reduce((a, f) => a + f.size, 0);
}
