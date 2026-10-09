/**
 * Relay API contract (spec §9.2). This module is the single source of truth for request and response
 * shapes, shared by the relay (validation) and every client (typing). Binary fields travel as base64url
 * strings; raw ciphertext uploads and downloads travel as application/octet-stream bodies.
 */
import { z } from "zod";

export const API_VERSION = "v1";

const b64 = z.string().regex(/^[A-Za-z0-9_-]*$/, "base64url");
export const B64 = b64;

export const KeyProtectionSchema = z.enum(["secure-enclave", "strongbox", "tee", "browser", "software"]);
export const TransferModeSchema = z.enum(["direct", "room", "paired"]);
export const RoomApprovalSchema = z.enum(["each", "batch", "auto"]);

export const ErrorBodySchema = z.object({ error: z.string(), message: z.string().optional() });
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** Stable error codes returned in `error`. */
export const ErrorCode = {
  BadRequest: "bad_request",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  ClaimConsumed: "claim_consumed",
  ClaimWindowClosed: "claim_window_closed",
  RoomFull: "room_full",
  Expired: "expired",
  Revoked: "revoked",
  NotApproved: "not_approved",
  RateLimited: "rate_limited",
  TooLarge: "too_large",
  ChainInvalid: "chain_invalid",
  Conflict: "conflict",
  Internal: "internal",
} as const;

// ---------------------------------------------------------------- identities

export const CreateIdentityRequest = z.object({ link: b64 });
export const CreateIdentityResponse = z.object({ fingerprint: b64, head_seq: z.number().int() });

export const ChainResponse = z.object({ fingerprint: b64, links: z.array(b64), head_seq: z.number().int() });

export const AppendLinksRequest = z.object({ links: z.array(b64).min(1).max(32) });
export const AppendLinksResponse = z.object({ head_seq: z.number().int() });

export const SignedPrekey = z.object({ id: b64, pub: b64, sig: b64 });
export type SignedPrekey = z.infer<typeof SignedPrekey>;

export const UploadPrekeysRequest = z.object({ device: b64, prekeys: z.array(SignedPrekey).min(1).max(200) });
export const UploadPrekeysResponse = z.object({ count: z.number().int() });

export const PrekeyCountResponse = z.object({ count: z.number().int() });

export const ClaimPrekeysResponse = z.object({
  fingerprint: b64,
  head_seq: z.number().int(),
  devices: z.array(
    z.object({
      device: b64, // compressed device signing key
      prekey: SignedPrekey.nullable(), // one-time prekey, removed from the pool; null when exhausted
    }),
  ),
});

// ---------------------------------------------------------------- transfers

export const CreateTransferRequest = z.object({
  mode: TransferModeSchema,
  claim_hash: b64.optional(),
  size_bucket: z.number().int().positive(),
  segments: z.number().int().positive(),
  ttl_seconds: z.number().int().min(600).max(30 * 86400),
  room: z
    .object({
      window_seconds: z.number().int().min(60).max(3600),
      cap: z.number().int().min(2).max(5000),
      approval: RoomApprovalSchema,
    })
    .optional(),
});
export type CreateTransferRequest = z.infer<typeof CreateTransferRequest>;

export const CreateTransferResponse = z.object({
  transfer_id: b64,
  upload_token: z.string(),
  expires_at: z.number().int(),
  events_url: z.string(),
});

export const FinalizeRequest = z.object({ segments: z.number().int().positive(), padding_parts: z.number().int().min(0) });

export const ClaimRequest = z.object({
  cs: b64,
  receiver_pub: b64, // uncompressed agreement key, 65 bytes
  receiver_sig_pub: b64, // uncompressed signing key, 65 bytes
  label: z.string().min(1).max(64),
  key_protection: KeyProtectionSchema,
  attestation: b64.optional(),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const ClaimResponse = z.object({
  claim_id: b64,
  claim_token: z.string(),
  status: z.literal("pending"),
  events_url: z.string(),
});

export const ClaimStatusSchema = z.enum(["pending", "approved", "denied", "expired", "revoked", "downloaded"]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ClaimStatusResponse = z.object({ claim_id: b64, status: ClaimStatusSchema, transfer_ready: z.boolean() });

export const ClaimSummary = z.object({
  claim_id: b64,
  receiver_pub: b64,
  receiver_sig_pub: b64,
  label: z.string(),
  key_protection: KeyProtectionSchema,
  status: ClaimStatusSchema,
  created_at: z.number().int(),
});
export type ClaimSummary = z.infer<typeof ClaimSummary>;

export const TransferStatusResponse = z.object({
  transfer_id: b64,
  mode: TransferModeSchema,
  uploaded: z.boolean(),
  expires_at: z.number().int(),
  claims: z.array(ClaimSummary),
});

/** User verification evidence attached to approvals (ADR-0005). */
export const UvEvidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device") }), // hardware-gated device signature on the request itself
  z.object({
    kind: z.literal("webauthn"),
    credential_id: b64,
    client_data_json: b64,
    authenticator_data: b64,
    signature: b64,
  }),
]);
export type UvEvidence = z.infer<typeof UvEvidence>;

export const ApproveRequest = z.object({ wrap: b64, uv: UvEvidence });
export const WrapResponse = z.object({ wrap: b64 });

/** Events pushed to the sender over the transfer WebSocket. */
export const SenderEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("claim"), claim: ClaimSummary }),
  z.object({ type: z.literal("claim_update"), claim_id: b64, status: ClaimStatusSchema }),
  z.object({ type: z.literal("uploaded") }),
  z.object({ type: z.literal("expired") }),
]);
export type SenderEvent = z.infer<typeof SenderEvent>;

