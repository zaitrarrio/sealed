/**
 * QR profiles (ADR-0019): larger QR codes per frame, faster frame holds, several codes per screen. The receiver
 * learns the symbol size from the stream descriptor, so every combination must complete from detector strings.
 */
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/bytes";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { parseCode } from "../../src/protocol/codes";
import { QR_HOLDS, QR_PROFILES, isT0SymbolSize } from "../../src/facet/tiers";
import { FacetReceiver, FacetSender, createReverseKeyOffer, openOpticalEnvelope, prepareAirgapStream, prepareBroadcastStream } from "../../src/facet/index";
import { qrMatrix, readQr } from "../../src/facet/qr";
import { renderQrMatrix } from "../../src/facet/render";

const data = randomBytes(40_000);
const files = [{ path: "big.bin", mediaType: "application/octet-stream", size: data.length, data }];

/** Drives a sender into a receiver as a detector would: `perScreen` codes per display frame, 20 % missed. */
function stream(sender: FacetSender, receiver: FacetReceiver, perScreen: number, maxScreens = 400): number {
  let screens = 0;
  let n = 0;
  while (screens < maxScreens && !receiver.progress.complete) {
    screens++;
    for (let k = 0; k < perScreen; k++) {
      const text = sender.qrText(sender.next());
      if (text && n++ % 5 !== 2) receiver.pushQrCode(text);
    }
  }
  return screens;
}

describe("QR profiles", () => {
  it("every profile's symbol size is valid and fits its QR version", () => {
    for (const p of QR_PROFILES) {
      expect(isT0SymbolSize(p.symbolSize)).toBe(true);
      const m = qrMatrix(randomBytes(12), randomBytes(p.symbolSize));
      expect(m.size).toBe(p.qrVersion * 4 + 17);
    }
    expect(isT0SymbolSize(852)).toBe(false); // not a multiple of 8
    expect(isT0SymbolSize(4096)).toBe(false); // larger than any QR code holds
  });

  it("a version-40 frame still decodes from pixels", () => {
    const header = randomBytes(12);
    const payload = randomBytes(2848);
    const m = qrMatrix(header, payload);
    const bytes = readQr(renderQrMatrix(m.modules, m.size, 185 * 5));
    expect(bytes?.subarray(12)).toEqual(payload);
  });

  for (const p of QR_PROFILES) {
    it(`Air-gap completes at ${p.symbolSize} B per code (QR v${p.qrVersion}), and larger codes need fewer screens`, { timeout: 60_000 }, async () => {
      const device = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
      const offer = createReverseKeyOffer("https://sealed.to", device, "Phone", 0);
      const rk = parseCode(offer.code);
      if (rk.kind !== "reverse-key") throw new Error("expected a reverse key code");
      const { sender } = await prepareAirgapStream({ files, reverseKey: rk, senderLabel: "Laptop", qr: { symbolSize: p.symbolSize } });
      const receiver = new FacetReceiver();
      const screens = stream(sender, receiver, 1);
      expect(receiver.progress.complete).toBe(true);
      expect(receiver.progress.symbolSize).toBe(p.symbolSize);
      // 40 kB at T bytes per code, 20 % lost: about 40000 / T / 0.8 codes plus descriptors.
      expect(screens).toBeLessThan(Math.ceil(40_000 / p.symbolSize / 0.8) + 20);
      const opened = await openOpticalEnvelope(receiver, { device });
      expect(opened.files[0]!.data).toEqual(data);
    });
  }

  it("two codes per screen halve the screens needed", async () => {
    const one = await prepareBroadcastStream({ files, tier: 0, qr: { symbolSize: 1664 } });
    const two = await prepareBroadcastStream({ files, tier: 0, qr: { symbolSize: 1664 } });
    const r1 = new FacetReceiver();
    const r2 = new FacetReceiver();
    const s1 = stream(one.sender, r1, 1);
    const s2 = stream(two.sender, r2, 2);
    expect(r1.progress.complete && r2.progress.complete).toBe(true);
    expect(s2).toBeLessThanOrEqual(Math.ceil(s1 / 2) + 2);
  });

  it("a signed broadcast verifies at a large QR size", async () => {
    const publisher = { signing: new SoftwareSigningKey(), fingerprint: randomBytes(32), label: "Library" };
    const small = [{ path: "note.txt", mediaType: "text/plain", size: 5, data: utf8("hello") }];
    const { sender } = await prepareBroadcastStream({ files: small, tier: 0, publisher, qr: { symbolSize: 2848 } });
    const receiver = new FacetReceiver();
    stream(sender, receiver, 1);
    const opened = await openOpticalEnvelope(receiver, {});
    expect(opened.publisher?.signatureValid).toBe(true);
  });

  it("frames carry the requested hold, and invalid sizes are refused", async () => {
    for (const hold of QR_HOLDS) {
      const { sender } = await prepareBroadcastStream({ files, tier: 0, qr: { holdRefreshes60: hold } });
      expect(sender.next().holdRefreshes).toBe(hold);
    }
    await expect(prepareBroadcastStream({ files, tier: 0, qr: { symbolSize: 1004 } })).rejects.toThrow(/symbol size/);
  });

  it("a receiver ignores frames whose size disagrees with the stream's descriptor", async () => {
    const a = await prepareBroadcastStream({ files, tier: 0, qr: { symbolSize: 1664 } });
    const receiver = new FacetReceiver();
    // Lock onto stream A (descriptor first), then feed a forged frame of another size under A's stream id.
    for (let i = 0; i < 6; i++) receiver.pushQrCode(a.sender.qrText(a.sender.next())!);
    const before = receiver.progress.framesDecoded;
    const b = new FacetSender({ envelope: randomBytes(5000), tier: 0, streamId: a.sender.streamId, descriptor: { cek: randomBytes(32) }, qr: { symbolSize: 840 } });
    for (let i = 0; i < 10; i++) {
      const f = b.next();
      if (f.type === "data") receiver.pushQrCode(b.qrText(f)!);
    }
    expect(receiver.progress.framesDecoded).toBe(before);
  });
});
