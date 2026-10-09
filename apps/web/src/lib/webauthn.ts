/**
 * Passkeys (spec §5.2, §9.2, ADR-0005). On the web a device key is not hardware-gated, so every approval carries
 * a user-verifying WebAuthn assertion over a relay challenge bound to exactly that approval.
 */
import { startAuthentication, startRegistration, WebAuthnError, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { RelayClient, UvEvidence } from "@sealed/core";

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
