/**
 * Pairing ceremony (spec §6.3.3) and device management (§6.3.4–6.3.5).
 * Mutual scan: each side shows a pairing code, scans the other's, verifies the scanned chain against the
 * fingerprint and head in the code, and both users confirm the same six-digit check code.
 */
import { concat, ctEqual, toB64url } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getBytes, getText, getUint } from "../cbor";
import type { KeyProtection, SigningKey } from "../crypto/keys";
import { SoftwareSigningKey } from "../crypto/keys";
import { randomBytes, sha256 } from "../crypto/primitives";
import { deviceSas, pairingSas } from "../crypto/sas";
import { cosignAddDevice, extendChain, makeLink, verifyChain, type ChainState, type Statement } from "../identity/sigchain";
import type { RelayClient } from "./client";
import { addDeviceCode, pairingCode, type ParsedCode } from "./codes";

export interface PairingOffer {
  nonce: Uint8Array;
  code: string;
}

export function createPairingOffer(origin: string, me: ChainState, label: string): PairingOffer {
  const nonce = randomBytes(16);
  return { nonce, code: pairingCode(origin, { fingerprint: me.fingerprint, headHash: me.headHash, headSeq: me.seq, nonce, label }) };
}

export interface ScannedPeer {
  chain: ChainState;
  /** The links `chain` was verified from; cache exactly these with the contact. */
  links: Uint8Array[];
  nonce: Uint8Array;
  label: string;
}

/** Fetches and verifies the scanned identity's chain; it must contain the scanned head at the scanned seq. */
export async function verifyScannedPairingCode(client: RelayClient, code: Extract<ParsedCode, { kind: "pair" }>): Promise<ScannedPeer> {
  const { links } = await client.getChain(code.fingerprint);
  const chain = verifyChain(links, code.fingerprint);
  const atSeq = chain.hashes[code.headSeq];
  if (!atSeq || !ctEqual(atSeq, code.headHash)) throw new Error("the relay's copy of this identity does not match the scanned code");
  return { chain, links: [...links], nonce: code.nonce, label: code.label };
}

export function pairingCheckCode(myNonce: Uint8Array, me: ChainState, peer: ScannedPeer): string {
  return pairingSas(myNonce, peer.nonce, me.fingerprint, peer.chain.fingerprint);
}

/** A pinned contact, stored only on the user's devices (never on the relay). */
export interface Contact {
  fingerprint: Uint8Array;
  displayName: string;
  pinnedSeq: number;
  pinnedHead: Uint8Array;
  pairedAt: number;
}

export function contactFromPeer(peer: ScannedPeer, displayName?: string): Contact {
  return { fingerprint: peer.chain.fingerprint, displayName: displayName ?? peer.label, pinnedSeq: peer.chain.seq, pinnedHead: peer.chain.headHash, pairedAt: Math.floor(Date.now() / 1000) };
}

export function encodeContacts(contacts: readonly Contact[]): Uint8Array {
  return encodeCbor({ v: 1, c: contacts.map((c) => ({ 1: c.fingerprint, 2: c.displayName, 3: c.pinnedSeq, 4: c.pinnedHead, 5: c.pairedAt })) });
}

export function decodeContacts(b: Uint8Array): Contact[] {
  const m = asMap(decodeCbor(b), "contacts");
  const list = m["c"];
  if (!Array.isArray(list)) throw new Error("contacts: bad shape");
  return (list as unknown[]).map((v, i) => {
    const c = asMap(v as never, `contact ${i}`);
    return { fingerprint: getBytes(c, 1, "contact", 32), displayName: getText(c, 2, "contact"), pinnedSeq: getUint(c, 3, "contact"), pinnedHead: getBytes(c, 4, "contact", 32), pairedAt: getUint(c, 5, "contact") };
  });
}

/**
 * Refreshes a contact's chain from the relay. Every new link must extend the pinned history; a fork or a
 * chain that no longer contains the pinned head throws, and the UI must block sending (ADR-0006).
 */
export async function refreshContactChain(client: RelayClient, contact: Contact, cached?: ChainState): Promise<{ chain: ChainState; changedDevices: boolean }> {
  const { links } = await client.getChain(contact.fingerprint);
  const chain = verifyChain(links, contact.fingerprint);
  const pinned = chain.hashes[contact.pinnedSeq];
  if (!pinned || !ctEqual(pinned, contact.pinnedHead)) throw new Error("contact identity forked from the pinned history");
  if (cached) extendChain(cached, links);
  const changedDevices = !cached || cached.seq !== chain.seq;
  return { chain, changedDevices };
}

// ------------------------------------------------------------------ adding devices

export interface NewDeviceOffer {
  nonce: Uint8Array;
  code: string;
  statement: Extract<Statement, { type: "add_device" }>;
}

/** On the NEW device: displays its keys and a precomputed co-signature so the existing device can add it. */
export async function createAddDeviceOffer(origin: string, device: { signing: SigningKey; agreementPublicKey: Uint8Array; label: string; protection: KeyProtection }): Promise<NewDeviceOffer> {
  const nonce = randomBytes(16);
  const base = { type: "add_device" as const, agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signing.publicKey, label: device.label, protection: device.protection };
  const cosig = await cosignAddDevice(device.signing, base);
  return {
    nonce,
    statement: { ...base, cosig },
    code: addDeviceCode(origin, { agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signing.publicKey, nonce, label: device.label, protection: device.protection, cosig }),
  };
}

