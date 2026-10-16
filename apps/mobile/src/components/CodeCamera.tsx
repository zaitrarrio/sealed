/**
 * Full-frame camera that reads a stream of QR codes with the platform's own detector (AVFoundation on iOS,
 * ML Kit / CameraX on Android, through VisionCamera's object output). The detector finds codes anywhere in the
 * picture, at any rotation and moderate tilt, so nothing has to be lined up: point the phone at the other
 * screen and keep it in view.
 *
 * Each distinct code is reported once while it stays on screen (the detector repeats every visible code on every
 * camera frame, and several codes may be in view at once); a code is reported again only after it has dropped
 * out of the recent set, which RaptorQ treats as a duplicate.
 */
import { color, radius } from "@sealed/tokens";
import { useIsFocused } from "expo-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useObjectOutput, type ScannedObject, type ScannedObjectType } from "react-native-vision-camera";
import { useAppActive } from "../lib/app-state";
import { Button, Notice, P, Row } from "../ui/kit";

const QR_TYPES: ScannedObjectType[] = ["qr"];
/** Codes remembered for de-duplication: enough for 4 codes per screen across a few frames. */
const RECENT = 16;

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
}

export function CodeCamera({ onCode, active = true, label = "Camera view of the other screen", overlay, onError }: CodeCameraProps) {
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [cameraError, setCameraError] = useState<string | null>(null);
  const recent = useRef<string[]>([]);
  const cb = useRef(onCode);
  cb.current = onCode;

  const output = useObjectOutput({
    types: QR_TYPES,
    onObjectsScanned: (objects: ScannedObject[]) => {
      const at = performance.now();
      for (const o of objects) {
        const value = (o as { value?: string }).value;
        if (!value || recent.current.includes(value)) continue;
        recent.current.push(value);
        if (recent.current.length > RECENT) recent.current.shift();
        cb.current(value, at);
      }
    },
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
