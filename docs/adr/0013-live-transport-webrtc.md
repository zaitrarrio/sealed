# ADR-0013: Live transfers over WebRTC data channels, encrypted at the application layer

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §6.4.3, test suite `live/`

## Context

When two Paired contacts are both online, a live transfer avoids storing ciphertext and can run faster on the same network. WebRTC data channels are available in all browsers and natively via libwebrtc.

## Decision

- Signaling (SDP offer/answer, ICE candidates) is relayed through the recipient's identity Durable Object over WebSocket. Signaling messages are signed by the sender's device signing key and verified against the pinned sigchain, so the relay cannot inject a different peer.
- The DTLS certificate fingerprint of each peer is included in the signed signaling payload, binding the WebRTC session to Sealed identities.
- The data channel carries **the same Envelope segments** as stored transfers (ADR-0003). DTLS protects the hop; Envelope encryption protects end to end. Either layer alone would suffice against the relay; both together mean a TURN server compromise reveals nothing.
- Flow control: one ordered, reliable channel, 64 KiB messages, backpressure on `bufferedAmount`; resume from the last fully verified segment after reconnect.
- If ICE fails or the transfer stalls for 15 seconds, the sender falls back to uploading to the mailbox and the receiver switches to download — without user action.

## Alternatives considered

- **Relay-only streaming via WebSockets.** Simpler; doubles bandwidth through the relay. Rejected as the default, used as fallback.
- **QUIC / WebTransport peer-to-peer.** Not available peer-to-peer in browsers. Rejected for now.

## Consequences

- LAN transfers between contacts can exceed what the relay would deliver, with no bytes stored.

## Verification

- `live/fingerprint`: a signaling payload with a mismatched DTLS fingerprint aborts the session.
- `live/fallback`: forced ICE failure completes the transfer via mailbox with identical Envelope hash.
- `live/resume`: killing the channel mid-transfer resumes from the last verified segment.
