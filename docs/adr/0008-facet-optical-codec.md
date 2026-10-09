# ADR-0008: Facet, a custom screen-to-camera codec with tiered density

**Status:** Accepted (parameters provisional until benchmark gate M1) · **Date:** 2026-10-09 · **Pairs with:** spec §7, test suite `facet/`

## Context

Air-gap and Broadcast modes move whole files through light. Standard QR codes are designed for print: two colors, fixed finder patterns, error correction tuned for physical damage. Animated QR with fountain codes reaches tens of KB/s (TXQR reported about 13 KB in roughly half a second at best). libcimbar, an open-source color codec purpose-built for screens, reports about 106 KB/s (Mode B) on a Snapdragon 625 phone using 12,400 colored tiles carrying 6 bits each. Sealed controls both encoder and decoder, so it can design for an emissive screen filmed by a phone camera.

## Decision

Build **Facet**, a Sealed-specific codec:

- **Symbol alphabet:** each cell carries a color (2–3 bits from a 4- or 8-color palette chosen for maximal separation in camera RGB after calibration) and a shape (4 bits from 16 high-contrast glyphs inside the cell). Shape decoding is robust to blur; color decoding is robust to scale.
- **Geometry:** square grid with four corner anchors (concentric rings, distinct per corner for orientation), a one-cell quiet border, and two black/white header strips (top and bottom, each two cells tall) carrying duplicate copies of the frame header.
- **Tiers** negotiated per receiver (ADR-0010, spec §7.3):

| Tier | Grid | Bits/cell | Data fps | Target goodput | Receivers |
|---|---|---|---|---|---|
| T0 Compatible | QR v20-L frames | — | 10 | 6–8 KB/s | any decoder, iOS web fallback |
| T1 Standard | 112 × 112 | 6 | 10 | ≈ 60 KB/s | web (Android Chrome, iOS Safari) |
| T2 Dense | 112 × 112 | 7 | 15 | ≈ 105 KB/s | native, 60 fps capture |
| T3 Max | 144 × 144 | 7 | 20 | ≈ 240 KB/s | native, ≥ 120 fps capture, record-then-decode |

Goodput targets assume the inner code rate (ADR-0009) and a 15% frame-loss allowance. They are design targets; T1 is benchmarked against libcimbar Mode B as the reference, and the tier table is revised from measured corpus data at milestone M1.

- **Timing:** each data frame is held for an integer number of display refreshes (≥ 2), so rolling-shutter captures that straddle a transition are detectable via mismatched header CRCs and salvageable by region.
- **Calibration:** the stream opens with, and repeats every 64 frames, a calibration frame of palette swatches in known positions; receivers fit a 3×3 color-correction matrix plus per-channel gamma.
- **T0 is real QR**, so a receiver without Sealed's decoder (or a constrained iOS web context) still works, slowly.

libcimbar (MPL-2.0) is used as a reference implementation and benchmark baseline only; Facet is an independent implementation so Sealed owns its IP and can tune for its tiers.

## Alternatives considered

- **Animated QR only.** Universal but ~10× slower. Kept as T0.
- **Adopt libcimbar directly.** Fastest path to working code; MPL-2.0 is file-level copyleft and compatible with proprietary use, but it fixes the design space and limits differentiation. Rejected as the production codec; retained as baseline.
- **Steganographic or invisible codes (HiLight-style).** Throughput is in the single-digit kbps range. Rejected.

## Consequences

- Sealed must maintain a capture corpus across screens and phones (spec §14.4); that corpus is also a defensible asset.
- Codec parameters are versioned in the header, so tiers can change without breaking older receivers.

## Verification

- `facet/roundtrip.synthetic`: encoder → simulated channel (blur, noise, gamma, JPEG-free color shift, rolling-shutter blend, 0–30% frame drop) → decoder recovers the Envelope bit-exactly at each tier's design point.
- `facet/corpus`: recorded real captures (≥ 20 phone models × 10 displays at launch) must meet per-tier goodput floors; regressions fail CI.
- `facet/t0.interop`: T0 frames decode with ZXing-C++ and Apple Vision unmodified.
- Benchmark gate **M1**: T1 goodput ≥ 50 KB/s median on the corpus, or the tier table is revised before Air-gap work proceeds.
