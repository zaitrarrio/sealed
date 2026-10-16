/**
 * Optical benchmark (web). One device shows a looping test stream; the other films it and reports how far the
 * pipeline got: codes read, valid Sealed frames, completion, throughput and a byte-for-byte check. Nothing to
 * pair or type — the stream names its own seed and size.
 *
 * The filming side reads QR frames with the browser's BarcodeDetector when it has one (Chrome on Android and
 * macOS, Edge), otherwise it hands camera frames to Sealed's own decoder in a worker. The report says which.
 */
import { BENCHMARK_SIZES, formatBenchmarkReport, prepareBenchmarkStream, type BenchmarkReport, type BenchmarkStream, type Tier } from "@sealed/core";
import { useEffect, useRef, useState } from "react";
import { FacetStream } from "../components/FacetStream";
import { Notice, PageTitle, Progress, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { CameraError, feedFrames, openCamera, qrDetector, stopStream, watchQrCodes } from "../lib/camera";
import type { FromBenchWorker, ToBenchWorker } from "../workers/bench.worker";

type Role = "film" | "show";

export function BenchPage() {
  const [role, setRole] = useState<Role>("film");
  return (
    <div className="stack-lg">
      <PageTitle eyebrow="Benchmark">Measure an offline transfer</PageTitle>
      <p className="muted">One device shows a test stream, the other films it. Then switch roles to measure the other direction.</p>
      <div className="radio-row" role="radiogroup" aria-label="Role">
        {(
          [
            ["film", "Film"],
            ["show", "Show"],
          ] as const
        ).map(([v, l]) => (
          <label key={v}>
            <input type="radio" name="role" value={v} checked={role === v} onChange={() => setRole(v)} data-testid={`bench-role-${v}`} />
            {l}
          </label>
        ))}
      </div>
      {role === "show" ? <ShowStream /> : <FilmStream />}
    </div>
  );
}

function ShowStream() {
  const [size, setSize] = useState<number>(BENCHMARK_SIZES[1]);
  const [tier, setTier] = useState<Tier>(0);
  const [stream, setStream] = useState<BenchmarkStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (stream) return <FacetStream sender={stream.sender} caption={`bench T${stream.tier} · ${formatBytes(stream.size)} · seed ${stream.seed}`} onStop={() => setStream(null)} />;

  return (
    <div className="stack">
      <label className="field">
        Payload size
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} data-testid="bench-size">
          {BENCHMARK_SIZES.map((b) => (
            <option key={b} value={b}>
              {formatBytes(b)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Stream type
        <select value={tier} onChange={(e) => setTier(Number(e.target.value) as Tier)}>
          <option value={0}>T0 — QR (every phone and browser)</option>
          <option value={1}>T1 — colour grid (experimental)</option>
          <option value={2}>T2 — colour grid (experimental)</option>
          <option value={3}>T3 — colour grid (experimental)</option>
        </select>
      </label>
      {tier !== 0 && <Notice>Grid streams are decoded in JavaScript on the filming side, a frame or two per second at best.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <button
        type="button"
        className="btn primary block"
        disabled={busy}
        data-testid="bench-show"
        onClick={() => {
          setBusy(true);
          setError(null);
          prepareBenchmarkStream({ size, tier })
            .then(setStream)
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Preparing…" : "Show test stream"}
      </button>
    </div>
  );
}

function FilmStream() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [reader, setReader] = useState<"detector" | "frames" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!running) return;
    const worker = new Worker(new URL("../workers/bench.worker.ts", import.meta.url), { type: "module" });
    let stream: MediaStream | null = null;
    let stop: (() => void) | null = null;
    let cancelled = false;
    worker.onmessage = (ev: MessageEvent<FromBenchWorker>) => {
      setReport(ev.data.report);
      if (ev.data.report.stage === "verified" || ev.data.report.stage === "failed") setRunning(false);
    };
    worker.postMessage({ type: "start" } satisfies ToBenchWorker);
    void (async () => {
      try {
        stream = await openCamera({ width: 1920, height: 1080, frameRate: 60 });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const detector = await qrDetector();
        if (cancelled) return;
        if (detector) {
          setReader("detector");
          stop = watchQrCodes(video, detector, (text) => worker.postMessage({ type: "code", text } satisfies ToBenchWorker));
        } else {
          setReader("frames");
          stop = feedFrames(stream, video, (frame) => worker.postMessage({ type: "frame", frame } satisfies ToBenchWorker, [frame as unknown as Transferable]));
        }
      } catch (e) {
        setError(e instanceof CameraError ? e.message : errorMessage(e));
        setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
      stopStream(stream);
      // Let the last report arrive before the worker goes away.
      worker.postMessage({ type: "stop" } satisfies ToBenchWorker);
      setTimeout(() => worker.terminate(), 1500);
    };
  }, [running]);

  const full = report ? { ...report, device: `${navigator.userAgent}${reader ? ` · ${reader === "detector" ? "BarcodeDetector" : "JS decoder"}` : ""}` } : null;
  const text = full ? formatBenchmarkReport(full) : "";

  return (
    <div className="stack">
      {error && <Notice tone="danger">{error}</Notice>}
      {!running && (
        <button
          type="button"
          className="btn primary block"
          data-testid="bench-film"
          onClick={() => {
            setReport(null);
            setCopied(false);
            setError(null);
            setRunning(true);
          }}
        >
          {report ? "Film again" : "Start filming"}
        </button>
      )}
      {running && (
        <div className="scanner">
          <video ref={videoRef} playsInline muted aria-label="Camera view of the test stream" />
        </div>
      )}
      {reader && running && <p className="subtle">{reader === "detector" ? "Reading with the browser's QR detector." : "This browser has no QR detector: decoding camera frames in JavaScript (slower)."}</p>}
      {running && (
        <button type="button" className="btn ghost" onClick={() => setRunning(false)}>
          Stop
        </button>
      )}
      {full && (
        <div className="card stack" data-testid="bench-report" data-stage={full.stage}>
          <p style={{ margin: 0, color: full.stage === "failed" ? "var(--crimson-text)" : full.stage === "verified" ? "var(--success)" : undefined }}>
            {full.verdict}
          </p>
          <Progress fraction={full.fraction} label={`${full.symbolsReceived}/${full.symbolsNeeded || "?"} symbols`} />
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>
            {text}
          </pre>
          <div className="row">
            <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(`${text}\n\n${JSON.stringify(full)}`).then(() => setCopied(true))}>
              {copied ? "Copied" : "Copy report"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
