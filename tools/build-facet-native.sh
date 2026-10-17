#!/usr/bin/env bash
# Cross-compiles the native grid decoder (crates/sealed-facet) for the phones (ADR-0023).
#   tools/build-facet-native.sh ios      → crates/sealed-facet/dist/SealedFacet.xcframework (needs Xcode + rust iOS targets)
#   tools/build-facet-native.sh android  → crates/sealed-facet/dist/android/jniLibs/<abi>/libsealed_facet.so (needs cargo-ndk + NDK)
# The C header is crates/sealed-facet/include/sealed_facet.h.
set -euo pipefail
cd "$(dirname "$0")/.."
out=crates/sealed-facet/dist
case "${1:-}" in
  ios)
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios >/dev/null
    for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
      cargo build -p sealed-facet --release --target "$t"
    done
    mkdir -p "$out/sim-universal"
    lipo -create target/aarch64-apple-ios-sim/release/libsealed_facet.a target/x86_64-apple-ios/release/libsealed_facet.a -output "$out/sim-universal/libsealed_facet.a"
    rm -rf "$out/SealedFacet.xcframework"
    xcodebuild -create-xcframework \
      -library target/aarch64-apple-ios/release/libsealed_facet.a -headers crates/sealed-facet/include \
      -library "$out/sim-universal/libsealed_facet.a" -headers crates/sealed-facet/include \
      -output "$out/SealedFacet.xcframework"
    echo "built $out/SealedFacet.xcframework"
    ;;
  android)
    command -v cargo-ndk >/dev/null || { echo "install cargo-ndk: cargo install cargo-ndk"; exit 1; }
    rustup target add aarch64-linux-android x86_64-linux-android armv7-linux-androideabi >/dev/null
    mkdir -p "$out/android/jniLibs"
    cargo ndk -t arm64-v8a -t x86_64 -t armeabi-v7a -o "$out/android/jniLibs" build -p sealed-facet --release
    echo "built $out/android/jniLibs"
    ;;
  *)
    echo "usage: $0 ios|android"; exit 2 ;;
esac
