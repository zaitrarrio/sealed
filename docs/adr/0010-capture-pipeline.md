# ADR-0010: Raw-frame capture, record-then-decode, and capability negotiation

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §7.6–7.7, test suite `capture/`

## Context

Decoding each frame live forces sparse frames, because every frame must decode within one capture interval (16–33 ms). Phone video encoders apply 4:2:0 chroma subsampling and lossy compression that destroy dense color symbols, so recording an MP4 and decoding later is not an option. Receivers vary widely: native apps can capture 60–240 fps with locked focus, exposure and white balance; iOS Safari exposes far less control.

## Decision

1. **Capture raw frames, never encoded video.** iOS: `AVCaptureVideoDataOutput` delivering `420YpCbCr8BiPlanarFullRange` or BGRA. Android: CameraX `ImageAnalysis` with `YUV_420_888` at full resolution. Web: `MediaStreamTrackProcessor` where available (Chromium), else `requestVideoFrameCallback` + `drawImage` to an `OffscreenCanvas`.
2. **Two passes.** A live pass locates anchors and decodes only the header strip on every frame, updating a coverage display ("Block 3 of 5 · 71%"). A heavy pass decodes data regions from a bounded ring buffer (default 600 frames) on the GPU, with temporal fusion when the same encoding symbol is captured more than once and region salvage on torn frames.
3. **Lock the camera** after the calibration frame is detected: focus, exposure and white balance fixed on native; best effort on web via `applyConstraints`.
4. **Capability negotiation:** the receiver computes a capability tier from measured capture fps, resolution and decode throughput during the first second, and reports it:
   - with a network, through the relay to the sender;
   - offline with a camera on the sender, as a small reverse code the sender scans (the same reverse channel used for Air-gap keys);
   - offline one-way, not at all — the sender's user picks "Fast" (T2) or "Compatible" (T1), and Broadcast cycles T1 and T0 frames interleaved.
5. Users stop when the coverage display reaches 100%, or the app stops automatically.

## Alternatives considered

- **Live-only decode.** Simplest, but caps density at what decodes in real time on the weakest receiver. Rejected.
- **Pure record-then-decode with no live feedback.** Users cannot tell when they are done. Rejected.

## Consequences

- Ring-buffer memory: 600 frames at 1280×720 YUV ≈ 830 MB is too large; buffers store anchor-cropped, rectified data regions only (≈ 0.5 MB each at T2 → ≈ 300 MB budget), and drop frames whose symbols are already recovered.
- Web receivers sit at T1 or T0 by default.

## Verification

- `capture/no-video-encoder`: static check that no capture path instantiates a video encoder.
- `capture/negotiation`: simulated receivers with fps/decoder profiles get the expected tier.
- `capture/torn`: synthetic frames blending two consecutive data frames at random scanlines recover ≥ 50% of symbols from both.
