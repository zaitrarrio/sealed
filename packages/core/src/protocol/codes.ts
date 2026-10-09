/**
 * Displayed codes. Every code is an https URL whose secret material lives in the fragment, which browsers
 * never send to servers. Native apps register universal/app links for the origin; any other camera opens the
 * web client, which reads the fragment locally.
 *
 *   /c/<transfer_id>#<claim_secret>      Direct and Room claim (spec §6.1.1)
 *   /p#<cbor>                            pairing code (§6.3.2)
 *   /d#<cbor>                            add-device code (§6.3.4)
 *   /k#<cbor>                            Air-gap reverse key code (§6.5)
 */
import { fromB64url, toB64url } from "../bytes";
import { asMap, decodeCbor, encodeCbor, getBytes, getText, getUint } from "../cbor";
import { compress, decompress } from "../crypto/keyid";
import type { KeyProtection } from "../crypto/keys";

export type ParsedCode =
  | { kind: "claim"; origin: string; transferId: Uint8Array; claimSecret: Uint8Array }
  | { kind: "pair"; origin: string; fingerprint: Uint8Array; headHash: Uint8Array; headSeq: number; nonce: Uint8Array; label: string }
  | { kind: "add-device"; origin: string; agreementPublicKey: Uint8Array; signingPublicKey: Uint8Array; nonce: Uint8Array; label: string; protection: KeyProtection; cosig: Uint8Array }
  | { kind: "reverse-key"; origin: string; receiverPublicKey: Uint8Array; nonce: Uint8Array; tier: number; label: string };

export class CodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeError";
  }
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function claimCode(origin: string, transferId: Uint8Array, claimSecret: Uint8Array): string {
  return `${trimOrigin(origin)}/c/${toB64url(transferId)}#${toB64url(claimSecret)}`;
}

export function pairingCode(origin: string, p: { fingerprint: Uint8Array; headHash: Uint8Array; headSeq: number; nonce: Uint8Array; label: string }): string {
  const body = encodeCbor({ 1: p.fingerprint, 2: p.headHash, 3: p.headSeq, 4: p.nonce, 5: p.label.slice(0, 40) });
  return `${trimOrigin(origin)}/p#${toB64url(body)}`;
}

export function addDeviceCode(origin: string, p: { agreementPublicKey: Uint8Array; signingPublicKey: Uint8Array; nonce: Uint8Array; label: string; protection: KeyProtection; cosig: Uint8Array }): string {
  const body = encodeCbor({ 1: compress(p.agreementPublicKey), 2: compress(p.signingPublicKey), 3: p.nonce, 4: p.label.slice(0, 40), 5: p.protection, 6: p.cosig });
  return `${trimOrigin(origin)}/d#${toB64url(body)}`;
}

export function reverseKeyCode(origin: string, p: { receiverPublicKey: Uint8Array; nonce: Uint8Array; tier: number; label: string }): string {
  const body = encodeCbor({ 1: compress(p.receiverPublicKey), 2: p.nonce, 3: p.tier, 4: p.label.slice(0, 40) });
  return `${trimOrigin(origin)}/k#${toB64url(body)}`;
}

const PROTECTIONS: readonly KeyProtection[] = ["secure-enclave", "strongbox", "tee", "browser", "software"];

/** Parses any Sealed code. `allowedOrigins`, when given, rejects codes from other hosts. */
export function parseCode(text: string, allowedOrigins?: readonly string[]): ParsedCode {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new CodeError("not a Sealed code");
  }
  const origin = url.origin;
  if (allowedOrigins && !allowedOrigins.map(trimOrigin).includes(origin)) throw new CodeError(`code is from an unknown origin ${origin}`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    throw new CodeError("codes must use https");
  }
  const frag = url.hash.replace(/^#/, "");
  if (!frag) throw new CodeError("code is missing its secret fragment");
  try {
    const claim = url.pathname.match(/^\/c\/([A-Za-z0-9_-]{22})\/?$/);
    if (claim) {
      const transferId = fromB64url(claim[1]!);
      const claimSecret = fromB64url(frag);
      if (transferId.length !== 16 || claimSecret.length !== 16) throw new CodeError("malformed claim code");
      return { kind: "claim", origin, transferId, claimSecret };
    }
    const m = asMap(decodeCbor(fromB64url(frag)), "code");
    switch (url.pathname.replace(/\/$/, "")) {
      case "/p":
        return { kind: "pair", origin, fingerprint: getBytes(m, 1, "pair", 32), headHash: getBytes(m, 2, "pair", 32), headSeq: getUint(m, 3, "pair"), nonce: getBytes(m, 4, "pair", 16), label: getText(m, 5, "pair") };
      case "/d": {
        const protection = getText(m, 5, "add-device") as KeyProtection;
        if (!PROTECTIONS.includes(protection)) throw new CodeError("unknown key protection");
        return {
          kind: "add-device",
          origin,
          agreementPublicKey: decompress(getBytes(m, 1, "add-device", 33)),
          signingPublicKey: decompress(getBytes(m, 2, "add-device", 33)),
          nonce: getBytes(m, 3, "add-device", 16),
          label: getText(m, 4, "add-device"),
          protection,
          cosig: getBytes(m, 6, "add-device", 64),
        };
      }
      case "/k":
        return { kind: "reverse-key", origin, receiverPublicKey: decompress(getBytes(m, 1, "reverse-key", 33)), nonce: getBytes(m, 2, "reverse-key", 16), tier: getUint(m, 3, "reverse-key"), label: getText(m, 4, "reverse-key") };
      default:
        throw new CodeError("unknown code type");
    }
  } catch (e) {
    if (e instanceof CodeError) throw e;
    throw new CodeError(`malformed code: ${(e as Error).message}`);
  }
}
