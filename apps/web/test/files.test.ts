import { EnvelopeBuilder, EnvelopeReader, PayloadExtractor, randomBytes } from "@sealed/core";
import { describe, expect, it } from "vitest";
import { blobChunks, dedupePaths, sanitizePath, toEnvelopeInputs, type PickedFile } from "../src/lib/files";
import { tierForProbe } from "../src/lib/capability";

function picked(path: string, bytes: Uint8Array): PickedFile {
  return { path, size: bytes.length, mediaType: "application/octet-stream", source: "local", blob: new Blob([new Uint8Array(bytes)]) };
}

describe("file sources", () => {
  it("sanitizes paths into manifest-valid relative paths", () => {
    expect(sanitizePath("photos\\2026\\a.jpg")).toBe("photos/2026/a.jpg");
    expect(sanitizePath("/etc/../passwd")).toBe("etc/passwd");
    expect(sanitizePath("./a//b/")).toBe("a/b");
    expect(sanitizePath("..")).toBe("file");
  });

  it("dedupes colliding paths", () => {
    const out = dedupePaths([picked("a.txt", new Uint8Array(1)), picked("a.txt", new Uint8Array(1)), picked("dir/b", new Uint8Array(1)), picked("dir/b", new Uint8Array(1))]);
    expect(out.map((f) => f.path)).toEqual(["a.txt", "a (2).txt", "dir/b", "dir/b (2)"]);
  });

  it("streams blobs in bounded chunks", async () => {
    const data = randomBytes(2_500_000);
    const sizes: number[] = [];
    for await (const c of blobChunks(new Blob([new Uint8Array(data)]), 1024 * 1024)) sizes.push(c.length);
    expect(sizes).toEqual([1048576, 1048576, 402848]);
  });

  it("produces Envelope inputs that seal and open to the exact bytes", async () => {
    const a = randomBytes(1_300_000);
    const b = randomBytes(10);
    const inputs = toEnvelopeInputs([picked("x/a.bin", a), picked("b.bin", b)]);
    const cek = randomBytes(32);
    const transferId = randomBytes(16);
    const builder = new EnvelopeBuilder({ transferId, cek, ttlSeconds: 600 });
    const segs: Uint8Array[] = [];
    for await (const s of builder.build(inputs)) segs.push(s.bytes);
    const reader = await EnvelopeReader.open(builder.manifestPart(), cek);
    const out = new Map<string, Uint8Array[]>();
    const ex = new PayloadExtractor(reader.manifest, { onFileData: (e, chunk) => void (out.get(e.path) ?? out.set(e.path, []).get(e.path)!).push(chunk.slice()) });
    for (let i = 0; i < segs.length; i++) await ex.push(await reader.decryptSegment(i, segs[i]!), i === segs.length - 1);
    const join = (p: string) => Buffer.concat((out.get(p) ?? []).map((c) => Buffer.from(c)));
    expect(join("x/a.bin").equals(Buffer.from(a))).toBe(true);
    expect(join("b.bin").equals(Buffer.from(b))).toBe(true);
  });
});

describe("capture capability", () => {
  it("reports T1 for cameras with ≥ 24 fps at 720p, else T0", () => {
    expect(tierForProbe({ fps: 30, width: 1280, height: 720 })).toBe(1);
    expect(tierForProbe({ fps: 60, width: 1920, height: 1080 })).toBe(1);
    expect(tierForProbe({ fps: 15, width: 1920, height: 1080 })).toBe(0);
    expect(tierForProbe({ fps: 30, width: 640, height: 480 })).toBe(0);
  });
});
