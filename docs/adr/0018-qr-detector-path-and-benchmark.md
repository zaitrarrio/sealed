# ADR-0018: Offline transfers read QR frames with the platform's detector; a benchmark measures every run

**Status:** Accepted · **Date:** 2026-10-16 · **Amends:** ADR-0008, ADR-0010, ADR-0016 §7, ADR-0017

## Context

Offline (Air-gap) transfers between two phones did not complete at all. Receivers advertised T1, so senders
streamed the colour grid, and the phone decoded every camera frame in JavaScript: about 0.5–0.8 s per frame in
Node and slower on Hermes, against a sender holding each frame for 100 ms. The grid decoder had only been
validated against simulated captures. ADR-0017's Rust/wgpu decoder is not wired into either app, and its
`push_frame` expects pre-located anchors that nothing detects yet.

Every phone already ships a fast, robust QR detector (AVFoundation, ML Kit), and Chrome on Android and macOS
exposes one as `BarcodeDetector`. They find a code anywhere in view, at any rotation and moderate tilt, at the
camera's frame rate — but they return text, and do not round-trip binary byte-mode payloads reliably.

## Decision

1. **T0 frames are Base45 text.** The same 852 frame bytes (header ∥ 840-byte RaptorQ symbol or descriptor) are
   written as RFC 9285 Base45 in one alphanumeric QR segment, version 21-L (1278 of 1352 characters). Wire
   semantics are unchanged; readers also accept byte-mode frames from earlier senders.
2. **The detector path.** `FacetReceiver.pushQrCode(text | bytes)` accepts a code read by any external detector.
   Phones feed it from VisionCamera's object output (`CodeCamera`); the web feeds it from `BarcodeDetector`
   when present and otherwise decodes frames in its worker with grid search disabled (`tiers: [0]`).
3. **T0 is the default** for reverse key codes, Air-gap and Broadcast on every client, until a native or GPU
   grid decoder ships. Grid tiers remain available as an experimental choice measured by the benchmark.
4. **Handshake as two turns of "show, film".** The receiver shows its key code and the sender films it (full
   frame, no alignment box); then they switch and the sender's stream starts by itself. Both show the safety
   code.
5. **Benchmark.** `BenchmarkMeter` (core) reports where a run got to — no input, codes but no Sealed frames,
   receiving, complete, verified — with rates, goodput and a byte-for-byte check against a seeded payload named
   in the stream. Exposed as a CLI (`task bench`), a web page (`/bench`) and a phone screen (Benchmark).

## Consequences

- Throughput is bounded by T0: 840 bytes per frame at 10 frames/s nominal, ≈ 7 KB/s in the CLI estimate (1 MB in
  about 2½ minutes), less when the detector misses frames. Slow, but transfers complete.
- The Rust crates must mirror Base45 T0 frames and `pushQrCode` before they can replace the TypeScript receiver.
- Browsers without `BarcodeDetector` (Safari, Firefox, Chrome on Windows/Linux) use the jsQR worker path, which is
  slower (hundreds of ms per frame); the benchmark shows which path a browser used.

## Verification

- Core: Base45 RFC 9285 vectors; T0 frames render at v21 and decode from pixels; Air-gap and Broadcast complete
  from detector strings with 25–30 % of frames missed, duplicates and stray codes; benchmark stages and report.
- Mobile: the decode session completes an Air-gap transfer from detector strings with the sender's safety code.
- Web e2e (Chromium, fake camera): Air-gap receive and Broadcast at T0; Air-gap send auto-starts after the key
  code and files; Benchmark films a test stream to "verified".
- On devices: run the Benchmark both directions between the two phones and keep the copied reports.
