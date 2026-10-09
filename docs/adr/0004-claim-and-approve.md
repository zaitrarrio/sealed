# ADR-0004: Claim-and-approve for Direct and Room

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §6.1–6.2, test suite `protocol/claim`

## Context

In Direct mode, a person shows a code and someone in front of them scans it. Anything visible on a screen can be photographed, recorded or viewed over a shoulder. If the code itself unlocked the file, every observer would get the file. The relay must also not be able to decrypt files, or to substitute its own key for the recipient's without detection.

## Decision

The code carries the right to **ask**, not the right to **read**.

1. The sender's client builds the Envelope, uploads ciphertext to the relay, and receives a `transfer_id` (128-bit random).
2. The client generates a **claim secret** `cs` (128-bit random). The relay stores only `H(cs)`.
3. The displayed code encodes `https://sealed.to/c/{transfer_id}#{base64url(cs)}`. The fragment is never sent to a server by browsers, so a scan in a generic camera app still keeps `cs` client-side when it opens the web receiver.
4. The receiver generates or loads its **device key** (ADR-0005) and submits `claim{transfer_id, cs, receiver_pub, device_label}`. The relay verifies `H(cs)`; in Direct mode it marks the claim secret consumed atomically (Durable Object, ADR-0012). A second claim is rejected.
5. Both screens display a **check code**: `SAS = HKDF(cs, salt=transfer_id, info="sealed/v1/sas" ∥ receiver_pub)` truncated to 20 bits and shown as six digits. The relay never learns `cs`, so it cannot compute a matching SAS for a substituted key.
6. The sender sees "Pixel 8 · Ana · 482 113 wants this file", compares the digits with the receiver's screen, and approves with Face ID or a passkey (user-verifying WebAuthn assertion).
7. On approval the sender's client wraps the CEK to `receiver_pub` with HPKE Base mode (`info = "sealed/v1/wrap" ∥ transfer_id`) and posts the wrap. The receiver downloads ciphertext and wrap, unwraps and decrypts.

**Room mode** differs only in claim policy: the claim secret is valid for a window (default 15 minutes) and a cap (default 200 devices); each claim creates its own pending approval and its own wrap. The presenter can auto-approve, approve in batches, or approve individually. Revoking a device deletes its wrap and download token; files already decrypted on that device cannot be recalled, and the UI says so.

Timeouts: unapproved claims expire after 120 seconds; transfers expire after 24 hours by default (configurable 10 minutes – 7 days).

## Alternatives considered

- **Key in the code.** Fast and works with any camera, but every observer can decrypt. Kept only as the `open` trust mode for Broadcast.
- **Numeric comparison only, no approval.** Removes a tap, but a distracted sender cannot stop a shoulder-surfer who scans first. Rejected for Direct; offered as Room auto-approve.
- **PAKE (e.g., CPace) over the claim secret.** Stronger against offline guessing, but `cs` is 128-bit random, so guessing is already infeasible. Rejected as unnecessary complexity.

## Consequences

- A screen recording of the code is useless after the first claim, and useless before it without sender approval.
- A malicious relay can deny service but cannot read files or impersonate a receiver without a visible check-code mismatch.
- The sender must be online at approval time; offline senders use Air-gap (ADR-0008).

## Verification

- `protocol/claim.replay`: second claim on a consumed Direct secret returns `409 claim_consumed`.
- `protocol/claim.race`: 1,000 concurrent claims against one Direct transfer produce exactly one accepted claim.
- `protocol/claim.mitm`: a test relay that swaps `receiver_pub` produces mismatched check codes on the two clients in 100% of runs.
- `protocol/claim.expiry`: clock-controlled tests for the 120 s claim and transfer TTLs.
- `protocol/room.cap`: claim 201 against a cap of 200 is rejected; revoked device's download token returns `410`.
