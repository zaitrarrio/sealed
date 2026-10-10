import { SoftwareAgreementKey, contactFromPeer, createIdentity, fromB64url, randomBytes, toB64url, verifyChain } from "@sealed/core";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { cachedChain, getContact, listContacts, recordFromContact, removeContact, saveContact, toContact } from "../src/lib/contacts-store";
import { defaultDeviceLabel, encodeChainLinks, loadOrCreateDeviceKeys, loadProfile, saveProfile, verifyCachedChain } from "../src/lib/device-store";
import { closeDb } from "../src/lib/idb";
import { IdbPrekeyStore } from "../src/lib/prekey-store";
import { deviceKeysFromStored, generateStoredDeviceKeys } from "../src/lib/webcrypto-keys";

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe("device store", () => {
  it("creates device keys once and returns the same non-extractable keys afterwards", async () => {
    const a = await loadOrCreateDeviceKeys();
    const b = await loadOrCreateDeviceKeys();
    expect(toB64url(a.agreement.publicKey)).toBe(toB64url(b.agreement.publicKey));
    expect(toB64url(a.signing.publicKey)).toBe(toB64url(b.signing.publicKey));
    expect(a.agreement.privateKey.extractable).toBe(false);
    // The persisted CryptoKey still works after a structured-clone round trip through IndexedDB.
    const peer = new SoftwareAgreementKey();
    expect(toB64url(await b.agreement.dh(peer.publicKey))).toBe(toB64url(await peer.dh(a.agreement.publicKey)));
  });

  it("persists the profile and re-verifies the cached chain against the fingerprint", async () => {
    const keys = await loadOrCreateDeviceKeys();
    const { link, state } = await createIdentity({ signing: keys.signing, agreementPublicKey: keys.agreement.publicKey, label: "Test", protection: "browser" });
    await saveProfile({ label: "Test", fingerprint: toB64url(state.fingerprint), chainLinks: encodeChainLinks([link]) });
    const p = await loadProfile();
    expect(p.label).toBe("Test");
    expect(verifyCachedChain(p)?.seq).toBe(0);
    // A tampered cache fails verification instead of being trusted.
    const bad = { ...p, fingerprint: toB64url(randomBytes(32)) };
    expect(verifyCachedChain(bad)).toBeNull();
  });

  it("derives a readable default device label", () => {
    expect(defaultDeviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(defaultDeviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(defaultDeviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Windows");
  });
});

describe("prekey store (wrapped to the device agreement key)", () => {
  it("round-trips one-time prekeys, stores only wrapped secrets, and deletes after use", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    const store = new IdbPrekeyStore(keys.agreement);
    const pk = new SoftwareAgreementKey();
    const id = randomBytes(8);
    await store.put(id, pk.secretKey);
    const recs = await store.list();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("one-time");
    // The stored blob is an HPKE wrap, not the secret.
    expect(Buffer.from(recs[0]!.wrapped).includes(Buffer.from(pk.secretKey))).toBe(false);
    expect(toB64url((await store.get(id))!)).toBe(toB64url(pk.secretKey));
    await store.delete(id);
    expect(await store.get(id)).toBeNull();
  });

  it("cannot be unwrapped by another device's key", async () => {
    const mine = deviceKeysFromStored(await generateStoredDeviceKeys());
    const other = deviceKeysFromStored(await generateStoredDeviceKeys());
    const id = randomBytes(8);
    await new IdbPrekeyStore(mine.agreement).put(id, new SoftwareAgreementKey().secretKey);
    await expect(new IdbPrekeyStore(other.agreement).get(id)).rejects.toThrow();
  });

  it("keeps medium-term prekeys through their retention window and drops them afterwards", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    const store = new IdbPrekeyStore(keys.agreement);
    const now = 1_800_000_000;
    const current = new SoftwareAgreementKey();
    const previous = new SoftwareAgreementKey();
    const ancient = new SoftwareAgreementKey();
    await store.putKind(randomBytes(8), current.secretKey, "medium-term", now + 7 * 86400);
    await store.putKind(randomBytes(8), previous.secretKey, "medium-term", now - 86400);
    await store.putKind(randomBytes(8), ancient.secretKey, "medium-term", now - 30 * 86400);
    const keysOut = await store.mediumTermKeys(now);
    expect(keysOut.map((k) => toB64url(k.key.publicKey))).toEqual([toB64url(current.publicKey), toB64url(previous.publicKey)]);
    expect(await store.list("medium-term")).toHaveLength(2);
  });
});

describe("contacts store", () => {
  it("saves, lists sorted, reloads the pinned chain, and removes contacts", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    const made = [];
    for (const name of ["Zoe", "Ana"]) {
      const { link, state } = await createIdentity({ signing: keys.signing, agreementPublicKey: keys.agreement.publicKey, label: name, protection: "browser", }, 1_700_000_000 + made.length);
      const contact = contactFromPeer({ chain: state, links: [link], nonce: randomBytes(16), label: name });
      await saveContact(recordFromContact(contact, [link]));
      made.push({ state, link });
    }
    const list = await listContacts();
    expect(list.map((c) => c.displayName)).toEqual(["Ana", "Zoe"]);
    const ana = list[0]!;
    const chain = cachedChain(ana);
    expect(chain && toB64url(chain.fingerprint)).toBe(ana.id);
    const c = toContact(ana);
    expect(toB64url(c.fingerprint)).toBe(ana.id);
    expect(c.pinnedSeq).toBe(0);
    expect(verifyChain(ana.chainLinks.map(fromB64url), c.fingerprint).seq).toBe(0);
    await removeContact(ana.id);
    expect(await getContact(ana.id)).toBeUndefined();
    expect(await listContacts()).toHaveLength(1);
  });

  it("treats a cached chain that does not verify as absent", async () => {
    const keys = deviceKeysFromStored(await generateStoredDeviceKeys());
    const { link, state } = await createIdentity({ signing: keys.signing, agreementPublicKey: keys.agreement.publicKey, label: "Eve", protection: "browser" });
    const rec = recordFromContact(contactFromPeer({ chain: state, links: [link], nonce: randomBytes(16), label: "Eve" }), [link]);
    const tampered = link.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    expect(cachedChain({ ...rec, chainLinks: [toB64url(tampered)] })).toBeNull();
  });
});
