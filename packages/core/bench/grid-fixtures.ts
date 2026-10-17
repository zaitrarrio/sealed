/**
 * Parity fixtures for the native grid decoder (ADR-0023): simulated camera captures of grid frames with the
 * JavaScript decoder's result at every stage, so the Rust port can be checked stage by stage and end to end.
 *
 *   pnpm fixtures:grid [outDir]      default crates/sealed-facet/fixtures (git-ignored; a few MB per frame)
 *
 * Per tier (1 and 3): a calibration frame then data frames, through one FacetReceiver so calibration state
 * carries over exactly as on a device. Each frame writes <name>.json (small values, base64 for short arrays)
 * plus <name>.rgba (capture), <name>.luma (f32), <name>.feat (f32 corrected features, after calibration).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareBenchmarkStream, type Tier } from "../src/index";
import { cellSizeFor } from "../src/facet/render";
import { CameraChannel } from "../test/facet/channel";
import { GridDetector, gridHomography, linearLuma } from "../src/facet/detect";
import { anchorPoints, refineHomography } from "../src/facet/refine";
import { gridLayout, type GridLayout } from "../src/facet/layout";
import { paletteExcess } from "../src/facet/palette";
import { anchorCalibration, defaultCalibration, fitChannel, DEFAULT_SIGMA, type ChannelCalibration } from "../src/facet/calibrate";
import { observe, decodeHeaders, decodeData } from "../src/facet/decode";
import { calibrationPicture, dataPicture } from "../src/facet/grid";
import { headerCrcMatches, parseFrameHeader } from "../src/facet/header";
import type { GridTier } from "../src/facet/tiers";

const outDir = process.argv[2] ?? resolve(process.cwd(), "../../crates/sealed-facet/fixtures");
mkdirSync(outDir, { recursive: true });

const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const f64 = (a: Float64Array | number[]) => Array.from(a);

async function run(tier: GridTier, frames: number): Promise<void> {
  const n = tier === 3 ? 144 : 112;
  const { sender } = await prepareBenchmarkStream({ size: 48 * 1024, tier, seed: 100 + tier });
  const channel = new CameraChannel({ seed: 7 + tier, blurCells: 0.3, maxRotationDeg: 12, dropRate: 0 });
  const px = 900;
  const cellPx = cellSizeFor(px, n);
  const layout: GridLayout = gridLayout(tier);
  let calibration: { channel: ChannelCalibration; centroids: Float32Array } | null = null;
  let written = 0;
  let seq = 0;
  while (written < frames) {
    const frame = sender.next();
    seq++;
    // The stream opens with 3 calibration and 3 descriptor frames, then data: keep the first of each, then data.
    if (frame.type === "calibration" && seq > 1) continue;
    if (frame.type === "descriptor" && seq !== 4) continue;
    const img = sender.render(frame, px);
    const cap = channel.capture(img, cellPx).image;
    const name = `t${tier}-${String(written).padStart(2, "0")}-${frame.type}`;
    const internal = (sender as unknown as { frames: Map<number, { header: Uint8Array; payload: Uint8Array; sbn: number; esi: number; streamId: Uint8Array }> }).frames.get(frame.sequence)!;
    const truthHeader = parseFrameHeader(internal.header)!;
    const picture = frame.type === "calibration" ? calibrationPicture(layout, internal.header) : dataPicture(layout, internal.header, { streamId: internal.streamId, tier, type: frame.type, sbn: internal.sbn, esi: internal.esi }, internal.payload);

    // Stages, as FacetReceiver.tryGrid runs them.
    const det = new GridDetector();
    const sets = det.detect(cap);
    const luma = det.luma ?? linearLuma(cap);
    const set = sets[0];
    if (!set) throw new Error(`${name}: detector found no corner set`);
    const coarse = gridHomography(set, n, luma);
    if (!coarse) throw new Error(`${name}: no homography`);
    const sigma = calibration?.channel.sigma ?? DEFAULT_SIGMA;
    const refined = refineHomography(luma, coarse, anchorPoints(layout, sigma));
    const h = refined && refined.rms < 0.35 ? refined.h : coarse;
    const cal = calibration ?? (() => {
      const fallback = anchorCalibration(cap, h, layout, defaultCalibration());
      if (!fallback) throw new Error(`${name}: anchor calibration failed`);
      return { channel: fallback, centroids: paletteExcess(tier) };
    })();
    const obs = observe(cap, h, layout, cal.channel, cal.centroids);
    if (!obs) throw new Error(`${name}: observe failed`);
    const cands = decodeHeaders(obs);
    const cand = cands.find((c) => Buffer.from(c.bytes).equals(Buffer.from(internal.header)));
    let payload: Uint8Array | null = null;
    let codewordFraction = 0;
    let fit: ReturnType<typeof fitChannel> = null;
    if (frame.type === "calibration") {
      if (!cand) throw new Error(`${name}: calibration header not decoded`);
      fit = fitChannel(cap, h, layout, picture, cal.channel, cal.centroids, true);
      if (!fit) throw new Error(`${name}: fitChannel failed`);
      calibration = { channel: fit.channel, centroids: fit.centroids };
    } else if (cand) {
      const res = decodeData(obs, cand, null);
      codewordFraction = res.codewordFraction;
      if (res.payload && headerCrcMatches(cand.bytes, res.payload)) payload = res.payload;
    }
    const json = {
      name,
      tier,
      n,
      type: frame.type,
      capture: { width: cap.width, height: cap.height, file: `${name}.rgba` },
      luma: { width: luma.width, height: luma.height, file: `${name}.luma` },
      truth: {
        header: b64(internal.header),
        headerParsed: { ...truthHeader, streamId: b64(truthHeader.streamId) },
        payload: b64(internal.payload),
        picture: b64(picture),
      },
      detect: { points: set.points.map((p) => [p[0], p[1]]), unit: set.unit, score: set.score, sets: sets.length },
      coarse: f64(coarse),
      refine: refined ? { h: f64(refined.h), rms: refined.rms, used: h === refined.h } : null,
      calibrationIn: { x: f64(cal.channel.x), sigma: cal.channel.sigma, fitted: cal.channel.fitted, rms: cal.channel.rms, lut: b64(cal.channel.lut), centroids: b64(cal.centroids) },
      observation: { file: `${name}.feat`, valid: b64(obs.valid), noiseVariance: obs.noiseVariance, sigma: cal.channel.sigma },
      headers: cands.map((c) => ({ bytes: b64(c.bytes), strip: c.strip })),
      headerMatched: Boolean(cand),
      decoded: { payload: payload ? b64(payload) : null, codewordFraction },
      calibrationOut: fit ? { x: f64(fit.channel.x), sigma: fit.channel.sigma, rms: fit.channel.rms, lut: b64(fit.channel.lut), centroids: b64(fit.centroids) } : null,
    };
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 1));
    writeFileSync(join(outDir, `${name}.rgba`), Buffer.from(cap.data.buffer, cap.data.byteOffset, cap.data.byteLength));
    writeFileSync(join(outDir, `${name}.luma`), Buffer.from(luma.data.buffer, luma.data.byteOffset, luma.data.byteLength));
    writeFileSync(join(outDir, `${name}.feat`), Buffer.from(obs.feat.buffer, obs.feat.byteOffset, obs.feat.byteLength));
    console.log(`${name}: ${cap.width}×${cap.height}, headers ${cands.length}${cand ? " (truth matched)" : ""}, payload ${payload ? `decoded (${payload.length} B)` : frame.type === "calibration" ? "n/a" : "not decoded"}`);
    written++;
  }
}

await run(1, 4);
await run(3, 3);
console.log(`fixtures written to ${outDir}`);
