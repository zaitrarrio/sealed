/**
 * Sender side of the torch back-channel (ADR-0022): the front camera watches for the receiver's torch and turns
 * its blinks into messages. The screen it sits on is busy drawing codes, so the camera work stays on the frame
 * processor thread: a small frame, one brightness number per frame (the mean of the brightest 1 % of pixels),
 * and only that number crosses to React, where the gate and pulse decoder run.
 *
 * Nothing is shown: the component renders a 1-point camera view. The torch is a point source bright enough to
 * saturate the sensor at a few metres, whatever else is in the picture, which is why the brightest pixels and not
 * the frame mean are measured.
 */
import { BrightnessGate, TorchDecoder, type TorchMessage } from "@sealed/core";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useFrameOutput, type Frame } from "react-native-vision-camera";
import { scheduleOnRN } from "react-native-worklets";
import { useAppActive } from "../lib/app-state";

const TARGET_RESOLUTION = { width: 320, height: 240 } as const;
const CONSTRAINTS = [{ fps: 30 }];
const NOOP = () => undefined;

export interface TorchWatcherProps {
  onMessage: (m: TorchMessage, at: number) => void;
  /** Raw brightness and gate state, for the benchmark's readout. */
  onSample?: (brightness: number, on: boolean) => void;
  active?: boolean;
  onError?: (message: string) => void;
}

export function TorchWatcher({ onMessage, onSample, active = true, onError }: TorchWatcherProps) {
  const device = useCameraDevice("front");
  const { hasPermission } = useCameraPermission();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const gate = useMemo(() => new BrightnessGate(), []);
  const decoder = useMemo(() => new TorchDecoder(), []);
  const cb = useRef({ onMessage, onSample, onError });
  cb.current = { onMessage, onSample, onError };

  useEffect(() => {
    if (!hasPermission) cb.current.onError?.("Camera permission is needed to see the receiver's torch.");
  }, [hasPermission]);

  // Timed on arrival: frame timestamps have platform-specific units, and the pulses are long enough (250 ms)
  // that the few milliseconds of delivery latency do not matter.
  const deliverRef = useRef((brightness: number) => {
    const at = performance.now();
    const on = gate.push(brightness);
    cb.current.onSample?.(brightness, on);
    const m = decoder.push(on, at);
    if (m) cb.current.onMessage(m, at);
  });
  const deliver = useCallback((brightness: number) => deliverRef.current(brightness), []);

  const onFrame = useCallback(
    (frame: Frame) => {
      "worklet";
      try {
        if (frame.isPlanar || !frame.hasPixelBuffer) return;
        const format = String(frame.pixelFormat);
        const bpp = format === "rgb-rgb-8-bit" ? 3 : 4;
        const px = new Uint8Array(frame.getPixelBuffer());
        const width = frame.width;
        const height = frame.height;
        const bytesPerRow = frame.bytesPerRow;
        const stride = 2;
        const hist = new Uint32Array(256);
        let n = 0;
        for (let y = 0; y < height; y += stride) {
          let o = y * bytesPerRow;
          for (let x = 0; x < width; x += stride, o += bpp * stride) {
            const r = px[o] as number;
            const g = px[o + 1] as number;
            const b = px[o + 2] as number;
            const m = r > g ? (r > b ? r : b) : g > b ? g : b;
            hist[m] = (hist[m] as number) + 1;
            n++;
          }
        }
        const want = Math.max(1, Math.floor(n / 100));
        let sum = 0;
        let count = 0;
        for (let v = 255; v >= 0 && count < want; v--) {
          const take = Math.min(hist[v] as number, want - count);
          sum += take * v;
          count += take;
        }
        scheduleOnRN(deliver, count ? sum / count : 0);
      } finally {
        frame.dispose();
      }
    },
    [deliver],
  );

  const output = useFrameOutput({ pixelFormat: "rgb", targetResolution: TARGET_RESOLUTION, dropFramesWhileBusy: true, onFrame, onFrameDropped: NOOP });
  const outputs = useMemo(() => [output], [output]);

  if (!hasPermission || !device) return null;
  return (
    <View style={styles.hidden} pointerEvents="none" accessible={false}>
      <Camera style={StyleSheet.absoluteFill} device={device} isActive={active && focused && appActive} outputs={outputs} constraints={CONSTRAINTS} onError={(e) => cb.current.onError?.(e.message)} />
    </View>
  );
}

const styles = StyleSheet.create({ hidden: { width: 1, height: 1, opacity: 0.01, overflow: "hidden" } });
