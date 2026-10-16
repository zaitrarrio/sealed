/**
 * The mobile optical receive path end to end, minus the camera: Facet frames rendered by core, laid out the
 * way VisionCamera delivers them on iOS (BGRA, padded rows, upscaled), converted by frame-convert and decoded by
 * FacetDecodeSession — for both Air-gap (with the check code) and Broadcast.
 */
import { SoftwareAgreementKey, SoftwareSigningKey, createReverseKeyOffer, parseCode, prepareAirgapStream, prepareBroadcastStream, randomBytes, utf8, type FacetSender, type RgbaImage } from "@sealed/core";
import { describe, expect, it } from "vitest";
import { FacetDecodeSession, type DecodeResult } from "../src/lib/facet-decode";
import { toRgba } from "../src/lib/frame-convert";

/** RGBA frame → 2× upscaled BGRA with 64 bytes of row padding, as a camera would hand it over. */
function asCameraBgra(img: RgbaImage): { buf: Uint8Array; w: number; h: number; stride: number } {
  const w = img.width * 2;
  const h = img.height * 2;
  const stride = w * 4 + 64;
  const buf = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y >> 1) * img.width + (x >> 1)) * 4;
      const d = y * stride + x * 4;
      buf[d] = img.data[s + 2] as number;
      buf[d + 1] = img.data[s + 1] as number;
      buf[d + 2] = img.data[s] as number;
      buf[d + 3] = 255;
    }
  return { buf, w, h, stride };
}

async function run(sender: FacetSender, session: FacetDecodeSession, max = 120): Promise<{ result: DecodeResult; sas: string | null }> {
  let sas: string | null = null;
  for (let i = 0; i < max; i++) {
    const cam = asCameraBgra(sender.render(sender.next(), 700));
    const { update, result } = await session.push(toRgba(cam.buf, cam.w, cam.h, cam.stride, "rgb-bgra-8-bit", 1024), i * 33);
    sas = update.sas ?? sas;
    if (result) return { result, sas };
  }
  throw new Error("stream did not complete");
}

const files = [
  { path: "notes.txt", mediaType: "text/plain", size: 11, data: utf8("hello world") },
  { path: "blob.bin", mediaType: "application/octet-stream", size: 3000, data: randomBytes(3000) },
];

describe("optical receive on mobile", () => {
  it("Air-gap: decodes, shows the same check code as the sender, opens with the device key", { timeout: 240_000 }, async () => {
    const device = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", device, "Phone", 1);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected a reverse key code");
    const { sender, sas } = await prepareAirgapStream({ files, reverseKey: rk, senderLabel: "Laptop" });
    const { result, sas: seen } = await run(sender, new FacetDecodeSession({ mode: "airgap", airgap: { device, nonce: offer.nonce } }));
    expect(seen).toBe(sas);
    expect(result.mode).toBe("airgap");
    expect(result.files.map((f) => f.entry.path)).toEqual(["notes.txt", "blob.bin"]);
    expect(result.files[1]!.data).toEqual(files[1]!.data);
  });

  it("Broadcast: decodes and reports the publisher signature", { timeout: 240_000 }, async () => {
    const publisher = { signing: new SoftwareSigningKey(), fingerprint: randomBytes(32), label: "Library" };
    const { sender } = await prepareBroadcastStream({ files: [files[0]!], tier: 1, publisher });
    const { result } = await run(sender, new FacetDecodeSession({ mode: "broadcast" }));
    expect(result.mode).toBe("broadcast");
    expect(result.publisher?.signatureValid).toBe(true);
    expect(new TextDecoder().decode(result.files[0]!.data)).toBe("hello world");
  });
});

describe("optical receive through the platform QR detector (detector path)", () => {
  it("Air-gap at T0: the session completes from detector strings and shows the sender's safety code", { timeout: 120_000 }, async () => {
    const device = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", device, "Phone", 0);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected a reverse key code");
    const { sender, sas } = await prepareAirgapStream({ files, reverseKey: rk, senderLabel: "Laptop" });
    const session = new FacetDecodeSession({ mode: "airgap", airgap: { device, nonce: offer.nonce } });
    let seen: string | null = null;
    let result: DecodeResult | undefined;
    for (let i = 0; i < 300 && !result; i++) {
      const text = sender.qrText(sender.next());
      if (!text || i % 5 === 3) continue; // the detector misses some frames
      const r = await session.pushCode(text, i * 100);
      seen = r.update.sas ?? seen;
      result = r.result;
      // Stray codes in view (a poster, another app) are ignored.
      if (i === 10) await session.pushCode("https://example.com", i * 100);
    }
    expect(result).toBeDefined();
    expect(seen).toBe(sas);
    expect(result!.files[1]!.data).toEqual(files[1]!.data);
  });
});
