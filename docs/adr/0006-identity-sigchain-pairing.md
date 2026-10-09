# ADR-0006: Identity as a signed device chain; pairing in person

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §6.3, test suite `identity/`

## Context

Paired mode is a lasting private channel between two people, established once by meeting in person. People have several devices and replace phones. Device keys are hardware-bound (ADR-0005) and cannot be copied, so "a person" cannot be one key. Contacts must keep trusting each other across device changes without re-meeting, and a lost phone must stop receiving files.

## Decision

**Identity = an append-only, hash-linked chain of signed statements** (a *sigchain*, as popularized by Keybase). Each link contains: sequence number, previous link hash, statement, timestamp, and a signature by a device that is valid at that point in the chain.

Statements:

- `add_device{agreement_pub, signing_pub, label, attestation}` — signed by an existing device; the new device co-signs to prove possession.
- `revoke_device{signing_pub, reason}` — signed by any remaining valid device or the paper key.
- `add_paper_key{signing_pub}` — a recovery key generated on device, displayed once as a printable code, and never stored by Sealed.
- `rotate_prekeys{...}` — see ADR-0007.

The first link is created on the user's first device. The **identity fingerprint** is `SHA-256(link_0)`. The relay stores and serves chains but cannot forge links; clients verify the full chain on every update.

**Adding a device** requires an existing device: the new device shows a code, the old device scans it and signs `add_device`. No account password exists to phish.

**Pairing ceremony** (both people present):

1. A shows a code containing A's identity fingerprint, current chain head hash and a 128-bit pairing nonce `nA`.
2. B scans, then shows its own code with B's fingerprint, head and `nB`.
3. A scans B's code. Each client fetches the other's chain from the relay, verifies it matches the scanned fingerprint and head, and computes `SAS = HKDF(nA ∥ nB, info="sealed/v1/pair" ∥ fpA ∥ fpB)` as six digits.
4. Both confirm the digits match. Each client pins the other's fingerprint locally and signs a contact record (stored encrypted in the user's own sync blob, not visible to the relay).

A one-sided variant (B scans A, both confirm SAS) supports devices without cameras on one side.

After pairing, a contact's chain may change (new phone, revoked phone). Clients accept updates only when every link verifies back to the pinned fingerprint, and show a notice ("Ana added a new device: iPhone 17"). A chain fork or verification failure blocks sending and shows a hard warning, the same way Signal treats a safety-number change.

## Alternatives considered

- **Server-held identity with password recovery.** Familiar, but the server becomes able to add devices and therefore read future files. Rejected.
- **Single identity key synced via iCloud Keychain / Google Password Manager.** Works within one ecosystem, breaks Sealed's cross-platform premise, and moves trust to the cloud provider. Rejected.
- **MLS (RFC 9420) for two-person channels now.** Correct for groups; heavyweight for pairs. Deferred: two-person Paired uses ADR-0007; Teams/groups will adopt MLS.

## Consequences

- No passwords and no account recovery by Sealed staff — recovery is the paper key or another device. This must be explained plainly at onboarding.
- The relay learns who is paired with whom only to the extent it observes delivery metadata (ADR-0015); the contact list itself is end-to-end encrypted.

## Verification

- `identity/chain.verify`: generated chains with forged signatures, reordered links, broken hash links, or links signed by revoked devices are rejected.
- `identity/pairing.sas`: SAS values match across platforms for fixed inputs (golden vectors); differ when any fingerprint byte changes.
- `identity/fork`: two valid-looking heads from the same parent trigger the blocking warning.
- `identity/revoke`: after `revoke_device`, senders stop producing wraps for that device within one chain refresh.
