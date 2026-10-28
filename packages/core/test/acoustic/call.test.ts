import { describe, expect, it } from "vitest";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { AuthenticationError, randomBytes } from "../../src/crypto/primitives";
import {
  callInfoBytes,
  createCallKeyMaterial,
  decodeSignal,
  dtlsMatches,
  encodeSignal,
  openCallFrame,
  sealCallFrame,
  unwrapCallKey,
  wrapInfo,
} from "../../src/index";

describe("paired call crypto", () => {
  it("wraps a call key with HPKE Auth and encrypts media frames", async () => {
    const alice = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const bob = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const session = randomBytes(16);
    const { callKey, wrap } = await createCallKeyMaterial(session, bob.agreement.publicKey, alice.agreement);
    const opened = await unwrapCallKey(wrap, bob.agreement, session, alice.agreement.publicKey);
    expect(opened).toEqual(callKey);
    expect(wrapInfo({ kind: "call", sessionId: session })).toEqual(callInfoBytes(session));

    const frame = randomBytes(120);
    const sealed = sealCallFrame(callKey, 0, frame);
    expect(openCallFrame(callKey, 0, sealed)).toEqual(frame);
    expect(() => openCallFrame(callKey, 1, sealed)).toThrow(AuthenticationError);
    const tampered = sealed.slice();
    tampered[0]! ^= 0xff;
    expect(() => openCallFrame(callKey, 0, tampered)).toThrow(AuthenticationError);
  });

  it("rejects a call offer whose DTLS fingerprint does not match the signed SDP", async () => {
    const alice = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const session = randomBytes(16);
    const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC:DD\r\n";
    const bytes = await encodeSignal(alice.signing, {
      kind: "offer",
      session,
      ts: Math.floor(Date.now() / 1000),
      body: sdp,
      dtlsFingerprint: "sha-256 11:22:33:44",
      call: true,
      callWrap: randomBytes(80),
    });
    const msg = decodeSignal(bytes, alice.signing.publicKey);
    expect(msg.call).toBe(true);
    expect(dtlsMatches(msg)).toBe(false);
  });

  it("accepts a matching fingerprint on a call signal", async () => {
    const alice = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const session = randomBytes(16);
    const fp = "sha-256 ab:cd:ef:01";
    const sdp = `v=0\r\na=fingerprint:${fp}\r\n`;
    const bytes = await encodeSignal(alice.signing, {
      kind: "offer",
      session,
      ts: Math.floor(Date.now() / 1000),
      body: sdp,
      dtlsFingerprint: fp,
      call: true,
    });
    const msg = decodeSignal(bytes, alice.signing.publicKey);
    expect(dtlsMatches(msg)).toBe(true);
    expect(msg.call).toBe(true);
  });

  it("refuses to open a call wrap for a non-pinned (wrong) sender", async () => {
    const alice = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const bob = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const eve = { agreement: new SoftwareAgreementKey(), signing: new SoftwareSigningKey() };
    const session = randomBytes(16);
    const { wrap } = await createCallKeyMaterial(session, bob.agreement.publicKey, alice.agreement);
    await expect(unwrapCallKey(wrap, bob.agreement, session, eve.agreement.publicKey)).rejects.toThrow();
  });
});
