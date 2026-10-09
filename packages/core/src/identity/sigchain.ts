/**
 * Identity as an append-only, hash-linked chain of signed statements (spec §6.3, ADR-0006).
 * The identity fingerprint is SHA-256 of the encoded first link. Clients verify every link back to a pinned
 * fingerprint, so the relay can store and serve chains but cannot forge, reorder or fork them undetected.
 */
import { ctEqual, toHex } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getBytes, getOptText, getText, getUint, type CborMap, type CborValue } from "../cbor";
import { compress, decompress } from "../crypto/keyid";
import type { KeyProtection, SigningKey } from "../crypto/keys";
import { P256, sha256 } from "../crypto/primitives";
import { signObject, verifyObject } from "../crypto/sig";

export type Statement =
  | { type: "add_device"; agreementPublicKey: Uint8Array; signingPublicKey: Uint8Array; label: string; protection: KeyProtection; cosig: Uint8Array }
  | { type: "revoke_device"; signingPublicKey: Uint8Array; reason: string }
  | { type: "add_paper_key"; signingPublicKey: Uint8Array }
  | { type: "revoke_paper_key"; signingPublicKey: Uint8Array }
  | { type: "rotate_mpk"; deviceSigningPublicKey: Uint8Array; mpkPublicKey: Uint8Array; mpkId: Uint8Array; expires: number; signature: Uint8Array };

export interface Link {
  seq: number;
  prev: Uint8Array | null;
  ts: number;
  statement: Statement;
  signer: Uint8Array; // uncompressed 65-byte P-256 public key
  sig: Uint8Array;
}

export class ChainError extends Error {
  constructor(message: string, readonly seq?: number) {
    super(seq === undefined ? message : `link ${seq}: ${message}`);
    this.name = "ChainError";
  }
}

const PROTECTIONS: readonly KeyProtection[] = ["secure-enclave", "strongbox", "tee", "browser", "software"];

function statementCbor(s: Statement, includeCosig = true): CborValue {
  switch (s.type) {
    case "add_device":
      return { 0: "add_device", 1: compress(s.agreementPublicKey), 2: compress(s.signingPublicKey), 3: s.label, 4: s.protection, 5: includeCosig ? s.cosig : undefined };
    case "revoke_device":
      return { 0: "revoke_device", 1: compress(s.signingPublicKey), 2: s.reason };
    case "add_paper_key":
      return { 0: "add_paper_key", 1: compress(s.signingPublicKey) };
    case "revoke_paper_key":
      return { 0: "revoke_paper_key", 1: compress(s.signingPublicKey) };
    case "rotate_mpk":
      return { 0: "rotate_mpk", 1: compress(s.deviceSigningPublicKey), 2: compress(s.mpkPublicKey), 3: s.mpkId, 4: s.expires, 5: s.signature };
  }
}

function parseStatement(m: CborMap, seq: number): Statement {
  const what = `link ${seq} statement`;
  const t = getText(m, 0, what);
  const key = (k: number) => decompress(getBytes(m, k, what, 33));
  switch (t) {
    case "add_device": {
      const protection = getText(m, 4, what) as KeyProtection;
      if (!PROTECTIONS.includes(protection)) throw new ChainError(`unknown key protection ${protection}`, seq);
      return { type: t, agreementPublicKey: key(1), signingPublicKey: key(2), label: getText(m, 3, what), protection, cosig: getBytes(m, 5, what, 64) };
    }
    case "revoke_device":
      return { type: t, signingPublicKey: key(1), reason: getOptText(m, 2, what) ?? "" };
    case "add_paper_key":
    case "revoke_paper_key":
      return { type: t, signingPublicKey: key(1) };
    case "rotate_mpk":
      return { type: t, deviceSigningPublicKey: key(1), mpkPublicKey: key(2), mpkId: getBytes(m, 3, what, 8), expires: getUint(m, 4, what), signature: getBytes(m, 5, what, 64) };
    default:
      throw new ChainError(`unknown statement ${t}`, seq);
  }
}

function unsignedLinkCbor(l: Omit<Link, "sig">): CborValue {
  return { 1: l.seq, 2: l.prev, 3: l.ts, 4: statementCbor(l.statement), 5: compress(l.signer) };
}

export function encodeLink(l: Link): Uint8Array {
  return encodeCbor({ ...(unsignedLinkCbor(l) as Record<string, CborValue>), 6: l.sig });
}

export function decodeLink(b: Uint8Array): Link {
  const m = asMap(decodeCbor(b), "link");
  const seq = getUint(m, 1, "link");
  const prevRaw = m["2"];
  const prev = prevRaw === null ? null : getBytes(m, 2, "link", 32);
  return {
    seq,
    prev,
    ts: getUint(m, 3, "link"),
    statement: parseStatement(asMap(m["4"], "link statement"), seq),
    signer: decompress(getBytes(m, 5, "link", 33)),
    sig: getBytes(m, 6, "link", 64),
  };
}

