import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/bytes";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { parseCode } from "../../src/protocol/codes";
import { FacetReceiver, airgapReceiverSas, createReverseKeyOffer, openOpticalEnvelope, prepareAirgapStream, prepareBroadcastStream, type FacetSender } from "../../src/facet/index";

const keys = () => ({ agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() });
const files = [
  { path: "notes/plan.txt", mediaType: "text/plain", size: 11, data: utf8("hello world") },
  { path: "data.bin", mediaType: "application/octet-stream", size: 9_000, data: randomBytes(9_000) },
];

/** Feeds rendered frames straight to the receiver (the camera channel is covered by roundtrip.test.ts). */
function stream(sender: FacetSender, receiver: FacetReceiver, max = 120): void {
  for (let i = 0; i < max && !receiver.progress.complete; i++) receiver.push(sender.render(sender.next(), 900));
}

describe("Air-gap (spec §6.5)", () => {
  for (const pinned of [false, true]) {
    it(pinned ? "with a pinned sender (HPKE Auth)" : "with an ephemeral sender key", { timeout: 120_000 }, async () => {
      const receiverKeys = keys();
      const senderKeys = keys();
      const offer = createReverseKeyOffer("https://sealed.to", receiverKeys, "Offline phone", 1);
      const rk = parseCode(offer.code);
      if (rk.kind !== "reverse-key") throw new Error("expected reverse-key code");
      const { sender, sas } = await prepareAirgapStream({ files, reverseKey: rk, senderLabel: "Laptop", ...(pinned ? { senderKeys } : {}) });
      const receiver = new FacetReceiver();
      stream(sender, receiver);
      expect(receiver.progress.complete).toBe(true);
      expect(airgapReceiverSas(receiver, offer.nonce, receiverKeys.agreement.publicKey)).toBe(sas);
      const opened = await openOpticalEnvelope(receiver, { device: receiverKeys, ...(pinned ? { expectedSenderAgreementKey: senderKeys.agreement.publicKey } : {}) });
      expect(opened.mode).toBe("airgap");
      expect(opened.files.map((f) => f.entry.path)).toEqual(["notes/plan.txt", "data.bin"]);
      expect(opened.files[1]!.data).toEqual(files[1]!.data);
      await expect(openOpticalEnvelope(receiver, { device: keys() })).rejects.toThrow(/unwrap/);
    });
  }
});

describe("Broadcast (spec §6.6)", () => {
  it("unsigned", { timeout: 120_000 }, async () => {
    const { sender } = await prepareBroadcastStream({ files, tier: 1 });
    const receiver = new FacetReceiver();
    stream(sender, receiver);
    const opened = await openOpticalEnvelope(receiver, {});
    expect(opened.mode).toBe("broadcast");
    expect(opened.publisher).toBeUndefined();
    expect(opened.files[0]!.data).toEqual(utf8("hello world"));
  });

  it("signed by a publisher, readable by a T0-only receiver through the interleaved stream", { timeout: 240_000 }, async () => {
    const publisher = { signing: new SoftwareSigningKey(), fingerprint: randomBytes(32), label: "County EOC" };
    const small = [{ path: "map.txt", mediaType: "text/plain", size: 1500, data: randomBytes(1500) }];
    const { sender } = await prepareBroadcastStream({ files: small, tier: 1, publisher, interleaveCompatible: true });
    const gridReceiver = new FacetReceiver();
    const qrOnly = new FacetReceiver({ tiers: [0] });
    for (let i = 0; i < 200 && !(gridReceiver.progress.complete && qrOnly.progress.complete); i++) {
      const img = sender.render(sender.next(), 900);
      gridReceiver.push(img);
      qrOnly.push(img);
    }
    for (const r of [gridReceiver, qrOnly]) {
      const opened = await openOpticalEnvelope(r, {});
      expect(opened.publisher?.signatureValid).toBe(true);
      expect(opened.publisher?.signingKey).toEqual(publisher.signing.publicKey);
      expect(opened.files[0]!.data).toEqual(small[0]!.data);
    }
  });
});
