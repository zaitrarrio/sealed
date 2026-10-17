/**
 * The native grid decoder (Rust → WebAssembly, ADR-0023) against the same simulated captures the JavaScript
 * decoder is checked with. Needs `tools/build-facet-wasm.sh` (the .wasm) and `pnpm fixtures:grid` (the
 * captures); without them the tests are skipped with a note, not failed, so a plain `pnpm test` works anywhere.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FacetReceiver, loadNativeDecoder } from "../../src/facet/index";

const wasmPath = resolve(__dirname, "../../wasm/sealed_facet.wasm");
const fixtureDir = resolve(__dirname, "../../../../crates/sealed-facet/fixtures");
const ready = existsSync(wasmPath) && existsSync(fixtureDir);

interface Fixture {
  name: string;
  tier: number;
  type: string;
  capture: { width: number; height: number; file: string };
  truth: { header: string; payload: string };
  decoded: { payload: string | null };
}

function fixtures(tier: number): Fixture[] {
  return readdirSync(fixtureDir)
    .filter((f) => f.startsWith(`t${tier}-`) && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")) as Fixture);
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

describe.skipIf(!ready)("native grid decoder (wasm)", () => {
  for (const tier of [1, 3] as const) {
    it(`T${tier}: decodes the fixture captures to the frames the sender emitted, faster than JavaScript`, async () => {
      const factory = await loadNativeDecoder(readFileSync(wasmPath));
      const native = factory.create([tier]);
      const js = new FacetReceiver({ tiers: [tier] });
      let nativeMs = 0;
      let jsMs = 0;
      let dataFrames = 0;
      for (const fx of fixtures(tier)) {
        const data = readFileSync(join(fixtureDir, fx.capture.file));
        const image = { width: fx.capture.width, height: fx.capture.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
        const t0 = performance.now();
        const frames = native.push(image);
        nativeMs += performance.now() - t0;
        const t1 = performance.now();
        js.push(image);
        jsMs += performance.now() - t1;
        const expected = Buffer.concat([Buffer.from(b64(fx.truth.header)), Buffer.from(b64(fx.truth.payload))]);
        if (fx.type === "calibration") {
          // A calibration frame carries no payload; the decoder may report it (header only) or just learn from it.
          for (const f of frames) expect(Buffer.from(f.subarray(0, 12))).toEqual(Buffer.from(b64(fx.truth.header)));
          continue;
        }
        dataFrames++;
        expect(frames.length, `${fx.name}: frames decoded`).toBe(1);
        expect(Buffer.from(frames[0]!).equals(expected), `${fx.name}: bytes`).toBe(true);
      }
      expect(dataFrames).toBeGreaterThan(0);
      expect(native.pixelsPerCell).toBeGreaterThan(2);
      console.log(`T${tier}: native ${(nativeMs / (dataFrames + 1)).toFixed(1)} ms/frame, JavaScript ${(jsMs / (dataFrames + 1)).toFixed(1)} ms/frame`);
      expect(nativeMs).toBeLessThan(jsMs);
      native.dispose();
    });
  }
  it("feeds native frames into FacetReceiver.pushFrameBytes", async () => {
    const factory = await loadNativeDecoder(readFileSync(wasmPath));
    const native = factory.create([1]);
    const receiver = new FacetReceiver({ tiers: [1] });
    for (const fx of fixtures(1)) {
      const data = readFileSync(join(fixtureDir, fx.capture.file));
      for (const f of native.push({ width: fx.capture.width, height: fx.capture.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) })) receiver.pushFrameBytes(f);
    }
    expect(receiver.progress.framesDecoded).toBeGreaterThanOrEqual(3);
    expect(receiver.progress.symbolsReceived).toBeGreaterThanOrEqual(2);
    native.dispose();
  });
});
