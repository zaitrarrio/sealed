import { describe, expect, it } from "vitest";
import { toB64url } from "../../src/bytes";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { claimSas } from "../../src/crypto/sas";
import { unwrapKey, wrapKey } from "../../src/crypto/wrap";
import { createIdentity } from "../../src/identity/sigchain";
import { parseSignatureHeader, signRequest, verifyRequestSignature } from "../../src/protocol/auth";
import { claimCode, parseCode, reverseKeyCode, CodeError } from "../../src/protocol/codes";
import { SegmentAssembler, decodeFrame, decodeSignal, dtlsMatches, encodeFrame, encodeSignal, segmentFrames } from "../../src/protocol/live";
import { generatePrekeys, verifyPrekey } from "../../src/protocol/paired";
import { addDeviceCheckCode, createAddDeviceOffer, createPairingOffer, decodeContacts, decodePaperKey, encodeContacts, encodePaperKey } from "../../src/protocol/pairing";

describe("codes", () => {
  it("round-trips claim, pairing, add-device and reverse-key codes", async () => {
    const tid = randomBytes(16);
    const cs = randomBytes(16);
    const c = parseCode(claimCode("https://sealed.to", tid, cs), ["https://sealed.to"]);
    expect(c.kind).toBe("claim");
    if (c.kind === "claim") {
      expect(c.transferId).toEqual(tid);
      expect(c.claimSecret).toEqual(cs);
    }
    const signing = new SoftwareSigningKey();
    const agreement = new SoftwareAgreementKey();
    const { state } = await createIdentity({ signing, agreementPublicKey: agreement.publicKey, label: "Zay", protection: "software" });
    const offer = createPairingOffer("https://sealed.to", state, "Zay's iPhone");
    const p = parseCode(offer.code);
    expect(p.kind === "pair" && p.label).toBe("Zay's iPhone");
    const add = await createAddDeviceOffer("https://sealed.to", { signing, agreementPublicKey: agreement.publicKey, label: "Laptop", protection: "browser" });
    const a = parseCode(add.code);
    expect(a.kind).toBe("add-device");
    if (a.kind === "add-device") {
      expect(a.cosig).toEqual(add.statement.cosig);
      expect(addDeviceCheckCode(a)).toMatch(/^\d{3} \d{3}$/);
    }
    const k = parseCode(reverseKeyCode("http://localhost:5173", { receiverPublicKey: agreement.publicKey, nonce: randomBytes(16), tier: 2, label: "Offline phone" }));
    expect(k.kind === "reverse-key" && k.receiverPublicKey).toEqual(agreement.publicKey);
  });

  it("rejects foreign origins, plain http, and missing fragments", () => {
    const code = claimCode("https://sealed.to", randomBytes(16), randomBytes(16));
    expect(() => parseCode(code, ["https://other.example"])).toThrow(CodeError);
    expect(() => parseCode(code.replace("https:", "http:"))).toThrow(CodeError);
    expect(() => parseCode(code.split("#")[0]!)).toThrow(CodeError);
  });
});

describe("request signatures", () => {
  it("verifies, and rejects body tampering and stale timestamps", async () => {
    const key = new SoftwareSigningKey();
    const fp = randomBytes(32);
    const body = new TextEncoder().encode('{"a":1}');
    const h = await signRequest(key, fp, "post", "/v1/transfers", body, 1_000_000);
    const parts = parseSignatureHeader(h);
    expect(verifyRequestSignature(key.publicKey, parts, "POST", "/v1/transfers", body, 1_000_010)).toBe(true);
    expect(verifyRequestSignature(key.publicKey, parts, "POST", "/v1/transfers", new Uint8Array([1]), 1_000_010)).toBe(false);
    expect(verifyRequestSignature(key.publicKey, parts, "POST", "/v1/transfers?x=1", body, 1_000_010)).toBe(false);
    expect(verifyRequestSignature(key.publicKey, parts, "POST", "/v1/transfers", body, 1_000_500)).toBe(false);
  });
});

describe("wraps and check codes", () => {
  it("binds the claim SAS to the receiver key, and wraps to the claimed key only", async () => {
    const cs = randomBytes(16);
    const tid = randomBytes(16);
    const r = new SoftwareAgreementKey();
    const evil = new SoftwareAgreementKey();
    expect(claimSas(cs, tid, r.publicKey)).not.toBe(claimSas(cs, tid, evil.publicKey));
    const cek = randomBytes(32);
    const wrap = await wrapKey(cek, r.publicKey, { kind: "direct", transferId: tid });
    expect(await unwrapKey(wrap, r, { kind: "direct", transferId: tid })).toEqual(cek);
    await expect(unwrapKey(wrap, evil, { kind: "direct", transferId: tid })).rejects.toThrow();
    await expect(unwrapKey(wrap, r, { kind: "direct", transferId: randomBytes(16) })).rejects.toThrow();
  });
});

describe("prekeys, paper keys and contacts", () => {
  it("signs and verifies prekeys", async () => {
    const dev = new SoftwareSigningKey();
    const { signed } = await generatePrekeys(dev, 3);
    expect(signed.every((p) => verifyPrekey(dev.publicKey, p))).toBe(true);
    expect(verifyPrekey(new SoftwareSigningKey().publicKey, signed[0]!)).toBe(false);
    expect(verifyPrekey(dev.publicKey, { ...signed[0]!, pub: signed[1]!.pub })).toBe(false);
  });

  it("encodes paper keys with a checksum", () => {
    const fp = randomBytes(32);
    const k = new SoftwareSigningKey();
    const text = encodePaperKey(fp, k);
    const back = decodePaperKey(text.toLowerCase());
    expect(back.fingerprint).toEqual(fp);
    expect(back.key.publicKey).toEqual(k.publicKey);
    const broken = text.slice(0, 10) + (text[10] === "A" ? "B" : "A") + text.slice(11);
    expect(() => decodePaperKey(broken)).toThrow(/checksum/);
  });

  it("round-trips contacts", () => {
    const c = [{ fingerprint: randomBytes(32), displayName: "Ana", pinnedSeq: 3, pinnedHead: randomBytes(32), pairedAt: 1_700_000_000 }];
    expect(decodeContacts(encodeContacts(c))).toEqual(c);
  });
});

describe("live transfer framing", () => {
  it("signs signals and reassembles chunked segments out of order", async () => {
    const key = new SoftwareSigningKey();
    const sdp = "v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\n";
    const bytes = await encodeSignal(key, { kind: "offer", session: randomBytes(16), ts: 100, body: sdp, dtlsFingerprint: "sha-256 ab:cd:ef", transferId: toB64url(randomBytes(16)) });
    const msg = decodeSignal(bytes, key.publicKey, 110);
    expect(dtlsMatches(msg)).toBe(true);
    expect(() => decodeSignal(bytes, new SoftwareSigningKey().publicKey, 110)).toThrow(/signature/);
    expect(() => decodeSignal(bytes, key.publicKey, 1000)).toThrow(/stale/);

    const seg0 = randomBytes(150_000);
    const seg1 = randomBytes(1000);
    const frames = [...segmentFrames(0, seg0), ...segmentFrames(1, seg1)].map((f) => decodeFrame(encodeFrame(decodeFrame(f))));
    const asm = new SegmentAssembler();
    const out: Uint8Array[] = [];
    for (const f of [frames[3]!, frames[0]!, frames[2]!, frames[1]!]) if (f.t === "chunk") for (const s of asm.add(f)) out.push(s.bytes);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(seg0);
    expect(out[1]).toEqual(seg1);
  });
});
