/**
 * Camera QR scanner with a paste fallback. Calls `onCode` with each decoded text; the parent decides whether it
 * is the code it wanted (returning an error string keeps scanning and shows the message).
 */
import { useEffect, useRef, useState } from "react";
import { CameraError, cameraAvailable, continuousFocus, openCamera, scanQr, stopStream } from "../lib/camera";

export interface ScannerProps {
  /** Return null to accept (scanning stops), or a message to keep scanning. */
  onCode: (text: string) => string | null | Promise<string | null>;
  label?: string;
  pasteLabel?: string;
  autoStart?: boolean;
}

export function Scanner({ onCode, label = "Point the camera at the code", pasteLabel = "Or paste a code or link", autoStart = true }: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const handling = useRef(false);
  const lastText = useRef<string>("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  const handle = async (text: string, fromCamera: boolean): Promise<boolean> => {
    if (handling.current) return false;
    if (fromCamera && text === lastText.current) return false;
    lastText.current = text;
    handling.current = true;
    setBusy(true);
    try {
      const err = await onCodeRef.current(text);
      setMessage(err);
      return err === null;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      handling.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let stopScan: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        stream = await openCamera({ width: 1280, height: 720 });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const track = stream.getVideoTracks()[0];
        if (track) await continuousFocus(track);
        stopScan = scanQr(video, (text) => {
          void handle(text, true).then((accepted) => {
            if (accepted) setActive(false);
          });
        });
      } catch (e) {
        setError(e instanceof CameraError ? e.message : "The camera could not start.");
        setActive(false);
      }
    })();
    return () => {
      cancelled = true;
      stopScan?.();
      stopStream(stream);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (autoStart && cameraAvailable()) setActive(true);
  }, [autoStart]);

  return (
    <div className="stack">
      {active ? (
        <div className="scanner">
          <video ref={videoRef} playsInline muted aria-label={label} />
          <div className="reticle" aria-hidden="true" />
        </div>
      ) : (
        <div className="card sunken stack">
          <p className="muted">{error ?? "The camera is off."}</p>
          {cameraAvailable() && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError(null);
                setActive(true);
              }}
            >
              Start camera
            </button>
          )}
        </div>
      )}
      {active && <p className="subtle">{label}</p>}
      {busy && <p className="subtle">Checking code…</p>}
      {message && (
        <div className="notice danger" role="alert">
          {message}
        </div>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const text = paste.trim();
          if (!text) return;
          void handle(text, false).then((ok) => {
            if (ok) {
              setPaste("");
              setActive(false);
            }
          });
        }}
      >
        <label className="field">
          {pasteLabel}
          <input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="https://…" data-testid="paste-code" />
        </label>
        <button type="submit" className="btn" disabled={!paste.trim() || busy}>
          Use this code
        </button>
      </form>
    </div>
  );
}
