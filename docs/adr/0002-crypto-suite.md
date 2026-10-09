# ADR-0002: Cryptographic suite — P-256, HPKE, AES-256-GCM, SHA-256

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §5, test suite `crypto/vectors`

## Context

Three forces constrain the suite:

1. **Hardware key storage.** Apple's Secure Enclave generates and uses only NIST P-256 keys. Android StrongBox and TEE Keymint support P-256 widely; X25519 support in hardware is uneven. Device keys must live in hardware (ADR-0005), so the curve must be P-256.
2. **Government buyers.** The Air-gap market expects FIPS 140-3 validated modules. P-256, AES-GCM, HKDF-SHA-256 and SHA-256 are all approved algorithms; X25519/ChaCha20 are not in the FIPS boundary.
3. **Standards over invention.** Key encapsulation should use a published construction with test vectors.

## Decision

| Purpose | Algorithm | Reference |
|---|---|---|
| Key encapsulation | HPKE, `DHKEM(P-256, HKDF-SHA256)`, `HKDF-SHA256`, `AES-256-GCM` (suite 0x0010/0x0001/0x0002) | RFC 9180 |
| Signatures | ECDSA P-256 with SHA-256, deterministic nonces | FIPS 186-5, RFC 6979 |
| Content encryption | AES-256-GCM in a segmented STREAM construction | ADR-0003 |
| Hashing | SHA-256 | FIPS 180-4 |
| Key derivation | HKDF-SHA256 with Sealed-specific labels | RFC 5869 |
| Short authentication strings | HKDF-SHA256 truncated to 20 bits, shown as 6 decimal digits | spec §5.6 |

HPKE mode selection:

- **Base** mode for Direct and Room, where the sender has no long-term identity relationship with the recipient.
- **Auth** mode for Paired and pinned Air-gap, so the recipient can verify the wrap came from a pinned sender device key.

Implementation: the Rust core uses RustCrypto crates (`p256`, `aes-gcm`, `hkdf`, `sha2`, `hpke` with the P-256 feature) for portability. A `fips` build feature swaps the backend to `aws-lc-rs`, whose AWS-LC module holds FIPS 140-3 validation, for government deployments. On-device hardware keys are reached through platform APIs (CryptoKit `SecureEnclave.P256`, Android Keystore) behind a `KeyStore` trait; the core never sees private key bytes for hardware keys.

## Alternatives considered

- **X25519 + ChaCha20-Poly1305.** Faster in software and simpler, but incompatible with Secure Enclave and outside FIPS. Rejected.
- **Post-quantum hybrid now (X-Wing / ML-KEM-768 + P-256).** Desirable for harvest-now-decrypt-later threats on stored ciphertext. Deferred to ADR-0016 (planned): the KEM identifier is carried in every wrap, so a hybrid KEM can be added without a format break.

## Consequences

- One curve everywhere simplifies audits and test vectors.
- AES-GCM has a 2^32 invocation limit per key with random nonces; the STREAM construction (ADR-0003) uses deterministic counters under a per-Envelope key, so the limit is not reached.
- The FIPS build is a compile flag, not a fork.

## Verification

- `crypto/vectors`: the CFRG-published HPKE test vectors (RFC 9180 Appendix A set, JSON) for the chosen suite must pass in native and WASM builds, and with both backends.
- `crypto/interop`: wraps produced on iOS (CryptoKit) decrypt in the Rust core and vice versa, run nightly on device farm.
- `crypto/negative`: tampered `enc`, wrong `info`, wrong suite ID and truncated ciphertext must all fail closed with a typed error.
