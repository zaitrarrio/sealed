# ADR-0011: One Rust core, compiled to WASM and native, with wgpu decode kernels

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §10, test suite `core/`

## Context

Sealed ships on web, iOS and Android. The Envelope, crypto, protocol state machines and the Facet codec must behave identically on all three, and security review should cover one implementation, not three. Facet decoding at T2/T3 needs GPU compute.

## Decision

- **`sealed-core`** (Rust 2024 edition) contains Envelope, crypto (behind a `KeyStore` trait for hardware keys), protocol state machines (claim, pairing, sigchain verification, delivery) and the Facet encoder/decoder.
- **Web:** compiled to `wasm32-unknown-unknown` with `wasm-bindgen`, run in a Worker; TypeScript wrapper package `@sealed/core`.
- **iOS / Android:** exposed through **UniFFI** to Swift and Kotlin; platform code implements `KeyStore` (Secure Enclave / Keystore) and camera capture.
- **GPU kernels in WGSL via `wgpu`**, which targets WebGPU in browsers, Metal on Apple and Vulkan on Android from one codebase. Kernels: rectification (perspective warp from anchors), color correction, cell sampling, shape classification, RS syndrome computation. A SIMD CPU path (`std::simd` / NEON) is maintained as fallback and as the test oracle.
- State machines are pure (sans-IO): they consume events and emit commands; platforms perform network and camera IO. This makes every protocol testable deterministically.

## Alternatives considered

- **Per-platform native implementations.** Best platform fit, triple the audit cost. Rejected.
- **Kotlin Multiplatform or C++ core.** Viable; Rust gives memory safety for parsing untrusted frames and Envelopes, and the founder's Rust/WebGPU expertise. Rejected in favor of Rust.

## Consequences

- WebGPU is required for T1 on web; browsers without it fall back to the CPU path at T0/T1-reduced.
- Binary size must be watched for the web bundle (budget: core ≤ 1.5 MB gzipped WASM).

## Verification

- `core/parity`: the same golden inputs produce byte-identical outputs from native, WASM and both GPU and CPU paths.
- `core/fuzz`: `cargo-fuzz` targets for frame parsing, Envelope parsing, CBOR manifest, sigchain links; run continuously, zero open crashes before release.
- `core/size`: CI fails if gzipped WASM exceeds budget.
