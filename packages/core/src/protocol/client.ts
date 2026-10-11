/** Typed client for the Sealed relay (spec §9.2), usable from browsers, React Native and Workers. */
import type { z } from "zod";
import { fromB64url, toB64url, utf8 } from "../bytes";
import { compress } from "../crypto/keyid";
import type { SigningKey } from "../crypto/keys";
import {
  AppendLinksResponse,
  ChainResponse,
  ClaimPrekeysResponse,
  ClaimResponse,
  ClaimStatusResponse,
  CreateIdentityResponse,
  CreateTransferResponse,
  ErrorBodySchema,
  MailboxResponse,
  OkResponse,
  PairingReturnResponse,
  Paths,
  PrekeyCountResponse,
  SyncBlobResponse,
  TransferStatusResponse,
  TurnResponse,
  UploadPrekeysResponse,
  WebAuthnOptionsResponse,
  WrapResponse,
  type ClaimRequest,
  type CreateTransferRequest,
  type SignedPrekey,
  type UvEvidence,
} from "./api";
import { SIGNATURE_HEADER, signRequest } from "./auth";

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface DeviceIdentity {
  fingerprint: Uint8Array;
  signing: SigningKey;
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string | null; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface RelayClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  identity?: DeviceIdentity;
}

type Auth = { kind: "none" } | { kind: "device" } | { kind: "bearer"; token: string };

