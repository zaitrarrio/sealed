/**
 * Acoustic Air-gap and Broadcast flows. Same trust paths as optical (spec §6.5–6.6): reverse-key + SAS for
 * strangers, pinned Auth wraps for contacts, open CEK for Broadcast. The transport is speaker → microphone.
 */
import { ctEqual } from "../bytes";
import { randomBytes, sha256 } from "../crypto/primitives";
import { SoftwareAgreementKey, type AgreementKey, type DeviceKeys } from "../crypto/keys";
import { signObject, verifyObject } from "../crypto/sig";
import { airgapSas } from "../crypto/sas";
import { compress } from "../crypto/keyid";
import { unwrapKey, wrapKey } from "../crypto/wrap";
import type { ParsedCode } from "../protocol/codes";
import { openEnvelope, sealEnvelope, type EnvelopeInput, type OpenedFile } from "../envelope/envelope";
import type { Manifest } from "../envelope/manifest";
import { encodeOti, planOti } from "../fec/index";
import { manifestPartOf, type BroadcastPublisher } from "../facet/optical";
import { AcousticSender, AcousticReceiver, estimateAcousticSeconds } from "./transfer";
import { acousticProfile, type AcousticProfileId } from "./profiles";

const AIRGAP_TTL_SECONDS = 24 * 3600;
/** Warn in UI above this size — acoustic is slow; point large files at the screen. */
export const ACOUSTIC_SIZE_WARN_BYTES = 256 * 1024;

export class AcousticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcousticError";
  }
}

function broadcastObject(streamId: Uint8Array, oti: Uint8Array, manifestDigest: Uint8Array): { 1: Uint8Array; 2: Uint8Array; 3: Uint8Array } {
  return { 1: streamId, 2: oti, 3: manifestDigest };
}

/** Sender: Air-gap over sound after the reverse key code was scanned. */
export async function prepareAirgapAcousticStream(o: {
  files: readonly EnvelopeInput[];
  reverseKey: Extract<ParsedCode, { kind: "reverse-key" }>;
  senderKeys?: DeviceKeys;
  senderLabel: string;
  profile?: AcousticProfileId;
}): Promise<{ sender: AcousticSender; sas: string; transferId: Uint8Array; profile: AcousticProfileId }> {
  const rk = o.reverseKey;
  const profile: AcousticProfileId = o.profile ?? 0;
  acousticProfile(profile);
  const streamId = randomBytes(4);
  const transferId = randomBytes(16);
  const cek = randomBytes(32);
  const ephemeral = o.senderKeys ? null : new SoftwareAgreementKey();
  const senderAgreement: AgreementKey = o.senderKeys ? o.senderKeys.agreement : (ephemeral as SoftwareAgreementKey);
  const wrap = await wrapKey(cek, rk.receiverPublicKey, { kind: "airgap", streamId }, o.senderKeys ? o.senderKeys.agreement : undefined);
  const { bytes } = await sealEnvelope(o.files, {
    transferId,
    cek,
    ttlSeconds: AIRGAP_TTL_SECONDS,
    pad: false,
    ...(o.senderKeys ? { sender: { key: o.senderKeys.signing, label: o.senderLabel } } : {}),
  });
  const sender = new AcousticSender({
    envelope: bytes,
    profile,
    streamId,
    descriptor: {
      senderPublicKey: senderAgreement.publicKey,
      wrap,
      manifestPart: manifestPartOf(bytes).slice(),
      senderLabel: o.senderLabel,
    },
  });
  const sas = airgapSas(rk.nonce, streamId, rk.receiverPublicKey, senderAgreement.publicKey);
  return { sender, sas, transferId, profile };
}

/** Receiver SAS once the acoustic descriptor carrying the sender key has been decoded. */
export function airgapAcousticReceiverSas(receiver: AcousticReceiver, nonce: Uint8Array, receiverPublicKey: Uint8Array): string | null {
  const d = receiver.streamDescriptor;
  if (!d || !d.senderPublicKey) return null;
  return airgapSas(nonce, d.streamId, receiverPublicKey, d.senderPublicKey);
}

