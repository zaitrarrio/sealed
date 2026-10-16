# ADR-0021: Lock the camera on the screen it is reading

**Status:** Accepted · **Date:** 2026-10-16 · **Builds on:** ADR-0018, ADR-0019

## Context

With the detector path, most "missed" codes at 20–30 frames/s are not detector failures. A screen at arm's
length is a flat, bright, self-lit target: auto focus hunts on it, auto exposure drifts with each frame's
contents, and the default exposure is long enough that two display frames blend into one camera frame. Rolling
shutter adds to this: a camera frame is read out over 10–20 ms, so unless a display frame is held for about two
camera frame periods, no camera frame falls entirely inside it.

## Decision

1. **Session constraints** (both platforms): 60 camera frames per second, video and preview stabilisation off,
   SDR. The benchmark reports the frame rate the session actually got; the rule of thumb shown next to it is that
   the sender's frame rate should stay at or below half the camera's.
2. **Lock once aimed.** After the first code is read:
   - bias auto exposure down (both platforms; EV on iOS, half the device's negative compensation range on
     Android, whose step size VisionCamera does not expose), so a bright screen meters to a short exposure;
   - meter on the code and lock focus, exposure and white balance there (`focusTo` with `adaptiveness:
     "locked"`; AVFoundation on iOS, CameraX `FocusMeteringAction` with locking on Android);
   - on iOS, pin 1/500 s with ISO raised to keep the brightness (`setExposureLocked`). VisionCamera 5 has no
     manual exposure on Android (CameraX does not expose it); a Camera2-interop patch is the follow-up if Android
     benchmarks show the bias alone is not enough.
3. **Release** the lock when the scene changes (iOS event) or when no code has been seen for 2.5 s (both), so a
   moved camera can find the screen again. Exposure bias returns to 0.
4. **Web**: the same lock (`focusMode`/`exposureMode`/`whiteBalanceMode: manual`, with `exposureTime` shortened
   to 1/500 s and ISO scaled where the browser exposes the ranges) now also fires on the detector path, on the
   first valid frame rather than only on grid calibration.

Code layout is unchanged. In portrait-to-portrait use the display's refresh scan and the camera's readout scan
run at right angles, so a fixed "band" layout has no general advantage; the existing layout already stacks codes
vertically in portrait and maximises their size.

## Consequences

- Nothing changes for senders. Receivers on devices without a control keep auto for that control.
- The benchmark's device line now records camera fps, what was locked, the bias and (iOS) the exposure chosen,
  so reports from the field say whether the lock happened.

## Verification

- Mobile: exposure shortening and bias selection are unit-tested in Node (`test/camera-lock.test.ts`); the lock
  module takes `Platform.OS` as an argument so it does not import React Native.
- Web: exposure shortening is unit-tested; the existing camera e2e tests still pass with the lock on the
  detector path.
- On devices: compare benchmark reports at 20 and 30 frames/s before and after (`locked …` in the device line).
