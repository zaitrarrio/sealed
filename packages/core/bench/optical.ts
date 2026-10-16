/**
 * Optical benchmark, command line (`pnpm --filter @sealed/core bench`).
 *
 * For each tier it streams a benchmark payload through two receive paths and reports what each achieved:
 *   detector  T0 only — the frame text a platform QR detector returns (what phones and Chrome use). Measures
 *             the protocol itself: RaptorQ, descriptor, assembly. No pixels.
 *   camera    sender pixels → camera simulator (blur, perspective, noise, drops) → FacetReceiver.push. Measures
 *             the JavaScript image decoder this machine runs, per captured frame.
 * Throughput estimates assume the sender's nominal frame rate and that the receiver keeps up only if it decodes
 * a frame within the frame interval; a decoder slower than that reads one frame in (decode time / interval).
 *
 *   --size <bytes>     payload size (default 65536)
 *   --tiers 0,1,2,3    tiers to run (default 0,1)
 *   --frames <n>       max frames shown per run (default 400)
 *   --qr               QR profile matrix instead: for each QR size × codes per screen × frame rate, the frames
 *                      needed (protocol overhead included, 20 % of codes missed) and the ceiling throughput if the
 *                      phone's detector reads every code it sees. Real devices land below this; the on-device
 *                      benchmark measures how far.
 *   --json             machine-readable output
 */
import { BenchmarkMeter, prepareBenchmarkStream, QR_HOLDS, QR_PROFILES, TIERS, QR_VERSION, type Tier } from "../src/index";
import { cellSizeFor, QR_QUIET_MODULES } from "../src/facet/render";
import { CameraChannel } from "../test/facet/channel";

