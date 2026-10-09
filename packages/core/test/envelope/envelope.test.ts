import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/bytes";
import { SoftwareSigningKey } from "../../src/crypto/keys";
import { AuthenticationError, randomBytes } from "../../src/crypto/primitives";
import { EnvelopeBuilder, EnvelopeReader, HEADER_LENGTH, PayloadExtractor, openEnvelope, sealEnvelope, type EnvelopeInput } from "../../src/envelope/envelope";
import { Compression, ManifestError, SEGMENT_SIZE, sizeBucket, validatePath } from "../../src/envelope/manifest";

function pseudo(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const opts = () => ({ transferId: randomBytes(16), cek: randomBytes(32), ttlSeconds: 3600 });

describe("Envelope", () => {
  it.each([
    [Compression.None, [0]],
    [Compression.None, [1, 5, SEGMENT_SIZE]],
    [Compression.None, [SEGMENT_SIZE, SEGMENT_SIZE + 1, 3 * SEGMENT_SIZE - 7]],
    [Compression.Deflate, [10, 2 * SEGMENT_SIZE + 3]],
  ])("round-trips compression %s sizes %j", async (compression, sizes) => {
    const o = { ...opts(), compression };
    const inputs: EnvelopeInput[] = sizes.map((s, i) => ({ path: `dir/file-${i}.bin`, mediaType: "application/octet-stream", size: s, data: pseudo(s, i + 1) }));
    const { bytes, manifest } = await sealEnvelope(inputs, o);
    expect(bytes.length).toBe(sizeBucket(bytes.length));
    const opened = await openEnvelope(bytes, o.cek, { expectedTransferId: o.transferId });
    expect(opened.manifest.files.map((f) => f.size)).toEqual(sizes);
    expect(manifest.segmentCount).toBe(Math.max(1, Math.ceil(manifest.payloadLength / SEGMENT_SIZE)));
    opened.files.forEach((f, i) => expect(sameBytes(f.data, pseudo(sizes[i]!, i + 1))).toBe(true));
  });

  it("streams async iterables and verifies the sender signature", async () => {
    const key = new SoftwareSigningKey();
    const o = { ...opts(), sender: { key, label: "Pixel 8" } };
    async function* chunks() {
      for (let i = 0; i < 5; i++) yield pseudo(300_000, 9 + i);
    }
    const { bytes } = await sealEnvelope([{ path: "a.txt", mediaType: "text/plain", size: 1_500_000, data: chunks() }], o);
    const opened = await openEnvelope(bytes, o.cek, { requireSigner: key.publicKey });
    expect(opened.files[0]!.data.length).toBe(1_500_000);
    await expect(openEnvelope(bytes, o.cek, { requireSigner: new SoftwareSigningKey().publicKey })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects tampering, truncation, reordering and the wrong key", async () => {
    const o = { ...opts(), compression: Compression.None };
    const builder = new EnvelopeBuilder(o);
    const segs: Uint8Array[] = [];
    for await (const s of builder.build([{ path: "x", mediaType: "application/octet-stream", size: 3 * SEGMENT_SIZE, data: pseudo(3 * SEGMENT_SIZE, 3) }])) segs.push(s.bytes);
    const reader = await EnvelopeReader.open(builder.manifestPart(), o.cek);
    expect((await reader.decryptSegment(0, segs[0]!)).length).toBe(SEGMENT_SIZE);
    await expect(reader.decryptSegment(1, segs[0]!)).rejects.toBeInstanceOf(AuthenticationError); // reorder
    await expect(reader.decryptSegment(2, segs[1]!)).rejects.toThrow(); // truncation (non-last as last)
    const flipped = segs[2]!.slice();
    flipped[100] = (flipped[100] as number) ^ 1;
    await expect(reader.decryptSegment(2, flipped)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(EnvelopeReader.open(builder.manifestPart(), randomBytes(32))).rejects.toBeInstanceOf(AuthenticationError);
    const mp = builder.manifestPart().slice();
    mp[HEADER_LENGTH + 3] = (mp[HEADER_LENGTH + 3] as number) ^ 1;
    await expect(EnvelopeReader.open(mp, o.cek)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("detects a payload that does not match declared hashes", async () => {
    const o = { ...opts(), compression: Compression.None };
    const { bytes } = await sealEnvelope([{ path: "f", mediaType: "text/plain", size: 4, data: utf8("abcd") }], o);
    const reader = await EnvelopeReader.open(bytes, o.cek);
    const tampered = { ...reader.manifest, files: [{ ...reader.manifest.files[0]!, sha256: new Uint8Array(32) }] };
    const ex = new PayloadExtractor(tampered, { onFileData: () => undefined });
    const seg = await reader.decryptSegment(0, bytes.subarray(reader.segmentOffset(0)));
    await expect(ex.push(seg, true)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("validates paths", () => {
    for (const bad of ["/etc/passwd", "a/../b", "a//b", "C:/x", "a\\b", "", "./a", "a\0b"]) expect(() => validatePath(bad)).toThrow(ManifestError);
    expect(validatePath("Photos/Ünïcode.jpg")).toBe("Photos/Ünïcode.jpg".normalize("NFC"));
  });

  it("rejects duplicate paths and size mismatches", async () => {
    const o = opts();
    await expect(sealEnvelope([{ path: "a", mediaType: "x/y", size: 1, data: utf8("a") }, { path: "a", mediaType: "x/y", size: 1, data: utf8("b") }], o)).rejects.toBeInstanceOf(ManifestError);
    await expect(sealEnvelope([{ path: "a", mediaType: "x/y", size: 2, data: utf8("a") }], o)).rejects.toBeInstanceOf(ManifestError);
  });
});
