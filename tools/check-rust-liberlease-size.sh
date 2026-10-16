#!/usr/bin/env bash
# Proxy size check for native rlib until wasm-pack is green in CI.
set -euo pipefail
cargo build -p sealed-core --release
lib=$(ls -1 target/release/libsealed_core.rlib target/release/libsealed_core.a target/release/libsealed_core.dylib 2>/dev/null | head -1 || true)
if [[ -z "${lib:-}" ]]; then
  echo "release library not found"
  exit 1
fi
size=$(wc -c < "$lib" | tr -d ' ')
echo "sealed-core release lib: $size bytes ($lib)"
# Soft budget for the static archive / dylib — informational gate.
SOFT=$((8 * 1024 * 1024))
if (( size > SOFT )); then
  echo "WARN: sealed-core release artifact is larger than 8 MiB soft budget"
fi
