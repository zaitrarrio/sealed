/**
 * Camera settings for reading a screen (ADR-0021).
 *
 * A screen at arm's length is a flat, bright, self-lit target: auto focus hunts on it, auto exposure drifts with
 * the frame's contents, and the default exposure is long enough that two display frames blend into one camera
 * frame. Once the first code has been read, the camera is aimed, so the pipeline:
 *
 * 1. biases auto exposure down (both platforms): a bright screen then meters to a short exposure;
 * 2. meters on the code and locks focus, exposure and white balance there (both platforms: AVFoundation on
 *    iOS, CameraX FocusMeteringAction with locking on Android);
 * 3. on iOS, where VisionCamera exposes manual exposure, pins exactly 1/500 s with ISO adjusted to match.
 *
 * Android has no manual exposure in VisionCamera 5 (CameraX does not expose it), so step 1 is what shortens the
 * exposure there. Every step is best-effort: a device without a control keeps auto for it.
 */
import type { CameraController, CameraRef, Constraint } from "react-native-vision-camera";

/** Longest exposure that still freezes a 60 Hz display frame with margin: 1/500 s. */
export const TARGET_EXPOSURE_S = 1 / 500;

/** Session constraints for a screen reader: fast frames, no stabilisation, no HDR tone mapping. */
export const SCREEN_READER_CONSTRAINTS: Constraint[] = [
  { fps: 60 },
  { videoStabilizationMode: "off" },
  { previewStabilizationMode: "off" },
  { videoDynamicRange: { bitDepth: "sdr-8-bit", colorSpace: "srgb", colorRange: "full" } },
];

/** Exposure bias applied before metering, in EV (iOS) or as the fraction of the device's negative range (Android). */
export const SCREEN_BIAS_EV = -1.5;
export const SCREEN_BIAS_FRACTION = 0.5;

export interface LockResult {
  /** Which settings ended up locked. */
  locked: ("focus" | "exposure" | "white balance")[];
  /** Exposure bias applied, in the platform's units (EV on iOS, compensation steps on Android). */
  bias?: number;
  /** Exposure chosen (seconds) and ISO, when the device allowed a manual exposure (iOS). */
  exposure?: { durationS: number; iso: number };
}

/**
 * The exposure bias to request. iOS reports and takes EV; Android reports and takes CameraX compensation
 * steps whose size is not exposed, so there the bias is half of the device's negative range. Null when the
 * device has no usable range.
 */
export function screenBias(d: { supportsExposureBias: boolean; minExposureBias: number; maxExposureBias: number }, os: string): number | null {
  if (!d.supportsExposureBias || !(d.minExposureBias < 0)) return null;
  if (os === "android") return Math.floor(d.minExposureBias * SCREEN_BIAS_FRACTION);
  return Math.max(d.minExposureBias, SCREEN_BIAS_EV);
}

/**
 * Picks the manual exposure to request: the current exposure shortened to `TARGET_EXPOSURE_S`, with ISO raised to
 * keep the same brightness, both clamped to the device's range. Returns null when the current exposure is already
 * short enough (nothing to gain) or the device reports no usable range.
 */
export function shortenedExposure(c: { exposureDuration: number; iso: number; minExposureDuration: number; maxExposureDuration: number; minISO: number; maxISO: number }, target = TARGET_EXPOSURE_S): { durationS: number; iso: number } | null {
  if (!(c.exposureDuration > 0) || !(c.iso > 0) || !(c.maxExposureDuration > c.minExposureDuration) || !(c.maxISO >= c.minISO)) return null;
  if (c.exposureDuration <= target) return null;
  const durationS = Math.min(Math.max(target, c.minExposureDuration), c.maxExposureDuration);
  const iso = Math.min(Math.max(c.iso * (c.exposureDuration / durationS), c.minISO), c.maxISO);
  return { durationS, iso: Math.round(iso) };
}

/**
 * Locks the camera on the screen it is pointed at. `viewPoint` is where the code was seen in the preview, in view
 * coordinates (the centre when unknown); `os` is Platform.OS, kept out of this module so it runs in Node tests.
 */
export async function lockOnScreen(camera: CameraRef, viewPoint: { x: number; y: number }, os: string): Promise<LockResult> {
  const result: LockResult = { locked: [] };
  const controller: CameraController | undefined = camera.controller;
  const bias = controller ? screenBias(controller.device, os) : null;
  if (controller && bias !== null) {
    try {
      await controller.setExposureBias(bias);
      result.bias = bias;
    } catch {
      // keep auto exposure as is
    }
  }
  try {
    await camera.focusTo(viewPoint, { modes: ["AF", "AE", "AWB"], responsiveness: "snappy", adaptiveness: "locked", autoResetAfter: null });
    result.locked.push("focus", "exposure", "white balance");
  } catch {
    // Metering unsupported; continue with the direct locks below.
  }
  if (!controller) return result;
  const device = controller.device;
  if (device.supportsExposureLocking) {
    const want = shortenedExposure(controller);
    try {
      if (want) {
        await controller.setExposureLocked(want.durationS, want.iso);
        result.exposure = want;
      } else {
        await controller.lockCurrentExposure();
      }
      if (!result.locked.includes("exposure")) result.locked.push("exposure");
    } catch {
      // iOS only; Android keeps the metering lock from focusTo.
    }
  }
  if (device.supportsFocusLocking && !result.locked.includes("focus")) {
    try {
      await controller.lockCurrentFocus();
      result.locked.push("focus");
    } catch {
      // ignore
    }
  }
  if (device.supportsWhiteBalanceLocking && !result.locked.includes("white balance")) {
    try {
      await controller.lockCurrentWhiteBalance();
      result.locked.push("white balance");
    } catch {
      // ignore
    }
  }
  return result;
}

/** Back to continuous auto everything, for when the scene changed or the stream went quiet. */
export async function unlock(camera: CameraRef): Promise<void> {
  try {
    await camera.resetFocus();
  } catch {
    // ignore
  }
  try {
    await camera.controller?.setExposureBias(0);
  } catch {
    // ignore
  }
}
