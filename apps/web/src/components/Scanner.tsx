/**
 * Camera QR scanner with a paste fallback. Calls `onCode` with each decoded text; the parent decides whether it
 * is the code it wanted (returning an error string keeps scanning and shows the message).
 *
 * A well-formed Sealed code made by another client origin this browser does not trust yet (for example a phone
 * app whose codes name https://sealed.to while this client runs on a development server) is not rejected
 * outright: the scanner names the origin and asks the user to trust it. Trusted origins live in Settings.
 */
import { useEffect, useRef, useState } from "react";
import { UnknownOriginError, parseCode } from "@sealed/core";
import { CameraError, cameraAvailable, continuousFocus, openCamera, scanQr, stopStream } from "../lib/camera";
import { acceptedOrigins } from "../lib/config";
import { session } from "../lib/session";

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
  const [trustAsk, setTrustAsk] = useState<{ text: string; origin: string } | null>(null);
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
      try {
        parseCode(text, acceptedOrigins());
      } catch (e) {
        if (e instanceof UnknownOriginError) {
          setMessage(null);
          setTrustAsk({ text, origin: e.origin });
          return false;
        }
        // Anything else is the screen's to explain.
      }
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
      {trustAsk && (
        <div className="card stack" role="alertdialog" aria-labelledby="trust-origin-title">
          <p id="trust-origin-title" style={{ margin: 0 }}>
            This code was made by <strong className="mono">{trustAsk.origin}</strong>, which this browser has not been set up to trust.
          </p>
          <p className="subtle" style={{ margin: 0 }}>
            Trust it only if you know it is a Sealed client you use (for example the Sealed phone app, or your organization's deployment). You can remove it later in Settings.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              data-testid="trust-origin"
              onClick={() => {
                const ask = trustAsk;
                setTrustAsk(null);
                void session
                  .trustOrigin(ask.origin)
                  .then(() => {
                    lastText.current = "";
                    return handle(ask.text, false);
                  })
                  .then((ok) => {
                    if (ok) {
                      setPaste("");
                      setActive(false);
                    }
                  })
                  .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
              }}
            >
              Trust and continue
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setTrustAsk(null);
                lastText.current = "";
              }}
            >
              Cancel
            </button>
          </div>
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
