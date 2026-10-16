# ADR-0019: QR profiles — larger codes, faster frames, several codes per screen

**Status:** Accepted · **Date:** 2026-10-16 · **Amends:** ADR-0018

## Context

With ADR-0018, offline transfers complete through the platform QR detector at about 7 KB/s: one version-21
code of 840 bytes per frame, 10 frames per second. Throughput is codes read per second × bytes per code. Three
knobs move it, and only measurement on real phones can say how far each goes before reads fail.

## Decision

1. **Variable T0 symbol size.** A T0 stream may use any symbol size that is a multiple of 8 between 64 and 2,848
   bytes. Named profiles (`QR_PROFILES`) match QR versions at error correction L in alphanumeric (Base45) mode:

   | QR version | Modules | Bytes per code |
   |---|---|---|
   | 21 | 101 | 840 (default) |
   | 25 | 117 | 1,216 |
   | 30 | 137 | 1,664 |
   | 35 | 157 | 2,216 |
   | 40 | 177 | 2,848 |

   The receiver learns the size from the stream descriptor (whose payload is padded to exactly the symbol size)
   and rejects data frames of any other size. Broadcast signatures bind the OTI, which includes the size, so a
   signed stream cannot be re-encoded at a different size.
2. **Frame hold.** Senders may hold each frame for 6, 4, 3 or 2 display refreshes (10, 15, 20, 30 frames/s at
   60 Hz). The hold travels with each frame; receivers need no change.
3. **Several codes per screen.** A sender may draw 1, 2 or 4 codes at once, each a different frame of the same
   stream. Platform detectors already report every code in view; receivers de-duplicate against a short set of
   recent codes instead of only the last one.
4. **Cheaper encoding.** Codes use a fixed mask (pattern 0) instead of the eight-way penalty search: the payload
   is ciphertext or RaptorQ symbols, so the mask barely affects readability, and encoding is about 5× faster
   (version 40: 14 ms → 2.3 ms per code in Node). Phones draw codes as vector paths from the module matrix and
   encode the next batch while the current one is held.
5. **Defaults stay at version 21, 1 code, 10 frames/s** until device measurements pick better ones.

## Consequences

- Ceilings with 20 % of codes missed (`task bench -- --qr`): v21 ×1 at 10/s ≈ 6 KB/s; v30 ×2 at 20/s ≈ 50 KB/s;
  v35 ×2 at 20/s ≈ 66 KB/s; v40 ×4 at 30/s ≈ 250 KB/s. Real rates depend on the receiving camera, the sending
  screen's size and brightness, distance and the phone's encode speed (shown on the sender's screen).
- Smaller modules need a closer, steadier camera. Four version-40 codes on a phone in portrait leave about one
  point per module and are not expected to read; they exist to find the limit.

## Verification

- Core: every profile completes an Air-gap transfer from detector strings with 20 % loss in fewer screens as size
  grows; two codes per screen halve the screens; a signed broadcast verifies at 2,848 bytes; frames carry the
  requested hold; mismatched sizes are rejected and not counted; a version-40 frame decodes from pixels.
- Web e2e: the benchmark films a version-30 stream through Chromium's camera path to "verified".
- On devices: sweep with the Benchmark (Show on one phone, Film on the other), in this order —
  1. QR size at 1 code, 10/s: v21, v25, v30, v35, v40. Keep the largest that still reaches "verified" quickly.
  2. Frame rate at that size: 10, 15, 20, 30/s.
  3. Codes on screen: 1, 2, 4 (try landscape for 2).
  Compare goodput in the copied reports; the best reliable combination becomes the default.
