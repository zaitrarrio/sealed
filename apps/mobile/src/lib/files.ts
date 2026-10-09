/**
 * File sources on mobile (spec §6.7). The system document picker surfaces local files and every installed
 * cloud provider — Google Drive, iCloud Drive, OneDrive, Dropbox — through the OS file provider framework, so
 * the user picks exactly what to share and Sealed never holds cloud credentials. Photos come from the photo
 * library picker. Picked files are copied into the app cache by the pickers and streamed in 1 MiB chunks.
 */
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import type { EnvelopeInput } from "@sealed/core";

export interface PickedFile {
  path: string;
  size: number;
  mediaType: string;
  mtime?: number;
  /** "cloud" when the document provider was a cloud service (recorded as manifest source). */
  source: "local" | "cloud" | "photos";
  uri: string;
}

const CHUNK = 1024 * 1024;

/** Streams a file in 1 MiB chunks through a native file handle, without loading it whole. */
export async function* uriChunks(uri: string, chunkSize = CHUNK): AsyncGenerator<Uint8Array> {
  const handle = new File(uri).open();
  try {
    for (;;) {
      const chunk = handle.readBytes(chunkSize);
      if (chunk.length === 0) break;
      yield new Uint8Array(chunk);
      if (chunk.length < chunkSize) break;
    }
  } finally {
    handle.close();
  }
}

export function toEnvelopeInputs(files: readonly PickedFile[]): EnvelopeInput[] {
  return files.map((f) => ({
    path: f.path,
    size: f.size,
    mediaType: f.mediaType || "application/octet-stream",
    data: uriChunks(f.uri),
    ...(f.mtime !== undefined ? { mtime: Math.floor(f.mtime / 1000) } : {}),
  }));
}

export function sanitizePath(p: string): string {
  const segs = p
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.replace(/[\0]/g, "").trim())
    .filter((s) => s !== "" && s !== "." && s !== "..");
  return segs.join("/") || "file";
}

/** Some providers report no size; read it from the cached copy. */
function sizeOf(uri: string, reported: number | null | undefined): number {
  if (typeof reported === "number" && reported >= 0) return reported;
  return new File(uri).size ?? 0;
}

const CLOUD_HINT = /com\.google\.android\.apps\.docs|com\.apple\.CloudDocs|com\.microsoft\.skydrive|com\.dropbox|docs\.google/i;

export async function pickDocuments(): Promise<PickedFile[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
  if (r.canceled) return [];
  return r.assets.map((a) => ({
    path: sanitizePath(a.name),
    size: sizeOf(a.uri, a.size),
    mediaType: a.mimeType ?? "application/octet-stream",
    ...(a.lastModified ? { mtime: a.lastModified } : {}),
    source: CLOUD_HINT.test(a.uri) ? ("cloud" as const) : ("local" as const),
    uri: a.uri,
  }));
}

export async function pickPhotos(): Promise<PickedFile[]> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, quality: 1, exif: false });
  if (r.canceled) return [];
  return r.assets.map((a, i) => {
    const name = a.fileName ?? `photo-${i + 1}.${a.type === "video" ? "mp4" : "jpg"}`;
    return { path: sanitizePath(name), size: sizeOf(a.uri, a.fileSize), mediaType: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"), source: "photos" as const, uri: a.uri };
  });
}

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
