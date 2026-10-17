import { describe, expect, it } from "vitest";
import { FacetReceiver, FacetSender, createReverseKeyOffer, openOpticalEnvelope, prepareAirgapStream } from "../../src/facet/index";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { parseCode } from "../../src/protocol/codes";

/** The sender's internal frame (header ∥ payload), as the native decoder would hand it over. */
function frameBytes(sender: FacetSender, sequence: number): Uint8Array {
  const f = (sender as unknown as { frames: Map<number, { header: Uint8Array; payload: Uint8Array }> }).frames.get(sequence)!;
  const out = new Uint8Array(f.header.length + f.payload.length);
  out.set(f.header);
  out.set(f.payload, f.header.length);
  return out;
}

describe("FacetReceiver.pushFrameBytes", () => {
  it("completes a T1 Air-gap transfer from grid frames given as bytes, ignoring frames of the wrong size", async () => {
    const rx = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", rx, "rx", 1);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected a reverse key");
    const data = new Uint8Array(40_000);
    for (let i = 0, x = 7; i < data.length; i++) data[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >>> 16;
    const files = [{ path: "a.bin", mediaType: "application/octet-stream", size: data.length, data }];
    const { sender } = await prepareAirgapStream({ files, reverseKey: rk, senderLabel: "tx", tier: 1 });
    const receiver = new FacetReceiver({ tiers: [1] });
    let frames = 0;
    for (let i = 0; i < 400 && !receiver.progress.complete; i++) {
      const f = sender.next();
      const bytes = frameBytes(sender, f.sequence);
      if (i === 5) receiver.pushFrameBytes(bytes.subarray(0, bytes.length - 8)); // truncated: must be ignored
      receiver.pushFrameBytes(bytes, i * 100);
      frames++;
    }
    expect(receiver.progress.complete).toBe(true);
    expect(receiver.progress.framesDecoded).toBeGreaterThan(frames / 2);
    const opened = await openOpticalEnvelope(receiver, { device: rx });
    expect(opened.files[0]!.data).toEqual(data);
  });
  it("ignores tiers the receiver does not allow", async () => {
    const rx = new SoftwareAgreementKey();
    const offer = createReverseKeyOffer("https://sealed.to", { agreement: rx }, "rx", 1);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected a reverse key");
    const data = new Uint8Array(1000);
    const { sender } = await prepareAirgapStream({ files: [{ path: "a.bin", mediaType: "application/octet-stream", size: data.length, data }], reverseKey: rk, senderLabel: "tx", tier: 1 });
    const receiver = new FacetReceiver({ tiers: [0] });
    for (let i = 0; i < 20; i++) receiver.pushFrameBytes(frameBytes(sender, sender.next().sequence));
    expect(receiver.progress.framesDecoded).toBe(0);
  });
});
