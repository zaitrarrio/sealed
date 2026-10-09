import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "../../src/bytes";
import { HpkeMode, deriveKeyPair, open, seal, setupRecipient, setupSender } from "../../src/crypto/hpke";
import { SoftwareAgreementKey } from "../../src/crypto/keys";
import { AuthenticationError } from "../../src/crypto/primitives";

interface Vector {
  mode: number;
  aead_id: number;
  info: string;
  ikmE: string;
  ikmR: string;
  ikmS?: string;
  skRm: string;
  pkRm: string;
  pkSm?: string;
  pkEm: string;
  enc: string;
  psk?: string;
  psk_id?: string;
  shared_secret: string;
  key: string;
  base_nonce: string;
  exporter_secret: string;
  encryptions: { aad: string; ct: string; nonce: string; pt: string }[];
}

const vectors = JSON.parse(readFileSync(new URL("../vectors/hpke-p256.json", import.meta.url), "utf8")) as Vector[];

describe("HPKE CFRG vectors, DHKEM(P-256, HKDF-SHA256)", () => {
  for (const v of vectors) {
    it(`mode ${v.mode} aead ${v.aead_id}`, async () => {
      const skE = deriveKeyPair(fromHex(v.ikmE));
      const skR = deriveKeyPair(fromHex(v.ikmR));
      expect(toHex(skE.publicKey)).toBe(v.pkEm);
      expect(toHex(skR.publicKey)).toBe(v.pkRm);
      expect(toHex(skR.secretKey)).toBe(v.skRm);
      const skS = v.ikmS ? deriveKeyPair(fromHex(v.ikmS)) : undefined;
      if (skS && v.pkSm) expect(toHex(skS.publicKey)).toBe(v.pkSm);
      const psk = v.psk ? fromHex(v.psk) : undefined;
      const pskId = v.psk_id ? fromHex(v.psk_id) : undefined;

      const sender = await setupSender({
        mode: v.mode as HpkeMode,
        aeadId: v.aead_id,
        recipientPublicKey: skR.publicKey,
        info: fromHex(v.info),
        ephemeral: skE,
        ...(skS ? { senderKey: skS } : {}),
        ...(psk ? { psk, pskId: pskId! } : {}),
      });
      expect(toHex(sender.enc)).toBe(v.enc);
      expect(toHex(sender.sharedSecret)).toBe(v.shared_secret);
      expect(toHex(sender.context.key)).toBe(v.key);
      expect(toHex(sender.context.baseNonce)).toBe(v.base_nonce);
      expect(toHex(sender.context.exporterSecret)).toBe(v.exporter_secret);

      const recipient = await setupRecipient({
        mode: v.mode as HpkeMode,
        aeadId: v.aead_id,
        enc: sender.enc,
        recipientKey: skR,
        info: fromHex(v.info),
        ...(skS ? { senderPublicKey: skS.publicKey } : {}),
        ...(psk ? { psk, pskId: pskId! } : {}),
      });
      for (const e of v.encryptions) {
        expect(toHex(sender.context.seal(fromHex(e.aad), fromHex(e.pt)))).toBe(e.ct);
        expect(toHex(recipient.open(fromHex(e.aad), fromHex(e.ct)))).toBe(e.pt);
      }
    });
  }
});

describe("HPKE single-shot (Sealed suite, AES-256-GCM)", () => {
  it("round-trips in Base and Auth modes", async () => {
    const r = new SoftwareAgreementKey();
    const s = new SoftwareAgreementKey();
    const info = utf8("sealed/v1/wrap");
    const pt = utf8("content key");
    const b = await seal({ recipientPublicKey: r.publicKey, info, plaintext: pt });
    expect(await open({ recipientKey: r, enc: b.enc, info, ciphertext: b.ciphertext })).toEqual(pt);
    const a = await seal({ recipientPublicKey: r.publicKey, info, plaintext: pt, senderKey: s });
    expect(await open({ recipientKey: r, enc: a.enc, info, ciphertext: a.ciphertext, senderPublicKey: s.publicKey })).toEqual(pt);
  });

  it("fails closed on wrong info, wrong sender, tampered enc and truncation", async () => {
    const r = new SoftwareAgreementKey();
    const s = new SoftwareAgreementKey();
    const info = utf8("ctx");
    const a = await seal({ recipientPublicKey: r.publicKey, info, plaintext: utf8("x"), senderKey: s });
    await expect(open({ recipientKey: r, enc: a.enc, info: utf8("other"), ciphertext: a.ciphertext, senderPublicKey: s.publicKey })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(open({ recipientKey: r, enc: a.enc, info, ciphertext: a.ciphertext, senderPublicKey: new SoftwareAgreementKey().publicKey })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(open({ recipientKey: r, enc: a.enc, info, ciphertext: a.ciphertext })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(open({ recipientKey: r, enc: a.enc, info, ciphertext: a.ciphertext.slice(0, -1), senderPublicKey: s.publicKey })).rejects.toBeInstanceOf(AuthenticationError);
    const badEnc = a.enc.slice();
    badEnc[10] = (badEnc[10] as number) ^ 1;
    await expect(open({ recipientKey: r, enc: badEnc, info, ciphertext: a.ciphertext, senderPublicKey: s.publicKey })).rejects.toThrow();
  });
});
