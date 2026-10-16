/**
 * Full-frame camera that reads a stream of QR codes with the platform's own detector (AVFoundation on iOS,
 * ML Kit / CameraX on Android, through VisionCamera's object output). The detector finds codes anywhere in the
 * picture, at any rotation and moderate tilt, so nothing has to be lined up: point the phone at the other
 * screen and keep it in view.
 *
 * Each distinct code is reported once while it stays on screen (the detector repeats every visible code on every
 * camera frame, and several codes may be in view at once); a code is reported again only after it has dropped
 * out of the recent set, which RaptorQ treats as a duplicate.
 *
 * The session asks for 60 camera frames a second without stabilisation or HDR, and once the first code is read
 * it locks focus, exposure and white balance on the other screen (ADR-0021). The lock is released when the scene
 * changes or no code has been seen for a while, so the camera can find the screen again.
 */
import { color, radius } from "@sealed/tokens";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useObjectOutput, type CameraRef, type ScannedCode, type ScannedObject, type ScannedObjectType } from "react-native-vision-camera";
import { useAppActive } from "../lib/app-state";
import { SCREEN_READER_CONSTRAINTS, lockOnScreen, unlock, type LockResult } from "../lib/camera-lock";
import { Button, Notice, P, Row } from "../ui/kit";

const QR_TYPES: ScannedObjectType[] = ["qr"];
/** Codes remembered for de-duplication: enough for 4 codes per screen across a few frames. */
const RECENT = 16;
/** With no code for this long, the lock is released so auto focus can find the screen again. */
const QUIET_MS = 2500;

export interface CodeCameraProps {
  /** Called once per newly visible code, with a monotonic timestamp in ms. */
  onCode: (value: string, at: number) => void;
  /** Camera runs only while true (and the screen is focused and the app in the foreground). */
  active?: boolean;
  /** Spoken description of the camera view. */
  label?: string;
  /** Drawn over the camera (status, counters). */
  overlay?: ReactNode;
  onError?: (message: string) => void;
  /** Reports what the camera managed to lock once aimed (shown in the benchmark). */
  onLock?: (result: LockResult | null) => void;
  /** Reports the camera frame rate the session actually got (the sender's frame rate should stay below half of it). */
  onCameraFps?: (fps: number | null) => void;
  /** Torch on/off: the back-channel to the sender's front camera (ADR-0022). */
  torch?: boolean;
}

export function CodeCamera({ onCode, active = true, label = "Camera view of the other screen", overlay, onError, onLock, onCameraFps, torch = false }: CodeCameraProps) {
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [cameraError, setCameraError] = useState<string | null>(null);
  const recent = useRef<string[]>([]);
  const cb = useRef(onCode);
  cb.current = onCode;
  const lockCb = useRef(onLock);
  lockCb.current = onLock;
  const fpsCb = useRef(onCameraFps);
  fpsCb.current = onCameraFps;
  const camera = useRef<CameraRef>(null);
  const view = useRef({ width: 0, height: 0 });
  /** "idle" → first code → "locking" → "locked"; back to "idle" on a quiet spell or a scene change. */
  const lock = useRef<"idle" | "locking" | "locked">("idle");
  const lastCodeAt = useRef(0);

  const release = useCallback(() => {
    if (lock.current === "idle") return;
    lock.current = "idle";
    lockCb.current?.(null);
    if (camera.current) void unlock(camera.current);
  }, []);

  const aimAt = useCallback((code: ScannedCode) => {
    if (lock.current !== "idle" || !camera.current) return;
    lock.current = "locking";
    const { width, height } = view.current;
    // The detector's box is in the camera frame; the preview fills the view with the same aspect, so the centre
    // maps through proportionally. Fall back to the view centre when there is no layout yet.
    const b = code.boundingBox;
    const point = width > 0 && height > 0 && b.width > 0 ? { x: (b.x + b.width / 2) * width, y: (b.y + b.height / 2) * height } : { x: width / 2, y: height / 2 };
    void lockOnScreen(camera.current, point, Platform.OS).then(
      (r) => {
        if (lock.current === "locking") {
          lock.current = "locked";
          lockCb.current?.(r);
        }
      },
      () => {
        lock.current = "idle";
      },
    );
  }, []);

  const output = useObjectOutput({
    types: QR_TYPES,
    onObjectsScanned: (objects: ScannedObject[]) => {
      const at = performance.now();
      let first: ScannedCode | null = null;
      for (const o of objects) {
        const value = (o as { value?: string }).value;
        if (!value) continue;
        lastCodeAt.current = at;
        first ??= o as ScannedCode;
        if (recent.current.includes(value)) continue;
        recent.current.push(value);
        if (recent.current.length > RECENT) recent.current.shift();
        cb.current(value, at);
      }
      if (first) aimAt(first);
    },
  });
  const outputs = useMemo(() => [output], [output]);

  // Release the lock after a quiet spell so a moved camera can refocus.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (lock.current === "locked" && performance.now() - lastCodeAt.current > QUIET_MS) release();
    }, 500);
    return () => clearInterval(t);
  }, [active, release]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    view.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
  }, []);

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
      <View style={styles.frame} accessibilityLabel={label} onLayout={onLayout}>
        <Camera
          ref={camera}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={active && focused && appActive}
          outputs={outputs}
          constraints={SCREEN_READER_CONSTRAINTS}
          torchMode={torch ? "on" : "off"}
          resizeMode="cover"
          onSessionConfigSelected={(c) => fpsCb.current?.(c.selectedFPS ?? null)}
          onSubjectAreaChanged={release}
          onStopped={release}
          onError={(e) => {
            setCameraError(e.message);
            onError?.(e.message);
          }}
        />
        {overlay ? (
          <View style={styles.overlay} pointerEvents="none">
            {overlay}
          </View>
        ) : null}
      </View>
      {cameraError ? <Notice tone="danger">{cameraError}</Notice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: "100%", aspectRatio: 3 / 4, borderRadius: radius.lg, overflow: "hidden", backgroundColor: color.bgSunken },
  overlay: { position: "absolute", left: 0, right: 0, bottom: 0, padding: 12, backgroundColor: "rgba(11,9,8,0.72)" },
});
