# ADR-0003: The Envelope — one content format for every transport

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §8, test suite `envelope/`

## Context

Files, multi-file selections and whole Drive folders must travel over storage, WebRTC and light. Receivers must be able to show contents and progress before everything arrives, verify integrity per segment, and resume interrupted downloads. The optical transport loses and reorders data, so the format must tolerate arbitrary segment arrival order.

## Decision

An **Envelope** is:

1. A **manifest** (deterministic CBOR, RFC 8949 §4.2): format version, transfer ID, creation time, expiry, file entries (path, size, media type, SHA-256 of plaintext), compression codec, segment size, total segment count, and the sender's signature where a sender identity exists.
2. A **payload**: the files concatenated in manifest order as a tar-like stream with no per-file headers (offsets come from the manifest), compressed with zstd level 9 unless the media type is already compressed (JPEG, MP4, ZIP, etc.).
3. **Encryption**: the payload is split into 1 MiB plaintext segments and sealed with AES-256-GCM using the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár 2015): nonce = 11-byte big-endian segment counter ∥ 1-byte last-segment flag, under a payload key `PK = HKDF(CEK, info="sealed/v1/payload")`. The manifest is sealed separately under `MK = HKDF(CEK, info="sealed/v1/manifest")`.
4. A random 256-bit **content encryption key (CEK)** per Envelope. The CEK is never stored or transmitted except inside an HPKE wrap (ADR-0002, ADR-0004).

The last-segment flag prevents truncation; the counter in the nonce prevents reordering and duplication attacks; per-segment tags let receivers verify and write each segment independently, which is what makes out-of-order optical recovery and resumable downloads possible.

Size padding: the ciphertext length is padded to the next bucket (64 KiB, then powers of 2 up to 1 GiB, then 256 MiB steps) to reduce file-size leakage to the relay (ADR-0015).

## Alternatives considered

- **age format.** Well-designed and uses STREAM, but X25519-based recipient stanzas conflict with ADR-0002 and its plugin model adds surface. Rejected; the STREAM layout is borrowed.
- **ZIP with AES.** Ubiquitous, but per-file encryption leaks names and sizes and has weak integrity semantics. Rejected.
- **Single AEAD over the whole payload.** Cannot verify or write before the end; incompatible with optical recovery. Rejected.

## Consequences

- Receivers can render a folder tree as soon as the manifest decrypts.
- A 1 MiB segment is the unit of resume, verification and optical source-block alignment (ADR-0009).
- Envelope bytes are identical across transports (ADR-0001).

## Verification

- `envelope/roundtrip`: property test over random file trees (0–5,000 files, 0 B–2 GiB) asserts bit-exact round trip.
- `envelope/tamper`: flipping any bit, swapping two segments, dropping the last segment, or duplicating a segment must fail with the specific error.
- `envelope/golden`: checked-in golden Envelopes with known CEKs decode identically in Rust, WASM, Swift and Kotlin bindings.
- `envelope/padding`: ciphertext length always equals a bucket boundary.
