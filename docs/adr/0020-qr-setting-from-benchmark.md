# ADR-0020: Offline sends use the QR setting kept from the Benchmark

**Status:** Accepted · **Date:** 2026-10-16 · **Builds on:** ADR-0019

## Context

ADR-0019 added QR size, codes on screen and frame rate, but only the Benchmark could use them. The best setting
depends on the two devices, the screen and the room, so it has to come from a measurement, and the sender is the
side that decides how codes are drawn.

## Decision

1. Each device keeps one setting, `settings.qrStream` (`QrStreamSetting`: bytes per code, codes on screen, frame
   hold). Missing or invalid storage falls back to version 21, 1 code, 10 frames/s (`qrStreamSetting`).
2. Benchmark → Show offers "Use … for my offline transfers" for the selected setting, and "Back to default". The
   setup form starts at the saved setting, so the next test begins from what is in use.
3. Secure offline send and Broadcast stream with the saved setting on both web and phone. The send screen's time
   estimate and the stream caption name it.
4. Receivers need nothing: they learn the size from the descriptor and read every code the detector reports.

## Consequences

- A setting tuned between two particular phones also applies when the same phone sends to a weaker camera. If a
  transfer stalls, go back to the default in the Benchmark. A receiver-advertised limit in the key code is a
  possible follow-up once real reports show how much cameras differ.
- Broadcast signatures still bind the symbol size, so the saved setting is part of what is signed.

## Verification

- Core: storage validation and description strings.
- Web e2e: a setting saved in the Benchmark survives a reload and is what Broadcast draws; the default Air-gap
  send still decodes from the canvas.
