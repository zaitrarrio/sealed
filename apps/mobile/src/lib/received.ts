/**
 * Received files at rest (spec §10.2, ADR-0005). Every decrypted file is immediately re-encrypted on its way to
 * disk: a random 256-bit file key seals 1 MiB chunks with AES-256-GCM (nonce = 11-byte counter ∥ last flag, as
 * in the Envelope's STREAM construction), and the file key is stored only as an HPKE wrap to this device's
 * hardware agreement key (wrap context "local"). Opening or exporting a file therefore needs the owner's face,
 * fingerprint or passcode. Export decrypts into a temporary cache file that is deleted after sharing.
 */
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import {
  aesGcmOpen,
  aesGcmSeal,
  fromB64url,
  randomBytes,
  segmentNonce,
  toB64url,
  unwrapKey,
  utf8,
  wrapKey,
  type AgreementKey,
  type ExtractSink,
  type FileEntry,
} from "@sealed/core";
import { kvGet, kvSet } from "./storage";

const CHUNK = 1024 * 1024;
const TAG = 16;
const INDEX_KEY = "received-index";
const AAD = utf8("sealed/v1/at-rest");

export interface ReceivedFile {
  id: string;
  path: string;
  size: number;
  mediaType: string;
  mtime?: number;
  receivedAt: number;
  /** Who it came from, when known (sender label or contact name). */
  from?: string;
  /** HPKE wrap of the file key to the device agreement key. */
  wrap: Uint8Array;
  chunks: number;
}

function dir(): Directory {
  const d = new Directory(Paths.document, "received");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

function dataFile(id: string): File {
  return new File(dir(), `${id}.sealed`);
}

export async function listReceived(): Promise<ReceivedFile[]> {
  return ((await kvGet<ReceivedFile[]>(INDEX_KEY)) ?? []).sort((a, b) => b.receivedAt - a.receivedAt);
}

let indexLock: Promise<unknown> = Promise.resolve();

function updateIndex(fn: (list: ReceivedFile[]) => ReceivedFile[]): Promise<void> {
  const run = indexLock.then(async () => {
    const list = (await kvGet<ReceivedFile[]>(INDEX_KEY)) ?? [];
    await kvSet(INDEX_KEY, fn(list));
  });
  indexLock = run.catch(() => undefined);
  return run;
}

class EncryptingWriter {
  private readonly key = randomBytes(32);
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private index = 0;
  private readonly handle;
  readonly id = toB64url(randomBytes(12));

  constructor() {
    const f = dataFile(this.id);
    f.create();
    this.handle = f.open();
  }

  private async flushChunk(chunk: Uint8Array, last: boolean): Promise<void> {
    const ct = await aesGcmSeal(this.key, segmentNonce(this.index, last), chunk, AAD);
    this.handle.writeBytes(ct);
    this.index++;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.pending[0] as Uint8Array;
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.pending.shift();
      } else {
        out.set(head.subarray(0, need), off);
        this.pending[0] = head.subarray(need);
        off += need;
      }
    }
    this.pendingLen -= n;
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    this.pending.push(data.slice());
    this.pendingLen += data.length;
    // Keep one full chunk back so the last chunk is always flagged.
    while (this.pendingLen > CHUNK) await this.flushChunk(this.take(CHUNK), false);
  }

  async close(deviceKey: AgreementKey): Promise<{ id: string; wrap: Uint8Array; chunks: number }> {
    await this.flushChunk(this.take(this.pendingLen), true);
    this.handle.close();
    const wrap = await wrapKey(this.key, deviceKey.publicKey, { kind: "local", fileId: fromB64url(this.id) });
    this.key.fill(0);
    return { id: this.id, wrap, chunks: this.index };
  }

  abort(): void {
    try {
      this.handle.close();
    } catch {
      // already closed
    }
    const f = dataFile(this.id);
    if (f.exists) f.delete();
  }
}

/** An ExtractSink that stores each file encrypted at rest and records it in the received index. */
export class ReceiveSink implements ExtractSink {
  readonly files: ReceivedFile[] = [];
  private writer: EncryptingWriter | null = null;
  /** Set by discard(); a receive still in flight then stops writing and records nothing. */
  private discarded = false;
  bytesWritten = 0;

  constructor(
    private readonly deviceKey: AgreementKey,
    /** Who it came from, as shown in the received list; may be set once the manifest is known. */
    public from?: string,
  ) {}

