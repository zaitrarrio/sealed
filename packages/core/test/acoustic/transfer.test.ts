import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/bytes";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { parseCode } from "../../src/protocol/codes";
import {
  AcousticReceiver,
  AcousticSender,
  applyAcousticChannel,
  airgapAcousticReceiverSas,
  createReverseKeyOffer,
  encodePacket,
  openAcousticEnvelope,
  prepareAirgapAcousticStream,
  prepareBroadcastAcousticStream,
  acousticProfile,
} from "../../src/index";

const files = [{ path: "note.txt", mediaType: "text/plain", size: 11, data: utf8("hello world") }];

describe("acoustic transfer", () => {
  it("transfers an Envelope through PCM with RaptorQ (A0, clean channel)", { timeout: 60_000 }, async () => {
    const receiverKeys = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", receiverKeys, "Phone", 0);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected reverse-key");
    const { sender, sas } = await prepareAirgapAcousticStream({
      files,
      reverseKey: rk,
      senderLabel: "Laptop",
      profile: 0,
    });
    const receiver = new AcousticReceiver(0);
    // Feed packets until complete (direct packet path — modem covered separately).
    for (let i = 0; i < 800 && !receiver.progress.complete; i++) {
      receiver.pushPacket(sender.nextPacket());
    }
    expect(receiver.progress.complete).toBe(true);
    expect(airgapAcousticReceiverSas(receiver, offer.nonce, receiverKeys.agreement.publicKey)).toBe(sas);
    const opened = await openAcousticEnvelope(receiver, { device: receiverKeys });
    expect(opened.mode).toBe("airgap");
    expect(opened.files[0]!.data).toEqual(utf8("hello world"));
  });

  it("transfers through modulated PCM on a mild synthetic channel", { timeout: 120_000 }, async () => {
    const receiverKeys = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", receiverKeys, "Phone", 0);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected reverse-key");
    const small = [{ path: "x.bin", mediaType: "application/octet-stream", size: 64, data: randomBytes(64) }];
    const { sender } = await prepareAirgapAcousticStream({ files: small, reverseKey: rk, senderLabel: "A", profile: 0 });
    const receiver = new AcousticReceiver(0);
    const p = acousticProfile(0);
    for (let i = 0; i < 400 && !receiver.progress.complete; i++) {
      const pcm = applyAcousticChannel(sender.nextPcm(), p, { noiseStd: 0.008, seed: i + 1 });
      receiver.pushPcm(pcm);
    }
    expect(receiver.progress.complete).toBe(true);
    const opened = await openAcousticEnvelope(receiver, { device: receiverKeys });
    expect(opened.files[0]!.data).toEqual(small[0]!.data);
  });

  it("Broadcast over sound recovers without a device key", { timeout: 60_000 }, async () => {
    const { sender } = await prepareBroadcastAcousticStream({ files, profile: 0 });
    const receiver = new AcousticReceiver(0);
    for (let i = 0; i < 800 && !receiver.progress.complete; i++) receiver.pushPacket(sender.nextPacket());
    const opened = await openAcousticEnvelope(receiver, {});
    expect(opened.mode).toBe("broadcast");
    expect(opened.files[0]!.data).toEqual(utf8("hello world"));
  });

  it("PCM never contains the claim secret or raw CEK for Air-gap", { timeout: 60_000 }, async () => {
    const receiverKeys = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const offer = createReverseKeyOffer("https://sealed.to", receiverKeys, "Phone", 0);
    const rk = parseCode(offer.code);
    if (rk.kind !== "reverse-key") throw new Error("expected reverse-key");
    // Claim secret is not part of acoustic at all; reverse-key nonce must not appear as a raw packet payload either.
    const { sender } = await prepareAirgapAcousticStream({ files, reverseKey: rk, senderLabel: "Laptop", profile: 0 });
    const forbidden = [rk.nonce, offer.nonce];
    const receiver = new AcousticReceiver(0);
    for (let i = 0; i < 800 && !receiver.progress.complete; i++) {
      const pkt = sender.nextPacket();
      const raw = encodePacket(pkt);
      for (const secret of forbidden) {
        expect(containsSubarray(raw, secret)).toBe(false);
      }
      receiver.pushPacket(pkt);
    }
    expect(receiver.progress.complete).toBe(true);
    // Air-gap descriptor must carry a wrap, not a clear CEK — opening without device keys fails.
    await expect(openAcousticEnvelope(receiver, {})).rejects.toThrow(/device's keys/);
  });
});

function containsSubarray(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

// silence unused import when tree-shaking AcousticSender in some runners
void AcousticSender;
