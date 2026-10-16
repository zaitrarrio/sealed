/**
 * Camera capture for Facet streams (spec §7.6, ADR-0010), two ways:
 *
 *   codes   (default) the platform QR detector reads each T0 frame and hands its text to FacetDecodeSession.
 *           Nothing is decoded in JavaScript, the code can be anywhere in view at any angle, and the detector
 *           keeps up with the sender's frame rate. This is what every offline transfer uses.
 *   pixels  raw camera frames go to the JavaScript decoder (colour-grid tiers T1–T3; ~0.5 s per frame).
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { RgbaImage } from "@sealed/core";
import { FacetDecodeSession, type DecodeProgress, type DecodeResult, type DecodeSessionOptions } from "../lib/facet-decode";
import { CodeCamera } from "./CodeCamera";
import { PixelCamera } from "./PixelCamera";

interface CaptureProps {
  options: DecodeSessionOptions;
  onProgress: (p: DecodeProgress) => void;
  onComplete: (r: DecodeResult) => void;
  onError: (message: string) => void;
  /** Shown over the camera view. */
  overlay?: ReactNode;
  /** Torch on/off for the back-channel (codes path only). */
  torch?: boolean;
  /** Keep the camera running after completion, while the torch signals "done". */
  keepAlive?: boolean;
}

type Push = (session: FacetDecodeSession) => Promise<{ update: DecodeProgress; result?: DecodeResult }>;

/** Shared bookkeeping: ordered decoding, throttled progress, completion. */
function useDecoder(options: DecodeSessionOptions, onProgress: CaptureProps["onProgress"], onComplete: CaptureProps["onComplete"], onError: CaptureProps["onError"]) {
  const session = useMemo(() => new FacetDecodeSession(options), [options]);
  const [done, setDone] = useState(false);
  const cbs = useRef({ onProgress, onComplete, onError });
  cbs.current = { onProgress, onComplete, onError };
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastPost = useRef(0);

  const feed = useCallback(
    (push: Push): Promise<void> => {
      // Decoding is async (manifest unwrap, final open); keep inputs in order.
      const run = queue.current.then(async () => {
        if (session.finished) return;
        try {
          const { update, result } = await push(session);
          const now = Date.now();
          if (result || now - lastPost.current > 150) {
            lastPost.current = now;
            cbs.current.onProgress(update);
          }
          if (result) {
            setDone(true);
            cbs.current.onComplete(result);
          }
        } catch (e) {
          if (session.finished) {
            setDone(true);
            cbs.current.onError(e instanceof Error ? e.message : String(e));
          }
        }
      });
      queue.current = run;
      return run;
    },
    [session],
  );
  const reportError = useCallback((m: string) => cbs.current.onError(m), []);
  return { feed, done, reportError };
}

export function OpticalCapture({ decode = "codes", ...props }: CaptureProps & { decode?: "codes" | "pixels" }) {
  return decode === "codes" ? <CodeCapture {...props} /> : <PixelCapture {...props} />;
}

function CodeCapture({ options, onProgress, onComplete, onError, overlay, torch = false, keepAlive = false }: CaptureProps) {
  const { feed, done, reportError } = useDecoder(options, onProgress, onComplete, onError);
  const onCode = useCallback((text: string, at: number) => void feed((s) => s.pushCode(text, at)), [feed]);
  return <CodeCamera onCode={onCode} active={!done || keepAlive} torch={torch} onError={reportError} {...(overlay ? { overlay } : {})} />;
}

function PixelCapture({ options, onProgress, onComplete, onError, overlay }: CaptureProps) {
  const { feed, done, reportError } = useDecoder(options, onProgress, onComplete, onError);
  const onImage = useCallback((image: RgbaImage, at: number) => feed((s) => s.push(image, at)), [feed]);
  return <PixelCamera onImage={onImage} active={!done} onError={reportError} {...(overlay ? { overlay } : {})} />;
}
