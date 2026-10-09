/**
 * Minimal promise wrapper over IndexedDB. One database per origin:
 *   kv        device keys, profile, settings (out-of-line string keys)
 *   contacts  pinned contacts, keyed by base64url fingerprint
 *   prekeys   one-time and medium-term prekey secrets, wrapped to this device's agreement key
 */
export const DB_NAME = "sealed";
export const DB_VERSION = 1;

export type StoreName = "kv" | "contacts" | "prekeys";

let opening: Promise<IDBDatabase> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("contacts")) db.createObjectStore("contacts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("prekeys")) db.createObjectStore("prekeys", { keyPath: "id" });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => {
      opening = null;
      reject(r.error ?? new Error("cannot open IndexedDB"));
    };
    r.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
  return opening;
}

/** Closes and forgets the cached connection (tests, and before deleting the database). */
export async function closeDb(): Promise<void> {
  if (!opening) return;
  const p = opening;
  opening = null;
  try {
    (await p).close();
  } catch {
    // never opened
  }
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  const t = db.transaction(store, mode);
  const result = req(run(t.objectStore(store)));
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
  return result;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await tx("kv", "readonly", (s) => s.get(key))) as T | undefined;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await tx("kv", "readwrite", (s) => s.put(value, key));
}

export async function kvDelete(key: string): Promise<void> {
  await tx("kv", "readwrite", (s) => s.delete(key));
}

export async function getRecord<T>(store: Exclude<StoreName, "kv">, id: string): Promise<T | undefined> {
  return (await tx(store, "readonly", (s) => s.get(id))) as T | undefined;
}

export async function putRecord<T extends { id: string }>(store: Exclude<StoreName, "kv">, value: T): Promise<void> {
  await tx(store, "readwrite", (s) => s.put(value));
}

export async function deleteRecord(store: Exclude<StoreName, "kv">, id: string): Promise<void> {
  await tx(store, "readwrite", (s) => s.delete(id));
}

export async function allRecords<T>(store: Exclude<StoreName, "kv">): Promise<T[]> {
  return (await tx(store, "readonly", (s) => s.getAll())) as T[];
}

export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, "readwrite", (s) => s.clear());
}
