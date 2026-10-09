/**
 * Paired delivery (spec §6.4, ADR-0007): fan-out wraps to each of a contact's devices using signed one-time
 * prekeys (forward secrecy), falling back to the device's medium-term prekey and finally its agreement key.
 */
import { ctEqual, fromB64url, toB64url } from "../bytes";
import { compress } from "../crypto/keyid";
import { SoftwareAgreementKey, type AgreementKey, type DeviceKeys, type SigningKey } from "../crypto/keys";
import { P256, randomBytes } from "../crypto/primitives";
import { signObject, verifyObject } from "../crypto/sig";
import { wrapKey } from "../crypto/wrap";
import { EnvelopeBuilder, type EnvelopeInput, type ExtractSink } from "../envelope/envelope";
import type { Manifest } from "../envelope/manifest";
import { sizeBucket } from "../envelope/manifest";
import { activeDevices, type ChainState, type DeviceRecord } from "../identity/sigchain";
import { Limits, type MailboxItem, type SignedPrekey } from "./api";
import type { RelayClient } from "./client";
import { downloadTransfer } from "./direct";

/** Prekey id used when wrapping directly to a device agreement key (no prekey available). */
export const DEVICE_KEY_PREKEY_ID = new Uint8Array(8);

export function prekeyObject(deviceSigningPublic: Uint8Array, prekeyPublic: Uint8Array, id: Uint8Array) {
  return { 1: compress(deviceSigningPublic), 2: compress(prekeyPublic), 3: id };
}

export interface GeneratedPrekey {
  id: Uint8Array;
  secretKey: Uint8Array;
}

/** Creates `count` one-time prekeys signed by the device. Store `secrets` wrapped at rest; upload `signed`. */
export async function generatePrekeys(device: SigningKey, count: number): Promise<{ secrets: GeneratedPrekey[]; signed: SignedPrekey[] }> {
  const secrets: GeneratedPrekey[] = [];
  const signed: SignedPrekey[] = [];
  for (let i = 0; i < count; i++) {
    const k = new SoftwareAgreementKey();
    const id = randomBytes(8);
    const sig = await signObject(device, "prekey", prekeyObject(device.publicKey, k.publicKey, id));
    secrets.push({ id, secretKey: k.secretKey });
    signed.push({ id: toB64url(id), pub: toB64url(k.publicKey), sig: toB64url(sig) });
  }
  return { secrets, signed };
}

export function verifyPrekey(deviceSigningPublic: Uint8Array, p: SignedPrekey): boolean {
  try {
    const pub = fromB64url(p.pub);
    return P256.isValidPublicKey(pub) && verifyObject(deviceSigningPublic, "prekey", prekeyObject(deviceSigningPublic, pub, fromB64url(p.id)), fromB64url(p.sig));
  } catch {
    return false;
  }
}

/** Platform storage for prekey secrets (wrapped at rest by the device agreement key). */
export interface PrekeyStore {
  put(id: Uint8Array, secretKey: Uint8Array): Promise<void>;
  get(id: Uint8Array): Promise<Uint8Array | null>;
  delete(id: Uint8Array): Promise<void>;
}

/** Replenishes the relay pool below the low-water mark. Returns how many were uploaded. */
export async function replenishPrekeys(client: RelayClient, device: SigningKey, store: PrekeyStore): Promise<number> {
  const { count } = await client.prekeyCount();
  if (count >= Limits.prekeyLowWater) return 0;
  const n = Limits.prekeyBatch - count;
  const { secrets, signed } = await generatePrekeys(device, n);
  for (const s of secrets) await store.put(s.id, s.secretKey);
  await client.uploadPrekeys(signed);
  return n;
}

export interface WrapTarget {
  device: DeviceRecord;
  publicKey: Uint8Array;
  prekeyId: Uint8Array;
  kind: "one-time" | "medium-term" | "device";
}

/** Chooses the recipient key for each active device of `state`, verifying every prekey against the chain. */
export async function resolveWrapTargets(client: RelayClient, state: ChainState, excludeDevice?: Uint8Array, now = Math.floor(Date.now() / 1000)): Promise<WrapTarget[]> {
  const claimed = await client.claimPrekeys(state.fingerprint);
  const byDevice = new Map(claimed.devices.map((d) => [d.device, d.prekey]));
  const out: WrapTarget[] = [];
  for (const dev of activeDevices(state)) {
    if (excludeDevice && ctEqual(compress(dev.signingPublicKey), compress(excludeDevice))) continue;
    const pk = byDevice.get(toB64url(compress(dev.signingPublicKey)));
    if (pk && verifyPrekey(dev.signingPublicKey, pk)) {
      out.push({ device: dev, publicKey: fromB64url(pk.pub), prekeyId: fromB64url(pk.id), kind: "one-time" });
    } else if (dev.mpk && dev.mpk.expires > now) {
      out.push({ device: dev, publicKey: dev.mpk.publicKey, prekeyId: dev.mpk.id, kind: "medium-term" });
    } else {
      out.push({ device: dev, publicKey: dev.agreementPublicKey, prekeyId: DEVICE_KEY_PREKEY_ID, kind: "device" });
    }
  }
  return out;
}

export interface PairedSendOptions {
  client: RelayClient;
  recipient: ChainState;
  /** The sender's own chain; other devices of the sender also receive a copy. */
  self: ChainState;
  files: readonly EnvelopeInput[];
  sender: { keys: DeviceKeys; label: string; fingerprint: Uint8Array };
  ttlSeconds?: number;
  source?: string;
  onProgress?: (bytes: number, total: number) => void;
}

