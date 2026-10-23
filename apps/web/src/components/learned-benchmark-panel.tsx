/**
 * Learned Optical File Transfer Benchmark Panel
 *
 * Implements interactive web-based benchmarking for:
 * "Learned Optical File Transfer Using Stock Smartphones: Joint waveform design
 *  and probabilistic decoding for exact offline transfer" (October 2026).
 */
import {
  runExperimentABlurSweep,
  runExperimentBGlareSweep,
  runExperimentCDeadlineSimulation,
  twoCellObservation,
  twoCellSeparationSquared,
  calculateGmi,
  BASELINE_SPECS,
  type BaselineSpec,
  type BlurSweepPoint,
  type GlareSweepPoint,
  type DeadlineSimulationResult,
} from "@sealed/core";
import { useState } from "react";
import { Notice, Progress, Spinner } from "./ui";

type BenchSuite = "all" | "exp-c" | "exp-a" | "exp-b" | "baselines" | "identifiability";

interface BenchmarkState {
  running: boolean;
  progressText: string;
  identifiability?: {
    points: { alpha: number; dSquared: number; distinguishable: boolean }[];
    gmi: number;
    optimalS: number;
  };
  baselineLadder?: BaselineSpec[];
  experimentA?: BlurSweepPoint[];
  experimentB?: GlareSweepPoint[];
  experimentC?: DeadlineSimulationResult & {
    marginSeconds: number;
    certificationLowerBound: number;
    certified: boolean;
  };
}

