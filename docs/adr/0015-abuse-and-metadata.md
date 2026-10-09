# ADR-0015: Abuse resistance and metadata minimization

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §11–12, test suite `abuse/`

## Context

End-to-end encrypted file hosting attracts abuse. Mozilla shut down Firefox Send in September 2020 after it was used to deliver malware and in spear-phishing. Sealed cannot scan content it cannot read, and must not add a backdoor to do so. It can shape the product so that it is a poor tool for anonymous mass distribution, and it can minimize what the relay learns about honest users.

## Decision

**Abuse resistance by design:**

- **No public download links.** Direct and Room require a scan plus approval; Paired requires an in-person pairing. There is no URL that grants a stranger a file without the sender actively approving.
- Senders must hold an account backed by a passkey and a verified device; new accounts have lower size and rate limits for their first 7 days.
- Default TTL 24 hours (Direct/Room), 30 days (Paired mailbox); hard maximum 7 days for Room.
- Room caps (200 devices default) and per-account daily volume limits.
- **Receiver-initiated reporting:** a recipient can report a transfer, voluntarily attaching the decrypted content or its hash; Sealed acts on the sender account. Hashes of reported known-malicious files feed an optional *client-side* warning list that receivers check after decryption, never sent to the server.
- Broadcast and Air-gap open modes never touch the relay.

**Metadata minimization:**

- Ciphertext padded to size buckets (ADR-0003).
- File names, types and counts exist only inside the encrypted manifest.
- Contact lists are end-to-end encrypted in the user's sync blob.
- Logs keep transfer IDs, sizes (bucketed), timestamps (rounded to the hour) and coarse region; IP addresses are hashed with a daily rotating key and dropped after 7 days unless tied to an abuse report.
- A published transparency report and a plain statement of what the relay can and cannot hand over.

## Consequences

- Sealed cannot detect illegal content proactively; this is stated in the terms and the white paper.
- Product friction is deliberate where it blocks abuse (no links) and minimal where it does not (one scan, one tap).

## Verification

- `abuse/no-public-url`: crawler test confirms no endpoint returns ciphertext or wraps without a valid per-device download token.
- `abuse/limits`: new-account limits enforced at the Worker edge.
- `abuse/logs`: log schema test fails if raw IP or file name fields appear.
