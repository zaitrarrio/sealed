/**
 * Full-frame camera that hands raw camera frames to JavaScript as RGBA or raw native buffers (for the
 * colour-grid tiers, which the platform QR detector cannot read).
 *
 * Like CodeCamera (ADR-0021), this session configures fast frames (60 fps target) without stabilisation or HDR,
 * applies immediate exposure bias to cut through bright display glare, and locks focus, exposure (1/500 s),
 * and white balance on the other screen once aimed or tapped.
 */
import type { RgbaImage } from "@sealed/core";
import { color, radius } from "@sealed/tokens";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, type CameraRef, type Frame } from "react-native-vision-camera";
import { createSynchronizable, scheduleOnRN } from "react-native-worklets";
import { useAppActive } from "../lib/app-state";
import { applyScreenBias, lockOnScreen, unlock, SCREEN_READER_CONSTRAINTS, type LockResult } from "../lib/camera-lock";
import { isSupportedFormat, toRgba, type RawPixelFormat } from "../lib/frame-convert";
import { Button, Notice, P, Row } from "../ui/kit";
import { CameraOverlay, type StreamInfo } from "./camera-overlay";

// Stable references: VisionCamera rebuilds the frame output (and its worklet runtime) when these change.
const TARGET_RESOLUTION = { width: 1920, height: 1080 } as const;
const NOOP = () => undefined;
/** With no frame for this long, the lock is released so auto focus can search again. */
const QUIET_MS = 2500;

export interface RawFrame {
  data: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
  format: RawPixelFormat;
}

export interface PixelCameraProps {
  /** Receives each processed frame; the next frame is taken only after the returned promise settles. */
  onImage: (image: RgbaImage, at: number) => Promise<void>;
  /** When set, frames are delivered raw (no RGBA conversion in JavaScript) and `onImage` is not called. */
  onRaw?: (frame: RawFrame, at: number) => Promise<void>;
  active?: boolean;
  label?: string;
  overlay?: ReactNode;
  onError?: (message: string) => void;
  onLock?: (result: LockResult | null) => void;
  onCameraFps?: (fps: number | null) => void;
  /** Whether the stream/transmission is locked, to update the reticle and viewfinder badge. */
  isLocked?: boolean;
  streamInfo?: StreamInfo;
}

export function PixelCamera({
  onImage,
  onRaw,
  active = true,
  label = "Camera view of the other screen",
  overlay,
  onError,
  onLock,
  onCameraFps,
  isLocked = false,
  streamInfo,
}: PixelCameraProps) {
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [formatError, setFormatError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [currentLock, setCurrentLock] = useState<LockResult | null>(null);
  const [tapPoint, setTapPoint] = useState<{ x: number; y: number } | null>(null);

  const busy = useMemo(() => createSynchronizable(false), []);
  const cb = useRef({ onImage, onRaw, onError });
  cb.current = { onImage, onRaw, onError };
  const lockCb = useRef(onLock);
  lockCb.current = onLock;
  const fpsCb = useRef(onCameraFps);
  fpsCb.current = onCameraFps;

  const camera = useRef<CameraRef>(null);
  const view = useRef({ width: 0, height: 0 });
  const lockState = useRef<"idle" | "locking" | "locked">("idle");
  const lastActiveAt = useRef(0);

  useEffect(() => () => busy.setBlocking(true), [busy]);

  const release = useCallback(() => {
    if (lockState.current === "idle") return;
    lockState.current = "idle";
    setCurrentLock(null);
    lockCb.current?.(null);
    if (camera.current) void unlock(camera.current);
  }, []);

  const aimAt = useCallback((point: { x: number; y: number }) => {
    if (!camera.current) return;
    lockState.current = "locking";
    void lockOnScreen(camera.current, point, Platform.OS).then(
      (r) => {
        lockState.current = "locked";
        setCurrentLock(r);
        lockCb.current?.(r);
      },
      () => {
        lockState.current = "idle";
        setCurrentLock(null);
      },
    );
  }, []);

  const deliverRef = useRef((buffer: ArrayBuffer, width: number, height: number, bytesPerRow: number, format: string, timestamp: number) => {
    void (async () => {
      try {
        if (!isSupportedFormat(format)) {
          setFormatError(`This camera delivered ${format} frames, which Sealed cannot decode.`);
          return;
        }
        if (cb.current.onRaw) await cb.current.onRaw({ data: new Uint8Array(buffer), width, height, bytesPerRow, format }, timestamp);
        else await cb.current.onImage(toRgba(new Uint8Array(buffer), width, height, bytesPerRow, format), timestamp);
        lastActiveAt.current = performance.now();
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

  // Release lock on quiet spell
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (lockState.current === "locked" && performance.now() - lastActiveAt.current > QUIET_MS) release();
    }, 500);
    return () => clearInterval(t);
  }, [active, release]);

  // When isLocked becomes true from valid frames, ensure camera optical lock is engaged
  useEffect(() => {
    if (isLocked && lockState.current === "idle" && camera.current) {
      const { width, height } = view.current;
      aimAt(width > 0 && height > 0 ? { x: width / 2, y: height / 2 } : { x: 180, y: 240 });
    }
  }, [isLocked, aimAt]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    view.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
  }, []);

  const handleTap = useCallback((e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    setTapPoint({ x: locationX, y: locationY });
    aimAt({ x: locationX, y: locationY });
  }, [aimAt]);

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

  const transmissionLocked = Boolean(isLocked || (currentLock && currentLock.locked.length > 0));

  return (
    <View style={{ gap: 8 }}>
      <Pressable style={styles.frame} accessibilityLabel={label} onLayout={onLayout} onPress={handleTap}>
        <Camera
          ref={camera}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={active && focused && appActive}
          outputs={outputs}
          constraints={SCREEN_READER_CONSTRAINTS}
          resizeMode="cover"
          onSessionConfigSelected={(c) => {
            fpsCb.current?.(c.selectedFPS ?? null);
            if (camera.current) void applyScreenBias(camera.current, Platform.OS);
          }}
          onSubjectAreaChanged={release}
          onStopped={release}
          onError={(e) => {
            setCameraError(e.message);
            cb.current.onError?.(e.message);
          }}
        />
        <CameraOverlay
          isLocked={transmissionLocked}
          streamInfo={{
            ...streamInfo,
            exposure: currentLock?.exposure ? `1/${Math.round(1 / currentLock.exposure.durationS)}s` : undefined,
          }}
          tapPoint={tapPoint}
        >
          {overlay}
        </CameraOverlay>
      </Pressable>
      {formatError ? <Notice tone="danger">{formatError}</Notice> : null}
      {cameraError ? <Notice tone="danger">{cameraError}</Notice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: color.bgSunken,
    position: "relative",
  },
});