function formatPayload(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

export function LearnedBenchmarkPanel() {
  const [suite, setSuite] = useState<BenchSuite>("all");
  const [fps, setFps] = useState<number>(60);
  const [payloadBytes, setPayloadBytes] = useState<number>(134217728); // 128 MiB
  const [quickMode, setQuickMode] = useState<boolean>(true);
  const [state, setState] = useState<BenchmarkState>({ running: false, progressText: "" });

  const runBenchmark = async () => {
    setState({ running: true, progressText: "Initializing optical benchmark simulation..." });
    await new Promise((r) => setTimeout(r, 50));

    try {
      let identifiabilityData = undefined;
      if (suite === "all" || suite === "identifiability") {
        setState((s) => ({ ...s, progressText: "Evaluating 2-cell channel singularity & GMI..." }));
        await new Promise((r) => setTimeout(r, 20));

        const alphas = [0.0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5, 0.51, 0.6, 0.7, 0.8];
        const points = alphas.map((a) => {
          const d2 = twoCellSeparationSquared(a, 0.1);
          const obs10 = twoCellObservation(a, [1, 0]);
          const obs01 = twoCellObservation(a, [0, 1]);
          const dist = Math.hypot(obs10[0] - obs01[0], obs10[1] - obs01[1]);
          return { alpha: a, dSquared: d2, distinguishable: dist > 1e-4 };
        });

        const sampleBits = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0]);
        const sampleLlrs = new Float64Array([8.5, -8.2, 7.8, 9.1, -7.9, -6.5, 8.4, -9.0, 7.5, 8.8, -8.0, 7.2, -8.1, -7.4, 8.9, -8.6]);
        const gmiRes = calculateGmi(sampleBits, sampleLlrs);

        identifiabilityData = {
          points,
          gmi: gmiRes.gmi,
          optimalS: gmiRes.optimalS,
        };
      }

      let baselineData = undefined;
      if (suite === "all" || suite === "baselines") {
        baselineData = Object.values(BASELINE_SPECS);
      }

      let expAData = undefined;
      if (suite === "all" || suite === "exp-a") {
        setState((s) => ({ ...s, progressText: "Running Experiment A: optical blur sweep..." }));
        await new Promise((r) => setTimeout(r, 30));
        const sigmas = quickMode ? [0.3, 0.8, 1.4] : [0.2, 0.5, 0.8, 1.2, 1.5];
        expAData = runExperimentABlurSweep(sigmas, 480);
      }

      let expBData = undefined;
      if (suite === "all" || suite === "exp-b") {
        setState((s) => ({ ...s, progressText: "Running Experiment B: specular glare & erasure sweep..." }));
        await new Promise((r) => setTimeout(r, 30));
        const radii = quickMode ? [0, 60, 120] : [0, 40, 80, 120];
        expBData = runExperimentBGlareSweep(radii, 480);
      }

      let expCData = undefined;
      if (suite === "all" || suite === "exp-c") {
        setState((s) => ({ ...s, progressText: "Running Experiment C: 128 MiB transfer deadline simulation..." }));
        await new Promise((r) => setTimeout(r, 30));
        const cRes = runExperimentCDeadlineSimulation(payloadBytes, fps);
        const marginSeconds = Number((cRes.deadlineSeconds - cRes.totalDurationSeconds).toFixed(1));
        const certified = cRes.deadlineMet && cRes.confidenceLowerBound95 >= 0.95;

        expCData = {
          ...cRes,
          marginSeconds,
          certificationLowerBound: Number((cRes.confidenceLowerBound95 * 100).toFixed(2)),
          certified,
        };
      }

      setState({
        running: false,
        progressText: "Benchmark completed successfully.",
        identifiability: identifiabilityData,
        baselineLadder: baselineData,
        experimentA: expAData,
        experimentB: expBData,
        experimentC: expCData,
      });
    } catch (err: unknown) {
      setState({
        running: false,
        progressText: `Benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const c = state.experimentC;

  return (
    <div className="stack-lg">
      <div className="card stack">
        <h3>Research Proposal Benchmark (128 MiB in &le; 120s)</h3>
        <p className="muted">
          Simulate physics-informed optical channels, joint learned waveforms, probabilistic decoding, and exact
          Clopper-Pearson statistical certification.
        </p>

        <div className="row wrap" style={{ gap: 16 }}>
          <label className="field" style={{ minWidth: 200 }}>
            Benchmark suite
            <select
              value={suite}
              onChange={(e) => setSuite(e.target.value as BenchSuite)}
              disabled={state.running}
            >
              <option value="all">Full Suite (Exp A, B, C &amp; Baselines)</option>
              <option value="exp-c">Experiment C: 128 MiB / 120s Deadline</option>
              <option value="exp-a">Experiment A: Optical Blur Sweep</option>
              <option value="exp-b">Experiment B: Glare &amp; Erasure Sweep</option>
              <option value="baselines">Baseline Ladder Taxonomy (B0-B6)</option>
              <option value="identifiability">Identifiability &amp; 2-Cell Singularity</option>
            </select>
          </label>

          <label className="field" style={{ minWidth: 140 }}>
            Display rate
            <select
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              disabled={state.running}
            >
              <option value={30}>30 fps</option>
              <option value={60}>60 fps (Nominal)</option>
              <option value={120}>120 fps (High Speed)</option>
            </select>
          </label>

          <label className="field" style={{ minWidth: 160 }}>
            Payload size
            <select
              value={payloadBytes}
              onChange={(e) => setPayloadBytes(Number(e.target.value))}
              disabled={state.running}
            >
              <option value={33554432}>{formatPayload(33554432)} (32 MiB)</option>
              <option value={67108864}>{formatPayload(67108864)} (64 MiB)</option>
              <option value={134217728}>{formatPayload(134217728)} (128 MiB - Proposal Target)</option>
            </select>
          </label>

          <label className="row" style={{ alignItems: "center", gap: 8, marginTop: 24, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={quickMode}
              onChange={(e) => setQuickMode(e.target.checked)}
              disabled={state.running}
            />
            <span className="subtle">Fast sweep mode</span>
          </label>
        </div>

        <button
          type="button"
          className="btn primary block"
          disabled={state.running}
          onClick={runBenchmark}
        >
          {state.running ? <Spinner label={state.progressText} /> : "Run Research Benchmark Suite"}
        </button>

        {state.progressText && !state.running && (
          <p className="subtle" style={{ margin: 0 }}>
            {state.progressText}
          </p>
        )}
      </div>

      {c && (
        <div className="card stack">
          <div className="row between" style={{ alignItems: "center" }}>
            <h4>Experiment C: Transfer Deadline Simulation</h4>
            <span
              className={`badge ${c.deadlineMet ? "hw" : "browser"}`}
              style={{ fontSize: 13, padding: "4px 10px" }}
            >
              {c.deadlineMet ? "DEADLINE MET (PASS)" : "DEADLINE EXCEEDED"}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 20 }}>
            <div className="stack" style={{ flex: 1, minWidth: 150 }}>
              <span className="subtle">Net Throughput</span>
              <strong style={{ fontSize: 24, color: "var(--amber)" }}>
                {c.verifiedGoodputMbps.toFixed(2)} Mbps
              </strong>
              <span className="muted" style={{ fontSize: 12 }}>Target: &ge; 11.51 Mbps</span>
            </div>

            <div className="stack" style={{ flex: 1, minWidth: 150 }}>
              <span className="subtle">Total Transfer Time</span>
              <strong style={{ fontSize: 24 }}>
                {c.totalDurationSeconds.toFixed(1)} s
              </strong>
              <span className="muted" style={{ fontSize: 12 }}>
                Deadline: &le; 120.0 s ({c.marginSeconds >= 0 ? `+${c.marginSeconds}s margin` : `${c.marginSeconds}s late`})
              </span>
            </div>

            <div className="stack" style={{ flex: 1, minWidth: 180 }}>
              <span className="subtle">Statistical Certification</span>
              <strong style={{ fontSize: 24, color: "var(--success)" }}>
                {c.certificationLowerBound.toFixed(2)}%
              </strong>
              <span className="muted" style={{ fontSize: 12 }}>
                Clopper-Pearson 95% bound (n = {c.sampleSizeRequired} trials)
              </span>
            </div>
          </div>

          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            <span className="subtle">Time-to-Event Waterfall Profile</span>
            <div style={{ display: "flex", height: 24, borderRadius: 6, overflow: "hidden", background: "var(--bg-sunken)" }}>
              <div
                style={{
                  width: `${(c.timeToEventProfile.acquisitionMs / (c.totalDurationSeconds * 1000)) * 100}%`,
                  background: "var(--amber)",
                }}
                title={`Acquisition: ${(c.timeToEventProfile.acquisitionMs / 1000).toFixed(1)}s`}
              />
              <div
                style={{
                  width: `${(c.timeToEventProfile.transferMs / (c.totalDurationSeconds * 1000)) * 100}%`,
                  background: "var(--success)",
                }}
                title={`Continuous Stream: ${(c.timeToEventProfile.transferMs / 1000).toFixed(1)}s`}
              />
              <div
                style={{
                  width: `${(c.timeToEventProfile.fecDrainMs / (c.totalDurationSeconds * 1000)) * 100}%`,
                  background: "var(--crimson)",
                }}
                title={`FEC Drain: ${(c.timeToEventProfile.fecDrainMs / 1000).toFixed(1)}s`}
              />
              <div
                style={{
                  width: `${(c.timeToEventProfile.verificationMs / (c.totalDurationSeconds * 1000)) * 100}%`,
                  background: "var(--line-strong)",
                }}
                title={`Verify: ${(c.timeToEventProfile.verificationMs / 1000).toFixed(1)}s`}
              />
            </div>
            <div className="row wrap between subtle" style={{ fontSize: 12 }}>
              <span>Acquisition: {(c.timeToEventProfile.acquisitionMs / 1000).toFixed(1)}s</span>
              <span>Active Stream: {(c.timeToEventProfile.transferMs / 1000).toFixed(1)}s</span>
              <span>FEC Drain: {(c.timeToEventProfile.fecDrainMs / 1000).toFixed(1)}s</span>
              <span>SHA-256 Check: {(c.timeToEventProfile.verificationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>
        </div>
      )}

      {state.experimentA && (
        <div className="card stack">
          <h4>Experiment A: Optical Blur Degradation Curve</h4>
          <p className="muted" style={{ margin: 0 }}>
            Sweeps optical blur sigma (&sigma;) to test where conventional thresholding (B1) fails versus joint learned modulation (B5/B6).
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>Blur (&sigma;)</th>
                  <th style={{ padding: "8px 6px" }}>B1 (Hard Thresh)</th>
                  <th style={{ padding: "8px 6px" }}>B2 (Wiener Deconv)</th>
                  <th style={{ padding: "8px 6px" }}>B5 (Joint Learned)</th>
                  <th style={{ padding: "8px 6px" }}>B6 (Spatiotemporal)</th>
                </tr>
              </thead>
              <tbody>
                {state.experimentA.map((pt) => (
                  <tr key={pt.blurSigmaCells} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "8px 6px", fontFamily: "var(--font-mono)" }}>
                      &sigma; = {pt.blurSigmaCells.toFixed(1)}
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <span className={pt.results.B1.packetsRecovered > 0 ? "mono" : "mono subtle"} style={{ color: pt.results.B1.packetsRecovered === 16 ? "var(--success)" : undefined }}>
                        {pt.results.B1.packetsRecovered}/16 pkts (BER {pt.results.B1.bitErrorRate.toFixed(2)})
                      </span>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <span className="mono">
                        {pt.results.B2.packetsRecovered}/16 pkts (BER {pt.results.B2.bitErrorRate.toFixed(2)})
                      </span>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <strong className="mono" style={{ color: "var(--success)" }}>
                        {pt.results.B5.packetsRecovered}/16 pkts (GMI {pt.results.B5.gmi.toFixed(2)})
                      </strong>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <strong className="mono" style={{ color: "var(--amber)" }}>
                        {pt.results.B6.packetsRecovered}/16 pkts (GMI {pt.results.B6.gmi.toFixed(2)})
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {state.experimentB && (
        <div className="card stack">
          <h4>Experiment B: Specular Glare &amp; Fountain Erasure Tagging</h4>
          <p className="muted" style={{ margin: 0 }}>
            Verifies that specular glare saturation is cleanly isolated into packet erasures without causing uncorrectable bit flips.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>Glare Radius</th>
                  <th style={{ padding: "8px 6px" }}>Saturated Area</th>
                  <th style={{ padding: "8px 6px" }}>B1 Recovered / Erasures</th>
                  <th style={{ padding: "8px 6px" }}>B5 Recovered / Erasures</th>
                  <th style={{ padding: "8px 6px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {state.experimentB.map((pt) => (
                  <tr key={pt.glareRadiusPx} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "8px 6px", fontFamily: "var(--font-mono)" }}>
                      {pt.glareRadiusPx === 0 ? "None" : `${pt.glareRadiusPx} px`}
                    </td>
                    <td style={{ padding: "8px 6px", fontFamily: "var(--font-mono)" }}>
                      {(pt.glareSaturationFraction * 100).toFixed(1)}%
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      {pt.results.B1.packetsRecovered}/16 ({pt.results.B1.erasureCount} erasures)
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <strong style={{ color: "var(--success)" }}>
                        {pt.results.B5.packetsRecovered}/16 ({pt.results.B5.erasureCount} erasures)
                      </strong>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <span className="badge hw" style={{ fontSize: 11 }}>
                        {pt.results.B5.erasureCount > 0 ? "Fountain Erasures Handled" : "Clear Channel"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {state.identifiability && (
        <div className="card stack">
          <h4>Identifiability &amp; 2-Cell Optical Singularity (Appendix C, Eq 13 &amp; 14)</h4>
          <p className="muted" style={{ margin: 0 }}>
            Analytic proof: At blur mixing a = 0.5, separation d&sup2; drops strictly to 0, making codewords [1,0] and [0,1] indistinguishable under noise.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>Mixing Parameter (a)</th>
                  <th style={{ padding: "8px 6px" }}>Separation d&sup2; (Eq 14)</th>
                  <th style={{ padding: "8px 6px" }}>Distinguishable</th>
                  <th style={{ padding: "8px 6px" }}>Singularity State</th>
                </tr>
              </thead>
              <tbody>
                {state.identifiability.points.map((p) => {
                  const isSingular = Math.abs(p.alpha - 0.5) < 1e-4;
                  return (
                    <tr
                      key={p.alpha}
                      style={{
                        borderBottom: "1px solid var(--line)",
                        background: isSingular ? "var(--amber-soft)" : undefined,
                      }}
                    >
                      <td style={{ padding: "8px 6px", fontFamily: "var(--font-mono)" }}>
                        a = {p.alpha.toFixed(2)}
                      </td>
                      <td style={{ padding: "8px 6px", fontFamily: "var(--font-mono)" }}>
                        {p.dSquared.toFixed(3)}
                      </td>
                      <td style={{ padding: "8px 6px" }}>
                        {p.distinguishable ? "YES" : "NO"}
                      </td>
                      <td style={{ padding: "8px 6px" }}>
                        {isSingular ? (
                          <span style={{ color: "var(--crimson-text)", fontWeight: 600 }}>
                            SINGULARITY COLLAPSE (d&sup2; = 0)
                          </span>
                        ) : (
                          <span className="subtle">Resolvable</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {state.baselineLadder && (
        <div className="card stack">
          <h4>Baseline Ladder Taxonomy (B0 through B6)</h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>ID</th>
                  <th style={{ padding: "8px 6px" }}>Baseline Name</th>
                  <th style={{ padding: "8px 6px" }}>Learned Waveform</th>
                  <th style={{ padding: "8px 6px" }}>Neural Equalizer</th>
                  <th style={{ padding: "8px 6px" }}>Temporal Multi-Frame</th>
                </tr>
              </thead>
              <tbody>
                {state.baselineLadder.map((b) => (
                  <tr key={b.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "8px 6px", fontWeight: 600 }}>{b.id}</td>
                    <td style={{ padding: "8px 6px" }}>{b.name}</td>
                    <td style={{ padding: "8px 6px" }}>{b.hasLearnedEncoder ? "YES" : "NO"}</td>
                    <td style={{ padding: "8px 6px" }}>{b.hasNeuralReceiver ? "YES" : "NO"}</td>
                    <td style={{ padding: "8px 6px" }}>{b.hasTemporalInference ? "YES" : "NO"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
