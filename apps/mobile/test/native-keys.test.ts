import { P256, SoftwareAgreementKey, SoftwareSigningKey, sha256 } from "@sealed/core";

const toBig = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
const fromBig = (n: bigint) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
const sOf = (sig: Uint8Array) => toBig(sig.subarray(32));
/** Flips s to n - s (a valid but high-S signature when s was low). */
function toHighS(sig: Uint8Array): Uint8Array {
  const out = sig.slice();
  out.set(fromBig(P256.order - sOf(sig)), 32);
  return out;
}
import { afterEach, describe, expect, it } from "vitest";
import { setNativeKeystoreForTesting, type AuthMode, type SealedKeystoreNative } from "../modules/sealed-keystore";
import { fromStdB64, toStdB64 } from "../src/lib/b64";
import { DEVICE_ALIAS, confirmUser, loadOrCreateDeviceKeys } from "../src/lib/native-keys";

/** A software implementation of the native interface, recording the auth modes used. */
function fakeKeystore() {
  const a = new SoftwareAgreementKey();
  const s = new SoftwareSigningKey();
  const calls: { op: string; mode?: AuthMode; reason?: string }[] = [];
  let created = false;
  const record = () => ({
    agreementPublicKey: toStdB64(P256.normalizePublicKey(a.publicKey, false)),
    signingPublicKey: toStdB64(P256.normalizePublicKey(s.publicKey, false)),
    protection: "secure-enclave" as const,
    agreementProtection: "secure-enclave" as const,
    signingProtection: "secure-enclave" as const,
    policy: "biometry-current-set" as const,
  });
  const impl: SealedKeystoreNative = {
    getCapabilities: () => ({ platform: "ios", secureHardware: true, strongBox: false, biometrics: "available", deviceCredential: true }),
    generateDeviceKeys: async () => {
      created = true;
      calls.push({ op: "generate" });
      return record();
    },
    getDeviceKeys: async () => (created ? record() : null),
    deleteDeviceKeys: async () => {
      created = false;
    },
    authenticate: async (_alias, reason) => {
      calls.push({ op: "authenticate", reason });
    },
    ecdh: async (_alias, peer, reason, mode) => {
      calls.push({ op: "ecdh", mode, reason });
      return toStdB64(await a.dh(fromStdB64(peer)));
    },
    sign: async (_alias, msg, reason, mode) => {
      calls.push({ op: "sign", mode, reason });
      // Return a high-S signature on purpose; the binding must normalize it.
      const sig = await s.sign(fromStdB64(msg));
      return toStdB64(toHighS(sig));
    },
    lock: () => true,
    getKeyAttestation: async () => null,
    getAppAttestation: async () => null,
  };
  return { impl, calls, a, s };
}

afterEach(() => setNativeKeystoreForTesting(null));

describe("native device keys", () => {
  it("creates hardware keys once and reuses them", async () => {
    const k = fakeKeystore();
    setNativeKeystoreForTesting(k.impl);
    const first = await loadOrCreateDeviceKeys();
    const second = await loadOrCreateDeviceKeys();
    expect(first.hardware).toBe(true);
    expect(first.agreement.protection).toBe("secure-enclave");
    expect(second.signing.publicKey).toEqual(first.signing.publicKey);
    expect(k.calls.filter((c) => c.op === "generate")).toHaveLength(1);
    expect(DEVICE_ALIAS).toBe("sealed.device.v1");
  });

  it("signs with low-S signatures that verify, in window mode by default and fresh on request", async () => {
    const k = fakeKeystore();
    setNativeKeystoreForTesting(k.impl);
    const keys = await loadOrCreateDeviceKeys();
    const msg = sha256(new TextEncoder().encode("approve"));
    const sig = await keys.signing.sign(msg);
    expect(P256.verify(sig, msg, keys.signing.publicKey)).toBe(true);
    expect(sOf(sig) <= P256.order >> 1n).toBe(true);
    await keys.signing.fresh("Approve Ada").sign(msg);
    expect(k.calls.filter((c) => c.op === "sign").map((c) => c.mode)).toEqual(["window", "fresh"]);
    expect(k.calls.at(-1)?.reason).toBe("Approve Ada");
  });

  it("performs ECDH that matches the peer's view", async () => {
    const k = fakeKeystore();
    setNativeKeystoreForTesting(k.impl);
    const keys = await loadOrCreateDeviceKeys();
    const peer = new SoftwareAgreementKey();
    expect(await keys.agreement.dh(P256.normalizePublicKey(peer.publicKey, true))).toEqual(await peer.dh(keys.agreement.publicKey));
  });

  it("falls back to software keys without the native module, which cannot confirm the user", async () => {
    const keys = await loadOrCreateDeviceKeys();
    expect(keys.hardware).toBe(false);
    expect(keys.agreement.protection).toBe("software");
    expect(await confirmUser("x")).toBe(false);
    const again = await loadOrCreateDeviceKeys();
    expect(again.agreement.publicKey).toEqual(keys.agreement.publicKey);
  });
});