/** Sender: open Broadcast over sound. UI MUST warn that anyone who can hear it can receive. */
export async function prepareBroadcastAcousticStream(o: {
  files: readonly EnvelopeInput[];
  publisher?: BroadcastPublisher;
  profile?: AcousticProfileId;
}): Promise<{ sender: AcousticSender; transferId: Uint8Array; profile: AcousticProfileId }> {
  const profile: AcousticProfileId = o.profile ?? 0;
  acousticProfile(profile);
  const streamId = randomBytes(4);
  const transferId = randomBytes(16);
  const cek = randomBytes(32);
  const { bytes } = await sealEnvelope(o.files, {
    transferId,
    cek,
    ttlSeconds: AIRGAP_TTL_SECONDS,
    pad: false,
    ...(o.publisher ? { sender: { key: o.publisher.signing, label: o.publisher.label, fingerprint: o.publisher.fingerprint } } : {}),
  });
  const manifestPart = manifestPartOf(bytes).slice();
  const manifestDigest = sha256(manifestPart);
  const p = acousticProfile(profile);
  const otiBytes = encodeOti(planOti(bytes.length, p.symbolSize, 256));
  const descriptor: ConstructorParameters<typeof AcousticSender>[0]["descriptor"] = {
    cek,
    manifestDigest,
    manifestPart,
  };
  if (o.publisher) {
    descriptor.publisherFingerprint = o.publisher.fingerprint;
    descriptor.publisherSigningKey = o.publisher.signing.publicKey;
    descriptor.signature = await signObject(o.publisher.signing, "broadcast", broadcastObject(streamId, otiBytes, manifestDigest));
  }
  const sender = new AcousticSender({ envelope: bytes, profile, streamId, descriptor, loop: true });
  return { sender, transferId, profile };
}

export interface OpenedAcoustic {
  manifest: Manifest;
  files: OpenedFile[];
  mode: "airgap" | "broadcast";
  publisher?: { fingerprint: Uint8Array; signingKey: Uint8Array; signatureValid: boolean };
}

/** Opens a completed acoustic Envelope (same crypto as optical). */
export async function openAcousticEnvelope(
  receiver: AcousticReceiver,
  o: { device?: DeviceKeys; expectedSenderAgreementKey?: Uint8Array },
): Promise<OpenedAcoustic> {
  const envelope = receiver.result();
  const d = receiver.streamDescriptor;
  if (!envelope || !d) throw new AcousticError("the acoustic stream is not complete");
  if (d.cek) return openBroadcast(envelope, d);
  if (!d.wrap) throw new AcousticError("descriptor carries neither a wrap nor a content key");
  if (!o.device) throw new AcousticError("an Air-gap transfer needs this device's keys to open");
  let cek: Uint8Array;
  try {
    cek = await unwrapKey(d.wrap, o.device.agreement, { kind: "airgap", streamId: d.streamId }, o.expectedSenderAgreementKey);
  } catch (e) {
    throw new AcousticError(`cannot unwrap the content key: ${(e as Error).message}`);
  }
  if (o.expectedSenderAgreementKey && d.senderPublicKey && !ctEqual(compress(d.senderPublicKey), compress(o.expectedSenderAgreementKey))) {
    throw new AcousticError("descriptor sender key does not match the pinned sender");
  }
  const { manifest, files } = await openEnvelope(envelope, cek);
  return { manifest, files, mode: "airgap" };
}

async function openBroadcast(envelope: Uint8Array, d: NonNullable<AcousticReceiver["streamDescriptor"]>): Promise<OpenedAcoustic> {
  const cek = d.cek as Uint8Array;
  const { manifest, files } = await openEnvelope(envelope, cek);
  if (!d.signature && !d.publisherSigningKey) return { manifest, files, mode: "broadcast" };
  const signingKey = d.publisherSigningKey ?? new Uint8Array(0);
  const fingerprint = d.publisherFingerprint ?? new Uint8Array(0);
  let valid = false;
  if (d.signature && d.publisherSigningKey && d.manifestDigest) {
    const digestOk = ctEqual(sha256(manifestPartOf(envelope)), d.manifestDigest);
    const sigOk = verifyObject(d.publisherSigningKey, "broadcast", broadcastObject(d.streamId, d.oti, d.manifestDigest), d.signature);
    const manifestOk = manifest.sender !== undefined && manifest.signature !== undefined && ctEqual(manifest.sender.signingPublicKey, d.publisherSigningKey);
    valid = digestOk && sigOk && manifestOk;
  }
  return { manifest, files, mode: "broadcast", publisher: { fingerprint, signingKey, signatureValid: valid } };
}

export { estimateAcousticSeconds };
