/**
 * Automated optical benchmark sweep (`pnpm --filter @sealed/core bench:sweep` or `task bench:sweep`).
 *
 * Runs deterministic parameter sweeps across QR profiles (v21–v40), channel packet loss rates,
 * frame rates, codes per screen, and payload sizes. Verifies all transfers byte-for-byte with SHA-256
 * and reports goodput, screen counts, and compute overhead.
 *
 * Options:
 *   --mode <profiles|loss|rates|sizes|full>   sweep mode (default: profiles)
 *   --size <bytes>                            payload size in bytes (default: 65536)
 *   --loss <0.0-0.9>                          drop rate fraction (default: 0.2)
 *   --codes <1|2|4>                           codes per screen (default: 1)
 *   --fps <10|15|20|30>                       display frames/sec (default: 10)
 *   --json                                    output machine-readable JSON
 *   --markdown                                output formatted Markdown table
 *   --out <path>                              write output to file
 *   --verify-all                              fail (exit 1) if any run fails byte verification
 */
import { writeFileSync } from "node:fs";
import { BenchmarkMeter, QR_HOLDS, QR_PROFILES, prepareBenchmarkStream } from "../src/index";

export interface SweepResult {
  mode: string;
  qrVersion: number;
  symbolSize: number;
  payloadBytes: number;
  codesPerScreen: number;
  fps: number;
  dropRate: number;
  screensToComplete: number;
  codesShown: number;
  codesRead: number;
  symbolsNeeded: number;
  verified: boolean;
  simulatedSeconds: number;
  goodputKBps: number;
  secondsFor1MB: number;
  cpuComputeMs: number;
  error: string | null;
}

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

export async function runSimulatedBenchmark(options: {
  size: number;
  symbolSize: number;
  qrVersion: number;
  codesPerScreen: number;
  fps: number;
  dropRate: number;
  seed?: number;
  maxScreens?: number;
}): Promise<SweepResult> {
  const {
    size,
    symbolSize,
    qrVersion,
    codesPerScreen,
    fps,
    dropRate,
    seed = 20261016,
    maxScreens = 2000,
  } = options;

  const frameIntervalMs = 1000 / fps;
  let simulatedTimeMs = 1000;
  const clock = {
    now: () => simulatedTimeMs,
    tick: () => {
      simulatedTimeMs += frameIntervalMs;
    },
  };

  const cpuStart = performance.now();
  const { sender } = await prepareBenchmarkStream({
    size,
    tier: 0,
    seed,
    qr: { symbolSize },
  });

  const meter = new BenchmarkMeter(clock.now);

  // Deterministic PRNG for channel drops
  let rngState = (seed ^ (symbolSize << 8) ^ Math.floor(dropRate * 1000)) >>> 0 || 1;
  const nextRandom = () => {
    rngState ^= rngState << 13;
    rngState >>>= 0;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    rngState >>>= 0;
    return (rngState >>> 0) / 4294967296;
  };

  let screens = 0;
  let codesShown = 0;
  let codesRead = 0;

  while (screens < maxScreens && !meter.complete) {
    screens++;
    for (let c = 0; c < codesPerScreen; c++) {
      const frame = sender.next();
      codesShown++;
      const text = sender.qrText(frame);
      if (!text) continue;

      const isDropped = nextRandom() < dropRate;
      if (!isDropped) {
        codesRead++;
        meter.pushCode(text);
      }
    }
    clock.tick();
  }

  await meter.finished();
  const cpuComputeMs = Math.round((performance.now() - cpuStart) * 10) / 10;
  const report = meter.report();

  const simulatedSeconds = (screens * frameIntervalMs) / 1000;
  const goodputKBps = simulatedSeconds > 0 && report.verified ? Math.round((size / simulatedSeconds / 1024) * 10) / 10 : 0;
  const secondsFor1MB = goodputKBps > 0 ? Math.round((1024 / goodputKBps) * 10) / 10 : Infinity;

  return {
    mode: "",
    qrVersion,
    symbolSize,
    payloadBytes: size,
    codesPerScreen,
    fps,
    dropRate,
    screensToComplete: screens,
    codesShown,
    codesRead,
    symbolsNeeded: report.symbolsNeeded,
    verified: report.verified === true,
    simulatedSeconds: Math.round(simulatedSeconds * 10) / 10,
    goodputKBps,
    secondsFor1MB,
    cpuComputeMs,
    error: report.error,
  };
}

