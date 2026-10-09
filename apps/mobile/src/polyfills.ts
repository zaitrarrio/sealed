/**
 * Runtime polyfills for Hermes (spec §5.1 "Random: OS CSPRNG").
 *
 * react-native-quick-crypto provides `crypto.getRandomValues` (backed by the OS CSPRNG through OpenSSL's
 * RAND_bytes) and a WebCrypto `subtle` with native AES-GCM. @sealed/core uses `getRandomValues` through
 * @noble/hashes for every key, nonce and claim secret, and probes `crypto.subtle` for its AES-GCM fast path
 * (segments are 1 MiB; the pure-JS fallback is ~30x slower on Hermes).
 *
 * After installing, a known-answer self-test cross-checks native AES-GCM against core's pure-JS
 * implementation. If they disagree (or subtle is unusable), core is pinned to the pure-JS path so a native
 * defect can never produce ciphertext other clients cannot open.
 */
import { install } from "react-native-quick-crypto";
import { registerGlobals } from "react-native-webrtc";
import { aesGcmOpen, aesGcmSeal, aesGcmSealSync, ctEqual, setSubtleForTesting } from "@sealed/core";

install();
// RTCPeerConnection and friends as globals, so the live-transfer code shared with the web client runs unchanged.
registerGlobals();

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== "function") {
  throw new Error("Sealed requires a cryptographically secure random number generator (react-native-quick-crypto failed to install).");
}

/** Result of the AES-GCM self-test, for the Settings diagnostics. */
export let nativeAesGcm: "native" | "javascript" | "pending" = "pending";

async function selfTest(): Promise<void> {
  // 8 KiB is above core's 4 KiB threshold, so aesGcmSeal takes the WebCrypto path.
  const key = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
  const nonce = new Uint8Array(12).map((_, i) => (i * 13 + 1) & 0xff);
  const aad = new Uint8Array([0x53, 0x45, 0x41, 0x4c]);
  const plain = new Uint8Array(8192).map((_, i) => (i * 31 + 17) & 0xff);
  try {
    const viaSubtle = await aesGcmSeal(key, nonce, plain, aad);
    const viaJs = aesGcmSealSync(key, nonce, plain, aad);
    const back = await aesGcmOpen(key, nonce, viaSubtle, aad);
    if (!ctEqual(viaSubtle, viaJs) || !ctEqual(back, plain)) throw new Error("native AES-GCM output differs from the reference");
    nativeAesGcm = "native";
  } catch {
    setSubtleForTesting(null);
    nativeAesGcm = "javascript";
  }
}

/** Resolves once the self-test has chosen the AES-GCM backend; the root layout awaits it before rendering. */
export const cryptoReady: Promise<void> = selfTest();