  onFileStart(): void {
    if (this.discarded) throw new Error("receive cancelled");
    this.writer = new EncryptingWriter();
  }

  async onFileData(_entry: FileEntry, chunk: Uint8Array): Promise<void> {
    if (this.discarded) throw new Error("receive cancelled");
    if (!this.writer) throw new Error("file data before start");
    await this.writer.write(chunk);
    this.bytesWritten += chunk.length;
  }

  async onFileEnd(entry: FileEntry): Promise<void> {
    if (!this.writer) throw new Error("file end before start");
    const writer = this.writer;
    const { id, wrap, chunks } = await writer.close(this.deviceKey);
    this.writer = null;
    if (this.discarded) {
      // discard() ran while the file key was being wrapped: drop this file too.
      const f = dataFile(id);
      if (f.exists) f.delete();
      throw new Error("receive cancelled");
    }
    const rec: ReceivedFile = {
      id,
      path: entry.path,
      size: entry.size,
      mediaType: entry.mediaType || "application/octet-stream",
      ...(entry.mtime !== undefined ? { mtime: entry.mtime } : {}),
      receivedAt: Math.floor(Date.now() / 1000),
      ...(this.from ? { from: this.from } : {}),
      wrap,
      chunks,
    };
    this.files.push(rec);
    await updateIndex((list) => [...list, rec]);
  }

  /** Removes everything this sink wrote (a failed or cancelled transfer). */
  async discard(): Promise<void> {
    this.discarded = true;
    this.writer?.abort();
    this.writer = null;
    const ids = new Set(this.files.map((f) => f.id));
    for (const id of ids) {
      const f = dataFile(id);
      if (f.exists) f.delete();
    }
    await updateIndex((list) => list.filter((r) => !ids.has(r.id)));
    this.files.length = 0;
  }
}

/** Stores whole in-memory files (optical receives) the same way. */
export async function storeOpened(deviceKey: AgreementKey, opened: readonly { entry: FileEntry; data: Uint8Array }[], from?: string): Promise<ReceivedFile[]> {
  const sink = new ReceiveSink(deviceKey, from);
  for (const { entry, data } of opened) {
    sink.onFileStart();
    for (let off = 0; off < data.length || off === 0; off += CHUNK) {
      await sink.onFileData(entry, data.subarray(off, off + CHUNK));
      if (data.length === 0) break;
    }
    await sink.onFileEnd(entry);
  }
  return sink.files;
}

export function baseName(path: string): string {
  return path.split("/").pop() || "file";
}

/** Decrypts a received file into a temporary cache file (one biometric prompt) and returns its URI. */
export async function decryptToCache(rec: ReceivedFile, deviceKey: AgreementKey): Promise<File> {
  const key = await unwrapKey(rec.wrap, deviceKey, { kind: "local", fileId: fromB64url(rec.id) });
  const outDir = new Directory(Paths.cache, "export", rec.id);
  if (outDir.exists) outDir.delete();
  outDir.create({ intermediates: true, idempotent: true });
  const out = new File(outDir, baseName(rec.path));
  out.create();
  const w = out.open();
  const r = dataFile(rec.id).open();
  try {
    for (let i = 0; i < rec.chunks; i++) {
      const last = i === rec.chunks - 1;
      const plainLen = last ? rec.size - i * CHUNK : CHUNK;
      const ct = r.readBytes(plainLen + TAG);
      if (ct.length !== plainLen + TAG) throw new Error("stored file is truncated");
      w.writeBytes(await aesGcmOpen(key, segmentNonce(i, last), ct, AAD));
    }
  } catch (e) {
    w.close();
    out.delete();
    throw e;
  } finally {
    r.close();
    key.fill(0);
  }
  w.close();
  return out;
}

/** Opens the system share sheet for a received file, then deletes the plaintext temporary copy. */
export async function shareReceived(rec: ReceivedFile, deviceKey: AgreementKey): Promise<void> {
  const tmp = await decryptToCache(rec, deviceKey);
  try {
    if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is not available on this device.");
    await Sharing.shareAsync(tmp.uri, { mimeType: rec.mediaType, dialogTitle: baseName(rec.path) });
  } finally {
    const parent = tmp.parentDirectory;
    if (parent.exists) parent.delete();
  }
}

export async function deleteReceived(id: string): Promise<void> {
  const f = dataFile(id);
  if (f.exists) f.delete();
  await updateIndex((list) => list.filter((r) => r.id !== id));
}
