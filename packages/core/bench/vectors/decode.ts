import { frameMask, encodeStream, decodeStream, type FrameIdentity } from "../../src/facet/grid";
import { gridLayout } from "../../src/facet/layout";
import { Xorshift32 } from "../../src/facet/random";
import { b64, bytes, diff, fnv, print } from "./util";

const tier = Number(process.argv[2] ?? "1") as 1 | 2 | 3;
const l = gridLayout(tier);
const rng = new Xorshift32(3000 + tier);
const rand = (n: number) => Uint8Array.from({ length: n }, () => rng.next() & 0xff);
const id: FrameIdentity = { streamId: Uint8Array.from([9, 8, 7, 6]), tier, type: "descriptor", sbn: 1, esi: 77 };
const payload = rand(l.symbolSize - 300);
const { mask } = frameMask(l, id);
const stream = encodeStream(l, payload, mask);

// decodeStream: clean, with errors below the margin, with low-confidence erasures, with forced erasures, with
// known codewords, and with too many errors.
const conf1 = new Float32Array(l.streamBytes).fill(1);
const corrupt = (count: number, lowConf: boolean, perCodeword = true) => {
  const r = Uint8Array.from(stream);
  const conf = new Float32Array(l.streamBytes).fill(1);
  const forced = new Uint8Array(l.streamBytes);
  for (let c = 0; c < l.codewords; c++) {
    const seen = new Set<number>();
    while (seen.size < count) {
      const p = rng.below(255);
      if (seen.has(p)) continue;
      seen.add(p);
      const j = p * l.codewords + c;
      r[j] ^= 1 + (rng.next() & 0xfe);
      if (lowConf) conf[j] = 0.01 + 0.001 * p;
      if (!perCodeword) forced[j] = 1;
    }
  }
  return { r, conf, forced };
};
const results: Record<string, unknown> = {};
// Tier 3 vectors omit the cases the smaller tiers already cover, to keep the file small.
const full = tier !== 3;
const emit = (name: string, received: Uint8Array, conf: Float32Array, forced?: Uint8Array, known?: { ok: Uint8Array; stream: Uint8Array }, maxFailures?: number) => {
  const res = decodeStream(l, received, mask, conf, forced, known, maxFailures);
  const lowIdx: number[] = [];
  const lowVal: number[] = [];
  conf.forEach((v, j) => v !== 1 && (lowIdx.push(j), lowVal.push(v)));
  const lowConf = { idx: b64(Uint16Array.from(lowIdx)), val: b64(Float32Array.from(lowVal)) };
  results[name] = {
    received: diff(stream, received),
    lowConf,
    forced: forced ? b64(Uint16Array.from(Array.from(forced).flatMap((v, j) => (v ? [j] : [])))) : null,
    known: known ? { ok: bytes(known.ok), streamHash: fnv(known.stream) } : null,
    maxFailures: maxFailures ?? null,
    payload: res.payload ? b64(res.payload) : null,
    ok: bytes(res.ok),
    streamHash: fnv(res.stream),
    failed: res.failed,
  };
};
emit("clean", stream, conf1);
{
  const { r, conf } = corrupt(10, false);
  emit("errors10", r, conf);
}
if (full) {
  const { r, conf } = corrupt(19, false);
  emit("errors19", r, conf);
}
{
  const { r, conf } = corrupt(21, false);
  emit("errors21", r, conf);
}
if (full) {
  const { r, conf } = corrupt(30, true);
  emit("erasures30", r, conf);
}
{
  const { r, conf } = corrupt(36, true);
  emit("erasures36", r, conf);
}
{
  const { r, forced } = corrupt(30, false, false);
  emit("forced30", r, conf1, forced);
}
{
  const { r, forced } = corrupt(41, false, false);
  emit("forced41", r, conf1, forced);
}
{
  const { r } = corrupt(25, false);
  const known = { ok: Uint8Array.from({ length: l.codewords }, (_, c) => (c % 2 ? 1 : 0)), stream: Uint8Array.from(stream) };
  emit("known", r, conf1, undefined, known);
  if (full) emit("maxFailures3", r, conf1, undefined, undefined, 3);
}
print({ id: { ...id, streamId: bytes(id.streamId) }, payload: b64(payload), maskHash: fnv(mask), streamHash: fnv(stream), decode: results });
