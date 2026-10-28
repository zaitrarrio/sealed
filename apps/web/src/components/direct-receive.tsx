/**
 * One-button receive with no relay and no code. The camera reads a Send on the other screen;
 * the files appear here when the stream completes.
 */
import { useEffect, useState } from "react";
import { OpticalCapture, type CaptureUpdate } from "./OpticalCapture";
import { ReceivedFiles } from "./ReceivedFiles";
import { Notice, Progress } from "./ui";
import { memoryFiles, type ReceivedFile } from "../lib/received";

export function DirectReceive({ autoStart }: { autoStart: boolean }) {
  const [capturing, setCapturing] = useState(autoStart);
  const [attempt, setAttempt] = useState(0);
  const [update, setUpdate] = useState<CaptureUpdate | null>(null);
  const [batches, setBatches] = useState<ReceivedFile[][]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (autoStart) setCapturing(true);
  }, [autoStart]);

  const fraction = update?.progress.fraction ?? 0;

  return (
    <div className="stack" data-testid="direct-receive">
      {batches.map((files, i) => (
        <div key={i} className="card stack" data-testid="direct-received">
          <strong>Received</strong>
          <ReceivedFiles files={files} />
        </div>
      ))}
      {capturing ? (
        <>
          <OpticalCapture
            key={attempt}
            init={{ type: "init", mode: "broadcast", tiers: [0] }}
            onProgress={setUpdate}
            onComplete={(r) => {
              setBatches((prev) => [
                memoryFiles(
                  r.files.map((f) => ({
                    entry: { path: f.path, size: f.size, mediaType: f.mediaType, sha256: new Uint8Array(32), ...(f.mtime !== undefined ? { mtime: f.mtime } : {}) },
                    data: f.data,
                  })),
                ),
                ...prev,
              ]);
              setCapturing(false);
              setUpdate(null);
            }}
            onError={setError}
          />
          <Progress fraction={fraction} label={fraction > 0 ? "Reading the screen" : "Point the camera at their screen"} />
          <button type="button" className="btn ghost" onClick={() => setCapturing(false)}>
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn primary"
          data-testid="direct-listen"
          onClick={() => {
            setError(null);
            setUpdate(null);
            setAttempt((n) => n + 1);
            setCapturing(true);
          }}
        >
          {batches.length > 0 ? "Receive another" : "Receive"}
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {!capturing && batches.length === 0 && <p className="subtle">Tap Receive and point the camera at their screen. The file shows up here. Nothing is uploaded.</p>}
    </div>
  );
}
