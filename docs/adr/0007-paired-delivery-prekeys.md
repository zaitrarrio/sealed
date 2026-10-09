# ADR-0007: Paired delivery with signed prekeys for forward secrecy

**Status:** Accepted · **Date:** 2026-10-09 · **Pairs with:** spec §6.4, test suite `paired/`

## Context

Paired contacts send files whenever they like, including while the recipient is offline. If every file were wrapped to the recipient's long-term device agreement key, a later compromise of that device key would expose every stored file still sitting on the relay. HPKE Base and Auth modes give sender-side ephemerality but not recipient-side forward secrecy.

## Decision

Each device publishes, through its sigchain:

- a **signed medium-term prekey** (P-256, rotated every 7 days, signed by the device signing key), and
- a pool of **signed one-time prekeys** (100 at a time, replenished below 20).

These prekey private keys are software keys wrapped at rest by the hardware device agreement key, because the Secure Enclave cannot import keys.

To send a file to a contact, the sender's client, for **each** of the contact's valid devices:

1. Fetches one one-time prekey (the relay hands each out once) or, if the pool is empty, the medium-term prekey.
2. Wraps the CEK with HPKE **Auth** mode from the sender's device agreement key to that prekey, `info = "sealed/v1/paired" ∥ transfer_id ∥ prekey_id`.
3. Signs the manifest with the sender's device signing key.

Recipients delete one-time prekey private keys immediately after unwrap, and medium-term prekeys 7 days after rotation. The ciphertext is uploaded once; only wraps fan out per device.

**Transport selection:** if any recipient device holds a live presence connection (ADR-0013), the sender offers a live WebRTC transfer; otherwise it uploads to the relay mailbox with a TTL of 30 days (configurable). The same Envelope bytes flow either way.

## Alternatives considered

- **Full Double Ratchet session.** Strong properties for message streams, but file sharing is infrequent and multi-device ratchet state is complex. Rejected for v1.
- **No prekeys (wrap to device key).** Simpler; loses forward secrecy for stored files. Rejected.

## Consequences

- Compromise of a device key alone does not decrypt past stored files whose one-time prekey was consumed and deleted.
- Prekey exhaustion falls back to the medium-term prekey, which bounds exposure to one rotation period.

## Verification

- `paired/fs`: after unwrap and prekey deletion, a test holding the device agreement key and all relay data cannot decrypt the CEK.
- `paired/fanout`: a contact with three devices receives three wraps; a revoked device receives none.
- `paired/exhaust`: with zero one-time prekeys, delivery succeeds via the medium-term prekey and the recipient replenishes on next launch.
