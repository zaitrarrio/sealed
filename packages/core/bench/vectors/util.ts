/** Helpers shared by the parity-vector generators (crates/sealed-facet/tests/vectors). */
export const b64 = (a: ArrayBufferView): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
export const bytes = (a: ArrayLike<number>): string => b64(Uint8Array.from(a));
export const digits = (a: ArrayLike<number>): string => Array.from(a, (v) => String(v)).join("");
export const print = (v: unknown): void => {
  process.stdout.write(JSON.stringify(v));
};
/** FNV-1a (32-bit) over the raw bytes of a typed array, as a decimal string. */
export const fnv = (a: ArrayBufferView): number => {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) {
    h ^= u[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
/** Sparse difference of `b` against `a`: indices (base64 Uint16) and the new values (base64 Uint8). */
export const diff = (a: Uint8Array, b: Uint8Array): { idx: string; val: string } => {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) (idx.push(i), val.push(b[i] as number));
  return { idx: b64(Uint16Array.from(idx)), val: b64(Uint8Array.from(val)) };
};
