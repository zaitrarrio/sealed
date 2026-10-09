/**
 * Encrypted local storage for the app's small structured state (profile, settings, contacts, prekey records).
 * Same API as the web client's IndexedDB layer (apps/web/src/lib/idb.ts) so the shared app logic ports
 * unchanged.
 *
 * Each store is one file under the app's document directory, sealed with AES-256-GCM under a random 256-bit
 * storage key kept in the platform keystore through expo-secure-store (iOS Keychain, Android Keystore-backed
 * encrypted preferences), accessible only after first unlock on this device. Records are JSON with byte arrays
 * tagged, so `Uint8Array` fields round-trip. Writes are serialized per store and replace the file atomically.
 */
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { aesGcmOpen, aesGcmSeal, fromB64url, fromUtf8, randomBytes, toB64url, utf8 } from "@sealed/core";

export type StoreName = "kv" | "contacts" | "prekeys";

const STORAGE_KEY_ITEM = "sealed.storage-key.v1";
const DIR_NAME = "sealed-state";
const AAD_PREFIX = "sealed/v1/storage/";

/** Pluggable backends so the logic is testable off-device. */
export interface StorageBackend {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface SecretBackend {
  get(item: string): Promise<string | null>;
  set(item: string, value: string): Promise<void>;
}

class ExpoFileBackend implements StorageBackend {
  private dir(): Directory {
    const d = new Directory(Paths.document, DIR_NAME);
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    return d;
  }

  async read(name: string): Promise<Uint8Array | null> {
    const f = new File(this.dir(), `${name}.bin`);
    if (!f.exists) return null;
    return new Uint8Array(await f.bytes());
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const dir = this.dir();
    const tmp = new File(dir, `${name}.bin.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    tmp.write(bytes);
    const target = new File(dir, `${name}.bin`);
    if (target.exists) target.delete();
    tmp.move(target);
  }

  async remove(name: string): Promise<void> {
    const f = new File(this.dir(), `${name}.bin`);
    if (f.exists) f.delete();
  }
}

class SecureStoreBackend implements SecretBackend {
  get(item: string): Promise<string | null> {
    return SecureStore.getItemAsync(item, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  }
  set(item: string, value: string): Promise<void> {
    return SecureStore.setItemAsync(item, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  }
}

// ------------------------------------------------------------------ serialization

function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array) return { $b: toB64url(v) };
  return v;
}

function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "$b" && typeof o.$b === "string") return fromB64url(o.$b);
  }
  return v;
}

export function serialize(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value, replacer));
}

export function deserialize<T>(bytes: Uint8Array): T {
  return JSON.parse(fromUtf8(bytes), reviver) as T;
}

// ------------------------------------------------------------------ encrypted stores

type Table = Record<string, unknown>;

export class EncryptedStorage {
  private key: Promise<Uint8Array> | null = null;
  private cache = new Map<StoreName, Promise<Table>>();
  private queues = new Map<StoreName, Promise<void>>();

  constructor(
    private readonly files: StorageBackend = new ExpoFileBackend(),
    private readonly secrets: SecretBackend = new SecureStoreBackend(),
  ) {}

  private storageKey(): Promise<Uint8Array> {
    if (!this.key) {
      this.key = (async () => {
        const existing = await this.secrets.get(STORAGE_KEY_ITEM);
        if (existing) return fromB64url(existing);
        const fresh = randomBytes(32);
        await this.secrets.set(STORAGE_KEY_ITEM, toB64url(fresh));
        return fresh;
      })();
      this.key.catch(() => {
        this.key = null;
      });
    }
    return this.key;
  }

  private load(store: StoreName): Promise<Table> {
    let p = this.cache.get(store);
    if (!p) {
      p = (async () => {
        const sealed = await this.files.read(store);
        if (!sealed) return {};
        if (sealed.length < 12 + 16) throw new Error(`storage file ${store} is truncated`);
        const key = await this.storageKey();
        const plain = await aesGcmOpen(key, sealed.subarray(0, 12), sealed.subarray(12), utf8(AAD_PREFIX + store));
        return deserialize<Table>(plain);
      })();
      this.cache.set(store, p);
      p.catch(() => this.cache.delete(store));
    }
    return p;
  }

  private persist(store: StoreName, table: Table): Promise<void> {
    const prev = this.queues.get(store) ?? Promise.resolve();
    const next = prev.then(async () => {
      const key = await this.storageKey();
      const nonce = randomBytes(12);
      const ct = await aesGcmSeal(key, nonce, serialize(table), utf8(AAD_PREFIX + store));
      const out = new Uint8Array(12 + ct.length);
      out.set(nonce, 0);
      out.set(ct, 12);
      await this.files.write(store, out);
    });
    this.queues.set(store, next.catch(() => undefined));
    return next;
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return (await this.load(store))[id] as T | undefined;
  }

  async put(store: StoreName, id: string, value: unknown): Promise<void> {
    const table = await this.load(store);
    table[id] = value;
    await this.persist(store, table);
  }

  async delete(store: StoreName, id: string): Promise<void> {
    const table = await this.load(store);
    if (!(id in table)) return;
    delete table[id];
    await this.persist(store, table);
  }

  async all<T>(store: StoreName): Promise<T[]> {
    return Object.values(await this.load(store)) as T[];
  }

  async clear(store: StoreName): Promise<void> {
    this.cache.set(store, Promise.resolve({}));
    await this.files.remove(store);
  }
}

let shared: EncryptedStorage | null = null;

export function storage(): EncryptedStorage {
  if (!shared) shared = new EncryptedStorage();
  return shared;
}

/** Test hook: swap the backing stores. */
export function setStorageForTesting(s: EncryptedStorage | null): void {
  shared = s;
}

// API shape shared with apps/web/src/lib/idb.ts.

export function kvGet<T>(key: string): Promise<T | undefined> {
  return storage().get<T>("kv", key);
}

export function kvSet<T>(key: string, value: T): Promise<void> {
  return storage().put("kv", key, value);
}

export function kvDelete(key: string): Promise<void> {
  return storage().delete("kv", key);
}

export function getRecord<T>(store: Exclude<StoreName, "kv">, id: string): Promise<T | undefined> {
  return storage().get<T>(store, id);
}

export function putRecord<T extends { id: string }>(store: Exclude<StoreName, "kv">, value: T): Promise<void> {
  return storage().put(store, value.id, value);
}

export function deleteRecord(store: Exclude<StoreName, "kv">, id: string): Promise<void> {
  return storage().delete(store, id);
}

export function allRecords<T>(store: Exclude<StoreName, "kv">): Promise<T[]> {
  return storage().all<T>(store);
}

export function clearStore(store: StoreName): Promise<void> {
  return storage().clear(store);
}
