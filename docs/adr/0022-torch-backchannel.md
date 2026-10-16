# ADR-0022: Torch back-channel — one bit of light from receiver to sender

**Status:** Accepted · **Date:** 2026-10-16 · **Builds on:** ADR-0019, ADR-0021

## Context

Optical streams are one-way. The sender loops until a person stops it, cannot tell whether the receiver is
dropping half the frames or reading all of them, and the rate is chosen before the first frame. Sealed is to stay
optical, so the return channel has to be light. The receiver films with its back camera; its torch LED sits next
to that lens and points at the sender, whose front camera faces the receiver. That is a working link with no new
posture.

## Decision

1. **Signal.** On-off keying at 2 pulses/s: `done` = torch on 1.5 s (repeated 3×), `slower` = 2 pulses,
   `faster` = 4 pulses, bursts separated by 0.8 s of darkness. A burst of 3 is ignored, not guessed. A 30 fps
   camera sees each pulse for 7–8 frames; the decoder tolerates a dropped frame inside a pulse.
2. **Detection.** The sender's front camera runs at 320×240; the mean of the brightest 1 % of pixels is the
   sample (a torch saturates a spot whatever the room looks like). On the phone that number is computed in the
   frame-processor worklet; only it crosses to JavaScript. A gate tracks the ambient floor (a level held longer
   than any message is the room, not a signal) with hysteresis; a pulse decoder turns edges into messages.
3. **Loss estimate.** The receiver counts gaps in each block's ESI sequence over the last 48 data frames
   (`ReceiveProgress.recentLoss`). A controller with hysteresis and a 5 s cooldown asks for `slower` above 35 %
   loss and `faster` below 6 % while under 80 % complete.
4. **Adaptation.** The sender moves one rung on a ladder (10 → 15 → 20 → 30 frames/s, then 2 and 4 codes on
   screen) per message; `FacetSender.setQrHold` changes the hold for frames from then on, which travels in each
   frame, so receivers need nothing. Bytes per code cannot change mid-stream (OTI, signatures).
5. **Done.** On completion the receiver flashes `done`; the sender stops and shows "Delivered". Phones keep a
   small camera tile alive after the result screen appears so the torch can finish; the web opens a short-lived
   camera for the same purpose. Broadcast (many receivers) does not use the channel.
6. **Platforms.** Torch control: VisionCamera `torchMode` on iOS and Android; `applyConstraints({torch})` on the
   web, which Chrome on Android supports and Safari does not (the page says so in the benchmark). Front-camera
   watching works everywhere a front camera exists.

## Consequences

- Transfers end by themselves and settle at the rate the pair of devices can read, from the saved setting as the
  starting point. The benchmark's Show side displays what the front camera reads; its Film side has Slower /
  Faster / Done buttons to try the channel by hand.
- A second phone's torch, or a lamp switched on, could be read as a message: the gate's floor and the strict
  pulse counts limit this to a wrong rate step (self-correcting) or a false "done" (the receiver's screen says
  otherwise, and the sender can restart).
- Capacity is a few symbols per second; it is a control channel, not data.

## Verification

- Core: schedule/decoder round trips at 30 fps including back-to-back bursts and a dropped frame; gate floor
  tracking; loss estimation incl. loop wrap; rate controller hysteresis and cooldown; ladder clamps; the player's
  timeline; end-to-end `recentLoss` through `FacetReceiver.pushQrCode` with every other frame skipped, and
  `setQrHold` reflected in emitted frames.
- Apps: brightness helper (padding, 3- and 4-byte formats). Web e2e: the fake camera plays a blinking "done"
  spot to the sender page, which stops and shows "Delivered".
- Devices: Benchmark → Film → Slower / Faster / Done while the other phone shows; its readout logs the messages.
