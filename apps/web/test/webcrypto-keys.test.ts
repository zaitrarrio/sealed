import { P256, SoftwareAgreementKey, randomBytes, signObject, signingInput, unwrapKey, utf8, verifyObject, verifyRaw, wrapKey } from "@sealed/core";
import { describe, expect, it } from "vitest";
import { WebCryptoAgreementKey, WebCryptoSigningKey, deviceKeysFromStored, generateStoredDeviceKeys } from "../src/lib/webcrypto-keys";

const HALF_N = P256.order >> 1n;

function sValue(sig: Uint8Array): bigint {
  let s = 0n;
  for (const b of sig.subarray(32)) s = (s << 8n) | BigInt(b);
  return s;
}

describe("WebCrypto device keys (ADR-0005, web)", () => {
  it("generates non-extractable P-256 keys with uncompressed public keys", async () => {
    const stored = await generateStoredDeviceKeys();
    expect(stored.agreementPrivate.extractable).toBe(false);
    expect(stored.signingPrivate.extractable).toBe(false);
    expect(stored.agreementPublic).toHaveLength(65);
    expect(stored.signingPublic[0]).toBe(4);
    expect(P256.isValidPublicKey(stored.agreementPublic)).toBe(true);
    const keys = deviceKeysFromStored(stored);
    expect(keys.agreement.protection).toBe("browser");
    expect(keys.signing.protection).toBe("browser");
    await expect(crypto.subtle.exportKey("pkcs8", stored.agreementPrivate)).rejects.toThrow();
  });

  it("dh returns the 32-byte x-coordinate and agrees with core's SoftwareAgreementKey in both directions", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    for (let i = 0; i < 8; i++) {
      const soft = new SoftwareAgreementKey();
      const a = await keys.agreement.dh(soft.publicKey);
      const b = await soft.dh(keys.agreement.publicKey);
      expect(a).toHaveLength(32);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });

  it("dh accepts compressed peer keys and rejects invalid points", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    const soft = new SoftwareAgreementKey();
    const compressed = P256.normalizePublicKey(soft.publicKey, true);
    expect(Buffer.from(await keys.agreement.dh(compressed)).equals(Buffer.from(await soft.dh(keys.agreement.publicKey)))).toBe(true);
    const bad = soft.publicKey.slice();
    bad[64] = (bad[64] as number) ^ 1;
    await expect(keys.agreement.dh(bad)).rejects.toThrow();
  });

  it("works as an HPKE recipient (Base and Auth) for core's wrapKey/unwrapKey", async () => {
    const recipient = deviceKeysFromStored(await generateStoredDeviceKeys());
    const sender = deviceKeysFromStored(await generateStoredDeviceKeys());
    const cek = randomBytes(32);
    const ctx = { kind: "direct" as const, transferId: randomBytes(16) };
    const base = await wrapKey(cek, recipient.agreement.publicKey, ctx);
    expect(Buffer.from(await unwrapKey(base, recipient.agreement, ctx)).equals(Buffer.from(cek))).toBe(true);
    const pctx = { kind: "paired" as const, transferId: randomBytes(16), prekeyId: new Uint8Array(8) };
    const auth = await wrapKey(cek, recipient.agreement.publicKey, pctx, sender.agreement);
    expect(Buffer.from(await unwrapKey(auth, recipient.agreement, pctx, sender.agreement.publicKey)).equals(Buffer.from(cek))).toBe(true);
    const other = new SoftwareAgreementKey();
    await expect(unwrapKey(auth, recipient.agreement, pctx, other.publicKey)).rejects.toThrow();
  });

  it("signatures are 64-byte r||s, always low-S, and verify with core verifyObject", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    for (let i = 0; i < 40; i++) {
      const obj = { 1: "sealed", 2: i, 3: randomBytes(16) };
      const raw = await keys.signing.sign(signingInput("request", obj));
      expect(raw).toHaveLength(64);
      expect(sValue(raw) <= HALF_N).toBe(true);
      expect(verifyObject(keys.signing.publicKey, "request", obj, raw)).toBe(true);
      const viaCore = await signObject(keys.signing, "link", obj);
      expect(verifyObject(keys.signing.publicKey, "link", obj, viaCore)).toBe(true);
      expect(verifyObject(keys.signing.publicKey, "manifest", obj, viaCore)).toBe(false);
    }
  });

  it("normalizes high-S signatures produced by WebCrypto", async () => {
    // Find a WebCrypto signature with high S, then check the adapter's output for the same key is low-S and valid.
    const stored = await generateStoredDeviceKeys();
    const key = new WebCryptoSigningKey(stored.signingPrivate, stored.signingPublic);
    const msg = new Uint8Array(utf8("high-s probe"));
    let sawHigh = false;
    for (let i = 0; i < 64 && !sawHigh; i++) {
      const native = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, stored.signingPrivate, msg));
      if (sValue(native) > HALF_N) {
        sawHigh = true;
        const fixed = P256.toLowS(native);
        expect(sValue(fixed) <= HALF_N).toBe(true);
        expect(verifyRaw(stored.signingPublic, msg, fixed)).toBe(true);
        // core's verify rejects the high-S original, which is why the adapter must normalize.
        expect(verifyRaw(stored.signingPublic, msg, native)).toBe(false);
      }
    }
    expect(sawHigh).toBe(true);
    const sig = await key.sign(msg);
    expect(sValue(sig) <= HALF_N).toBe(true);
    expect(verifyRaw(stored.signingPublic, msg, sig)).toBe(true);
  });

  it("rejects malformed public keys at construction", async () => {
    const stored = await generateStoredDeviceKeys();
    expect(() => new WebCryptoAgreementKey(stored.agreementPrivate, stored.agreementPublic.subarray(1))).toThrow();
    expect(() => new WebCryptoSigningKey(stored.signingPrivate, P256.normalizePublicKey(stored.signingPublic, true))).toThrow();
  });
});
