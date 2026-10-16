/**
 * Optical benchmark (web). One device shows a looping test stream; the other films it and reports how far the
 * pipeline got: codes read, valid Sealed frames, completion, throughput and a byte-for-byte check. Nothing to
 * pair or type — the stream names its own seed and size.
 *
 * The filming side reads QR frames with the browser's BarcodeDetector when it has one (Chrome on Android and
 * macOS, Edge), otherwise it hands camera frames to Sealed's own decoder in a worker. The report says which.
 */
import { BENCHMARK_SIZES, DEFAULT_QR_STREAM, QR_HOLDS, QR_PROFILES, describeQrStream, formatBenchmarkReport, isDefaultQrStream, qrStreamSetting, prepareBenchmarkStream, type BenchmarkReport, type BenchmarkStream, type Tier } from "@sealed/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { FacetStream } from "../components/FacetStream";
import { Notice, PageTitle, Progress, errorMessage } from "../components/ui";
import { formatBytes } from "../lib/bytes";
import { session, useSession } from "../lib/session";
import { CameraError, feedFrames, lockCameraSettings, openCamera, qrDetector, setTorch, stopStream, torchSupported, watchQrCodes } from "../lib/camera";
import { TorchWatcher } from "../components/TorchWatcher";
import { TorchPlayer, type TorchMessage } from "@sealed/core";
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
  const s = useSession();
  const saved = qrStreamSetting(s.settings.qrStream);
  const [size, setSize] = useState<number>(BENCHMARK_SIZES[1]);
  const [tier, setTier] = useState<Tier>(0);
  const [qrSize, setQrSize] = useState<number>(saved.symbolSize);
  const [codes, setCodes] = useState<number>(saved.codesPerScreen);
  const [hold, setHold] = useState<number>(saved.holdRefreshes60);
  const [stream, setStream] = useState<BenchmarkStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = qrStreamSetting({ symbolSize: qrSize, codesPerScreen: codes, holdRefreshes60: hold });
  const isSaved = chosen.symbolSize === saved.symbolSize && chosen.codesPerScreen === saved.codesPerScreen && chosen.holdRefreshes60 === saved.holdRefreshes60;

  if (stream) {
    const profile = stream.tier === 0 ? `QR ${stream.qr.symbolSize} B × ${codes} at ${60 / stream.qr.holdRefreshes60}/s` : `T${stream.tier}`;
    return (
      <div className="stack">
        <FacetStream sender={stream.sender} codesPerScreen={stream.tier === 0 ? codes : 1} caption={`bench ${profile} · ${formatBytes(stream.size)}`} onStop={() => setStream(null)} />
        <TorchReadout />
      </div>
    );
  }

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
      {tier === 0 ? (
        <>
          <label className="field">
            QR size
            <select value={qrSize} onChange={(e) => setQrSize(Number(e.target.value))} data-testid="bench-qr-size">
              {QR_PROFILES.map((p) => (
                <option key={p.symbolSize} value={p.symbolSize}>
                  Version {p.qrVersion} — {p.symbolSize} bytes per code
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Codes on screen
            <select value={codes} onChange={(e) => setCodes(Number(e.target.value))} data-testid="bench-codes">
              {[1, 2, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Frames per second (60 Hz screen)
            <select value={hold} onChange={(e) => setHold(Number(e.target.value))} data-testid="bench-fps">
              {QR_HOLDS.map((h) => (
                <option key={h} value={h}>
                  {60 / h} per second
                </option>
              ))}
            </select>
          </label>
          <p className="subtle">Sends at most {((qrSize * codes * (60 / hold)) / 1024).toFixed(0)} KB/s; the filming device shows how much it actually reads.</p>
          <p className="subtle" data-testid="bench-saved">
            Your offline transfers use {describeQrStream(saved)}
            {isDefaultQrStream(saved) ? " (the default)" : ""}.
          </p>
        </>
      ) : (
        <Notice>Grid streams are decoded in JavaScript on the filming side, a frame or two per second at best.</Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <button
        type="button"
        className="btn primary block"
        disabled={busy}
        data-testid="bench-show"
        onClick={() => {
          setBusy(true);
          setError(null);
          prepareBenchmarkStream({ size, tier, ...(tier === 0 ? { qr: { symbolSize: qrSize, holdRefreshes60: hold } } : {}) })
            .then(setStream)
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Preparing…" : "Show test stream"}
      </button>
      {tier === 0 && <UseForTransfers chosen={chosen} isSaved={isSaved} />}
    </div>
  );
}

/** Front-camera view of the other device's torch: brightness, gate state and decoded messages (ADR-0022). */
function TorchReadout() {
  const [sample, setSample] = useState<{ brightness: number; on: boolean } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card stack" data-testid="torch-readout">
      <TorchWatcher onMessage={(m: TorchMessage) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 6))} onSample={(brightness, on) => setSample({ brightness, on })} onError={setError} />
      <p className="subtle" style={{ margin: 0 }}>
        Back-channel (front camera watching their torch)
      </p>
      <pre className="mono" style={{ margin: 0, fontSize: 12 }}>
        {sample ? `brightness ${sample.brightness.toFixed(0)} · torch ${sample.on ? "ON" : "off"}` : "no frames yet"}
        {log.map((l) => `\n${l}`).join("")}
      </pre>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/**
 * Saves the shown setting for this device's offline sends. The sender decides how codes are drawn, so the choice
 * lives on the showing side: once the other device reports "verified" at a good speed, keep it.
 */
function UseForTransfers({ chosen, isSaved }: { chosen: ReturnType<typeof qrStreamSetting>; isSaved: boolean }) {
  if (isSaved) {
    return (
      <p className="subtle" data-testid="bench-use-saved">
        Your offline transfers already use this setting.{" "}
        {!isDefaultQrStream(chosen) && (
          <button type="button" className="btn small ghost" onClick={() => void session.updateSettings({ qrStream: { ...DEFAULT_QR_STREAM } })}>
            Back to default
          </button>
        )}
      </p>
    );
  }
  return (
    <div className="card stack">
      <p style={{ margin: 0 }}>After a test: if the other device reached “verified” quickly, keep this setting for when this device sends offline.</p>
      <button type="button" className="btn block" data-testid="bench-use" onClick={() => void session.updateSettings({ qrStream: chosen })}>
        Use {describeQrStream(chosen)} for my offline transfers
      </button>
    </div>
  );
}

function FilmStream() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [reader, setReader] = useState<"detector" | "frames" | null>(null);
  const [camera, setCamera] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [torchOk, setTorchOk] = useState<boolean | null>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const player = useMemo(() => new TorchPlayer((on) => void (track.current && setTorch(track.current, on))), []);
  useEffect(() => () => player.stop(), [player]);

  useEffect(() => {
    if (!running) return;
    const worker = new Worker(new URL("../workers/bench.worker.ts", import.meta.url), { type: "module" });
    let stream: MediaStream | null = null;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let lockedOnce = false;
    worker.onmessage = (ev: MessageEvent<FromBenchWorker>) => {
      setReport(ev.data.report);
      // Aimed: lock focus, exposure and white balance on the screen (ADR-0021).
      if (!lockedOnce && ev.data.report.validFrames > 0 && stream) {
        lockedOnce = true;
        const track = stream.getVideoTracks()[0];
        if (track) void lockCameraSettings(track).then((l) => setCamera((c) => `${c} · locked ${l.join(", ") || "nothing"}`));
      }
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
        track.current = stream.getVideoTracks()[0] ?? null;
        setTorchOk(track.current ? torchSupported(track.current) : false);
        const fps = stream.getVideoTracks()[0]?.getSettings().frameRate;
        setCamera(fps ? `camera ${Math.round(fps)} fps (reads cleanly up to ${Math.floor(fps / 2)} frames/s)` : "camera fps unknown");
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
      track.current = null;
      stopStream(stream);
      // Let the last report arrive before the worker goes away.
      worker.postMessage({ type: "stop" } satisfies ToBenchWorker);
      setTimeout(() => worker.terminate(), 1500);
    };
  }, [running]);

  const full = report ? { ...report, device: `${navigator.userAgent}${reader ? ` · ${reader === "detector" ? "BarcodeDetector" : "JS decoder"}` : ""}${camera ? ` · ${camera}` : ""}` } : null;
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
      {running && torchOk !== null && (
        <div className="stack">
          <p className="subtle">{torchOk ? "Flash the torch at the showing device (its screen should say what it read):" : "This browser cannot switch the torch, so it cannot signal the sender."}</p>
          {torchOk && (
            <div className="row">
              <button type="button" className="btn small" onClick={() => player.play("slower")}>
                Slower
              </button>
              <button type="button" className="btn small" onClick={() => player.play("faster")}>
                Faster
              </button>
              <button type="button" className="btn small" onClick={() => player.play("done")}>
                Done
              </button>
            </div>
          )}
        </div>
      )}
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
