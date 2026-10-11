# ADR-0017: Rust+wgpu migration path and unified Send/Receive UX

**Status:** Accepted · **Date:** 2026-10-11 · **Amends:** ADR-0011, ADR-0016

## Context

ADR-0016 recorded that the first implementation shipped a TypeScript core without GPU kernels. Transfers also failed in practice because share sessions were cancelled on React unmount, web senders blocked without a pre-registered passkey, and claim secrets were lost on reload. The product UI exposed five modes and cryptographic jargon.

## Decision

1. **Transfer lifecycle** lives in a process-level `TransferSessionStore` (web + mobile). Unmount no longer cancels uploads. Claim secrets are stashed in `sessionStorage`. Completed receives stay on a received-file shelf.
2. **Web approval** registers a passkey in-flow via `ensurePasskeyThenVerify` when none exists.
3. **UX** collapses to Send / Receive with automatic mode resolution (`resolveSendMode`) and "Safety code" copy instead of SAS jargon.
4. **Rust workspace** (`crates/sealed-core`, `sealed-facet`, `sealed-wasm`, `sealed-uniffi`) implements Envelope (zstd), BIP-39 paper keys, FEC, sans-IO protocol machines, and WGSL kernels (`rectify`, `calibrate`, `sample`, `syndrome`) with a CPU fallback oracle.
5. **Spec gaps closed in TS+relay:** BIP-39 paper keys (base32 still decodeable), encrypted contacts sync blob endpoints, one-sided pairing return path.

## Consequences

- TypeScript `@sealed/core` remains the production path for web/mobile until WASM bindings are wired into the Vite/Expo builds.
- Optical goodput still depends on replacing the JS FacetReceiver with `sealed-facet` (GPU) to hit Gate M2.
- CI runs Rust tests, TS unit tests, keystore source presence checks, and release-size proxies.

## Verification

- Gate M1: share session survives navigation (manual + e2e).
- Gate M2: `sealed-facet` CPU pipeline + WGSL sources present; GPU goodput measured on device corpus.
- Gate M3: `cargo test -p sealed-core` (HPKE/AES/RaptorQ/zstd/BIP-39).
- Gate M4: Home shows Send/Receive; mode-resolution unit tests; no SAS/DAK/CEK in default labels.
