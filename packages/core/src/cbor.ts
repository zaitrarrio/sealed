/**
 * Deterministic CBOR (RFC 8949 §4.2.1 core deterministic encoding), restricted to the types Sealed uses:
 * unsigned/negative integers (safe range), byte strings, text strings, arrays, maps, booleans and null.
 *
 * Maps are written from plain objects. Keys that are canonical decimal integers ("0", "12", "-3") are encoded
 * as CBOR integers; all other keys as text. Entries whose value is `undefined` are omitted. Keys are sorted by
 * the bytewise order of their encodings. The decoder is strict: it rejects non-shortest integers, unsorted or
 * duplicate keys, indefinite lengths, tags, floats and trailing bytes, so every accepted input re-encodes to
 * identical bytes — which is what signatures over CBOR require.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | { readonly [key: string]: CborValue | undefined };

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const INT_KEY = /^(0|-?[1-9][0-9]*)$/;

class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  head(major: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new CborError(`length/value out of range: ${value}`);
    const m = major << 5;
    if (value < 24) this.byte(m | value);
    else if (value < 0x100) {
      this.byte(m | 24);
      this.byte(value);
    } else if (value < 0x10000) {
      this.byte(m | 25);
      this.byte(value >> 8);
      this.byte(value & 0xff);
    } else if (value < 0x100000000) {
      this.byte(m | 26);
      this.byte((value >>> 24) & 0xff);
      this.byte((value >>> 16) & 0xff);
      this.byte((value >>> 8) & 0xff);
      this.byte(value & 0xff);
    } else {
      this.byte(m | 27);
      const hi = Math.floor(value / 0x100000000);
      const lo = value >>> 0;
      for (const w of [hi, lo]) {
        this.byte((w >>> 24) & 0xff);
        this.byte((w >>> 16) & 0xff);
        this.byte((w >>> 8) & 0xff);
        this.byte(w & 0xff);
      }
    }
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function encodeInto(w: Writer, v: CborValue): void {
  if (v === null) return w.byte(0xf6);
  if (v === true) return w.byte(0xf5);
  if (v === false) return w.byte(0xf4);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new CborError(`only safe integers are supported, got ${v}`);
    return v >= 0 ? w.head(0, v) : w.head(1, -1 - v);
  }
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    w.head(3, b.length);
    return w.bytes(b);
  }
  if (v instanceof Uint8Array) {
    w.head(2, v.length);
    return w.bytes(v);
  }
  if (Array.isArray(v)) {
    w.head(4, v.length);
    for (const item of v as readonly CborValue[]) encodeInto(w, item);
    return;
  }
  const obj = v as { readonly [key: string]: CborValue | undefined };
  const entries: { k: Uint8Array; v: CborValue }[] = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined) continue;
    entries.push({ k: encodeCbor(INT_KEY.test(key) ? Number(key) : key), v: val });
  }
  entries.sort((a, b) => compareBytes(a.k, b.k));
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(entries[i - 1]!.k, entries[i]!.k) === 0) throw new CborError("duplicate map key");
  }
  w.head(5, entries.length);
  for (const e of entries) {
    w.bytes(e.k);
    encodeInto(w, e.v);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function encodeCbor(v: CborValue): Uint8Array {
  const w = new Writer();
  encodeInto(w, v);
  return w.result();
}

const MAX_DEPTH = 32;

class Reader {
  off = 0;
  constructor(readonly b: Uint8Array) {}

  u8(): number {
    if (this.off >= this.b.length) throw new CborError("unexpected end of input");
    return this.b[this.off++] as number;
  }

  head(): { major: number; value: number } {
    const ib = this.u8();
    const major = ib >> 5;
    const ai = ib & 31;
    if (ai < 24) return { major, value: ai };
    if (ai === 24) {
      const v = this.u8();
      if (v < 24) throw new CborError("non-shortest integer encoding");
      return { major, value: v };
    }
    if (ai === 25) {
      const v = (this.u8() << 8) | this.u8();
      if (v < 0x100) throw new CborError("non-shortest integer encoding");
      return { major, value: v };
    }
    if (ai === 26) {
      const v = ((this.u8() << 24) >>> 0) + ((this.u8() << 16) | (this.u8() << 8) | this.u8());
      if (v < 0x10000) throw new CborError("non-shortest integer encoding");
      return { major, value: v };
    }
    if (ai === 27) {
      const hi = ((this.u8() << 24) >>> 0) + ((this.u8() << 16) | (this.u8() << 8) | this.u8());
      const lo = ((this.u8() << 24) >>> 0) + ((this.u8() << 16) | (this.u8() << 8) | this.u8());
      const v = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(v)) throw new CborError("integer exceeds safe range");
      if (v < 0x100000000) throw new CborError("non-shortest integer encoding");
      return { major, value: v };
    }
    throw new CborError(`unsupported additional info ${ai} (indefinite lengths and floats are not allowed)`);
  }

  take(n: number): Uint8Array {
    if (this.off + n > this.b.length) throw new CborError("unexpected end of input");
    const out = this.b.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  value(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError("nesting too deep");
    const start = this.off;
    const ib = this.b[this.off];
    if (ib === 0xf4) return this.off++, false;
    if (ib === 0xf5) return this.off++, true;
    if (ib === 0xf6) return this.off++, null;
    const { major, value } = this.head();
    switch (major) {
      case 0:
        return value;
      case 1:
        return -1 - value;
      case 2:
        return this.take(value);
      case 3:
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(this.take(value));
      case 4: {
        if (value > this.b.length - this.off) throw new CborError("array length exceeds input");
        const arr: CborValue[] = [];
        for (let i = 0; i < value; i++) arr.push(this.value(depth + 1));
        return arr;
      }
      case 5: {
        if (value > this.b.length - this.off) throw new CborError("map length exceeds input");
        const obj: Record<string, CborValue> = Object.create(null) as Record<string, CborValue>;
        let prevKey: Uint8Array | null = null;
        for (let i = 0; i < value; i++) {
          const ks = this.off;
          const key = this.value(depth + 1);
          const keyBytes = this.b.subarray(ks, this.off);
          if (typeof key !== "number" && typeof key !== "string") throw new CborError("map keys must be integers or text");
          if (prevKey && compareBytes(prevKey, keyBytes) >= 0) throw new CborError("map keys not in deterministic order");
          prevKey = keyBytes;
          obj[String(key)] = this.value(depth + 1);
        }
        return obj;
      }
      default:
        this.off = start;
        throw new CborError(`unsupported major type ${major}`);
    }
  }
}

export function decodeCbor(b: Uint8Array): CborValue {
  const r = new Reader(b);
  const v = r.value(0);
  if (r.off !== b.length) throw new CborError("trailing bytes after CBOR item");
  return v;
}

/** Typed accessors for decoded maps; each throws a CborError naming the field when the shape is wrong. */
export type CborMap = { readonly [key: string]: CborValue | undefined };

