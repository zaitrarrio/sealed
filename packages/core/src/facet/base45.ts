/**
 * Base45 (RFC 9285): bytes ↔ text in the QR alphanumeric alphabet. QR alphanumeric mode stores 2 characters in
 * 11 bits, so Base45 costs ≈ 3 % over raw byte mode, and the result survives every QR reader that only returns
 * text (iOS and Android system detectors, the web BarcodeDetector), which byte-mode binary does not.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

export function base45Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let n = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
    const c = n % 45;
    n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out += ALPHABET[c]! + ALPHABET[d]! + ALPHABET[e]!;
  }
  if (i < bytes.length) {
    const n = bytes[i] as number;
    out += ALPHABET[n % 45]! + ALPHABET[Math.floor(n / 45)]!;
  }
  return out;
}

/** Decodes Base45 text; returns null for anything that is not valid Base45 (wrong alphabet, length or range). */
export function base45Decode(text: string): Uint8Array | null {
  const len = text.length;
  if (len % 3 === 1) return null;
  const out = new Uint8Array(Math.floor(len / 3) * 2 + (len % 3 === 2 ? 1 : 0));
  let o = 0;
  const v = (k: number): number => {
    const code = text.charCodeAt(k);
    return code < 128 ? (VALUE[code] as number) : -1;
  };
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const c = v(i);
    const d = v(i + 1);
    const e = v(i + 2);
    if (c < 0 || d < 0 || e < 0) return null;
    const n = c + d * 45 + e * 2025;
    if (n > 0xffff) return null;
    out[o++] = n >> 8;
    out[o++] = n & 0xff;
  }
  if (i < len) {
    const c = v(i);
    const d = v(i + 1);
    if (c < 0 || d < 0) return null;
    const n = c + d * 45;
    if (n > 0xff) return null;
    out[o++] = n;
  }
  return out;
}
