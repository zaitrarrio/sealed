# ADR-0016: What the first implementation does differently from the specification

**Status:** Accepted · **Date:** 2026-10-09 · **Amends:** ADR-0011, ADR-0003, ADR-0006, ADR-0008/0010; spec §5–§10

## Context

The first implementation (this repository) had to deliver every mode on web, iOS and Android at once. Some
decisions in the specification assumed a team and a timeline that the first build did not have (a Rust core
with GPU kernels), and a few details changed once code met reality. This ADR records each deviation so the
spec, the code and reviewers agree on what actually ships.

## Decisions

### 1. TypeScript core instead of Rust + wgpu (amends ADR-0011)

`packages/core` is one isomorphic TypeScript package used unchanged by the web client, the Expo app and the
relay. Crypto uses audited `@noble/*` libraries, with WebCrypto (browser) or react-native-quick-crypto
(native, OpenSSL) for bulk AES-GCM after a known-answer cross-check at startup. HPKE passes all RFC 9180
P-256 test vectors; the RaptorQ implementation is bit-exact with the Rust `raptorq` 2.0.1 crate
(`tools/fec-vectors`).

*Why:* one implementation still gives one audit surface (the goal of ADR-0011), without a WASM/UniFFI
toolchain. *Cost:* see 7.

### 2. Expo / React Native for the mobile apps

The apps are one Expo SDK 57 code base. Hardware keys live in a local Expo module
(`apps/mobile/modules/sealed-keystore`: Swift with CryptoKit + LocalAuthentication, Kotlin with Android
Keystore + BiometricPrompt). Camera capture uses VisionCamera 5; optical streams are drawn with Skia.

### 3. DEFLATE instead of zstd (amends spec §8.2 key 6)

Compression value **2 = DEFLATE (raw, fflate)** is used; value 1 (zstd) is reserved and not produced. A
dependable, small, pure-JS zstd *encoder* was not available for all three runtimes. Already-compressed media
types are stored uncompressed (value 0), as before.

### 4. Manifest AEAD associated data is the first 22 header bytes (clarifies spec §8.1)

The manifest is sealed with associated data = header bytes 0–21 (magic, version, flags, transfer id). The
4-byte manifest-length field is excluded because it is only known after encryption. Payload segments keep
the magic as associated data. Tampering with any covered byte fails authentication.

### 5. Paper keys are base32 text, not BIP-39 words (amends spec §6.3.5)

The paper key is base32 of `fingerprint ∥ secret ∥ 4-byte checksum`, grouped in fives, shown with a QR code.
It carries the identity fingerprint so recovery needs nothing else. A word-list encoding can be layered on
later without changing the key material.

### 6. Pairing is mutual-scan only; contacts are per device (amends spec §6.3.3–6.3.4)

- The one-sided pairing variant (relay-mediated return path) is not implemented; both people scan each
  other's code and confirm the SAS on their own devices.
- The add-device cosignature travels inside the new-device code (CBOR field 6) instead of being collected
  over the relay.
- There is no encrypted sync blob yet: each device keeps its own contact list (encrypted at rest on mobile,
  in IndexedDB on the web). A new device starts with no contacts.

### 7. Facet decoding runs on the CPU in JavaScript (amends ADR-0008, ADR-0010)

There are no GPU kernels. The decoder measures **~0.5–0.8 s per captured frame in Node**; Hermes on a phone
is slower. Consequences:

- Web receivers decode in a Worker and drop frames while busy; phones do the same with a worklet-side busy
  flag. RaptorQ repair symbols cover dropped frames, but effective throughput is far below the spec's
  T1–T3 targets.
- Phones report T1 in their reverse key code until they have measured an optical receive, then choose the
  tier from measured capture rate and decode time (`apps/mobile/src/lib/capability.ts`). Web receivers report
  T1 or T0 from a camera probe and never T2/T3.
- T0 (QR) decoding uses jsQR plus an unsharp-mask retry. In the simulated channel it holds up to about σ0.15
  blur and ±5° rotation; the denser grid tiers tolerate more (σ0.35 with the full channel model).

A native (or WebGPU) decoder is required before optical modes can be marketed at the spec's rates.

### 8. Repair symbols never end

Senders emit repair symbols indefinitely (spec §7.5) by default; a finite repair budget is available for
tests only. Broadcast loops; Air-gap streams until the sender stops.

## Consequences

- The spec remains the target design; this ADR is the list of gaps to close or ratify. Items 1 and 7 are the
  largest: the optical modes work end to end but slowly.
- Swift and Kotlin code for the keystore module was written without a compiler in CI. It must be built and
  exercised on real devices (Secure Enclave and StrongBox are unavailable in simulators/emulators) before
  release.

## Verification

- Core: `pnpm --filter @sealed/core test` (HPKE vectors, Envelope, sigchain, protocols, RaptorQ parity, Facet
  round trips through a simulated camera for every tier).
- Relay: `pnpm --filter @sealed/relay test`. Web: unit tests and Playwright end-to-end tests of every mode.
- Mobile: `pnpm --filter @sealed/mobile test` (encrypted storage, at-rest encryption, hardware-key binding
  with a fake keystore, code routing, optical decode of camera-shaped frames), `expo-doctor`, and
  `expo export` for iOS and Android.
