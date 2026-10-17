# ADR-0023: Native grid decoder — the Facet grid receive path in Rust, one C ABI for WebAssembly and phones

**Status:** Accepted · **Date:** 2026-10-17 · **Builds on:** ADR-0011, ADR-0018, ADR-0019, ADR-0022

## Context

QR (T0) through platform detectors tops out around 60 KB/s with the fastest profile (ADR-0019). The colour-grid
tiers carry 7–14 KB per frame at 10–20 frames/s (70–280 KB/s nominal) but their decoder runs in JavaScript:
measured on simulated 1280×960 captures in Node, T1 takes ~600 ms per frame (detect 65, refine 36, sample 16,
header 28, data detection 500) and T3 ~1.1 s. Phones are slower. That is the one thing between Sealed and an
order of magnitude.

The data stage dominates because it is a joint colour-and-shape maximum-likelihood detector with iterative
interference cancellation, turbo Reed–Solomon and temporal fusion, all in scalar JavaScript over 12,544–20,736
cells. This is compute, not algorithm: the same arithmetic compiled natively with SIMD is the fix, and the
algorithm is already validated by the JavaScript tests.

ADR-0011 planned a Rust core compiled to WASM and native; what shipped was a skeleton. This ADR replaces it with
a port of the real decoder.

## Decision

1. **Port, do not redesign.** `crates/sealed-facet` is a module-for-module port of `packages/core/src/facet`
   (random, gf256/rs, header, palette, glyphs, layout, grid, homography, detect, refine, sample, model,
   calibrate, equalize, vamp, decode, receiver). The JavaScript stays the reference and test oracle. Each
   module is checked against vectors generated from the TypeScript, and the whole pipeline against fixtures of
   simulated captures (`pnpm fixtures:grid`) that record every stage's JavaScript result.
2. **The boundary is "pixels in, frames out".** The native decoder owns detection, calibration and data
   detection and returns header ∥ payload bytes; `FacetReceiver.pushFrameBytes` consumes them exactly as it
   consumes a QR frame from a platform detector. RaptorQ, descriptors, keys and the envelope stay in TypeScript
   on every platform, so the security-relevant parsing has one implementation.
3. **One C ABI over linear memory** (`crates/sealed-facet/src/ffi.rs`, mirrored by
   `packages/core/src/facet/native.ts`): `facet_alloc/free`, `facet_decoder_new/free/push/frame_len/frame_copy/
   pixels_per_cell`. The web loads the same `.wasm` with `WebAssembly.instantiate` and no bindgen toolchain;
   the phones link the same symbols from a static library through a VisionCamera frame-processor plugin.
   `tools/build-facet-wasm.sh` builds `packages/core/wasm/sealed_facet.wasm` (git-ignored; a build step).
4. **Fallback stays.** Where the module is missing (no build) or fails to load, the JavaScript decoder runs as
   before; the QR tiers are untouched.
5. **CPU first.** The port targets scalar + SIMD CPU (wasm simd128, NEON via autovectorisation). GPU kernels
   (wgpu) remain a later step once the CPU port is the bottleneck on phones.

## Consequences

- One decoder to audit for the grid tiers, on three platforms; the JavaScript version remains for browsers that
  cannot run the module and as the oracle.
- Build: Rust toolchain with the `wasm32-unknown-unknown` target for the web; `cargo-ndk`/Xcode for the phones.
  CI builds the wasm before the web app.
- Fixtures are tens of MB and generated on demand, not committed.

## Results (2026-10-17, simulated 1280×960 captures, byte-exact against the JavaScript decoder)

| Path | T1 data frame | T3 data frame |
|---|---|---|
| JavaScript (Node) | ≈ 600 ms | ≈ 1,100 ms |
| Rust, one thread | ≈ 90 ms | ≈ 150 ms |
| Rust, threads (2-core box) | ≈ 65 ms | ≈ 95 ms |
| WebAssembly (Node, single-threaded, SSE2-class SIMD) | ≈ 120 ms | ≈ 200 ms |

The remaining single-thread cost is dense LMMSE products at the SIMD width of baseline x86-64; everything heavy
is row-, cell- or codeword-parallel, so a 4–8-core phone with NEON is expected to land well under the frame
interval of T1 (100 ms) and near it for T3 (50 ms). The web receiver offers tier 1 when the module loads.

## Verification

- Per-module parity tests with TypeScript-generated vectors under `crates/sealed-facet/tests/vectors`.
- Fixture parity: every stage's output within tolerance of the JavaScript result; decoded payload bytes equal.
- `packages/core/test/facet/native.test.ts`: the wasm decodes the fixture captures to the frames the sender
  emitted, feeds `FacetReceiver`, and is faster than the JavaScript decoder (the measured ratio is printed).
- `crates/sealed-facet/tests/profile.rs` prints per-stage times; `tests/receiver.rs` runs the whole path.
- Web e2e: the offline receive page offers tier 1 and decodes a T1 stream from the fake camera natively.
- On devices: the Benchmark's grid tiers with the native decoder, compared with the JavaScript path.