export class RelayClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  identity: DeviceIdentity | undefined;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis.fetch?.bind(globalThis) as unknown as FetchLike | undefined);
    if (!f) throw new Error("no fetch implementation available");
    this.fetchImpl = f;
    this.identity = opts.identity;
  }

  private requireIdentity(): DeviceIdentity {
    if (!this.identity) throw new Error("this request requires a device identity");
    return this.identity;
  }

  private async request(method: string, path: string, auth: Auth, body?: Uint8Array | object, accept: "json" | "bytes" = "json", signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {};
    let raw: Uint8Array | undefined;
    if (body instanceof Uint8Array) {
      raw = body;
      headers["content-type"] = "application/octet-stream";
    } else if (body !== undefined) {
      raw = utf8(JSON.stringify(body));
      headers["content-type"] = "application/json";
    }
    if (auth.kind === "device") {
      const id = this.requireIdentity();
      headers[SIGNATURE_HEADER] = await signRequest(id.signing, id.fingerprint, method, path, raw ?? new Uint8Array(0));
    } else if (auth.kind === "bearer") {
      headers["authorization"] = `Bearer ${auth.token}`;
    }
    const res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: raw ?? null, ...(signal ? { signal } : {}) });
    if (!res.ok) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const parsed = ErrorBodySchema.safeParse(await res.json());
        if (parsed.success) {
          code = parsed.data.error;
          message = parsed.data.message ?? parsed.data.error;
        }
      } catch {
        // non-JSON error body
      }
      throw new RelayError(res.status, code, message);
    }
    return accept === "bytes" ? new Uint8Array(await res.arrayBuffer()) : res.json();
  }

  private async json<T extends z.ZodTypeAny>(schema: T, method: string, path: string, auth: Auth, body?: object): Promise<z.infer<T>> {
    return schema.parse(await this.request(method, path, auth, body));
  }

  /** Builds a WebSocket URL with a device signature or bearer token in the query (browsers cannot set headers). */
  async socketUrl(path: string, auth: { kind: "device" } | { kind: "bearer"; token: string }): Promise<string> {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    if (auth.kind === "bearer") return `${wsBase}${path}?token=${encodeURIComponent(auth.token)}`;
    const id = this.requireIdentity();
    const sig = await signRequest(id.signing, id.fingerprint, "GET", path);
    return `${wsBase}${path}?sig=${encodeURIComponent(sig)}`;
  }

  health(): Promise<unknown> {
    return this.request("GET", Paths.health(), { kind: "none" });
  }

  // ------------------------------------------------------------ identities

  createIdentity(link: Uint8Array) {
    return this.json(CreateIdentityResponse, "POST", Paths.identities(), { kind: "none" }, { link: toB64url(link) });
  }

  async getChain(fingerprint: Uint8Array, since = 0): Promise<{ links: Uint8Array[]; headSeq: number }> {
    const r = await this.json(ChainResponse, "GET", `${Paths.chain(toB64url(fingerprint))}?since=${since}`, { kind: "none" });
    return { links: r.links.map(fromB64url), headSeq: r.head_seq };
  }

  appendLinks(links: Uint8Array[]) {
    const id = this.requireIdentity();
    return this.json(AppendLinksResponse, "POST", Paths.links(toB64url(id.fingerprint)), { kind: "device" }, { links: links.map(toB64url) });
  }

  uploadPrekeys(prekeys: SignedPrekey[]) {
    const id = this.requireIdentity();
    return this.json(UploadPrekeysResponse, "POST", Paths.prekeys(toB64url(id.fingerprint)), { kind: "device" }, { device: toB64url(compress(id.signing.publicKey)), prekeys });
  }

  prekeyCount() {
    const id = this.requireIdentity();
    return this.json(PrekeyCountResponse, "GET", `${Paths.prekeyCount(toB64url(id.fingerprint))}?device=${toB64url(compress(id.signing.publicKey))}`, { kind: "device" });
  }

  claimPrekeys(fingerprint: Uint8Array) {
    return this.json(ClaimPrekeysResponse, "POST", Paths.claimPrekeys(toB64url(fingerprint)), { kind: "device" }, {});
  }

  // ------------------------------------------------------------ transfers (sender)

  createTransfer(req: CreateTransferRequest) {
    return this.json(CreateTransferResponse, "POST", Paths.transfers(), { kind: "device" }, req);
  }

  async uploadManifest(transferId: string, uploadToken: string, bytes: Uint8Array): Promise<void> {
    await this.request("PUT", Paths.manifest(transferId), { kind: "bearer", token: uploadToken }, bytes);
  }

  async uploadSegment(transferId: string, uploadToken: string, index: number, bytes: Uint8Array): Promise<void> {
    await this.request("PUT", Paths.segment(transferId, index), { kind: "bearer", token: uploadToken }, bytes);
  }

  async uploadPadding(transferId: string, uploadToken: string, part: number, bytes: Uint8Array): Promise<void> {
    await this.request("PUT", Paths.padding(transferId, part), { kind: "bearer", token: uploadToken }, bytes);
  }

  finalize(transferId: string, uploadToken: string, segments: number, paddingParts: number) {
    return this.json(OkResponse, "POST", Paths.finalize(transferId), { kind: "bearer", token: uploadToken }, { segments, padding_parts: paddingParts });
  }

  transferStatus(transferId: string) {
    return this.json(TransferStatusResponse, "GET", Paths.transfer(transferId), { kind: "device" });
  }

  approve(transferId: string, claimId: string, wrap: Uint8Array, uv: UvEvidence) {
    return this.json(OkResponse, "POST", Paths.approve(transferId, claimId), { kind: "device" }, { wrap: toB64url(wrap), uv });
  }

  deny(transferId: string, claimId: string) {
    return this.json(OkResponse, "POST", Paths.deny(transferId, claimId), { kind: "device" }, {});
  }

  revoke(transferId: string, claimId: string) {
    return this.json(OkResponse, "DELETE", Paths.claim(transferId, claimId), { kind: "device" });
  }

  cancelTransfer(transferId: string) {
    return this.json(OkResponse, "DELETE", Paths.transfer(transferId), { kind: "device" });
  }

  // ------------------------------------------------------------ transfers (receiver)

  claim(transferId: string, req: ClaimRequest) {
    return this.json(ClaimResponse, "POST", Paths.claims(transferId), { kind: "none" }, req);
  }

  claimStatus(claimId: string, claimToken: string, waitSeconds = 0) {
    return this.json(ClaimStatusResponse, "GET", `${Paths.claimStatus(claimId)}?wait=${waitSeconds}`, { kind: "bearer", token: claimToken });
  }

  async fetchWrap(transferId: string, claimId: string, claimToken: string): Promise<Uint8Array> {
    const r = await this.json(WrapResponse, "GET", Paths.wrap(transferId, claimId), { kind: "bearer", token: claimToken });
    return fromB64url(r.wrap);
  }

  /** Downloads the manifest part with a claim token, or with the device signature for Paired transfers. */
  async downloadManifest(transferId: string, auth: { claimToken: string } | "device"): Promise<Uint8Array> {
    return (await this.request("GET", Paths.manifest(transferId), auth === "device" ? { kind: "device" } : { kind: "bearer", token: auth.claimToken }, undefined, "bytes")) as Uint8Array;
  }

  async downloadSegment(transferId: string, index: number, auth: { claimToken: string } | "device", signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.request("GET", Paths.segment(transferId, index), auth === "device" ? { kind: "device" } : { kind: "bearer", token: auth.claimToken }, undefined, "bytes", signal)) as Uint8Array;
  }

  complete(transferId: string, claimId: string, claimToken: string) {
    return this.json(OkResponse, "POST", Paths.complete(transferId, claimId), { kind: "bearer", token: claimToken }, {});
  }

  // ------------------------------------------------------------ mailbox, presence, misc

  deliver(recipientFp: Uint8Array, transferId: string, wraps: { device: Uint8Array; prekeyId: Uint8Array | null; wrap: Uint8Array }[]) {
    const id = this.requireIdentity();
    return this.json(OkResponse, "POST", Paths.mailbox(toB64url(recipientFp)), { kind: "device" }, {
      transfer_id: transferId,
      sender_fp: toB64url(id.fingerprint),
      wraps: wraps.map((w) => ({ device: toB64url(w.device), prekey_id: w.prekeyId ? toB64url(w.prekeyId) : null, wrap: toB64url(w.wrap) })),
    });
  }

  mailbox() {
    return this.json(MailboxResponse, "GET", Paths.myMailbox(), { kind: "device" });
  }

  ackMailbox(transferId: string) {
    return this.json(OkResponse, "DELETE", Paths.mailboxItem(transferId), { kind: "device" });
  }

  turn() {
    return this.json(TurnResponse, "GET", Paths.turn(), { kind: "device" });
  }

  registerPush(platform: "apns" | "fcm" | "webpush", token: string) {
    return this.json(OkResponse, "POST", Paths.push(), { kind: "device" }, { platform, token });
  }

  webauthnRegisterOptions() {
    return this.json(WebAuthnOptionsResponse, "POST", Paths.webauthnRegisterOptions(), { kind: "device" }, {});
  }

  webauthnRegisterVerify(response: Record<string, unknown>) {
    return this.json(OkResponse, "POST", Paths.webauthnRegisterVerify(), { kind: "device" }, { response });
  }

  /** Options for an assertion whose challenge is bound to `action` (e.g. "approve:<transfer>:<claim>:<wrap hash>"). */
  webauthnAuthOptions(action: string) {
    return this.json(WebAuthnOptionsResponse, "POST", Paths.webauthnAuthOptions(), { kind: "device" }, { action });
  }

  report(req: { transfer_id: string; reason: "malware" | "harassment" | "illegal" | "spam" | "other"; details?: string; evidence_sha256?: string }, claimToken?: string) {
    return this.json(OkResponse, "POST", Paths.reports(), claimToken ? { kind: "bearer", token: claimToken } : { kind: "device" }, req);
  }

  /** PUT opaque encrypted contacts sync blob (spec §6.3.4). */
  putSyncBlob(ciphertextB64: string) {
    const id = this.requireIdentity();
    return this.json(OkResponse, "PUT", Paths.sync(toB64url(id.fingerprint)), { kind: "device" }, { ciphertext: ciphertextB64 });
  }

  /** GET opaque encrypted contacts sync blob, or null when none stored. */
  async getSyncBlob(): Promise<string | null> {
    const id = this.requireIdentity();
    try {
      const r = await this.json(SyncBlobResponse, "GET", Paths.sync(toB64url(id.fingerprint)), { kind: "device" });
      return r.ciphertext;
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  /** Post a one-sided pairing return bundle for the peer who showed a code (spec §6.3.3). */
  postPairingReturn(peerFp: Uint8Array, bundleB64: string) {
    return this.json(OkResponse, "POST", Paths.pairingReturn(toB64url(peerFp)), { kind: "device" }, { bundle: bundleB64 });
  }

  /** Poll for a one-sided pairing return bundle addressed to this identity. */
  async getPairingReturn(): Promise<string | null> {
    const id = this.requireIdentity();
    try {
      const r = await this.json(PairingReturnResponse, "GET", Paths.pairingReturn(toB64url(id.fingerprint)), { kind: "device" });
      return r.bundle;
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }
}
