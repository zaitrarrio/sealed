# ADR-0024: Acoustic transport — speaker-to-microphone file transfer

**Status:** Accepted · **Date:** 2026-10-28 · **Pairs with:** ADR-0001, ADR-0008, ADR-0009, spec §6.5–6.6, test suite `acoustic/`

## Context

Air-gap and Broadcast already move Envelopes through light (Facet). Some rooms cannot use a camera: the screen is covered, the receiver has no camera permission, or a speaker must reach everyone present. Sound is a slower public channel, but it fits the same two-primitive model (transport × trust).

## Decision

Add transport `acoustic` beside `stored`, `live`, and `optical`.

1. **Modem.** Multi-carrier QPSK at 48 kHz with a chirp preamble. Profiles:
   - **A0** — denser audible band, design raw ~500 B/s, target goodput ≥ 400 B/s on a clean synthetic channel.
   - **A1** — more carriers on OFDM bin centres, design raw ~1500 B/s.
   Rates are design gates. Product UI MUST NOT quote KB/s until a real-phone bench meets the A0 floor on at least two devices.

2. **Framing.** Packets `SALA` ∥ version ∥ profile ∥ type ∥ flags ∥ stream_id ∥ sbn ∥ esi ∥ payload ∥ CRC-32. Types: sync, descriptor, data, end. Descriptors reuse Facet CBOR (`encodeDescriptorPayload`) and may fragment across packets.

3. **FEC.** Outer RaptorQ as ADR-0009. Half-duplex; no acoustic acknowledgements. Any enough symbols rebuild the Envelope.

4. **Trust.** Unchanged:
   - Air-gap: reverse key code (optical or QR) + SAS, then speaker streams ciphertext wrapped to the receiver.
   - Broadcast: CEK in the descriptor; UI warns that anyone who can hear the stream can receive it (further than a screen).
   - The speaker never plays claim secrets, content keys (except Broadcast), or safety codes. Spec §10.3 spoken check codes stay visual while sound is the channel.

5. **Size.** Warn above 256 KiB and steer multi-megabyte files back to the screen.

6. **Mic policy.** Microphone on only during an explicit Receive. Default tones are audible. Near-ultrasonic (A2) is deferred and opt-in only.

## Alternatives considered

- **ggwave / quiet.js as the modem.** Faster to ship; locks Sealed to their profiles and licences. Rejected for production; useful as a future benchmark baseline.
- **Fully screenless stranger Air-gap (key over sound).** Anyone in earshot can inject a key. Rejected; reverse-key scan stays required for strangers.
- **Acoustic ACKs for ARQ.** Adds a reverse speaker path and echo complexity. Rejected while RaptorQ covers loss.

## Consequences

- Mode resolution keeps Air-gap / Broadcast; the channel (screen vs sound) is a send-time choice.
- Mobile mic permission copy must describe listening for transfers, not “does not record audio.”
- New corpus: synthetic channel tests in CI; device benches before marketing rates.

## Verification

- `acoustic/modem`: clean and mild-noise packet round trips; raw rate ≥ profile target.
- `acoustic/transfer`: Air-gap and Broadcast Envelope round trips via packets and via PCM; Air-gap PCM contains neither reverse-key nonce nor openable CEK without device keys.
- Device bench (manual gate): A0 goodput ≥ 300 B/s median on ≥ 2 phones before UI rates.
