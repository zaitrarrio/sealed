import { SoftwareAgreementKey, randomBytes } from "@sealed/core";
import { beforeEach, describe, expect, it } from "vitest";
import { EncryptedStorage, allRecords, deserialize, kvGet, kvSet, putRecord, serialize, setStorageForTesting, type SecretBackend, type StorageBackend } from "../src/lib/storage";
import { ReceiveSink, decryptToCache, deleteReceived, listReceived, shareReceived, storeOpened } from "../src/lib/received";
import { __fs } from "./mocks/expo-file-system";
import { shared } from "./mocks/expo-sharing";

class MemFiles implements StorageBackend {
  m = new Map<string, Uint8Array>();
  async read(n: string) {
    return this.m.get(n) ?? null;
  }
  async write(n: string, b: Uint8Array) {
    this.m.set(n, b.slice());
  }
  async remove(n: string) {
    this.m.delete(n);
  }
}
class MemSecrets implements SecretBackend {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("encrypted storage", () => {
  it("round-trips JSON with byte arrays, encrypted on disk", async () => {
    const files = new MemFiles();
    const secrets = new MemSecrets();
    setStorageForTesting(new EncryptedStorage(files, secrets));
    const bytes = randomBytes(40);
    await kvSet("profile", { label: "Phone", raw: bytes, nested: [{ b: bytes.subarray(0, 3) }] });
    await putRecord("contacts", { id: "abc", name: "Ada" });
    const disk = files.m.get("kv")!;
    expect(new TextDecoder().decode(disk)).not.toContain("Phone");

    setStorageForTesting(new EncryptedStorage(files, secrets));
    const v = await kvGet<{ label: string; raw: Uint8Array; nested: { b: Uint8Array }[] }>("profile");
    expect(v?.label).toBe("Phone");
    expect(v?.raw).toEqual(bytes);
    expect(v?.nested[0]?.b).toEqual(bytes.subarray(0, 3));
    expect(await allRecords("contacts")).toEqual([{ id: "abc", name: "Ada" }]);
  });

  it("refuses a tampered store and a store moved under another name", async () => {
    const files = new MemFiles();
    const secrets = new MemSecrets();
    setStorageForTesting(new EncryptedStorage(files, secrets));
    await kvSet("x", 1);
    const sealed = files.m.get("kv")!;
    const flipped = sealed.slice();
    flipped[flipped.length - 1]! ^= 1;
    files.m.set("kv", flipped);
    setStorageForTesting(new EncryptedStorage(files, secrets));
    await expect(kvGet("x")).rejects.toThrow();
    files.m.set("kv", sealed);
    files.m.set("contacts", sealed);
    setStorageForTesting(new EncryptedStorage(files, secrets));
    await expect(allRecords("contacts")).rejects.toThrow();
  });

  it("recovers a replace interrupted between deleting the old file and moving the new one in", async () => {
    __fs.reset();
    const secrets = new MemSecrets();
    setStorageForTesting(new EncryptedStorage(undefined, secrets));
    await kvSet("k", "v");
    const bin = [...__fs.files.keys()].find((k) => k.endsWith("/kv.bin"))!;
    __fs.files.set(`${bin}.tmp`, __fs.files.get(bin)!);
    __fs.files.delete(bin);
    setStorageForTesting(new EncryptedStorage(undefined, secrets));
    expect(await kvGet("k")).toBe("v");
  });

  it("serializes tagged bytes", () => {
    const b = new Uint8Array([1, 2, 3]);
    expect(deserialize<{ b: Uint8Array }>(serialize({ b })).b).toEqual(b);
  });
});

describe("received files at rest", () => {
  beforeEach(() => {
    __fs.reset();
    shared.length = 0;
    setStorageForTesting(new EncryptedStorage(new MemFiles(), new MemSecrets()));
  });

  const entry = (path: string, size: number) => ({ path, size, mediaType: "application/octet-stream", sha256: new Uint8Array(32) });

  it("stores multi-chunk files encrypted and decrypts them for sharing", async () => {
    const device = new SoftwareAgreementKey();
    const big = randomBytes(2.5 * 1024 * 1024);
    const sink = new ReceiveSink(device, "Ada");
    sink.onFileStart();
    for (let off = 0; off < big.length; off += 300_000) await sink.onFileData(entry("a.bin", big.length), big.subarray(off, off + 300_000));
    await sink.onFileEnd(entry("a.bin", big.length));
    const [rec] = sink.files;
    expect(rec?.chunks).toBe(3);

    const stored = [...__fs.files.entries()].find(([k]) => k.endsWith(`${rec!.id}.sealed`))![1];
    expect(stored.length).toBe(big.length + 3 * 16);
    expect(Buffer.from(stored).includes(Buffer.from(big.subarray(0, 64)))).toBe(false);

    const out = await decryptToCache(rec!, device);
    expect(await out.bytes()).toEqual(big);
    expect((await listReceived()).map((r) => r.path)).toEqual(["a.bin"]);
    expect((await listReceived())[0]?.from).toBe("Ada");
  });

  it("needs this device's key, and shareReceived removes the plaintext copy", async () => {
    const device = new SoftwareAgreementKey();
    const [rec] = await storeOpened(device, [{ entry: entry("dir/note.txt", 5), data: new TextEncoder().encode("hello") }]);
    await expect(decryptToCache(rec!, new SoftwareAgreementKey())).rejects.toThrow();
    await shareReceived(rec!, device);
    expect(new TextDecoder().decode(shared[0]!.bytes)).toBe("hello");
    expect([...__fs.files.keys()].some((k) => k.startsWith("file:///cache/export"))).toBe(false);
  });

  it("handles empty files and deletion, and discard removes partial receives", async () => {
    const device = new SoftwareAgreementKey();
    const [rec] = await storeOpened(device, [{ entry: entry("empty", 0), data: new Uint8Array(0) }]);
    expect(await (await decryptToCache(rec!, device)).bytes()).toEqual(new Uint8Array(0));
    await deleteReceived(rec!.id);
    expect(await listReceived()).toEqual([]);

    const sink = new ReceiveSink(device);
    sink.onFileStart();
    await sink.onFileData(entry("x", 10), randomBytes(10));
    await sink.discard();
    expect([...__fs.files.keys()].filter((k) => k.endsWith(".sealed"))).toEqual([]);
  });

  it("keeps nothing when discarded while the last file is being finished", async () => {
    const device = new SoftwareAgreementKey();
    const sink = new ReceiveSink(device);
    sink.onFileStart();
    await sink.onFileData(entry("late.bin", 100), randomBytes(100));
    const ending = sink.onFileEnd(entry("late.bin", 100));
    await sink.discard();
    await expect(ending).rejects.toThrow(/cancelled/);
    expect(await listReceived()).toEqual([]);
    expect([...__fs.files.keys()].filter((k) => k.endsWith(".sealed"))).toEqual([]);
  });
});
