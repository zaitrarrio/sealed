# ADR-0001: Two primitives, five modes

**Status:** Accepted · **Date:** 2026-10-09 · **Deciders:** Founder · **Pairs with:** spec §3, test suite `modes/`

## Context

Sealed is pitched as five distinct products: Direct, Room, Paired, Air-gap and Broadcast. Each serves a different buyer. If each mode is built as its own pipeline, the codebase fragments, security review multiplies by five, and a fix in one mode silently misses the others.

Every mode answers the same two questions: how do the bytes move, and who is allowed to decrypt them.

## Decision

The system is built from two orthogonal primitives, and every mode is a configuration of them.

1. **Transport** — how ciphertext moves: `stored` (relay object storage), `live` (WebRTC data channel), or `optical` (Facet frame stream, ADR-0008).
2. **Trust** — how the content key reaches a recipient: `claim` (one-time scanned secret plus sender approval, ADR-0004), `pinned` (keys exchanged at an earlier in-person pairing, ADR-0006), `reverse-optical` (recipient key captured by the sender's camera), or `open` (no recipient binding; publisher signature only).

| Mode | Transport | Trust | Recipients |
|---|---|---|---|
| Direct | stored → optical fallback | claim | 1 |
| Room | stored | claim (multi-use, windowed) | N |
| Paired | live or stored | pinned | 1 contact, all devices |
| Air-gap | optical | reverse-optical or pinned | 1 |
| Broadcast | optical | open (signed) | anyone in view |

All modes share one content format (the Envelope, ADR-0003), one crypto suite (ADR-0002) and one Rust core (ADR-0011). The UI exposes two actions — **Share** and **Share offline** — and resolves the mode from context: a second scanner turns Direct into Room; a pinned contact selects Paired; no network selects an optical mode.

## Alternatives considered

- **Separate apps per mode.** Cleaner marketing, but five security surfaces and no shared contacts. Rejected.
- **One mode with options.** Fewer concepts, but users would face crypto choices. Rejected; the mode is inferred, not chosen.

## Consequences

- New modes become new rows in the table, not new pipelines.
- Every transport must carry the same Envelope bytes, so an Envelope received optically is byte-identical to one downloaded.
- Marketing can sell five stories while engineering ships one system.

## Verification

- `modes/matrix.test`: for each row in the table, a property test sends the same random Envelope through the named transport and trust path and asserts byte-identical output and identical manifest hash.
- `modes/resolve.test`: table-driven tests of the mode resolver (network state × recipient count × contact status → mode).
- `modes/no-plaintext.test`: instrumented relay asserts no request body or stored object ever parses as a valid plaintext Envelope.