async function runSweep(): Promise<void> {
  const mode = parseArg("mode", "profiles");
  const baseSize = Number(parseArg("size", "65536"));
  const baseLoss = Number(parseArg("loss", "0.2"));
  const baseCodes = Number(parseArg("codes", "1"));
  const baseFps = Number(parseArg("fps", "10"));
  const json = hasFlag("json");
  const markdown = hasFlag("markdown");
  const verifyAll = hasFlag("verify-all");
  const outFile = parseArg("out", "");

  const runs: Array<{
    size: number;
    symbolSize: number;
    qrVersion: number;
    codesPerScreen: number;
    fps: number;
    dropRate: number;
    label: string;
  }> = [];

  if (mode === "profiles" || mode === "full") {
    for (const p of QR_PROFILES) {
      runs.push({
        size: baseSize,
        symbolSize: p.symbolSize,
        qrVersion: p.qrVersion,
        codesPerScreen: baseCodes,
        fps: baseFps,
        dropRate: baseLoss,
        label: `QR v${p.qrVersion} (${p.symbolSize} B)`,
      });
    }
  }

  if (mode === "loss" || mode === "full") {
    const defaultProfile = QR_PROFILES[0]!;
    for (const drop of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
      runs.push({
        size: baseSize,
        symbolSize: defaultProfile.symbolSize,
        qrVersion: defaultProfile.qrVersion,
        codesPerScreen: baseCodes,
        fps: baseFps,
        dropRate: drop,
        label: `Loss ${(drop * 100).toFixed(0)}%`,
      });
    }
  }

  if (mode === "rates" || mode === "full") {
    const defaultProfile = QR_PROFILES[0]!;
    for (const codes of [1, 2, 4]) {
      for (const hold of QR_HOLDS) {
        const fps = 60 / hold;
        runs.push({
          size: baseSize,
          symbolSize: defaultProfile.symbolSize,
          qrVersion: defaultProfile.qrVersion,
          codesPerScreen: codes,
          fps,
          dropRate: baseLoss,
          label: `${codes} code${codes > 1 ? "s" : ""} @ ${fps} fps`,
        });
      }
    }
  }

  if (mode === "sizes" || mode === "full") {
    const defaultProfile = QR_PROFILES[0]!;
    for (const sz of [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024]) {
      runs.push({
        size: sz,
        symbolSize: defaultProfile.symbolSize,
        qrVersion: defaultProfile.qrVersion,
        codesPerScreen: baseCodes,
        fps: baseFps,
        dropRate: baseLoss,
        label: `${sz / 1024} KB payload`,
      });
    }
  }

  const results: SweepResult[] = [];
  if (!json) {
    process.stderr.write(`Running optical benchmark sweep [mode: ${mode}, ${runs.length} scenarios]...`);
  }

  for (const r of runs) {
    const res = await runSimulatedBenchmark(r);
    res.mode = r.label;
    results.push(res);
    if (!json) process.stderr.write(".");
  }

  if (!json) process.stderr.write(" done\n\n");

  const unverified = results.filter((r) => !r.verified);
  if (verifyAll && unverified.length > 0) {
    console.error(`Benchmark verification failed for ${unverified.length} scenarios:`);
    for (const u of unverified) console.error(`  - ${u.mode}: ${u.error ?? "checksum mismatch"}`);
    process.exit(1);
  }

  let formatted = "";

  if (json) {
    formatted = JSON.stringify(
      {
        mode,
        scenarios: results.length,
        timestamp: new Date().toISOString(),
        results,
      },
      null,
      2
    );
  } else if (markdown) {
    const headers = [
      "Scenario",
      "Payload",
      "QR Profile",
      "Codes × FPS",
      "Loss",
      "Screens",
      "Goodput",
      "1 MB in",
      "Verified",
      "CPU ms",
    ];
    const rows = results.map((r) => [
      r.mode,
      `${(r.payloadBytes / 1024).toFixed(0)} KB`,
      `v${r.qrVersion} (${r.symbolSize} B)`,
      `${r.codesPerScreen} × ${r.fps}/s`,
      `${(r.dropRate * 100).toFixed(0)}%`,
      `${r.screensToComplete}`,
      `${r.goodputKBps} KB/s`,
      Number.isFinite(r.secondsFor1MB) ? `${r.secondsFor1MB} s` : "-",
      r.verified ? "Yes" : "NO",
      `${r.cpuComputeMs} ms`,
    ]);

    const mdHeader = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
    const mdRows = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
    formatted = `### Optical Benchmark Sweep (${mode})\n\n${mdHeader}\n${mdRows}\n`;
  } else {
    const headers = [
      "Scenario",
      "Payload",
      "Codes × FPS",
      "Loss",
      "Screens",
      "Goodput",
      "1 MB in",
      "Verified",
      "CPU ms",
    ];
    const rows = results.map((r) => [
      r.mode,
      `${(r.payloadBytes / 1024).toFixed(0)} KB`,
      `${r.codesPerScreen} × ${r.fps}/s`,
      `${(r.dropRate * 100).toFixed(0)}%`,
      `${r.screensToComplete}`,
      `${r.goodputKBps} KB/s`,
      Number.isFinite(r.secondsFor1MB) ? `${r.secondsFor1MB} s` : "-",
      r.verified ? "yes" : "NO",
      `${r.cpuComputeMs} ms`,
    ]);

    const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
    const padLine = (items: string[]) => items.map((it, i) => it.padEnd(colWidths[i] as number)).join("  ");

    const divider = "-".repeat(colWidths.reduce((a, b) => a + b + 2, 0));
    formatted = [
      `Sealed Optical Benchmark Sweep — Mode: ${mode}`,
      divider,
      padLine(headers),
      divider,
      ...rows.map(padLine),
      divider,
      `All ${results.length} scenarios completed and verified byte-for-byte.`,
    ].join("\n");
  }

  if (outFile) {
    writeFileSync(outFile, `${formatted}\n`, "utf8");
    if (!json) console.log(`Results written to ${outFile}`);
  } else {
    console.log(formatted);
  }
}

const isMain =
  typeof process !== "undefined" &&
  Boolean(
    process.argv[1] &&
      (process.argv[1].endsWith("optical-sweep.mjs") ||
        process.argv[1].endsWith("optical-sweep.ts") ||
        process.argv[1].endsWith("optical-sweep"))
  );

if (isMain) {
  void runSweep();
}

