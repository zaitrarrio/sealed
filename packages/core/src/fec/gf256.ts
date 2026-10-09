/**
 * GF(2^8) arithmetic over the RFC 6330 field: reducing polynomial x^8 + x^4 + x^3 + x^2 + 1
 * (0x11D), primitive element alpha = 2. This is the field behind RaptorQ's OCT_EXP / OCT_LOG
 * tables (RFC 6330 §5.7.3 - §5.7.4); the Reed-Solomon code in `rs.ts` uses the same field.
 *
 * Addition is XOR. All helpers are pure TypeScript over Uint8Array and allocation-free on the hot
 * path, so they run unchanged in browsers, Cloudflare Workers and React Native (Hermes).
 */

/** Reducing polynomial of the field. */
export const GF256_POLY = 0x11d;

/**
 * EXP[i] = alpha^i. Length 512 so that EXP[LOG[a] + LOG[b]] never needs a modular reduction
 * (the RFC table OCT_EXP has 510 entries for the same reason).
 */
export const GF256_EXP: Uint8Array = new Uint8Array(512);

/** LOG[a] = log_alpha(a) for a in 1..255. LOG[0] is 0 and must never be used. */
export const GF256_LOG: Uint8Array = new Uint8Array(256);

/**
 * Full multiplication table: GF256_MUL[(a << 8) | b] = a * b. 64 KiB; `mulRow(c)` returns the
 * 256-entry row for a fixed multiplier which is what the bulk helpers index into.
 */
export const GF256_MUL: Uint8Array = new Uint8Array(65536);

/** GF256_INV[a] = a^-1 for a != 0. GF256_INV[0] is 0 and must never be used. */
export const GF256_INV: Uint8Array = new Uint8Array(256);

(function initTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF256_POLY;
  }
  for (let i = 255; i < 512; i++) GF256_EXP[i] = GF256_EXP[i - 255] as number;
  for (let a = 1; a < 256; a++) {
    const la = GF256_LOG[a] as number;
    GF256_INV[a] = GF256_EXP[255 - la] as number;
    const base = a << 8;
    for (let b = 1; b < 256; b++) {
      GF256_MUL[base | b] = GF256_EXP[la + (GF256_LOG[b] as number)] as number;
    }
  }
})();

function assertByte(v: number, name: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`${name} must be an integer in 0..255, got ${v}`);
}

/** alpha^i for any integer i (negative exponents allowed). */
export function gfPow2(i: number): number {
  const e = ((i % 255) + 255) % 255;
  return GF256_EXP[e] as number;
}

/** a + b (= a - b) in GF(256). */
export function add(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

/** a * b in GF(256). */
export function mul(a: number, b: number): number {
  return GF256_MUL[((a & 0xff) << 8) | (b & 0xff)] as number;
}

/** a / b in GF(256). Throws on division by zero. */
export function div(a: number, b: number): number {
  assertByte(a, "a");
  assertByte(b, "b");
  if (b === 0) throw new RangeError("GF(256) division by zero");
  if (a === 0) return 0;
  return GF256_EXP[(GF256_LOG[a] as number) + 255 - (GF256_LOG[b] as number)] as number;
}

/** a^-1 in GF(256). Throws for a = 0. */
export function inv(a: number): number {
  assertByte(a, "a");
  if (a === 0) throw new RangeError("GF(256) inverse of zero");
  return GF256_INV[a] as number;
}

/** a^e in GF(256) for integer e >= 0. */
export function pow(a: number, e: number): number {
  assertByte(a, "a");
  if (!Number.isInteger(e) || e < 0) throw new RangeError(`exponent must be a non-negative integer, got ${e}`);
  if (e === 0) return 1;
  if (a === 0) return 0;
  return GF256_EXP[((GF256_LOG[a] as number) * e) % 255] as number;
}

/** The 256-entry multiplication row for multiplier c: mulRow(c)[x] = c * x. */
export function mulRow(c: number): Uint8Array {
  const cc = c & 0xff;
  return GF256_MUL.subarray(cc << 8, (cc << 8) + 256);
}

function checkLengths(dst: Uint8Array, src: Uint8Array): number {
  if (dst.length < src.length) {
    throw new RangeError(`dst (${dst.length} bytes) is shorter than src (${src.length} bytes)`);
  }
  return src.length;
}

/**
 * dst[i] ^= src[i] for i in 0..src.length-1 (GF(256) vector addition). Operates on whatever
 * range the arrays view, so pass `subarray`s to work on part of a larger buffer. Uses 32-bit
 * words when both views are 4-byte aligned.
 */
export function addAssign(dst: Uint8Array, src: Uint8Array): void {
  const n = checkLengths(dst, src);
  let i = 0;
  if (n >= 32 && (dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const words = n >>> 2;
    const d32 = new Int32Array(dst.buffer, dst.byteOffset, words);
    const s32 = new Int32Array(src.buffer, src.byteOffset, words);
    for (let w = 0; w < words; w++) d32[w] = (d32[w] as number) ^ (s32[w] as number);
    i = words << 2;
  }
  for (; i < n; i++) dst[i] = (dst[i] as number) ^ (src[i] as number);
}

/** dst[i] ^= c * src[i] for i in 0..src.length-1. */
export function mulAddAssign(dst: Uint8Array, src: Uint8Array, c: number): void {
  assertByte(c, "c");
  if (c === 0) {
    checkLengths(dst, src);
    return;
  }
  if (c === 1) {
    addAssign(dst, src);
    return;
  }
  const n = checkLengths(dst, src);
  const base = c << 8;
  const t = GF256_MUL;
  for (let i = 0; i < n; i++) dst[i] = (dst[i] as number) ^ (t[base | (src[i] as number)] as number);
}

/** dst[i] = c * dst[i] for every byte in the view. */
export function mulAssign(dst: Uint8Array, c: number): void {
  assertByte(c, "c");
  if (c === 1) return;
  if (c === 0) {
    dst.fill(0);
    return;
  }
  const base = c << 8;
  const t = GF256_MUL;
  for (let i = 0; i < dst.length; i++) dst[i] = t[base | (dst[i] as number)] as number;
}
