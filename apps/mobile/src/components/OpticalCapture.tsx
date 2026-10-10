/**
 * Camera capture for Facet streams (spec §7.6, ADR-0010). VisionCamera delivers raw 8-bit RGB frames (never
 * encoded video) to a frame-processor worklet; the worklet copies the pixel buffer and hands it to the JS
 * thread, where FacetDecodeSession decodes it. While a frame is being decoded the worklet drops new frames
 * (a cross-runtime `busy` flag), so the decoder always works on the freshest capture and RaptorQ repair
 * symbols make up for the dropped ones.
 */
import type { RgbaImage } from "@sealed/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, type Frame } from "react-native-vision-camera";
import { createSynchronizable, scheduleOnRN } from "react-native-worklets";
import { useIsFocused } from "expo-router";
import { useAppActive } from "../lib/app-state";
import { FacetDecodeSession, type DecodeProgress, type DecodeResult, type DecodeSessionOptions } from "../lib/facet-decode";
import { isSupportedFormat, toRgba } from "../lib/frame-convert";
import { Button, Notice, P, Row } from "../ui/kit";
import { scannerStyles } from "./Scanner";

// Stable references: VisionCamera rebuilds the frame output (and its worklet runtime) when these change.
const TARGET_RESOLUTION = { width: 1920, height: 1080 } as const;
const CONSTRAINTS = [{ fps: 60 }];
const NOOP = () => undefined;

export function OpticalCapture({
  options,
  onProgress,
  onComplete,
  onError,
}: {
  options: DecodeSessionOptions;
  onProgress: (p: DecodeProgress) => void;
  onComplete: (r: DecodeResult) => void;
  onError: (message: string) => void;
}) {
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [done, setDone] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const session = useMemo(() => new FacetDecodeSession(options), [options]);
  const busy = useMemo(() => createSynchronizable(false), []);
  const cbs = useRef({ onProgress, onComplete, onError });
  cbs.current = { onProgress, onComplete, onError };
  const lastPost = useRef(0);

  useEffect(() => () => busy.setBlocking(true), [busy]);

  const decodeImpl = (buffer: ArrayBuffer, width: number, height: number, bytesPerRow: number, format: string, timestamp: number): void => {
    void (async () => {
      try {
        if (session.finished) return;
        if (!isSupportedFormat(format)) {
          setFormatError(`This camera delivered ${format} frames, which Sealed cannot decode.`);
          return;
        }
        const image: RgbaImage = toRgba(new Uint8Array(buffer), width, height, bytesPerRow, format);
        const { update, result } = await session.push(image, timestamp);
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
      } finally {
        if (!session.finished) busy.setBlocking(false);
      }
    })();
  };

  const decodeRef = useRef(decodeImpl);
  decodeRef.current = decodeImpl;
  const decode = useCallback((buffer: ArrayBuffer, width: number, height: number, bytesPerRow: number, format: string, timestamp: number) => decodeRef.current(buffer, width, height, bytesPerRow, format, timestamp), []);

  const onFrame = useCallback(
    (frame: Frame) => {
      "worklet";
      try {
        if (busy.getDirty()) return;
        if (frame.isPlanar || !frame.hasPixelBuffer) return;
        busy.setBlocking(true);
        // Copy out of the camera's buffer: the frame is recycled once disposed.
        const copy = frame.getPixelBuffer().slice(0);
        scheduleOnRN(decode, copy, frame.width, frame.height, frame.bytesPerRow, String(frame.pixelFormat), frame.timestamp);
      } finally {
        frame.dispose();
      }
    },
    [busy, decode],
  );

  const output = useFrameOutput({
    pixelFormat: "rgb",
    targetResolution: TARGET_RESOLUTION,
    dropFramesWhileBusy: true,
    onFrame,
    // Drops while a decode is running are expected (RaptorQ covers them); do not log each one.
    onFrameDropped: NOOP,
  });

  const outputs = useMemo(() => [output], [output]);

  if (!hasPermission) {
    return (
      <Notice>
        <View style={{ gap: 8 }}>
          <P>Receiving offline uses the camera to read the sender's screen. Nothing is recorded.</P>
          <Row>
            <Button title="Allow camera" tone="primary" onPress={() => void requestPermission()} />
          </Row>
        </View>
      </Notice>
    );
  }
  if (!device) return <Notice tone="danger">No camera is available on this device.</Notice>;

  return (
    <View style={{ gap: 8 }}>
      <View style={scannerStyles.frame} accessibilityLabel="Camera view of the sender's screen">
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={focused && appActive && !done}
          outputs={outputs}
          constraints={CONSTRAINTS}
          onError={(e) => cbs.current.onError(e.message)}
        />
        <View style={scannerStyles.reticle} pointerEvents="none" />
      </View>
      {formatError ? <Notice tone="danger">{formatError}</Notice> : null}
    </View>
  );
}