export function linkHash(encoded: Uint8Array): Uint8Array {
  return sha256(encoded);
}

/** The new device's co-signature proving possession of the key it asks to add. */
export function cosigObject(s: Extract<Statement, { type: "add_device" }>): CborValue {
  return { cosig: statementCbor(s, false) };
}

export async function cosignAddDevice(newDeviceSigning: SigningKey, s: Omit<Extract<Statement, { type: "add_device" }>, "cosig">): Promise<Uint8Array> {
  return signObject(newDeviceSigning, "link", cosigObject({ ...s, cosig: new Uint8Array(64) }));
}

export function mpkObject(deviceSigningPublicKey: Uint8Array, mpkPublicKey: Uint8Array, mpkId: Uint8Array, expires: number): CborValue {
  return { 1: compress(deviceSigningPublicKey), 2: compress(mpkPublicKey), 3: mpkId, 4: expires };
}

export interface DeviceRecord {
  agreementPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  label: string;
  protection: KeyProtection;
  addedSeq: number;
  revokedSeq?: number;
  mpk?: { publicKey: Uint8Array; id: Uint8Array; expires: number };
}

export interface ChainState {
  fingerprint: Uint8Array;
  seq: number;
  headHash: Uint8Array;
  devices: Map<string, DeviceRecord>; // keyed by hex of compressed signing key
  paperKeys: Map<string, { publicKey: Uint8Array; revoked: boolean }>;
  /** Hash of every link by seq, for fork detection against cached prefixes. */
  hashes: Uint8Array[];
}

function k(pub: Uint8Array): string {
  return toHex(compress(pub));
}

export function activeDevices(state: ChainState): DeviceRecord[] {
  return [...state.devices.values()].filter((d) => d.revokedSeq === undefined);
}

function signerValid(state: ChainState, signer: Uint8Array): "device" | "paper" | null {
  const d = state.devices.get(k(signer));
  if (d && d.revokedSeq === undefined) return "device";
  const p = state.paperKeys.get(k(signer));
  if (p && !p.revoked) return "paper";
  return null;
}

function apply(state: ChainState | null, encoded: Uint8Array): ChainState {
  const l = decodeLink(encoded);
  if (!ctEqual(encoded, encodeLink(l))) throw new ChainError("non-canonical encoding", l.seq);
  if (!verifyObject(l.signer, "link", unsignedLinkCbor(l), l.sig)) throw new ChainError("bad signature", l.seq);
  const hash = linkHash(encoded);

  if (state === null) {
    if (l.seq !== 0 || l.prev !== null) throw new ChainError("first link must have seq 0 and no prev", l.seq);
    const s = l.statement;
    if (s.type !== "add_device") throw new ChainError("first link must add a device", 0);
    if (!ctEqual(compress(s.signingPublicKey), compress(l.signer))) throw new ChainError("first link must be self-signed", 0);
    if (!verifyObject(s.signingPublicKey, "link", cosigObject(s), s.cosig)) throw new ChainError("bad co-signature", 0);
    return {
      fingerprint: hash,
      seq: 0,
      headHash: hash,
      devices: new Map([[k(s.signingPublicKey), { agreementPublicKey: s.agreementPublicKey, signingPublicKey: s.signingPublicKey, label: s.label, protection: s.protection, addedSeq: 0 }]]),
      paperKeys: new Map(),
      hashes: [hash],
    };
  }

  if (l.seq !== state.seq + 1) throw new ChainError(`expected seq ${state.seq + 1}`, l.seq);
  if (!l.prev || !ctEqual(l.prev, state.headHash)) throw new ChainError("prev hash does not match chain head", l.seq);
  const role = signerValid(state, l.signer);
  if (!role) throw new ChainError("signer is not a valid device or paper key", l.seq);
  const next: ChainState = { ...state, devices: new Map(state.devices), paperKeys: new Map(state.paperKeys), seq: l.seq, headHash: hash, hashes: [...state.hashes, hash] };
  const s = l.statement;
  switch (s.type) {
    case "add_device": {
      if (next.devices.has(k(s.signingPublicKey))) throw new ChainError("device already present", l.seq);
      if (!verifyObject(s.signingPublicKey, "link", cosigObject(s), s.cosig)) throw new ChainError("bad co-signature", l.seq);
      next.devices.set(k(s.signingPublicKey), { agreementPublicKey: s.agreementPublicKey, signingPublicKey: s.signingPublicKey, label: s.label, protection: s.protection, addedSeq: l.seq });
      break;
    }
    case "revoke_device": {
      const d = next.devices.get(k(s.signingPublicKey));
      if (!d || d.revokedSeq !== undefined) throw new ChainError("revoking a device that is not active", l.seq);
      next.devices.set(k(s.signingPublicKey), { ...d, revokedSeq: l.seq });
      break;
    }
    case "add_paper_key": {
      if (role !== "device") throw new ChainError("only a device may add a paper key", l.seq);
      if (next.paperKeys.has(k(s.signingPublicKey))) throw new ChainError("paper key already present", l.seq);
      next.paperKeys.set(k(s.signingPublicKey), { publicKey: s.signingPublicKey, revoked: false });
      break;
    }
    case "revoke_paper_key": {
      const p = next.paperKeys.get(k(s.signingPublicKey));
      if (!p || p.revoked) throw new ChainError("revoking a paper key that is not active", l.seq);
      next.paperKeys.set(k(s.signingPublicKey), { ...p, revoked: true });
      break;
    }
    case "rotate_mpk": {
      if (!ctEqual(compress(s.deviceSigningPublicKey), compress(l.signer))) throw new ChainError("a device may rotate only its own prekey", l.seq);
      const d = next.devices.get(k(s.deviceSigningPublicKey));
      if (!d || d.revokedSeq !== undefined) throw new ChainError("prekey for inactive device", l.seq);
      if (!verifyObject(s.deviceSigningPublicKey, "prekey", mpkObject(s.deviceSigningPublicKey, s.mpkPublicKey, s.mpkId, s.expires), s.signature)) {
        throw new ChainError("bad prekey signature", l.seq);
      }
      next.devices.set(k(s.deviceSigningPublicKey), { ...d, mpk: { publicKey: s.mpkPublicKey, id: s.mpkId, expires: s.expires } });
      break;
    }
  }
  return next;
}

