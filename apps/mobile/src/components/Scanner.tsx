/**
 * Camera QR scanner (VisionCamera object output, the platform's native barcode detector) with a paste fallback.
 * `onCode` receives each decoded text; returning null accepts it (scanning stops), a string keeps scanning and
 * shows the message.
 */
import { color, radius } from "@sealed/tokens";
import * as Clipboard from "expo-clipboard";
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useObjectOutput, type ScannedObject, type ScannedObjectType } from "react-native-vision-camera";
import { useAppActive } from "../lib/app-state";
import { Button, Field, Notice, P, Row, Spinner } from "../ui/kit";

const QR_TYPES: ScannedObjectType[] = ["qr"];

export interface ScannerProps {
  onCode: (text: string) => string | null | Promise<string | null>;
  label?: string;
  pasteLabel?: string;
}

export function Scanner({ onCode, label = "Point the camera at the code", pasteLabel = "Or paste a code or link" }: ScannerProps) {
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [accepted, setAccepted] = useState(false);
  const handling = useRef(false);
  const lastText = useRef("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  const handle = useCallback(async (text: string, fromCamera: boolean) => {
    if (handling.current) return;
    if (fromCamera && text === lastText.current) return;
    lastText.current = text;
    handling.current = true;
    setBusy(true);
    try {
      const err = await onCodeRef.current(text);
      setMessage(err);
      if (err === null) setAccepted(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      handling.current = false;
      setBusy(false);
    }
  }, []);

  const output = useObjectOutput({
    types: QR_TYPES,
    onObjectsScanned: (objects: ScannedObject[]) => {
      for (const o of objects) {
        const value = (o as { value?: string }).value;
        if (value) {
          void handle(value, true);
          break;
        }
      }
    },
  });

  const outputs = useMemo(() => [output], [output]);
  const cameraOn = hasPermission && device !== undefined && focused && appActive && !accepted;

  return (
    <View style={{ gap: 12 }}>
      {!hasPermission ? (
        <Notice>
          <View style={{ gap: 8 }}>
            <P>Sealed needs the camera to scan codes. Nothing is recorded or uploaded.</P>
            <Row>
              <Button title="Allow camera" tone="primary" onPress={() => void requestPermission()} />
            </Row>
          </View>
        </Notice>
      ) : device === undefined ? (
        <Notice tone="danger">No camera is available on this device. Paste the code instead.</Notice>
      ) : (
        <View style={styles.frame} accessibilityLabel={label}>
          <Camera style={StyleSheet.absoluteFill} device={device} isActive={cameraOn} outputs={outputs} onError={(e) => setMessage(e.message)} />
          <View style={styles.reticle} pointerEvents="none" />
        </View>
      )}
      <P tone="subtle">{label}</P>
      {busy ? <Spinner label="Checking the code…" /> : null}
      {message ? <Notice tone="danger">{message}</Notice> : null}
      <Field label={pasteLabel} value={paste} onChangeText={setPaste} autoCapitalize="none" autoCorrect={false} placeholder="https://…" />
      <Row>
        <Button title="Use pasted code" disabled={!paste.trim() || busy} onPress={() => void handle(paste.trim(), false)} />
        <Button
          title="Paste from clipboard"
          tone="ghost"
          onPress={() => {
            void Clipboard.getStringAsync().then((t) => {
              if (t) {
                setPaste(t);
                void handle(t.trim(), false);
              }
            });
          }}
        />
      </Row>
    </View>
  );
}

export const scannerStyles = StyleSheet.create({
  frame: { aspectRatio: 1, width: "100%", borderRadius: radius.lg, overflow: "hidden", backgroundColor: color.bgSunken },
  reticle: { position: "absolute", left: "15%", top: "15%", right: "15%", bottom: "15%", borderWidth: 2, borderColor: color.amber, borderRadius: radius.md },
});
const styles = scannerStyles;
