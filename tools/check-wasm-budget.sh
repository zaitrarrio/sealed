#!/usr/bin/env bash
# Fail if gzipped WASM exceeds 1.5 MiB (spec §13 / ADR-0011).
set -euo pipefail
DIR="${1:-packages/core-wasm/pkg}"
BUDGET=$((1536 * 1024))
if [[ ! -d "$DIR" ]]; then
  echo "wasm pkg dir missing: $DIR (skip)"
  exit 0
fi
shopt -s nullglob
files=("$DIR"/*.wasm)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no .wasm files in $DIR"
  exit 1
fi
fail=0
for f in "${files[@]}"; do
  gz=$(gzip -c "$f" | wc -c | tr -d ' ')
  echo "$(basename "$f"): ${gz} bytes gzipped (budget ${BUDGET})"
  if (( gz > BUDGET )); then
    echo "FAIL: exceeds budget"
    fail=1
  fi
done
exit "$fail"
