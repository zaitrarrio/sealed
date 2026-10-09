/**
 * App entry. Crypto polyfills must be installed before any module that touches `globalThis.crypto`
 * (@noble/hashes reads it lazily, @sealed/core's AES-GCM fast path probes `crypto.subtle`), then Expo Router
 * takes over. ES module evaluation order follows import order, so this file only contains these two imports.
 */
import "./src/polyfills";
// Background push task must be defined at startup, before any screen mounts.
import "./src/lib/push";
import "expo-router/entry";