export interface PairedSendResult {
  transferId: string;
  manifest: Manifest;
  cek: Uint8Array;
  /** Envelope parts kept in memory only when `keepParts` is set (live transfers reuse them). */
  recipients: number;
}

/** Uploads an Envelope to the relay and delivers per-device wraps to the contact's (and own) mailboxes. */
export async function sendToContact(o: PairedSendOptions): Promise<PairedSendResult> {
  const cek = randomBytes(32);
  const total = o.files.reduce((a, f) => a + f.size, 0);
  const segments = Math.max(1, Math.ceil(total / (1024 * 1024)));
  const ttl = o.ttlSeconds ?? Limits.pairedTtlSeconds;
  const created = await o.client.createTransfer({ mode: "paired", size_bucket: sizeBucket(total + segments * 16 + 4096), segments, ttl_seconds: ttl });
  const transferIdBytes = fromB64url(created.transfer_id);
  const builder = new EnvelopeBuilder({
    transferId: transferIdBytes,
    cek,
    ttlSeconds: ttl,
    sender: { key: o.sender.keys.signing, label: o.sender.label, fingerprint: o.sender.fingerprint },
    ...(o.source ? { source: o.source } : {}),
  });
  let n = 0;
  for await (const seg of builder.build(o.files)) {
    await o.client.uploadSegment(created.transfer_id, created.upload_token, seg.index, seg.bytes);
    n++;
    o.onProgress?.(Math.min(total, n * 1024 * 1024), total);
  }
  let pad = 0;
  for (const chunk of builder.paddingChunks(Limits.maxPaddingPartBytes)) await o.client.uploadPadding(created.transfer_id, created.upload_token, pad++, chunk);
  await o.client.uploadManifest(created.transfer_id, created.upload_token, builder.manifestPart());
  await o.client.finalize(created.transfer_id, created.upload_token, n, pad);

  let recipients = 0;
  for (const target of [o.recipient, o.self]) {
    const isSelf = target === o.self;
    if (isSelf && ctEqual(o.self.fingerprint, o.recipient.fingerprint)) continue;
    const targets = await resolveWrapTargets(o.client, target, isSelf ? o.sender.keys.signing.publicKey : undefined);
    if (targets.length === 0) continue;
    const wraps = [];
    for (const t of targets) {
      const wrap = await wrapKey(cek, t.publicKey, { kind: "paired", transferId: transferIdBytes, prekeyId: t.prekeyId }, o.sender.keys.agreement);
      wraps.push({ device: compress(t.device.signingPublicKey), prekeyId: t.prekeyId, wrap });
    }
    await o.client.deliver(target.fingerprint, created.transfer_id, wraps);
    recipients += wraps.length;
  }
  return { transferId: created.transfer_id, manifest: builder.getManifest(), cek, recipients };
}

export interface ReceivePairedOptions {
  client: RelayClient;
  item: MailboxItem;
  device: DeviceKeys;
  /** Verified chain of the sender (a pinned contact, or this user's own chain for self-delivery). */
  senderChain: ChainState;
  /** This device's medium-term prekey private keys (current and previous), if any. */
  mediumTermKeys?: { id: Uint8Array; key: AgreementKey }[];
  prekeys: PrekeyStore;
  sink: ExtractSink;
  onManifest?: (m: Manifest) => void | Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/** Downloads one mailbox delivery: unwraps with the right prekey, verifies the sender, then acks. */
export async function receivePaired(o: ReceivePairedOptions): Promise<Manifest> {
  const senderDevice = activeOrAny(o.senderChain, fromB64url(o.item.sender_device));
  if (!senderDevice) throw new Error("delivery is from a device that is not in the sender's chain");
  const prekeyId = o.item.prekey_id ? fromB64url(o.item.prekey_id) : DEVICE_KEY_PREKEY_ID;
  let key: AgreementKey = o.device.agreement;
  let oneTime = false;
  if (!ctEqual(prekeyId, DEVICE_KEY_PREKEY_ID)) {
    const mt = o.mediumTermKeys?.find((k) => ctEqual(k.id, prekeyId));
    if (mt) key = mt.key;
    else {
      const secret = await o.prekeys.get(prekeyId);
      if (!secret) throw new Error("one-time prekey not found (already used or never issued here)");
      key = new SoftwareAgreementKey(secret);
      oneTime = true;
    }
  }
  const manifest = await downloadTransfer({
    client: o.client,
    transferId: o.item.transfer_id,
    auth: { device: true, wrap: fromB64url(o.item.wrap), prekeyKey: key, prekeyId, senderAgreementPublic: senderDevice.agreementPublicKey },
    device: o.device,
    sink: o.sink,
    requireSigner: senderDevice.signingPublicKey,
    ...(o.onManifest ? { onManifest: o.onManifest } : {}),
    ...(o.onProgress ? { onProgress: (p: { bytesDone: number; totalBytes: number }) => o.onProgress!(p.bytesDone, p.totalBytes) } : {}),
  });
  if (oneTime) await o.prekeys.delete(prekeyId);
  await o.client.ackMailbox(o.item.transfer_id);
  return manifest;
}

function activeOrAny(state: ChainState, compressedSigning: Uint8Array): DeviceRecord | undefined {
  for (const d of state.devices.values()) {
    if (ctEqual(compress(d.signingPublicKey), compressedSigning) && d.revokedSeq === undefined) return d;
  }
  return undefined;
}
