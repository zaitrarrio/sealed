#!/usr/bin/env bash
set -euo pipefail

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is not installed; skipping WASM build"
  exit 0
fi

# If on macOS and default clang doesn't support wasm32, use Homebrew LLVM if present
if [[ "$(uname -s)" == "Darwin" && -x "/usr/local/opt/llvm/bin/clang" ]]; then
  export CC="/usr/local/opt/llvm/bin/clang"
  export AR="/usr/local/opt/llvm/bin/llvm-ar"
elif [[ "$(uname -s)" == "Darwin" && -x "/opt/homebrew/opt/llvm/bin/clang" ]]; then
  export CC="/opt/homebrew/opt/llvm/bin/clang"
  export AR="/opt/homebrew/opt/llvm/bin/llvm-ar"
fi

wasm-pack build --target web crates/sealed-wasm --out-dir pkg
echo "WASM build complete: crates/sealed-wasm/pkg"
