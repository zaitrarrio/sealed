# ADR-0005: Device keys in hardware, gated by biometrics

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §5.2, test suite `keys/`

## Context

Passkeys and Face ID cannot be the shared secret: biometric data never leaves the device, and a passkey is a signing credential bound to one relying party. They can, however, make keys unusable without the owner present. Sealed needs a decryption key that cannot be copied off the phone and cannot be used by someone holding an unlocked phone.

## Decision

Each installation holds a **device key pair** (P-256, ADR-0002):

| Platform | Storage | Gate |
|---|---|---|
| iOS / iPadOS / macOS | Secure Enclave (`SecureEnclave.P256.KeyAgreement` and `.Signing`) | `kSecAccessControlBiometryCurrentSet` or device passcode, per user setting |
| Android | Keystore, StrongBox where `FEATURE_STRONGBOX_KEYSTORE` is present, else TEE | `setUserAuthenticationRequired(true)` with `AUTH_BIOMETRIC_STRONG` |
| Web | WebCrypto non-extractable `CryptoKey` in IndexedDB | WebAuthn user-verification assertion before each unwrap |

Two keys per device: an agreement key (HPKE recipient) and a signing key (manifests, sigchain links, ADR-0006). Hardware attestation (App Attest, Android Key Attestation) is collected and sent with claims when available, and shown to the sender as "hardware-protected" or "browser key".

The web tier is weaker: a non-extractable key resists exfiltration by script but lives in browser storage and can be lost when site data is cleared. The UI labels web receivers accordingly, and enterprise policy can refuse browser keys.

**Received files at rest** stay inside the app's storage encrypted under a per-file key wrapped by the device agreement key, so opening a received file requires a biometric or passcode prompt. Users can export a plaintext copy explicitly.

## Alternatives considered

- **Software keys protected by OS keychain only.** Simpler, but extractable from a jailbroken device or backup. Rejected for native; it is effectively the web fallback.
- **Passkey PRF extension (WebAuthn `prf`) to derive keys.** Promising for web: it yields a per-credential secret gated by user verification and synced across a user's devices. Adopted as an *enhancement* for web clients where supported; not relied on because support varies by authenticator.

## Consequences

- Device loss means key loss by design; recovery runs through the sigchain and paper key (ADR-0006).
- Biometric prompts add a tap per unwrap; batching unwraps per Envelope keeps it to one prompt per transfer.

## Verification

- `keys/nonexportable` (device farm): attempting to export private key material fails on each platform.
- `keys/gate`: unwrap without a satisfied biometric prompt fails; with `BiometryCurrentSet`, enrolling a new fingerprint or face invalidates the key and the app re-enrolls.
- `keys/attestation`: attestation objects from a test device verify against Apple and Google roots; tampered objects fail.
