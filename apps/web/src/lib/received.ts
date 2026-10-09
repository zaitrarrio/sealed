/**
 * Received-file storage (spec §10.2). Decrypted files stream into the Origin Private File System when available
 * (bounded memory, survives a large download), otherwise into memory. The receiver then saves each file, or all
 * of them as a zip built with fflate, through a download link.
 *
 * Web limitation: OPFS contents are plaintext on disk inside the browser profile; native clients keep received
 * files encrypted under per-file keys. Files are deleted from OPFS when the user leaves the receive screen.
 */
import type { ExtractSink, FileEntry } from "@sealed/core";
import { Zip, ZipPassThrough } from "fflate";
import { buf } from "./bytes";

export interface ReceivedFile {
  path: string;
  size: number;
  mediaType: string;
  mtime?: number;
  blob: () => Promise<Blob>;
}

interface Writer {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<Blob | null>;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

/** A sink that writes each file into OPFS (or memory) and remembers it for saving. */
export class ReceiveSink implements ExtractSink {
  readonly files: ReceivedFile[] = [];
  private writer: Writer | null = null;
  private dir: FileSystemDirectoryHandle | null = null;
  private readonly dirName = `rx-${crypto.randomUUID()}`;
  private ready: Promise<void>;
  bytesWritten = 0;

  constructor(useOpfs = true) {
    this.ready = useOpfs
      ? opfsRoot().then(async (root) => {
          if (!root) return;
          try {
            this.dir = await root.getDirectoryHandle(this.dirName, { create: true });
            // Probe writable support (Safari only supports sync handles in workers).
            const probe = await this.dir.getFileHandle("probe", { create: true });
            if (typeof (probe as FileSystemFileHandle & { createWritable?: unknown }).createWritable !== "function") this.dir = null;
            else await this.dir.removeEntry("probe");
          } catch {
            this.dir = null;
          }
        })
      : Promise.resolve();
  }

  async onFileStart(entry: FileEntry, index: number): Promise<void> {
    await this.ready;
    this.writer = await this.openWriter(index);
    void entry;
  }

  async onFileData(_entry: FileEntry, chunk: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("file data before start");
    await this.writer.write(chunk);
    this.bytesWritten += chunk.length;
  }

  async onFileEnd(entry: FileEntry, index: number): Promise<void> {
    if (!this.writer) throw new Error("file end before start");
    const blob = await this.writer.close();
    this.writer = null;
    const dir = this.dir;
    const name = `f${index}`;
    const mediaType = entry.mediaType || "application/octet-stream";
    this.files.push({
      path: entry.path,
      size: entry.size,
      mediaType,
      ...(entry.mtime !== undefined ? { mtime: entry.mtime } : {}),
      blob: blob
        ? async () => blob
        : async () => {
            const f = await (dir as FileSystemDirectoryHandle).getFileHandle(name).then((h) => h.getFile());
            return new Blob([f], { type: mediaType });
          },
    });
  }

  private async openWriter(index: number): Promise<Writer> {
    if (this.dir) {
      const handle = await this.dir.getFileHandle(`f${index}`, { create: true });
      const w = await handle.createWritable();
      return {
        write: (c) => w.write(buf(c)),
        close: async () => {
          await w.close();
          return null;
        },
      };
    }
    const parts: BlobPart[] = [];
    return {
      write: async (c) => {
        parts.push(buf(c));
      },
      close: async () => new Blob(parts),
    };
  }

  /** Deletes the OPFS copies. */
  async discard(): Promise<void> {
    await this.ready;
    try {
      const root = await opfsRoot();
      if (root && this.dir) await root.removeEntry(this.dirName, { recursive: true });
    } catch {
      // already gone
    }
    this.dir = null;
  }
}

/** Removes leftover receive directories from earlier sessions (e.g. a closed tab). */
export async function sweepOpfs(): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  try {
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) if (name.startsWith("rx-")) names.push(name);
    for (const n of names) await root.removeEntry(n, { recursive: true }).catch(() => undefined);
  } catch {
    // iteration unsupported
  }
}

export function baseName(path: string): string {
  return path.split("/").pop() || "file";
}

/** Triggers a browser download for a blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Builds a zip (stored, no recompression) of all received files, streaming each file through fflate. */
export async function zipFiles(files: readonly ReceivedFile[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const total = files.reduce((a, f) => a + f.size, 0);
  const parts: BlobPart[] = [];
  let done = 0;
  const zip = new Zip((err, data) => {
    if (err) throw err;
    parts.push(buf(data));
  });
  for (const f of files) {
    const entry = new ZipPassThrough(f.path);
    if (f.mtime !== undefined) entry.mtime = new Date(f.mtime * 1000);
    zip.add(entry);
    const blob = await f.blob();
    const reader = blob.stream().getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      entry.push(value, false);
      done += value.length;
      onProgress?.(done, total);
    }
    entry.push(new Uint8Array(0), true);
  }
  zip.end();
  return new Blob(parts, { type: "application/zip" });
}

/** In-memory files (optical receives produce whole files). */
export function memoryFiles(opened: readonly { entry: FileEntry; data: Uint8Array }[]): ReceivedFile[] {
  return opened.map(({ entry, data }) => {
    const blob = new Blob([buf(data)], { type: entry.mediaType || "application/octet-stream" });
    return { path: entry.path, size: entry.size, mediaType: entry.mediaType, ...(entry.mtime !== undefined ? { mtime: entry.mtime } : {}), blob: async () => blob };
  });
}
