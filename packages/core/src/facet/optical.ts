/**
 * Optical transfer flows over Facet: Air-gap secure (spec §6.5) and Broadcast open (spec §6.6).
 *
 * Air-gap: the receiver shows a reverse key code (receiver DAK public key, nonce rn, capability tier, label). The
 * sender scans it, seals the Envelope, wraps the CEK to the receiver's key with HPKE (Base mode with an ephemeral
 * sender key, or Auth mode with the sender's device agreement key), and streams descriptor + data frames. Both
 * sides display the Air-gap SAS = HKDF(rn, stream_id, "sealed/v1/airgap" ∥ receiver_pub ∥ sender_pub).
 *
 * Broadcast: the CEK travels in clear in the descriptor. A publisher identity signs (type "broadcast")
 * {1: stream_id, 2: OTI, 3: manifest digest}; the Envelope manifest is additionally signed by the same key through
 * sealEnvelope's sender option, and the receiver checks that both signatures come from the same key.
 */
import { ctEqual } from "../bytes";
import { randomBytes, sha256 } from "../crypto/primitives";
import { SoftwareAgreementKey, type AgreementKey, type DeviceKeys, type SigningKey } from "../crypto/keys";
import { signObject, verifyObject } from "../crypto/sig";
import { airgapSas } from "../crypto/sas";
import { compress } from "../crypto/keyid";
import { unwrapKey, wrapKey } from "../crypto/wrap";
import { reverseKeyCode, type ParsedCode } from "../protocol/codes";
import { HEADER_LENGTH, decodeHeader, openEnvelope, sealEnvelope, type EnvelopeInput, type OpenedFile } from "../envelope/envelope";
import type { Manifest } from "../envelope/manifest";
import { encodeOti } from "../fec/index";
import type { StreamDescriptor, Tier } from "./types";
import { FacetSender } from "./sender";
import type { FacetReceiver } from "./receiver";
import { isTier, planStreamOti } from "./tiers";

const AIRGAP_TTL_SECONDS = 24 * 3600;
// T0 (QR) by default: every phone and most browsers can read it with the platform's own detector, which keeps
// up with the stream; the colour-grid tiers need the JavaScript pixel decoder (ADR-0018).
const DEFAULT_AIRGAP_TIER: Tier = 0;
const DEFAULT_BROADCAST_TIER: Tier = 0;

/** Error raised when an optical Envelope cannot be opened (missing key material, wrong device, bad signature). */
export class OpticalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpticalError";
  }
}

/** Receiver step 1 (§6.5): a reverse key code to display, and the nonce to keep for the SAS. */
export function createReverseKeyOffer(origin: string, device: { agreement: AgreementKey }, label: string, tier: Tier): { code: string; nonce: Uint8Array } {
  if (!isTier(tier)) throw new RangeError(`invalid capability tier ${String(tier)}`);
  const nonce = randomBytes(16);
  const code = reverseKeyCode(origin, { receiverPublicKey: device.agreement.publicKey, nonce, tier, label });
  return { code, nonce };
}

/** The Envelope's manifest part (header ∥ sealed manifest). */
export function manifestPartOf(envelope: Uint8Array): Uint8Array {
  const h = decodeHeader(envelope);
  const end = HEADER_LENGTH + h.manifestLength;
  if (envelope.length < end) throw new OpticalError("truncated envelope");
  return envelope.subarray(0, end);
}

/** Sender steps 2–3 (§6.5). */
export async function prepareAirgapStream(o: {
  files: readonly EnvelopeInput[];
  reverseKey: Extract<ParsedCode, { kind: "reverse-key" }>;
  senderKeys?: DeviceKeys;
  senderLabel: string;
  tier?: Tier;
}): Promise<{ sender: FacetSender; sas: string; transferId: Uint8Array }> {
  const rk = o.reverseKey;
  const requested = o.tier ?? (isTier(rk.tier) ? rk.tier : DEFAULT_AIRGAP_TIER);
  // Never exceed the receiver's reported capability.
  const tier = (isTier(rk.tier) ? Math.min(requested, rk.tier) : requested) as Tier;
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
  const manifestPart = manifestPartOf(bytes).slice();
  const sender = new FacetSender({
    envelope: bytes,
    tier,
    streamId,
    descriptor: { senderPublicKey: senderAgreement.publicKey, wrap, manifestPart, senderLabel: o.senderLabel },
  });
  const sas = airgapSas(rk.nonce, streamId, rk.receiverPublicKey, senderAgreement.publicKey);
  return { sender, sas, transferId };
}

/** Receiver step 2 (§6.5): the SAS to compare, once a descriptor carrying the sender key has been decoded. */
export function airgapReceiverSas(receiver: FacetReceiver, nonce: Uint8Array, receiverPublicKey: Uint8Array): string | null {
  const d = receiver.descriptor;
  if (!d || !d.senderPublicKey) return null;
  return airgapSas(nonce, d.streamId, receiverPublicKey, d.senderPublicKey);
}

export interface BroadcastPublisher {
  signing: SigningKey;
  fingerprint: Uint8Array;
  label: string;
}

