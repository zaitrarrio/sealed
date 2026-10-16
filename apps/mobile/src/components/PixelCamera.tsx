/**
 * Full-frame camera that hands raw camera frames to JavaScript as RGBA (for the colour-grid tiers, which the
 * platform QR detector cannot read). VisionCamera delivers 8-bit RGB frames to a frame-processor worklet; the
 * worklet copies the pixel buffer and schedules `onImage` on the JS thread. While `onImage` runs, the worklet
 * drops new frames (a cross-runtime `busy` flag), so the consumer always works on the freshest capture.
 *
 * Slow by nature (the JavaScript decoder takes ~0.5 s per frame on a phone); offline transfers use CodeCamera.
 */
import type { RgbaImage } from "@sealed/core";
import { color, radius } from "@sealed/tokens";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, type Frame } from "react-native-vision-camera";
import { createSynchronizable, scheduleOnRN } from "react-native-worklets";
import { useAppActive } from "../lib/app-state";
import { SCREEN_READER_CONSTRAINTS } from "../lib/camera-lock";
import { isSupportedFormat, toRgba } from "../lib/frame-convert";
import { Button, Notice, P, Row } from "../ui/kit";

// Stable references: VisionCamera rebuilds the frame output (and its worklet runtime) when these change.
const TARGET_RESOLUTION = { width: 1920, height: 1080 } as const;
const NOOP = () => undefined;

export interface PixelCameraProps {
  /** Receives each processed frame; the next frame is taken only after the returned promise settles. */
  onImage: (image: RgbaImage, at: number) => Promise<void>;
  active?: boolean;
  label?: string;
  overlay?: ReactNode;
  onError?: (message: string) => void;
}

export function PixelCamera({ onImage, active = true, label = "Camera view of the other screen", overlay, onError }: PixelCameraProps) {
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [formatError, setFormatError] = useState<string | null>(null);
  const busy = useMemo(() => createSynchronizable(false), []);
  const cb = useRef({ onImage, onError });
  cb.current = { onImage, onError };

  useEffect(() => () => busy.setBlocking(true), [busy]);

  const deliverRef = useRef((buffer: ArrayBuffer, width: number, height: number, bytesPerRow: number, format: string, timestamp: number) => {
    void (async () => {
      try {
        if (!isSupportedFormat(format)) {
          setFormatError(`This camera delivered ${format} frames, which Sealed cannot decode.`);
          return;
        }
        await cb.current.onImage(toRgba(new Uint8Array(buffer), width, height, bytesPerRow, format), timestamp);
      } catch (e) {
        cb.current.onError?.(e instanceof Error ? e.message : String(e));
      } finally {
        busy.setBlocking(false);
      }
    })();
  });
  const deliver = useCallback(
    (buffer: ArrayBuffer, width: number, height: number, bytesPerRow: number, format: string, timestamp: number) => deliverRef.current(buffer, width, height, bytesPerRow, format, timestamp),
    [],
  );

  const onFrame = useCallback(
    (frame: Frame) => {
      "worklet";
      try {
        if (busy.getDirty()) return;
        if (frame.isPlanar || !frame.hasPixelBuffer) return;
        busy.setBlocking(true);
        // Copy out of the camera's buffer: the frame is recycled once disposed.
        const copy = frame.getPixelBuffer().slice(0);
        scheduleOnRN(deliver, copy, frame.width, frame.height, frame.bytesPerRow, String(frame.pixelFormat), frame.timestamp);
      } finally {
        frame.dispose();
      }
    },
    [busy, deliver],
  );

  const output = useFrameOutput({
    pixelFormat: "rgb",
    targetResolution: TARGET_RESOLUTION,
    dropFramesWhileBusy: true,
    onFrame,
    // Drops while a frame is being processed are expected; do not log each one.
    onFrameDropped: NOOP,
  });
  const outputs = useMemo(() => [output], [output]);

  if (!hasPermission) {
    return (
      <Notice>
        <View style={{ gap: 8 }}>
          <P>Sealed uses the camera to read the other screen. Nothing is recorded or uploaded.</P>
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
      <View style={styles.frame} accessibilityLabel={label}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={active && focused && appActive}
          outputs={outputs}
          constraints={SCREEN_READER_CONSTRAINTS}
          onError={(e) => cb.current.onError?.(e.message)}
        />
        {overlay ? (
          <View style={styles.overlay} pointerEvents="none">
            {overlay}
          </View>
        ) : null}
      </View>
      {formatError ? <Notice tone="danger">{formatError}</Notice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: "100%", aspectRatio: 3 / 4, borderRadius: radius.lg, overflow: "hidden", backgroundColor: color.bgSunken },
  overlay: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 12, backgroundColor: "rgba(11,9,8,0.72)" },
});
