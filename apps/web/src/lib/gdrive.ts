/**
 * Google Drive source (spec §6.7, ADR-0014): Google Picker with the drive.file scope, OAuth via Google Identity
 * Services' token client. Only items the user picks become readable. Downloads run in this browser; the token
 * never reaches the relay. Google-native documents export to PDF. Folders expand to their direct and nested
 * files (drive.file grants access to a picked folder's contents for this session).
 */
import { env, driveConfigured } from "./config";
import type { PickedFile } from "./files";
import { sanitizePath } from "./files";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_FOLDER_FILES = 2000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
  callback: (r: TokenResponse) => void;
}

interface PickerDoc {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
}

interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  enableFeature(f: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(o: string): PickerBuilder;
  setCallback(cb: (data: Record<string, unknown>) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void; dispose(): void };
}

interface GoogleGlobal {
  accounts: { oauth2: { initTokenClient(o: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }): TokenClient } };
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => { setIncludeFolders(b: boolean): unknown; setSelectFolderEnabled(b: boolean): unknown; setMode(m: unknown): unknown };
    ViewId: { DOCS: unknown };
    Feature: { MULTISELECT_ENABLED: unknown; SUPPORT_DRIVES: unknown };
    DocsViewMode: { LIST: unknown };
    Action: { PICKED: string; CANCEL: string };
    Response: { ACTION: string; DOCUMENTS: string };
    Document: { ID: string; NAME: string; MIME_TYPE: string };
  };
}

interface GapiGlobal {
  load(lib: string, cb: { callback: () => void; onerror: () => void }): void;
}

declare global {
  interface Window {
    google?: GoogleGlobal;
    gapi?: GapiGlobal;
  }
}

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error(`could not load ${new URL(src).host}`));
      };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  await loadScript("https://accounts.google.com/gsi/client");
  const g = window.google;
  if (!g?.accounts?.oauth2) throw new Error("Google sign-in did not load");
  return new Promise<string>((resolve, reject) => {
    const client = g.accounts.oauth2.initTokenClient({
      client_id: env.google.clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          reject(new Error(r.error_description || r.error || "Google did not grant access"));
          return;
        }
        token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "The Google window was closed." : `Google sign-in failed (${e.type})`)),
    });
    client.requestAccessToken({ prompt: token ? "" : "consent" });
  });
}

async function loadPicker(): Promise<GoogleGlobal["picker"]> {
  await loadScript("https://apis.google.com/js/api.js");
  const gapi = window.gapi;
  if (!gapi) throw new Error("Google API loader did not load");
  await new Promise<void>((resolve, reject) => gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Picker did not load")) }));
  const picker = window.google?.picker;
  if (!picker) throw new Error("Google Picker is unavailable");
  return picker;
}

function pick(picker: GoogleGlobal["picker"], oauth: string): Promise<PickerDoc[]> {
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(true);
    view.setMode(picker.DocsViewMode.LIST);
    const p = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(oauth)
      .setDeveloperKey(env.google.apiKey)
      .setAppId(env.google.appId)
      .setOrigin(window.location.origin)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const docs = (data[picker.Response.DOCUMENTS] as Record<string, unknown>[]) ?? [];
          resolve(docs.map((d) => ({ id: String(d[picker.Document.ID]), name: String(d[picker.Document.NAME]), mimeType: String(d[picker.Document.MIME_TYPE]) })));
          p.dispose();
        } else if (action === picker.Action.CANCEL) {
          resolve([]);
          p.dispose();
        }
      })
      .build();
    p.setVisible(true);
  });
}

async function driveJson<T>(oauth: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${oauth}` } });
  if (!res.ok) throw new Error(`Google Drive returned ${res.status}`);
  return (await res.json()) as T;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

async function listFolder(oauth: string, folderId: string, prefix: string, out: { file: DriveFile; path: string }[]): Promise<void> {
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId.replace(/'/g, "")}' in parents and trashed = false`);
    const fields = encodeURIComponent("nextPageToken, files(id, name, mimeType, size, modifiedTime)");
    const r = await driveJson<{ files: DriveFile[]; nextPageToken?: string }>(
      oauth,
      `/files?q=${q}&fields=${fields}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    for (const f of r.files) {
      if (out.length >= MAX_FOLDER_FILES) throw new Error(`That folder has more than ${MAX_FOLDER_FILES} files.`);
      if (f.mimeType === FOLDER) await listFolder(oauth, f.id, `${prefix}${f.name}/`, out);
      else out.push({ file: f, path: `${prefix}${f.name}` });
    }
    pageToken = r.nextPageToken;
  } while (pageToken);
}

function isGoogleNative(mime: string): boolean {
  return mime.startsWith("application/vnd.google-apps.") && mime !== FOLDER;
}

async function download(oauth: string, f: DriveFile, path: string): Promise<PickedFile> {
  const native = isGoogleNative(f.mimeType);
  const url = native ? `${API}/files/${encodeURIComponent(f.id)}/export?mimeType=application/pdf` : `${API}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${oauth}` } });
  if (!res.ok) throw new Error(`Could not download "${f.name}" from Google Drive (${res.status}).`);
  const blob = await res.blob();
  const finalPath = native && !/\.pdf$/i.test(path) ? `${path}.pdf` : path;
  const mtime = f.modifiedTime ? Date.parse(f.modifiedTime) : undefined;
  return {
    path: sanitizePath(finalPath),
    size: blob.size,
    mediaType: native ? "application/pdf" : f.mimeType || blob.type || "application/octet-stream",
    ...(mtime !== undefined && Number.isFinite(mtime) ? { mtime } : {}),
    source: "gdrive",
    blob,
  };
}

export { driveConfigured };

/**
 * Opens the Picker and downloads what the user picked. `onProgress` reports files fetched so far.
 * Resolves to [] when the user cancels.
 */
export async function pickFromDrive(onProgress?: (done: number, total: number) => void): Promise<PickedFile[]> {
  if (!driveConfigured()) throw new Error("Google Drive is not configured for this site.");
  const oauth = await accessToken();
  const picker = await loadPicker();
  const docs = await pick(picker, oauth);
  if (docs.length === 0) return [];
  const targets: { file: DriveFile; path: string }[] = [];
  for (const d of docs) {
    if (d.mimeType === FOLDER) await listFolder(oauth, d.id, `${d.name}/`, targets);
    else {
      const meta = await driveJson<DriveFile>(oauth, `/files/${encodeURIComponent(d.id)}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`);
      targets.push({ file: meta, path: meta.name });
    }
  }
  const out: PickedFile[] = [];
  for (const t of targets) {
    out.push(await download(oauth, t.file, t.path));
    onProgress?.(out.length, targets.length);
  }
  return out;
}