interface Row {
  tier: Tier;
  path: "detector" | "camera";
  payloadBytes: number;
  framesShown: number;
  validFrames: number;
  complete: boolean;
  verified: boolean | null;
  renderMsPerFrame: number;
  decodeMsPerFrame: number;
  /** Frames the sender needed to show before the receiver completed (lower is better; ≥ symbols needed). */
  framesToComplete: number | null;
  estimatedGoodputBytesPerSecond: number;
  estimatedSecondsFor1MB: number;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const size = Number(arg("size", "65536"));
const tiers = arg("tiers", "0,1")
  .split(",")
  .map((t) => Number(t) as Tier)
  .filter((t) => t in TIERS);
const maxFrames = Number(arg("frames", "400"));
const json = process.argv.includes("--json");

function estimate(tier: Tier, framesToComplete: number | null, framesShown: number, decodeMs: number, payload: number): { goodput: number; oneMb: number } {
  const t = TIERS[tier];
  const intervalMs = 1000 / t.dataFps;
  // The receiver reads at most one frame per decode; slower decoders skip frames.
  const readFraction = decodeMs <= intervalMs ? 1 : intervalMs / decodeMs;
  const frames = framesToComplete ?? framesShown;
  const efficiency = frames > 0 ? payload / (frames * t.symbolSize) : 0; // overhead: descriptor, repair, losses
  const goodput = t.symbolSize * t.dataFps * readFraction * Math.min(1, efficiency);
  return { goodput, oneMb: goodput > 0 ? (1024 * 1024) / goodput : Infinity };
}

async function run(tier: Tier, path: Row["path"]): Promise<Row> {
  const { sender } = await prepareBenchmarkStream({ size, tier, seed: 20261016 + tier });
  const meter = new BenchmarkMeter();
  const channel = new CameraChannel({ seed: 31 + tier, blurCells: tier === 0 ? 0.15 : 0.3, maxRotationDeg: tier === 0 ? 5 : 15, dropRate: 0.1 });
  const px = 1000;
  const cellPx = tier === 0 ? Math.floor(px / (QR_VERSION * 4 + 17 + 2 * QR_QUIET_MODULES)) : cellSizeFor(px, tier === 3 ? 144 : 112);
  let shown = 0;
  let renderMs = 0;
  let decodeMs = 0;
  let decoded = 0;
  let toComplete: number | null = null;
  while (shown < maxFrames && !meter.complete) {
    const frame = sender.next();
    shown++;
    if (path === "detector") {
      const text = sender.qrText(frame);
      if (text) meter.pushCode(text);
    } else {
      const t0 = performance.now();
      const img = sender.render(frame, px);
      renderMs += performance.now() - t0;
      if (!channel.delivered()) continue;
      const cap = channel.capture(img, cellPx);
      const t1 = performance.now();
      meter.pushImage(cap.image);
      decodeMs += performance.now() - t1;
      decoded++;
    }
    if (meter.complete) toComplete = shown;
  }
  await meter.finished();
  const r = meter.report();
  const perDecode = decoded ? decodeMs / decoded : 0;
  const est = estimate(tier, toComplete, shown, perDecode, size);
  return {
    tier,
    path,
    payloadBytes: size,
    framesShown: shown,
    validFrames: r.validFrames,
    complete: meter.complete,
    verified: r.verified,
    renderMsPerFrame: Math.round(shown ? renderMs / shown : 0),
    decodeMsPerFrame: Math.round(perDecode),
    framesToComplete: toComplete,
    estimatedGoodputBytesPerSecond: Math.round(meter.complete ? est.goodput : 0),
    estimatedSecondsFor1MB: meter.complete ? Math.round(est.oneMb) : Infinity,
  };
}

if (process.argv.includes("--qr")) {
  const out: { qrVersion: number; symbolSize: number; codesPerScreen: number; framesPerSecond: number; screensToComplete: number; ceilingKBps: number; secondsFor1MB: number }[] = [];
  for (const p of QR_PROFILES) {
    // Screens needed for this payload when 20 % of codes are missed (descriptors and repair included).
    const { sender } = await prepareBenchmarkStream({ size, tier: 0, seed: 7, qr: { symbolSize: p.symbolSize } });
    const meter = new BenchmarkMeter();
    let codes = 0;
    while (!meter.complete && codes < 100_000) {
      const text = sender.qrText(sender.next());
      if (text && codes++ % 5 !== 2) meter.pushCode(text);
    }
    await meter.finished();
    const efficiency = size / (codes * p.symbolSize); // payload per code shown
    for (const perScreen of [1, 2, 4]) {
      for (const hold of QR_HOLDS) {
        const fps = 60 / hold;
        const bps = perScreen * fps * p.symbolSize * efficiency;
        out.push({ qrVersion: p.qrVersion, symbolSize: p.symbolSize, codesPerScreen: perScreen, framesPerSecond: fps, screensToComplete: Math.ceil(codes / perScreen), ceilingKBps: Math.round(bps / 102.4) / 10, secondsFor1MB: Math.round((1024 * 1024) / bps) });
      }
    }
  }
  if (json) process.stdout.write(`${JSON.stringify({ size, rows: out }, null, 2)}\n`);
  else {
    console.log(`QR profile ceilings — ${(size / 1024).toFixed(0)} KB payload, 20 % of codes missed, detector reads every code it sees`);
    console.log("QR   bytes/code  codes/screen  frames/s  ceiling KB/s  1 MB in");
    for (const r of out) console.log(`v${r.qrVersion}  ${String(r.symbolSize).padEnd(10)}  ${String(r.codesPerScreen).padEnd(12)}  ${String(r.framesPerSecond).padEnd(8)}  ${String(r.ceilingKBps).padEnd(12)}  ${r.secondsFor1MB} s`);
    console.log("\nThe detector's real read rate decides which of these hold: measure with the on-device Benchmark.");
  }
  process.exit(0);
}

const rows: Row[] = [];
for (const tier of tiers) {
  if (tier === 0) rows.push(await run(0, "detector"));
  rows.push(await run(tier, "camera"));
  if (!json) process.stderr.write(`.`);
}

if (json) {
  process.stdout.write(`${JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, size, rows }, null, 2)}\n`);
} else {
  process.stderr.write("\n");
  const head = ["tier", "path", "done", "verified", "frames", "valid", "render ms", "decode ms", "est. KB/s", "1 MB in"];
  const body = rows.map((r) => [
    `T${r.tier}`,
    r.path,
    r.complete ? "yes" : "NO",
    r.verified === null ? "-" : r.verified ? "yes" : "NO",
    `${r.framesToComplete ?? r.framesShown}`,
    `${r.validFrames}`,
    r.path === "camera" ? `${r.renderMsPerFrame}` : "-",
    r.path === "camera" ? `${r.decodeMsPerFrame}` : "-",
    (r.estimatedGoodputBytesPerSecond / 1024).toFixed(1),
    Number.isFinite(r.estimatedSecondsFor1MB) ? `${Math.round(r.estimatedSecondsFor1MB)} s` : "-",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] as string).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
  console.log(`Sealed optical benchmark — ${(size / 1024).toFixed(0)} KB payload, Node ${process.version}, ${process.platform}-${process.arch}`);
  console.log(line(head));
  for (const b of body) console.log(line(b));
  console.log(
    "\ndetector = text from a platform QR detector (phones, Chrome); camera = this machine's JavaScript image decoder on simulated captures.\nEstimates assume the sender's nominal frame rate; a decoder slower than one frame interval reads proportionally fewer frames.",
  );
}
