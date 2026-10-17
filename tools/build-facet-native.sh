#!/usr/bin/env bash
# Cross-compiles the native grid decoder (crates/sealed-facet) for the phones (ADR-0023).
#   tools/build-facet-native.sh ios      → apps/mobile/modules/sealed-facet/ios/SealedFacet.xcframework (needs Xcode + rust iOS targets)
#   tools/build-facet-native.sh android  → apps/mobile/modules/sealed-facet/android/src/main/jniLibs/<abi>/libsealed_facet.so (needs cargo-ndk + NDK)
# Both outputs are git-ignored; the Expo module `sealed-facet` picks them up at the next native build
# (`task mobile:prebuild` / `pod install`). The C header and module map are in crates/sealed-facet/include.
set -euo pipefail
cd "$(dirname "$0")/.."
out=crates/sealed-facet/dist
module=apps/mobile/modules/sealed-facet
case "${1:-}" in
  ios)
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios >/dev/null
    for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
      cargo build -p sealed-facet --release --target "$t"
    done
    mkdir -p "$out/sim-universal"
    lipo -create target/aarch64-apple-ios-sim/release/libsealed_facet.a target/x86_64-apple-ios/release/libsealed_facet.a -output "$out/sim-universal/libsealed_facet.a"
    rm -rf "$module/ios/SealedFacet.xcframework"
    xcodebuild -create-xcframework \
      -library target/aarch64-apple-ios/release/libsealed_facet.a -headers crates/sealed-facet/include \
      -library "$out/sim-universal/libsealed_facet.a" -headers crates/sealed-facet/include \
      -output "$module/ios/SealedFacet.xcframework"
    echo "built $module/ios/SealedFacet.xcframework"
    ;;
  android)
    command -v cargo-ndk >/dev/null || { echo "install cargo-ndk: cargo install cargo-ndk"; exit 1; }
    rustup target add aarch64-linux-android x86_64-linux-android armv7-linux-androideabi >/dev/null
    mkdir -p "$module/android/src/main/jniLibs"
    cargo ndk -t arm64-v8a -t x86_64 -o "$module/android/src/main/jniLibs" build -p sealed-facet --release
    echo "built $module/android/src/main/jniLibs"
    ;;
  *)
    echo "usage: $0 ios|android"; exit 2 ;;
esac