export function addDeviceCheckCode(code: Extract<ParsedCode, { kind: "add-device" }>): string {
  return deviceSas(code.nonce, code.agreementPublicKey, code.signingPublicKey);
}

/** On the EXISTING device: appends the add_device link after the user confirmed the check code. */
export async function approveNewDevice(client: RelayClient, me: ChainState, signer: SigningKey, code: Extract<ParsedCode, { kind: "add-device" }>): Promise<ChainState> {
  const statement: Statement = { type: "add_device", agreementPublicKey: code.agreementPublicKey, signingPublicKey: code.signingPublicKey, label: code.label, protection: code.protection, cosig: code.cosig };
  const link = await makeLink(me, signer, statement);
  const next = extendChain(me, [link]);
  await client.appendLinks([link]);
  return next;
}

export async function revokeDevice(client: RelayClient, me: ChainState, signer: SigningKey, target: Uint8Array, reason: string): Promise<ChainState> {
  const link = await makeLink(me, signer, { type: "revoke_device", signingPublicKey: target, reason });
  const next = extendChain(me, [link]);
  await client.appendLinks([link]);
  return next;
}

// ------------------------------------------------------------------ paper keys

const B32 = "ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // Crockford-style, no I L O U

function b32encode(b: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function b32decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid paper key character");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Paper key text: base32 of fingerprint ∥ secret ∥ 4-byte checksum, grouped in fives. */
export function encodePaperKey(fingerprint: Uint8Array, key: SoftwareSigningKey): string {
  const body = concat(fingerprint, key.secretKey);
  const raw = b32encode(concat(body, sha256(body).slice(0, 4)));
  return raw.match(/.{1,5}/g)!.join("-");
}

export function decodePaperKey(text: string): { fingerprint: Uint8Array; key: SoftwareSigningKey } {
  const raw = b32decode(text).slice(0, 68);
  if (raw.length !== 68) throw new Error("paper key has the wrong length");
  const body = raw.slice(0, 64);
  if (!ctEqual(raw.slice(64), sha256(body).slice(0, 4))) throw new Error("paper key checksum mismatch");
  return { fingerprint: body.slice(0, 32), key: new SoftwareSigningKey(body.slice(32)) };
}

/** Creates a paper key and appends `add_paper_key`. Show the returned text once; never store it. */
export async function createPaperKey(client: RelayClient, me: ChainState, signer: SigningKey): Promise<{ text: string; chain: ChainState }> {
  const paper = new SoftwareSigningKey();
  const link = await makeLink(me, signer, { type: "add_paper_key", signingPublicKey: paper.publicKey });
  const next = extendChain(me, [link]);
  await client.appendLinks([link]);
  return { text: encodePaperKey(me.fingerprint, paper), chain: next };
}

/** Recovery on a fresh install: the paper key adds this device and revokes the listed lost devices. */
export async function recoverWithPaperKey(
  client: RelayClient,
  paperText: string,
  device: { signing: SigningKey; agreementPublicKey: Uint8Array; label: string; protection: KeyProtection },
  revoke: (state: ChainState) => Uint8Array[],
): Promise<ChainState> {
  const { fingerprint, key } = decodePaperKey(paperText);
  const { links } = await client.getChain(fingerprint);
  let state = verifyChain(links, fingerprint);
  const base = { type: "add_device" as const, agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signing.publicKey, label: device.label, protection: device.protection };
  const cosig = await cosignAddDevice(device.signing, base);
  const newLinks: Uint8Array[] = [];
  const add = await makeLink(state, key, { ...base, cosig });
  state = extendChain(state, [add]);
  newLinks.push(add);
  for (const target of revoke(state)) {
    const l = await makeLink(state, key, { type: "revoke_device", signingPublicKey: target, reason: "recovered with paper key" });
    state = extendChain(state, [l]);
    newLinks.push(l);
  }
  // The paper key signs; relay authentication uses the newly added device.
  const prev = client.identity;
  client.identity = { fingerprint, signing: device.signing };
  try {
    await client.appendLinks(newLinks);
  } finally {
    if (prev) client.identity = prev;
  }
  return state;
}

export function fingerprintLabel(fp: Uint8Array): string {
  return toB64url(fp).slice(0, 8);
}

/**
 * On the NEW device, after the existing device appended the add_device link: scan the existing device's
 * pairing code to learn the identity, and confirm the verified chain contains this device as active.
 */
export async function joinIdentity(client: RelayClient, code: Extract<ParsedCode, { kind: "pair" }>, mySigningPublicKey: Uint8Array): Promise<ChainState> {
  const { chain } = await verifyScannedPairingCode(client, code);
  const me = [...chain.devices.values()].find((d) => ctEqual(d.signingPublicKey, mySigningPublicKey) && d.revokedSeq === undefined);
  if (!me) throw new Error("this device has not been added to that identity yet");
  return chain;
}
