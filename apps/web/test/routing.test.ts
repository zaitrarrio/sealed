import { addDeviceCode, claimCode, pairingCode, randomBytes, reverseKeyCode, SoftwareAgreementKey, toB64url } from "@sealed/core";
import { describe, expect, it, vi } from "vitest";
import { codeFromLocation, describeKind, expectCode, friendlyCodeError, routeCode } from "../src/lib/routing";

const ORIGIN = "https://sealed.to";
const ACCEPTED = [ORIGIN, "http://localhost:5173"];

describe("code routing", () => {
  it("routes claim codes to /c/<id> and keeps the secret in the fragment", () => {
    const tid = randomBytes(16);
    const cs = randomBytes(16);
    const r = routeCode(claimCode(ORIGIN, tid, cs), ACCEPTED);
    expect(r.parsed.kind).toBe("claim");
    expect(r.path).toBe(`/c/${toB64url(tid)}#${toB64url(cs)}`);
  });

  it("routes pairing, add-device and reverse-key codes to their landing paths", () => {
    const pair = pairingCode(ORIGIN, { fingerprint: randomBytes(32), headHash: randomBytes(32), headSeq: 2, nonce: randomBytes(16), label: "Ana" });
    expect(routeCode(pair, ACCEPTED).path.startsWith("/p#")).toBe(true);
    const a = new SoftwareAgreementKey();
    const s = new SoftwareAgreementKey();
    const add = addDeviceCode(ORIGIN, { agreementPublicKey: a.publicKey, signingPublicKey: s.publicKey, nonce: randomBytes(16), label: "Tablet", protection: "browser", cosig: randomBytes(64) });
    expect(routeCode(add, ACCEPTED).path.startsWith("/d#")).toBe(true);
    const rk = reverseKeyCode(ORIGIN, { receiverPublicKey: a.publicKey, nonce: randomBytes(16), tier: 1, label: "Laptop" });
    const routed = routeCode(rk, ACCEPTED);
    expect(routed.parsed.kind).toBe("reverse-key");
    expect(routed.path.startsWith("/k#")).toBe(true);
  });

  it("accepts localhost codes over http for development", () => {
    const code = claimCode("http://localhost:5173", randomBytes(16), randomBytes(16));
    expect(routeCode(code, ACCEPTED).parsed.kind).toBe("claim");
  });

  it("rejects codes from untrusted origins, non-codes and incomplete codes", () => {
    const evil = claimCode("https://evil.example", randomBytes(16), randomBytes(16));
    expect(() => routeCode(evil, ACCEPTED)).toThrow(/unknown origin/);
    expect(friendlyCodeError(catchErr(() => routeCode(evil, ACCEPTED)))).toBe("That code was made by https://evil.example, which this app does not trust yet.");
    expect(friendlyCodeError(catchErr(() => routeCode("hello", ACCEPTED)))).toBe("That is not a Sealed code.");
    const noSecret = claimCode(ORIGIN, randomBytes(16), randomBytes(16)).split("#")[0]!;
    expect(friendlyCodeError(catchErr(() => routeCode(noSecret, ACCEPTED)))).toBe("That code is incomplete. Scan it again.");
  });

  it("expectCode enforces the code kind a screen wants", () => {
    const claim = claimCode(ORIGIN, randomBytes(16), randomBytes(16));
    expect(() => expectCode(claim, "pair", ACCEPTED)).toThrow(`Expected a ${describeKind("pair")}, but this is a ${describeKind("claim")}.`);
    expect(expectCode(claim, "claim", ACCEPTED).kind).toBe("claim");
  });

  it("rebuilds landing codes from location, and ignores locations without a fragment", () => {
    expect(codeFromLocation(ORIGIN, "/p", "#abc")).toBe(`${ORIGIN}/p#abc`);
    expect(codeFromLocation(ORIGIN, "/p", "")).toBeNull();
    expect(codeFromLocation(ORIGIN, "/p", "#")).toBeNull();
  });
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("trusted code origins", () => {
  it("accepts another client's codes once its origin is trusted", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    const { acceptedOrigins, setTrustedOrigins, trustableOrigin } = await import("../src/lib/config");
    const phone = claimCode("https://sealed.to", randomBytes(16), randomBytes(16));
    setTrustedOrigins([]);
    const before = acceptedOrigins().filter((o) => o !== "https://sealed.to");
    expect(() => routeCode(phone, before)).toThrow(/unknown origin/);
    setTrustedOrigins([trustableOrigin("https://sealed.to/")]);
    expect(acceptedOrigins()).toContain("https://sealed.to");
    expect(routeCode(phone, acceptedOrigins()).parsed.kind).toBe("claim");
    expect(() => trustableOrigin("http://sealed.to")).toThrow(/https/);
    expect(trustableOrigin("http://192.168.1.10:5173")).toBe("http://192.168.1.10:5173");
    setTrustedOrigins([]);
    vi.unstubAllGlobals();
  });
});