/** Signed object of a Broadcast descriptor (§6.6): {1: stream_id, 2: OTI, 3: manifest digest}. */
function broadcastObject(streamId: Uint8Array, oti: Uint8Array, manifestDigest: Uint8Array): { 1: Uint8Array; 2: Uint8Array; 3: Uint8Array } {
  return { 1: streamId, 2: oti, 3: manifestDigest };
}

/** Sender side of Broadcast (§6.6). The client MUST warn the user before starting it (anyone in view can receive). */
export async function prepareBroadcastStream(o: {
  files: readonly EnvelopeInput[];
  publisher?: BroadcastPublisher;
  tier?: Tier;
  interleaveCompatible?: boolean;
}): Promise<{ sender: FacetSender; transferId: Uint8Array }> {
  const tier = o.tier ?? DEFAULT_BROADCAST_TIER;
  if (!isTier(tier)) throw new RangeError(`invalid tier ${String(tier)}`);
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
  const descriptor: ConstructorParameters<typeof FacetSender>[0]["descriptor"] = { cek, manifestDigest, manifestPart };
  let compatibleSignature: Uint8Array | undefined;
  if (o.publisher) {
    descriptor.publisherFingerprint = o.publisher.fingerprint;
    descriptor.publisherSigningKey = o.publisher.signing.publicKey;
    descriptor.signature = await signObject(o.publisher.signing, "broadcast", broadcastObject(streamId, encodeOti(planStreamOti(bytes.length, tier)), manifestDigest));
    if (o.interleaveCompatible && tier !== 0) {
      compatibleSignature = await signObject(o.publisher.signing, "broadcast", broadcastObject(streamId, encodeOti(planStreamOti(bytes.length, 0)), manifestDigest));
    }
  }
  const sender = new FacetSender({
    envelope: bytes,
    tier,
    streamId,
    descriptor,
    loop: true,
    interleaveCompatible: o.interleaveCompatible === true,
    ...(compatibleSignature ? { compatibleSignature } : {}),
  });
  return { sender, transferId };
}

export interface OpenedOptical {
  manifest: Manifest;
  files: OpenedFile[];
  mode: "airgap" | "broadcast";
  publisher?: { fingerprint: Uint8Array; signingKey: Uint8Array; signatureValid: boolean };
}

/**
 * Opens the Envelope a receiver reconstructed. Air-gap needs `device` (the receiver's DAK unwraps the CEK);
 * `expectedSenderAgreementKey` requires HPKE Auth mode from a pinned sender. Broadcast needs nothing; the
 * publisher signature result is reported, not enforced (the UI shows "Signature present, publisher not
 * verified" unless the fingerprint is pinned).
 */
export async function openOpticalEnvelope(receiver: FacetReceiver, o: { device?: DeviceKeys; expectedSenderAgreementKey?: Uint8Array }): Promise<OpenedOptical> {
  const envelope = receiver.result();
  const d = receiver.descriptor;
  if (!envelope || !d) throw new OpticalError("the optical stream is not complete");
  if (d.cek) return openBroadcast(envelope, d);
  if (!d.wrap) throw new OpticalError("descriptor carries neither a wrap nor a content key");
  if (!o.device) throw new OpticalError("an Air-gap transfer needs this device's keys to open");
  let cek: Uint8Array;
  try {
    cek = await unwrapKey(d.wrap, o.device.agreement, { kind: "airgap", streamId: d.streamId }, o.expectedSenderAgreementKey);
  } catch (e) {
    throw new OpticalError(`cannot unwrap the content key: ${(e as Error).message}`);
  }
  // HPKE Auth already authenticated the pinned sender; also require the key shown in the SAS to be that sender.
  if (o.expectedSenderAgreementKey && d.senderPublicKey && !ctEqual(compress(d.senderPublicKey), compress(o.expectedSenderAgreementKey))) {
    throw new OpticalError("descriptor sender key does not match the pinned sender");
  }
  const { manifest, files } = await openEnvelope(envelope, cek);
  return { manifest, files, mode: "airgap" };
}

async function openBroadcast(envelope: Uint8Array, d: StreamDescriptor): Promise<OpenedOptical> {
  const cek = d.cek as Uint8Array;
  const { manifest, files } = await openEnvelope(envelope, cek);
  if (!d.signature && !d.publisherSigningKey) return { manifest, files, mode: "broadcast" };
  const signingKey = d.publisherSigningKey ?? new Uint8Array(0);
  const fingerprint = d.publisherFingerprint ?? new Uint8Array(0);
  let valid = false;
  if (d.signature && d.publisherSigningKey && d.manifestDigest) {
    const digestOk = ctEqual(sha256(manifestPartOf(envelope)), d.manifestDigest);
    const sigOk = verifyObject(d.publisherSigningKey, "broadcast", broadcastObject(d.streamId, d.oti, d.manifestDigest), d.signature);
    // openEnvelope verified the manifest signature itself; require it to be by the same key.
    const manifestOk = manifest.sender !== undefined && manifest.signature !== undefined && ctEqual(manifest.sender.signingPublicKey, d.publisherSigningKey);
    valid = digestOk && sigOk && manifestOk;
  }
  return { manifest, files, mode: "broadcast", publisher: { fingerprint, signingKey, signatureValid: valid } };
}
