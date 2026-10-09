import { describe, expect, it } from "vitest";
import { SoftwareAgreementKey, SoftwareSigningKey } from "../../src/crypto/keys";
import { randomBytes } from "../../src/crypto/primitives";
import { ChainError, activeDevices, cosignAddDevice, createIdentity, decodeLink, encodeLink, extendChain, makeLink, rotateMpkStatement, verifyChain } from "../../src/identity/sigchain";

async function device(label: string) {
  const signing = new SoftwareSigningKey();
  const agreement = new SoftwareAgreementKey();
  return { signing, agreement, label };
}

async function addDeviceStatement(d: Awaited<ReturnType<typeof device>>) {
  const base = { type: "add_device" as const, agreementPublicKey: d.agreement.publicKey, signingPublicKey: d.signing.publicKey, label: d.label, protection: "software" as const };
  return { ...base, cosig: await cosignAddDevice(d.signing, base) };
}

describe("sigchain", () => {
  it("creates, extends, revokes and rotates prekeys", async () => {
    const phone = await device("iPhone");
    const { link: l0, state: s0 } = await createIdentity({ signing: phone.signing, agreementPublicKey: phone.agreement.publicKey, label: "iPhone", protection: "software" });
    const laptop = await device("Laptop");
    const l1 = await makeLink(s0, phone.signing, await addDeviceStatement(laptop));
    const s1 = extendChain(s0, [l1]);
    expect(activeDevices(s1)).toHaveLength(2);
    const paper = new SoftwareSigningKey();
    const l2 = await makeLink(s1, laptop.signing, { type: "add_paper_key", signingPublicKey: paper.publicKey });
    const s2 = extendChain(s1, [l2]);
    const l3 = await makeLink(s2, paper, { type: "revoke_device", signingPublicKey: phone.signing.publicKey, reason: "lost" });
    const s3 = extendChain(s2, [l3]);
    expect(activeDevices(s3).map((d) => d.label)).toEqual(["Laptop"]);
    const mpk = new SoftwareAgreementKey();
    const l4 = await makeLink(s3, laptop.signing, await rotateMpkStatement(laptop.signing, mpk.publicKey, randomBytes(8), 2_000_000_000));
    const s4 = extendChain(s3, [l4]);
    expect(activeDevices(s4)[0]!.mpk?.publicKey).toEqual(mpk.publicKey);
    const full = verifyChain([l0, l1, l2, l3, l4], s0.fingerprint);
    expect(full.headHash).toEqual(s4.headHash);
    // Overlapping prefixes are accepted when they match.
    expect(extendChain(s2, [l1, l2, l3]).seq).toBe(3);
  });

  it("rejects revoked signers, forged links, reordering, wrong identities and forks", async () => {
    const a = await device("A");
    const { link: l0, state: s0 } = await createIdentity({ signing: a.signing, agreementPublicKey: a.agreement.publicKey, label: "A", protection: "software" });
    const b = await device("B");
    const l1 = await makeLink(s0, a.signing, await addDeviceStatement(b));
    const s1 = extendChain(s0, [l1]);
    const l2 = await makeLink(s1, b.signing, { type: "revoke_device", signingPublicKey: a.signing.publicKey, reason: "" });
    const s2 = extendChain(s1, [l2]);
    const c = await device("C");
    const byRevoked = await makeLink(s2, a.signing, await addDeviceStatement(c));
    expect(() => extendChain(s2, [byRevoked])).toThrow(ChainError);

    const stranger = new SoftwareSigningKey();
    const byStranger = await makeLink(s1, stranger, await addDeviceStatement(c));
    expect(() => extendChain(s1, [byStranger])).toThrow(/signer/);

    const tampered = decodeLink(l1);
    tampered.ts += 1;
    expect(() => extendChain(s0, [encodeLink(tampered)])).toThrow(/signature/);

    expect(() => verifyChain([l1, l0])).toThrow(ChainError);
    const other = await createIdentity({ signing: c.signing, agreementPublicKey: c.agreement.publicKey, label: "C", protection: "software" });
    expect(() => verifyChain([l0, l1], other.state.fingerprint)).toThrow(/pinned/);

    // A different link at seq 1 is a fork relative to verified history.
    const d = await device("D");
    const fork = await makeLink(s0, a.signing, await addDeviceStatement(d));
    expect(() => extendChain(s2, [fork])).toThrow(/fork/);
  });

  it("requires a valid co-signature from the added device", async () => {
    const a = await device("A");
    const { state } = await createIdentity({ signing: a.signing, agreementPublicKey: a.agreement.publicKey, label: "A", protection: "software" });
    const b = await device("B");
    const st = await addDeviceStatement(b);
    const forged = await makeLink(state, a.signing, { ...st, cosig: await cosignAddDevice(a.signing, { ...st }) });
    expect(() => extendChain(state, [forged])).toThrow(/co-signature/);
  });
});