export function asMap(v: CborValue | undefined, what: string): CborMap {
  if (v === null || v === undefined || typeof v !== "object" || v instanceof Uint8Array || Array.isArray(v)) {
    throw new CborError(`${what}: expected map`);
  }
  return v as CborMap;
}

export function getBytes(m: CborMap, key: number | string, what: string, len?: number): Uint8Array {
  const v = m[String(key)];
  if (!(v instanceof Uint8Array)) throw new CborError(`${what}: field ${key} must be bytes`);
  if (len !== undefined && v.length !== len) throw new CborError(`${what}: field ${key} must be ${len} bytes`);
  return v;
}

export function getOptBytes(m: CborMap, key: number | string, what: string): Uint8Array | undefined {
  return m[String(key)] === undefined ? undefined : getBytes(m, key, what);
}

export function getUint(m: CborMap, key: number | string, what: string): number {
  const v = m[String(key)];
  if (typeof v !== "number" || v < 0) throw new CborError(`${what}: field ${key} must be an unsigned integer`);
  return v;
}

export function getText(m: CborMap, key: number | string, what: string): string {
  const v = m[String(key)];
  if (typeof v !== "string") throw new CborError(`${what}: field ${key} must be text`);
  return v;
}

export function getOptText(m: CborMap, key: number | string, what: string): string | undefined {
  return m[String(key)] === undefined ? undefined : getText(m, key, what);
}

export function getArray(m: CborMap, key: number | string, what: string): readonly CborValue[] {
  const v = m[String(key)];
  if (!Array.isArray(v)) throw new CborError(`${what}: field ${key} must be an array`);
  return v as readonly CborValue[];
}