/** Verifies a full chain. With `fingerprint`, requires the chain to start at that identity. */
export function verifyChain(links: readonly Uint8Array[], fingerprint?: Uint8Array): ChainState {
  if (links.length === 0) throw new ChainError("empty chain");
  let state: ChainState | null = null;
  for (const l of links) state = apply(state, l);
  const s = state as ChainState;
  if (fingerprint && !ctEqual(fingerprint, s.fingerprint)) throw new ChainError("chain does not belong to the pinned identity");
  return s;
}

/**
 * Extends a verified state with new links. `links` may start at any seq ≤ state.seq + 1; links that overlap
 * the known prefix must hash-match it, otherwise the chain has forked (spec §6.3.1) and a ChainError is thrown.
 */
export function extendChain(state: ChainState, links: readonly Uint8Array[]): ChainState {
  let s = state;
  for (const encoded of links) {
    const l = decodeLink(encoded);
    if (l.seq <= s.seq) {
      const known = s.hashes[l.seq];
      if (!known || !ctEqual(known, linkHash(encoded))) throw new ChainError("fork detected: link differs from verified history", l.seq);
      continue;
    }
    s = apply(s, encoded);
  }
  return s;
}

/** Builds and signs a new link on top of `state` (or the genesis link when state is null). */
export async function makeLink(state: ChainState | null, signer: SigningKey, statement: Statement, ts = Math.floor(Date.now() / 1000)): Promise<Uint8Array> {
  const unsigned = { seq: state ? state.seq + 1 : 0, prev: state ? state.headHash : null, ts, statement, signer: signer.publicKey };
  const sig = await signObject(signer, "link", unsignedLinkCbor(unsigned));
  return encodeLink({ ...unsigned, sig });
}

/** Creates a new identity on its first device. Returns the encoded genesis link and its verified state. */
export async function createIdentity(device: { signing: SigningKey; agreementPublicKey: Uint8Array; label: string; protection: KeyProtection }, ts?: number): Promise<{ link: Uint8Array; state: ChainState }> {
  const base = { type: "add_device" as const, agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signing.publicKey, label: device.label, protection: device.protection };
  const cosig = await cosignAddDevice(device.signing, base);
  const link = await makeLink(null, device.signing, { ...base, cosig }, ts);
  return { link, state: verifyChain([link]) };
}

export async function rotateMpkStatement(device: SigningKey, mpkPublicKey: Uint8Array, mpkId: Uint8Array, expires: number): Promise<Statement> {
  const signature = await signObject(device, "prekey", mpkObject(device.publicKey, mpkPublicKey, mpkId, expires));
  return { type: "rotate_mpk", deviceSigningPublicKey: device.publicKey, mpkPublicKey, mpkId, expires, signature };
}

export function isValidPublicKey(pub: Uint8Array): boolean {
  return P256.isValidPublicKey(pub);
}
