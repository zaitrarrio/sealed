/**
 * Direct and Room flows (spec §6.1–6.2, ADR-0004), platform-neutral. UI layers supply files, keys,
 * user-verification and progress callbacks; these functions do the cryptography and relay calls.
 */
import { fromB64url, toB64url } from "../bytes";
import type { DeviceKeys } from "../crypto/keys";
import { randomBytes, sha256 } from "../crypto/primitives";
import { claimSas } from "../crypto/sas";
import { unwrapKey, wrapKey } from "../crypto/wrap";
import { EnvelopeBuilder, EnvelopeReader, PayloadExtractor, type EnvelopeInput, type ExtractSink } from "../envelope/envelope";
import type { Manifest } from "../envelope/manifest";
import { sizeBucket } from "../envelope/manifest";
import { Limits, type ClaimSummary, type UvEvidence } from "./api";
import { RelayClient } from "./client";
import { claimCode } from "./codes";

export interface UploadProgress {
  phase: "encrypting" | "uploading" | "done";
  bytesProcessed: number;
  totalBytes: number;
  segmentsUploaded: number;
}

export interface ShareOptions {
  client: RelayClient;
  /** Origin used in displayed codes, e.g. https://sealed.to */
  origin: string;
  files: readonly EnvelopeInput[];
  mode: "direct" | "room";
  room?: { windowSeconds: number; cap: number; approval: "each" | "batch" | "auto" };
  ttlSeconds?: number;
  sender: { keys: DeviceKeys; label: string; fingerprint: Uint8Array };
  source?: string;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface ShareSession {
  transferId: string;
  transferIdBytes: Uint8Array;
  claimSecret: Uint8Array;
  code: string;
  uploadToken: string;
  eventsUrl: string;
  /** Resolves when ciphertext and manifest are fully uploaded and finalized. */
  uploaded: Promise<Manifest>;
  /** Six-digit check code to show beside a claim; must match the receiver's screen. */
  sasFor(claim: Pick<ClaimSummary, "receiver_pub">): string;
  /** Wraps the content key to the claiming device and posts the approval. */
  approve(claim: Pick<ClaimSummary, "claim_id" | "receiver_pub">, uv: (action: string) => Promise<UvEvidence>): Promise<void>;
  deny(claimId: string): Promise<void>;
  revoke(claimId: string): Promise<void>;
  cancel(): Promise<void>;
}

export function approvalAction(transferId: string, claimId: string, wrap: Uint8Array): string {
  return `approve:${transferId}:${claimId}:${toB64url(sha256(wrap))}`;
}

export async function startShare(o: ShareOptions): Promise<ShareSession> {
  const cek = randomBytes(32);
  const claimSecret = randomBytes(16);
  const totalBytes = o.files.reduce((a, f) => a + f.size, 0);
  // Estimate bucket and segment count for the relay's quota checks; finalize carries exact numbers.
  const estSegments = Math.max(1, Math.ceil(totalBytes / (1024 * 1024)));
  const ttl = o.ttlSeconds ?? Limits.defaultTtlSeconds;
  const created = await o.client.createTransfer({
    mode: o.mode,
    claim_hash: toB64url(sha256(claimSecret)),
    size_bucket: sizeBucket(totalBytes + estSegments * 16 + 4096),
    segments: estSegments,
    ttl_seconds: o.mode === "room" ? Math.min(ttl, Limits.roomMaxTtlSeconds) : ttl,
    ...(o.mode === "room" && o.room ? { room: { window_seconds: o.room.windowSeconds, cap: o.room.cap, approval: o.room.approval } } : {}),
  });
  const transferIdBytes = fromB64url(created.transfer_id);
  const transferId = created.transfer_id;

  const uploaded = (async (): Promise<Manifest> => {
    const builder = new EnvelopeBuilder({
      transferId: transferIdBytes,
      cek,
      ttlSeconds: ttl,
      sender: { key: o.sender.keys.signing, label: o.sender.label, fingerprint: o.sender.fingerprint },
      ...(o.source ? { source: o.source } : {}),
    });
    let processed = 0;
    let uploadedSegments = 0;
    for await (const seg of builder.build(o.files)) {
      if (o.signal?.aborted) throw new Error("share cancelled");
      processed = Math.min(totalBytes, (seg.index + 1) * 1024 * 1024);
      o.onProgress?.({ phase: "uploading", bytesProcessed: processed, totalBytes, segmentsUploaded: uploadedSegments });
      await o.client.uploadSegment(transferId, created.upload_token, seg.index, seg.bytes);
      uploadedSegments++;
    }
    let paddingParts = 0;
    for (const chunk of builder.paddingChunks(Limits.maxPaddingPartBytes)) {
      await o.client.uploadPadding(transferId, created.upload_token, paddingParts++, chunk);
    }
    await o.client.uploadManifest(transferId, created.upload_token, builder.manifestPart());
    await o.client.finalize(transferId, created.upload_token, uploadedSegments, paddingParts);
    o.onProgress?.({ phase: "done", bytesProcessed: totalBytes, totalBytes, segmentsUploaded: uploadedSegments });
    return builder.getManifest();
  })();
  // Callers observe failures through `uploaded`; avoid unhandled-rejection noise until they do.
  uploaded.catch(() => undefined);

  return {
    transferId,
    transferIdBytes,
    claimSecret,
    code: claimCode(o.origin, transferIdBytes, claimSecret),
    uploadToken: created.upload_token,
    eventsUrl: created.events_url,
    uploaded,
    sasFor: (claim) => claimSas(claimSecret, transferIdBytes, fromB64url(claim.receiver_pub)),
    async approve(claim, uv) {
      const wrap = await wrapKey(cek, fromB64url(claim.receiver_pub), { kind: "direct", transferId: transferIdBytes });
      const evidence = await uv(approvalAction(transferId, claim.claim_id, wrap));
      await o.client.approve(transferId, claim.claim_id, wrap, evidence);
    },
    async deny(claimId) {
      await o.client.deny(transferId, claimId);
    },
    async revoke(claimId) {
      await o.client.revoke(transferId, claimId);
    },
    async cancel() {
      await o.client.cancelTransfer(transferId);
    },
  };
}

export interface ClaimHandle {
  transferId: string;
  transferIdBytes: Uint8Array;
  claimId: string;
  claimToken: string;
  eventsUrl: string;
  sas: string;
}

/** Receiver side: submits a claim for a scanned code using this device's keys. */
export async function claimTransfer(o: { client: RelayClient; transferId: Uint8Array; claimSecret: Uint8Array; device: DeviceKeys; label: string; attestation?: Uint8Array }): Promise<ClaimHandle> {
  const transferId = toB64url(o.transferId);
  const r = await o.client.claim(transferId, {
    cs: toB64url(o.claimSecret),
    receiver_pub: toB64url(o.device.agreement.publicKey),
    receiver_sig_pub: toB64url(o.device.signing.publicKey),
    label: o.label.slice(0, 64),
    key_protection: o.device.agreement.protection,
    ...(o.attestation ? { attestation: toB64url(o.attestation) } : {}),
  });
  return {
    transferId,
    transferIdBytes: o.transferId,
    claimId: r.claim_id,
    claimToken: r.claim_token,
    eventsUrl: r.events_url,
    sas: claimSas(o.claimSecret, o.transferId, o.device.agreement.publicKey),
  };
}

/** Long-polls until the claim is approved and the upload finalized, or ends in a terminal state. */
export async function waitForApproval(client: RelayClient, h: ClaimHandle, signal?: AbortSignal): Promise<"approved" | "denied" | "expired" | "revoked"> {
  for (;;) {
    if (signal?.aborted) throw new Error("cancelled");
    const s = await client.claimStatus(h.claimId, h.claimToken, 25);
    if (s.status === "approved" && s.transfer_ready) return "approved";
    if (s.status === "denied" || s.status === "expired" || s.status === "revoked") return s.status;
  }
}

export interface DownloadProgress {
  segmentsDone: number;
  segmentCount: number;
  bytesDone: number;
  totalBytes: number;
}

/**
 * Downloads, decrypts and verifies a transfer, streaming files into `sink`. The unwrap triggers one biometric
 * prompt on hardware keys. Segments are fetched with bounded parallelism but delivered in order.
 */
export async function downloadTransfer(o: {
  client: RelayClient;
  transferId: string;
  auth: { claimToken: string; claimId: string } | { device: true; wrap: Uint8Array; prekeyKey?: import("../crypto/keys").AgreementKey; prekeyId?: Uint8Array; senderAgreementPublic?: Uint8Array };
  device: DeviceKeys;
  sink: ExtractSink;
  onManifest?: (m: Manifest) => void | Promise<void>;
  onProgress?: (p: DownloadProgress) => void;
  concurrency?: number;
  requireSigner?: Uint8Array;
  signal?: AbortSignal;
}): Promise<Manifest> {
  const transferIdBytes = fromB64url(o.transferId);
  let cek: Uint8Array;
  let fetchAuth: { claimToken: string } | "device";
  if ("claimToken" in o.auth) {
    const wrap = await o.client.fetchWrap(o.transferId, o.auth.claimId, o.auth.claimToken);
    cek = await unwrapKey(wrap, o.device.agreement, { kind: "direct", transferId: transferIdBytes });
    fetchAuth = { claimToken: o.auth.claimToken };
  } else {
    const key = o.auth.prekeyKey ?? o.device.agreement;
    cek = await unwrapKey(o.auth.wrap, key, { kind: "paired", transferId: transferIdBytes, prekeyId: o.auth.prekeyId ?? new Uint8Array(8) }, o.auth.senderAgreementPublic);
    fetchAuth = "device";
  }
  const manifestPart = await o.client.downloadManifest(o.transferId, fetchAuth);
  const reader = await EnvelopeReader.open(manifestPart, cek, { expectedTransferId: transferIdBytes, ...(o.requireSigner ? { requireSigner: o.requireSigner } : {}) });
  const m = reader.manifest;
  await o.onManifest?.(m);
  const extractor = new PayloadExtractor(m, o.sink);
  const totalBytes = m.files.reduce((a, f) => a + f.size, 0);
  const concurrency = Math.max(1, Math.min(o.concurrency ?? 4, 8));
  const inflight = new Map<number, Promise<Uint8Array>>();
  let next = 0;
  let bytesDone = 0;
  const launch = () => {
    while (inflight.size < concurrency && next < m.segmentCount) {
      const i = next++;
      inflight.set(i, o.client.downloadSegment(o.transferId, i, fetchAuth, o.signal));
    }
  };
  for (let i = 0; i < m.segmentCount; i++) {
    launch();
    const ct = await inflight.get(i)!;
    inflight.delete(i);
    const pt = await reader.decryptSegment(i, ct);
    await extractor.push(pt, i === m.segmentCount - 1);
    bytesDone = Math.min(totalBytes, Math.round(((i + 1) / m.segmentCount) * totalBytes));
    o.onProgress?.({ segmentsDone: i + 1, segmentCount: m.segmentCount, bytesDone, totalBytes });
  }
  if ("claimToken" in o.auth) await o.client.complete(o.transferId, o.auth.claimId, o.auth.claimToken).catch(() => undefined);
  return m;
}
