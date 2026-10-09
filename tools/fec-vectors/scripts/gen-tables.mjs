#!/usr/bin/env node
// Generates packages/core/src/fec/raptorq/tables.ts from the RFC 6330 text and cross-checks every
// value against the reference Rust `raptorq` sources (rng.rs + systematic_constants.rs).
//
// Usage:
//   curl -sS -o rfc6330.txt https://www.rfc-editor.org/rfc/rfc6330.txt
//   node tools/fec-vectors/scripts/gen-tables.mjs <rfc6330.txt> <raptorq-src-dir> <out tables.ts>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [rfcPath, refSrc, outPath] = process.argv.slice(2);
if (!rfcPath || !refSrc || !outPath) {
  console.error("usage: gen-tables.mjs <rfc6330.txt> <raptorq/src> <out.ts>");
  process.exit(2);
}

const rfc = readFileSync(rfcPath, "utf8");
const lines = rfc.split("\n");

/** Strip RFC page headers/footers and return body lines between two headings. */
function section(startHeading, endHeading) {
  const s = lines.findIndex((l) => l.startsWith(startHeading));
  const e = lines.findIndex((l, i) => i > s && l.startsWith(endHeading));
  if (s < 0 || e < 0) throw new Error(`section not found: ${startHeading}`);
  return lines
    .slice(s + 1, e)
    .filter((l) => !/^RFC 6330\s/.test(l) && !/^Luby, et al\./.test(l) && !/\f/.test(l));
}

function parseV(start, end) {
  const nums = section(start, end)
    .join(" ")
    .split(/[^0-9]+/)
    .filter((t) => t.length > 0)
    .map(Number);
  if (nums.length !== 256) throw new Error(`${start}: expected 256 values, got ${nums.length}`);
  for (const n of nums) if (!(n >= 0 && n <= 0xffffffff)) throw new Error(`bad V entry ${n}`);
  return nums;
}

const V0 = parseV("5.5.1.  The Table V0", "5.5.2.  The Table V1");
const V1 = parseV("5.5.2.  The Table V1", "5.5.3.  The Table V2");
const V2 = parseV("5.5.3.  The Table V2", "5.5.4.  The Table V3");
const V3 = parseV("5.5.4.  The Table V3", "5.6.  Systematic Indices");

const table = [];
for (const l of section("5.6.  Systematic Indices", "5.7.  Operating with Octets")) {
  const m = /^\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/.exec(l);
  if (m) table.push(m.slice(1, 6).map(Number));
}
if (table.length !== 477) throw new Error(`expected 477 K' rows, got ${table.length}`);
for (let i = 1; i < table.length; i++) {
  if (table[i][0] <= table[i - 1][0]) throw new Error("K' column not strictly increasing");
}

// --- cross-check against reference Rust sources ----------------------------------------------
const rng = readFileSync(join(refSrc, "rng.rs"), "utf8");
function refArray(name) {
  const m = new RegExp(`const ${name}: \\[u32; 256\\] = \\[([^\\]]*)\\]`).exec(rng);
  if (!m) throw new Error(`ref ${name} missing`);
  return m[1].split(/[^0-9]+/).filter((t) => t.length > 0).map(Number);
}
for (const [name, ours] of [["V0", V0], ["V1", V1], ["V2", V2], ["V3", V3]]) {
  const ref = refArray(name);
  if (ref.length !== 256 || ref.some((v, i) => v !== ours[i])) throw new Error(`${name} mismatch vs reference`);
}

const sc = readFileSync(join(refSrc, "systematic_constants.rs"), "utf8");
const sysM = /SYSTEMATIC_INDICES_AND_PARAMETERS: \[\(u32, u32, u32, u32, u32\); 477\] = \[([\s\S]*?)\];/.exec(sc);
const p1M = /P1_TABLE: \[\(u32, u32\); 477\] = \[([\s\S]*?)\];/.exec(sc);
if (!sysM || !p1M) throw new Error("reference systematic tables not found");
const refSys = [...sysM[1].matchAll(/\((\d+), (\d+), (\d+), (\d+), (\d+)\)/g)].map((m) => m.slice(1, 6).map(Number));
const refP1 = [...p1M[1].matchAll(/\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
if (refSys.length !== 477 || refP1.length !== 477) throw new Error("reference table length mismatch");
for (let i = 0; i < 477; i++) {
  if (refSys[i].some((v, j) => v !== table[i][j])) throw new Error(`systematic row ${i} mismatch`);
}

// P1 = smallest prime >= P where P = L - W = K' + S + H - W (RFC 6330 §5.3.3.3).
function isPrime(n) {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}
const P1 = table.map(([k, , s, h, w]) => {
  let p = k + s + h - w;
  while (!isPrime(p)) p++;
  return p;
});
for (let i = 0; i < 477; i++) {
  if (refP1[i][0] !== table[i][0] || refP1[i][1] !== P1[i]) throw new Error(`P1 row ${i} mismatch`);
}

// --- emit --------------------------------------------------------------------------------------
function fmt(arr, perLine) {
  const out = [];
  for (let i = 0; i < arr.length; i += perLine) out.push("  " + arr.slice(i, i + perLine).join(", ") + ",");
  return out.join("\n");
}
const col = (j) => table.map((r) => r[j]);

const src = `// GENERATED FILE - DO NOT EDIT.
// Produced by tools/fec-vectors/scripts/gen-tables.mjs from the RFC 6330 text (sections 5.5 and
// 5.6) and cross-checked value-by-value against the reference \`raptorq\` crate sources.

/** RFC 6330 §5.5.1 */
export const V0: Uint32Array = Uint32Array.from([
${fmt(V0, 8)}
]);

/** RFC 6330 §5.5.2 */
export const V1: Uint32Array = Uint32Array.from([
${fmt(V1, 8)}
]);

/** RFC 6330 §5.5.3 */
export const V2: Uint32Array = Uint32Array.from([
${fmt(V2, 8)}
]);

/** RFC 6330 §5.5.4 */
export const V3: Uint32Array = Uint32Array.from([
${fmt(V3, 8)}
]);

/** RFC 6330 §5.6 Table 2, column K' (supported extended source block sizes, ascending). */
export const K_PRIME: Uint16Array = Uint16Array.from([
${fmt(col(0), 12)}
]);

/** RFC 6330 §5.6 Table 2, column J(K') (systematic index). */
export const J_K: Uint16Array = Uint16Array.from([
${fmt(col(1), 12)}
]);

/** RFC 6330 §5.6 Table 2, column S(K') (LDPC symbols). */
export const S_K: Uint16Array = Uint16Array.from([
${fmt(col(2), 12)}
]);

/** RFC 6330 §5.6 Table 2, column H(K') (HDPC symbols). */
export const H_K: Uint8Array = Uint8Array.from([
${fmt(col(3), 16)}
]);

/** RFC 6330 §5.6 Table 2, column W(K') (LT symbols). */
export const W_K: Uint16Array = Uint16Array.from([
${fmt(col(4), 12)}
]);

/** P1(K'): smallest prime >= P = L - W (RFC 6330 §5.3.3.3), precomputed per row. */
export const P1_K: Uint16Array = Uint16Array.from([
${fmt(P1, 12)}
]);

/** K'_max (RFC 6330 §5.1.2). */
export const K_PRIME_MAX = ${table[table.length - 1][0]};
`;
writeFileSync(outPath, src);
console.log(`wrote ${outPath}: 4x256 V entries, ${table.length} K' rows (verified against reference)`);
