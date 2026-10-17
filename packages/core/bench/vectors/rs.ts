import { ReedSolomon } from "../../src/fec/index";
import { Xorshift32 } from "../../src/facet/random";
import { bytes } from "./util";
import { print } from "./util";

const rng = new Xorshift32(42);
const rand = (n: number) => Uint8Array.from({ length: n }, () => rng.next() & 0xff);
const pick = (n: number, count: number): number[] => {
  const s = new Set<number>();
  while (s.size < count) s.add(rng.below(n));
  return Array.from(s);
};

interface Case {
  n: number;
  k: number;
  data: string;
  codeword: string;
  received: string;
  erasures: number[];
  decoded: string | null;
  note: string;
}
const cases: Case[] = [];
for (const [n, k] of [
  [255, 207],
  [20, 12],
  [15, 9],
  [8, 6],
] as const) {
  const rs = new ReedSolomon(n, k);
  const m = n - k;
  const scenarios: { errors: number; erasures: number; note: string }[] = [
    { errors: 0, erasures: 0, note: "clean" },
    { errors: 1, erasures: 0, note: "one error" },
    { errors: Math.floor(m / 2), erasures: 0, note: "max errors" },
    { errors: 0, erasures: m, note: "max erasures" },
    { errors: Math.floor(m / 4), erasures: m - 2 * Math.floor(m / 4), note: "mixed at capacity" },
    { errors: Math.floor(m / 2) + 1, erasures: 0, note: "too many errors" },
    { errors: 2, erasures: m - 2, note: "over capacity mixed" },
    { errors: 0, erasures: m + 1, note: "too many erasures" },
    { errors: 1, erasures: 3, note: "erasure positions also corrupted" },
  ];
  for (const sc of scenarios) {
    for (let rep = 0; rep < 2; rep++) {
      const data = rand(k);
      const cw = rs.encode(data);
      const received = Uint8Array.from(cw);
      const ers = sc.erasures > n ? Array.from({ length: n }, (_, i) => i) : pick(n, Math.min(sc.erasures, n));
      // Corrupt erased positions (sometimes) and distinct error positions.
      const eraSet = new Set(ers);
      for (const p of ers) if (rng.below(3) !== 0) received[p] ^= 1 + (rng.next() & 0xfe);
      const free = Array.from({ length: n }, (_, i) => i).filter((i) => !eraSet.has(i));
      const errPos: number[] = [];
      while (errPos.length < sc.errors && free.length) {
        const i = rng.below(free.length);
        errPos.push(free[i] as number);
        free.splice(i, 1);
      }
      for (const p of errPos) received[p] ^= 1 + (rng.next() & 0xfe);
      let decoded: Uint8Array | null;
      try {
        decoded = rs.decode(received, ers);
      } catch {
        decoded = null;
      }
      cases.push({ n, k, data: bytes(data), codeword: bytes(cw), received: bytes(received), erasures: ers, decoded: decoded ? bytes(decoded) : null, note: sc.note });
    }
  }
}
// Generator polynomial check via encoding of unit vectors.
const rs255 = new ReedSolomon(255, 207);
const unit = new Uint8Array(207);
unit[0] = 1;
const unitCw = bytes(rs255.encode(unit));
print({ cases, unitCw });