/** Events pushed to a claiming receiver. */
export const ReceiverEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: ClaimStatusSchema, transfer_ready: z.boolean() }),
]);
export type ReceiverEvent = z.infer<typeof ReceiverEvent>;

// ---------------------------------------------------------------- mailbox (Paired)

export const MailboxWrap = z.object({ device: b64, prekey_id: b64.nullable(), wrap: b64 });

export const DeliverRequest = z.object({
  transfer_id: b64,
  sender_fp: b64,
  wraps: z.array(MailboxWrap).min(1).max(64),
});

export const MailboxItem = z.object({
  transfer_id: b64,
  sender_fp: b64,
  sender_device: b64,
  prekey_id: b64.nullable(),
  wrap: b64,
  created_at: z.number().int(),
  expires_at: z.number().int(),
});
export type MailboxItem = z.infer<typeof MailboxItem>;

export const MailboxResponse = z.object({ items: z.array(MailboxItem) });

// ---------------------------------------------------------------- presence and signaling (Paired live)

/** Client → relay frames on the presence socket. */
export const PresenceClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("signal"), to_fp: b64, to_device: b64.optional(), payload: b64 }),
  z.object({ type: z.literal("watch"), fps: z.array(b64).max(500) }),
  z.object({ type: z.literal("ping") }),
]);
export type PresenceClientFrame = z.infer<typeof PresenceClientFrame>;

/** Relay → client frames. `payload` is a signed CBOR signaling message verified by the receiver. */
export const PresenceServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("signal"), from_fp: b64, from_device: b64, payload: b64 }),
  z.object({ type: z.literal("presence"), fp: b64, devices_online: z.number().int() }),
  z.object({ type: z.literal("mailbox") }),
  z.object({ type: z.literal("pong") }),
]);
export type PresenceServerFrame = z.infer<typeof PresenceServerFrame>;

export const TurnResponse = z.object({
  ice_servers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })),
  expires_at: z.number().int(),
});

// ---------------------------------------------------------------- devices, push, webauthn, reports

export const PushRegistration = z.object({ platform: z.enum(["apns", "fcm", "webpush"]), token: z.string().min(1).max(4096) });

export const WebAuthnOptionsResponse = z.object({ options: z.record(z.string(), z.unknown()) });
export const WebAuthnRegisterVerifyRequest = z.object({ response: z.record(z.string(), z.unknown()) });

export const ReportRequest = z.object({
  transfer_id: b64,
  reason: z.enum(["malware", "harassment", "illegal", "spam", "other"]),
  details: z.string().max(2000).optional(),
  evidence_sha256: b64.optional(),
});

export const OkResponse = z.object({ ok: z.literal(true) });

/** Path builders shared by client and relay router. */
export const Paths = {
  identities: () => `/v1/identities`,
  chain: (fp: string) => `/v1/identities/${fp}/chain`,
  links: (fp: string) => `/v1/identities/${fp}/links`,
  prekeys: (fp: string) => `/v1/identities/${fp}/prekeys`,
  prekeyCount: (fp: string) => `/v1/identities/${fp}/prekeys/count`,
  claimPrekeys: (fp: string) => `/v1/identities/${fp}/prekeys/claim`,
  transfers: () => `/v1/transfers`,
  transfer: (id: string) => `/v1/transfers/${id}`,
  manifest: (id: string) => `/v1/transfers/${id}/manifest`,
  segment: (id: string, n: number) => `/v1/transfers/${id}/segments/${n}`,
  padding: (id: string, k: number) => `/v1/transfers/${id}/padding/${k}`,
  finalize: (id: string) => `/v1/transfers/${id}/finalize`,
  transferEvents: (id: string) => `/v1/transfers/${id}/events`,
  claims: (id: string) => `/v1/transfers/${id}/claims`,
  claim: (id: string, cid: string) => `/v1/transfers/${id}/claims/${cid}`,
  approve: (id: string, cid: string) => `/v1/transfers/${id}/claims/${cid}/approve`,
  deny: (id: string, cid: string) => `/v1/transfers/${id}/claims/${cid}/deny`,
  wrap: (id: string, cid: string) => `/v1/transfers/${id}/claims/${cid}/wrap`,
  complete: (id: string, cid: string) => `/v1/transfers/${id}/claims/${cid}/complete`,
  claimStatus: (cid: string) => `/v1/claims/${cid}`,
  claimEvents: (cid: string) => `/v1/claims/${cid}/events`,
  mailbox: (fp: string) => `/v1/mailbox/${fp}`,
  myMailbox: () => `/v1/mailbox`,
  mailboxItem: (transferId: string) => `/v1/mailbox/items/${transferId}`,
  presence: () => `/v1/presence`,
  turn: () => `/v1/turn`,
  push: () => `/v1/devices/push`,
  webauthnRegisterOptions: () => `/v1/webauthn/register/options`,
  webauthnRegisterVerify: () => `/v1/webauthn/register/verify`,
  webauthnAuthOptions: () => `/v1/webauthn/authenticate/options`,
  reports: () => `/v1/reports`,
  health: () => `/v1/health`,
} as const;

/** Limits shared by client and relay (spec §6.2, §8.3). */
export const Limits = {
  maxSegmentCipherBytes: 1024 * 1024 + 16,
  maxPaddingPartBytes: 8 * 1024 * 1024,
  maxManifestPartBytes: 4 * 1024 * 1024,
  claimTimeoutSeconds: 120,
  defaultTtlSeconds: 86400,
  roomMaxTtlSeconds: 7 * 86400,
  pairedTtlSeconds: 30 * 86400,
  requestClockSkewSeconds: 120,
  roomDefaultCap: 200,
  roomDefaultWindowSeconds: 900,
  prekeyLowWater: 20,
  prekeyBatch: 100,
} as const;
