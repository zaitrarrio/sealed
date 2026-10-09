/**
 * Passkeys (spec §5.2, §9.2 "Accounts", ADR-0005). A passkey is registered per identity by a device-signed
 * request and later supplies user-verification evidence for approvals from devices without hardware-gated
 * keys (web). Every challenge is single-use, expires after 5 minutes, and is bound to the action it authorizes.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromB64url, toB64url, utf8, type UvEvidence } from "@sealed/core";
import type { Env } from "./env";
import { Errors, HttpError } from "./http";
import { nowSeconds } from "./util";

export interface RelyingParty {
  rpID: string;
  rpName: string;
  origins: string[];
}

export function relyingParty(env: Env, requestUrl: string): RelyingParty {
  const url = new URL(requestUrl);
  const rpID = env.WEBAUTHN_RP_ID && env.WEBAUTHN_RP_ID.length > 0 ? env.WEBAUTHN_RP_ID : url.hostname;
  const origins = (env.WEBAUTHN_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { rpID, rpName: env.WEBAUTHN_RP_NAME ?? "Sealed", origins: origins.length > 0 ? origins : [url.origin] };
}

const REGISTER_ACTION = "register";
const ACTION_RE = /^[A-Za-z0-9_:.-]{1,256}$/;

interface PasskeyRow extends Record<string, unknown> {
  credential_id: string;
  fp: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
}

async function passkeysFor(env: Env, fp: string): Promise<PasskeyRow[]> {
  const r = await env.DB.prepare("SELECT credential_id, fp, public_key, sign_count, transports FROM passkeys WHERE fp = ?").bind(fp).all<PasskeyRow>();
  return r.results;
}

function parseTransports(s: string | null): string[] | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

export async function registrationOptions(env: Env, rp: RelyingParty, fp: string, deviceLabel: string): Promise<Record<string, unknown>> {
  const challenge = await env.IDENTITY.getByName(fp).issueChallenge("register", REGISTER_ACTION);
  const existing = await passkeysFor(env, fp);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: `sealed-${fp.slice(0, 8)}`,
    userDisplayName: deviceLabel,
    userID: new Uint8Array(fromB64url(fp)),
    challenge: new Uint8Array(fromB64url(challenge)),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, ...(parseTransports(p.transports) ? { transports: parseTransports(p.transports)! } : {}) })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  });
  return options as unknown as Record<string, unknown>;
}

export async function verifyRegistration(env: Env, rp: RelyingParty, fp: string, response: Record<string, unknown>): Promise<void> {
  const stub = env.IDENTITY.getByName(fp);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: (c: string) => stub.consumeChallenge(c, "register", REGISTER_ACTION),
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch (e) {
    throw Errors.badRequest(`passkey registration failed: ${(e as Error).message}`);
  }
  if (!verification.verified) throw Errors.badRequest("passkey registration not verified");
  const cred = verification.registrationInfo.credential;
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO passkeys (credential_id, fp, public_key, sign_count, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(cred.id, fp, toB64url(cred.publicKey), cred.counter, cred.transports ? JSON.stringify(cred.transports) : null, nowSeconds())
    .run();
  if (inserted.meta.changes === 0) throw Errors.conflict("credential already registered");
}

export async function authenticationOptions(env: Env, rp: RelyingParty, fp: string, action: string): Promise<Record<string, unknown>> {
  if (!ACTION_RE.test(action)) throw Errors.badRequest("action must be 1..256 characters of [A-Za-z0-9_:.-]");
  const existing = await passkeysFor(env, fp);
  if (existing.length === 0) throw Errors.notFound("no passkey registered for this identity");
  const challenge = await env.IDENTITY.getByName(fp).issueChallenge("auth", action);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: new Uint8Array(fromB64url(challenge)),
    userVerification: "required",
    allowCredentials: existing.map((p) => ({ id: p.credential_id, ...(parseTransports(p.transports) ? { transports: parseTransports(p.transports)! } : {}) })),
  });
  return options as unknown as Record<string, unknown>;
}

/** Verifies a user-verifying assertion over a challenge issued for exactly `action`, and bumps the counter. */
export async function verifyAssertion(env: Env, rp: RelyingParty, fp: string, action: string, uv: Extract<UvEvidence, { kind: "webauthn" }>): Promise<void> {
  const row = await env.DB.prepare("SELECT credential_id, fp, public_key, sign_count, transports FROM passkeys WHERE credential_id = ?").bind(uv.credential_id).first<PasskeyRow>();
  if (!row || row.fp !== fp) throw new HttpError(403, "forbidden", "passkey is not registered to this identity");
  const stub = env.IDENTITY.getByName(fp);
  const response: AuthenticationResponseJSON = {
    id: uv.credential_id,
    rawId: uv.credential_id,
    type: "public-key",
    response: { clientDataJSON: uv.client_data_json, authenticatorData: uv.authenticator_data, signature: uv.signature },
    clientExtensionResults: {},
  };
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (c: string) => stub.consumeChallenge(c, "auth", action),
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      credential: { id: row.credential_id, publicKey: new Uint8Array(fromB64url(row.public_key)), counter: row.sign_count, ...(parseTransports(row.transports) ? { transports: parseTransports(row.transports)! } : {}) },
      requireUserVerification: true,
    });
  } catch (e) {
    throw new HttpError(403, "forbidden", `user verification failed: ${(e as Error).message}`);
  }
  if (!result.verified || !result.authenticationInfo.userVerified) throw new HttpError(403, "forbidden", "user verification failed");
  await env.DB.prepare("UPDATE passkeys SET sign_count = ? WHERE credential_id = ?").bind(result.authenticationInfo.newCounter, row.credential_id).run();
}

/** The challenge bytes exactly as encoded in clientDataJSON (b64url), for tests and diagnostics. */
export function challengeFromClientData(clientDataJsonB64: string): string | null {
  try {
    const cd = JSON.parse(new TextDecoder().decode(fromB64url(clientDataJsonB64))) as { challenge?: unknown };
    return typeof cd.challenge === "string" ? cd.challenge : null;
  } catch {
    return null;
  }
}

export const _internal = { utf8 };
