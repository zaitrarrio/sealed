/**
 * T0 frames as text: Base45 (RFC 9285 vectors), frames rendered as alphanumeric QR still read by the image path,
 * and complete Air-gap and Broadcast transfers fed only with the strings a system QR detector returns —
 * out of order, duplicated, mixed with unrelated codes, with frames missing.
 */
import { describe, expect, it } from "vitest";
import { parseCode } from "../../src/protocol/codes";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { utf8 } from "../../src/bytes";
import { base45Decode, base45Encode } from "../../src/facet/base45";
import { QR_FRAME_BYTES, qrFrameBytes, qrFrameText, qrMatrix, readQr } from "../../src/facet/qr";
import { FacetReceiver, airgapReceiverSas, createReverseKeyOffer, openOpticalEnvelope, prepareAirgapStream, prepareBroadcastStream, type FacetSender } from "../../src/facet/index";
import { renderQrMatrix } from "../../src/facet/render";

describe("Base45 (RFC 9285)", () => {
  it("matches the RFC test vectors and round-trips arbitrary bytes", () => {
    const enc = (s: string) => base45Encode(utf8(s));
    expect(enc("AB")).toBe("BB8");
    expect(enc("Hello!!")).toBe("%69 VD92EX0");
    expect(enc("base-45")).toBe("UJCLQE7W581");
    expect(enc("ietf!")).toBe("QED8WEX0");
    expect(new TextDecoder().decode(base45Decode("QED8WEX0")!)).toBe("ietf!");
    for (const n of [0, 1, 2, 3, 851, 852]) {
      const b = randomBytes(n);
      expect(base45Decode(base45Encode(b))).toEqual(b);
    }
  });

  it("rejects text that is not Base45", () => {
    expect(base45Decode("GGW")).toBeNull(); // 65535 < value overflow: G=16 → 16+16*45+32*2025 > 0xffff
    expect(base45Decode("abc")).toBeNull(); // lowercase is outside the alphabet
    expect(base45Decode("A")).toBeNull(); // length ≡ 1 (mod 3)
    expect(base45Decode("https://sealed.to/c/x")).toBeNull();
  });
});

describe("T0 frames as text", () => {
  it("fits QR version 21-L and still decodes from pixels", () => {
    const header = randomBytes(12);
    const payload = randomBytes(840);
    const text = qrFrameText(header, payload);
    expect(text.length).toBe(1278);
    const m = qrMatrix(header, payload);
    expect(m.size).toBe(21 * 4 + 17);
    const bytes = readQr(renderQrMatrix(m.modules, m.size, 700));
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(QR_FRAME_BYTES);
    expect(bytes!.subarray(0, 12)).toEqual(header);
    expect(bytes!.subarray(12)).toEqual(payload);
  });

  it("accepts text, raw bytes, and text exposed as bytes", () => {
    const frame = randomBytes(QR_FRAME_BYTES);
    const text = base45Encode(frame);
    expect(qrFrameBytes(text)).toEqual(frame);
    expect(qrFrameBytes(frame)).toEqual(frame);
    expect(qrFrameBytes(Uint8Array.from(text, (c) => c.charCodeAt(0)))).toEqual(frame);
    expect(qrFrameBytes("https://sealed.to/k#abc")).toBeNull();
    expect(qrFrameBytes(randomBytes(100))).toBeNull();
  });
});

/** The strings a system QR detector would report for `count` sender frames: every frame, as text. */
function detectedStrings(sender: FacetSender, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = sender.qrText(sender.next());
    if (text) out.push(text);
  }
  return out;
}

/** A detector's view: duplicates (the code stays on screen for several camera frames), losses, stray codes. */
function noisy(codes: string[], seed = 7): string[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const out: string[] = [];
  for (const c of codes) {
    if (rnd() < 0.3) continue; // missed
    const reps = 1 + Math.floor(rnd() * 3);
    for (let r = 0; r < reps; r++) out.push(c);
    if (rnd() < 0.1) out.push("https://example.com/not-sealed");
  }
  return out;
}

const files = [
  { path: "notes/plan.txt", mediaType: "text/plain", size: 11, data: utf8("hello world") },
  { path: "data.bin", mediaType: "application/octet-stream", size: 12_000, data: randomBytes(12_000) },
];

describe("transfers through a system QR detector", () => {
  it("Air-gap at T0: completes from detector strings alone, check codes agree", async () => {
    const device = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", device, "Phone", 0);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected a reverse key code");
    const { sender, sas } = await prepareAirgapStream({ files, reverseKey: rk, senderLabel: "Laptop" });
    const receiver = new FacetReceiver();
    let t = 0;
    for (const code of noisy(detectedStrings(sender, 200))) {
      receiver.pushQrCode(code, (t += 50));
      if (receiver.progress.complete) break;
    }
    expect(receiver.progress.complete).toBe(true);
    expect(airgapReceiverSas(receiver, offer.nonce, device.agreement.publicKey)).toBe(sas);
    const opened = await openOpticalEnvelope(receiver, { device });
    expect(opened.files[1]!.data).toEqual(files[1]!.data);
  });

  it("Broadcast at T0: completes when the receiver starts mid-stream", async () => {
    const { sender } = await prepareBroadcastStream({ files, tier: 0 });
    detectedStrings(sender, 37); // the receiver arrives late
    const receiver = new FacetReceiver();
    for (const code of noisy(detectedStrings(sender, 300), 11)) {
      receiver.pushQrCode(code);
      if (receiver.progress.complete) break;
    }
    expect(receiver.progress.complete).toBe(true);
    const opened = await openOpticalEnvelope(receiver, {});
    expect(opened.files.map((f) => f.entry.path)).toEqual(["notes/plan.txt", "data.bin"]);
  });
});
