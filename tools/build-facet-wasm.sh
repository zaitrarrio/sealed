#!/usr/bin/env bash
# Builds the native grid decoder (crates/sealed-facet) to WebAssembly with a plain C ABI (ADR-0023) and places
# it where @sealed/core loads it from: packages/core/wasm/sealed_facet.wasm. No wasm-bindgen or wasm-pack needed.
set -euo pipefail
cd "$(dirname "$0")/.."
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128" cargo build -p sealed-facet --release --no-default-features --target wasm32-unknown-unknown
mkdir -p packages/core/wasm
cp target/wasm32-unknown-unknown/release/sealed_facet.wasm packages/core/wasm/sealed_facet.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-simd packages/core/wasm/sealed_facet.wasm -o packages/core/wasm/sealed_facet.wasm
fi
ls -la packages/core/wasm/sealed_facet.wasm
