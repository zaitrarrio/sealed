/**
 * Short authentication strings (spec §5.3, §5.6): six decimal digits shown on both devices.
 * The first 20 bits of an HKDF-SHA256 output, big-endian, reduced modulo 1,000,000 and shown as "482 113".
 */
import { concat, utf8 } from "../bytes";
import { compress } from "./keyid";
import { hkdf } from "./primitives";

function digits(okm: Uint8Array): string {
  const v = (((okm[0] as number) << 12) | ((okm[1] as number) << 4) | ((okm[2] as number) >> 4)) % 1_000_000;
  const s = v.toString().padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** Direct / Room: binds the claim secret (never seen by the relay) to the claiming device's key. */
export function claimSas(claimSecret: Uint8Array, transferId: Uint8Array, receiverAgreementPublic: Uint8Array): string {
  return digits(hkdf(claimSecret, transferId, concat(utf8("sealed/v1/sas"), compress(receiverAgreementPublic)), 3));
}

/** Pairing: both nonces and both identity fingerprints (sorted so both sides compute the same value). */
export function pairingSas(nonceA: Uint8Array, nonceB: Uint8Array, fingerprintA: Uint8Array, fingerprintB: Uint8Array): string {
  const [n1, n2] = compareBytes(nonceA, nonceB) <= 0 ? [nonceA, nonceB] : [nonceB, nonceA];
  const [f1, f2] = compareBytes(fingerprintA, fingerprintB) <= 0 ? [fingerprintA, fingerprintB] : [fingerprintB, fingerprintA];
  return digits(hkdf(concat(n1, n2), new Uint8Array(0), concat(utf8("sealed/v1/pair"), f1, f2), 3));
}

/** Air-gap reverse-optical: binds the receiver's nonce, the stream and both public keys. */
export function airgapSas(receiverNonce: Uint8Array, streamId: Uint8Array, receiverPublic: Uint8Array, senderPublic: Uint8Array): string {
  return digits(hkdf(receiverNonce, streamId, concat(utf8("sealed/v1/airgap"), compress(receiverPublic), compress(senderPublic)), 3));
}

/** Adding a device: binds both of the new device's public keys and the scan nonce. */
export function deviceSas(nonce: Uint8Array, agreementPublic: Uint8Array, signingPublic: Uint8Array): string {
  return digits(hkdf(nonce, new Uint8Array(0), concat(utf8("sealed/v1/add-device"), compress(agreementPublic), compress(signingPublic)), 3));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
