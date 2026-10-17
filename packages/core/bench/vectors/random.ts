import { Xorshift32, seedFrom, shuffleInPlace } from "../../src/facet/random";
import { print } from "./util";

const enc = new TextEncoder();
const seeds = [0, 1, 2, 7, 0x9e3779b9, 0xdeadbeef, 0xffffffff, 0x80000000];
const sequences = seeds.map((seed) => {
  const r = new Xorshift32(seed);
  const next = Array.from({ length: 24 }, () => r.next());
  const below = [1, 2, 3, 7, 16, 100, 4096, 65537].map((n) => r.below(n));
  return { seed, next, below };
});
const seedCases = [
  { parts: [] as (number | number[])[], label: "empty" },
  { parts: [0], label: "zero" },
  { parts: [1, 2, 3], label: "ints" },
  { parts: [0xffffffff], label: "max" },
  { parts: [Array.from(enc.encode("facet/v1/cells")), 1], label: "cells-1" },
  { parts: [Array.from(enc.encode("facet/v1/cells")), 3], label: "cells-3" },
  { parts: [Array.from(enc.encode("facet/v1/header-whiten"))], label: "whiten" },
  { parts: [[0xe1, 0xcb, 0x88, 0x16], (1 << 24) | (2 << 16) | 5, 123456], label: "frame" },
  { parts: [[0, 0, 0, 0], 0, 0], label: "zeros" },
].map((c) => ({
  label: c.label,
  parts: c.parts,
  seed: seedFrom(...c.parts.map((p) => (typeof p === "number" ? p : Uint8Array.from(p)))),
}));
const shuffles = [0, 5, 0xabcdef].map((seed) => {
  const arr = Int32Array.from({ length: 40 }, (_, i) => i);
  shuffleInPlace(arr, new Xorshift32(seed));
  return { seed, out: Array.from(arr) };
});
print({ sequences, seedCases, shuffles });
