/**
 * Passkeys (spec §5.2, §9.2, ADR-0005). On the web a device key is not hardware-gated, so every approval carries
 * a user-verifying WebAuthn assertion over a relay challenge bound to exactly that approval.
 *
 * If no passkey is registered yet, `ensurePasskeyThenVerify` registers one in-flow on the first approval so
 * senders are not blocked by a missing Settings step.
 */
import { RelayError, type RelayClient, type UvEvidence } from "@sealed/core";
import { startAuthentication, startRegistration, WebAuthnError, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

export function webauthnSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials);
}

/** Registers a passkey for this identity (device-signed request; the relay binds it to the fingerprint). */
export async function registerPasskey(client: RelayClient): Promise<void> {
  const { options } = await client.webauthnRegisterOptions();
  const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
  await client.webauthnRegisterVerify(response as unknown as Record<string, unknown>);
}

/** Collects user verification for one action string (e.g. approvalAction(...)) as relay UV evidence. */
export async function userVerification(client: RelayClient, action: string): Promise<UvEvidence> {
  const { options } = await client.webauthnAuthOptions(action);
  const r = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return {
    kind: "webauthn",
    credential_id: r.id,
    client_data_json: r.response.clientDataJSON,
    authenticator_data: r.response.authenticatorData,
    signature: r.response.signature,
  };
}

/**
 * Ensures a passkey exists (registering in-flow when needed), then returns UV evidence for `action`.
 * `onRegistered` is called after a successful first-time registration so the session profile can be updated.
 */
export async function ensurePasskeyThenVerify(
  client: RelayClient,
  action: string,
  opts: { alreadyRegistered?: boolean; onRegistered?: () => void | Promise<void> } = {},
): Promise<UvEvidence> {
  if (!opts.alreadyRegistered) {
    try {
      await registerPasskey(client);
      await opts.onRegistered?.();
    } catch (e) {
      // Already registered on the relay but the local profile flag was stale — continue to authenticate.
      if (!(e instanceof RelayError && (e.status === 409 || e.code === "conflict"))) throw e;
      await opts.onRegistered?.();
    }
  }
  try {
    return await userVerification(client, action);
  } catch (e) {
    // No passkey on the relay (stale true flag, or registration just failed silently) — register then retry once.
    if (e instanceof RelayError && e.status === 404) {
      await registerPasskey(client);
      await opts.onRegistered?.();
      return await userVerification(client, action);
    }
    throw e;
  }
}

/** Human message for WebAuthn failures (cancelled prompts are the common case). */
export function describeWebAuthnError(e: unknown): string {
  if (e instanceof WebAuthnError) {
    if (e.code === "ERROR_CEREMONY_ABORTED") return "The passkey prompt was cancelled.";
    if (e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "This passkey is already registered.";
    return e.message;
  }
  if (e instanceof DOMException && e.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  return e instanceof Error ? e.message : String(e);
}
