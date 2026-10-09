# 1. Overview

## 1.1 Purpose

This specification defines Sealed v1: the user-facing modes, the cryptographic design, the wire and optical formats, the relay services, the client platforms, the security model and the verification plan. It is the implementation reference for engineering and the review reference for security auditors. Architectural rationale lives in the ADR compendium; this document states *what* must be built, precisely enough to implement and test.

## 1.2 Product summary

Sealed moves files between people by showing a code on one screen and scanning it with another device. Files are end-to-end encrypted on the sender's device; the relay stores only ciphertext. When devices have a network, the code is a handshake and the bytes move at network speed. When they do not, the same screen streams the file itself through light using the Facet optical codec.

## 1.3 Design goals

1. **One scan, one tap.** A first-time recipient receives a file with one scan and no account; a sender approves with one biometric.
2. **Server-blind.** No component operated by Sealed can decrypt user content or forge a recipient.
3. **Possession is the credential.** Physical presence in front of a screen, confirmed by a check code, replaces addresses, links and phone numbers.
4. **Keys in hardware.** Decryption keys are non-exportable and gated by the owner's biometric where the platform allows.
5. **Graceful degradation.** Network first, light second, with the same file format and the same guarantees.
6. **Standards-based and auditable.** IETF and NIST primitives, published test vectors, one shared core.

## 1.4 Non-goals for v1

- Continuous sync of folders between devices.
- Group chats or messaging.
- Server-side content scanning of any kind.
- Desktop-native clients (desktop is served by the web client; native desktop follows in v1.x).

## 1.5 Conventions

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Byte strings are big-endian. `∥` denotes concatenation. `H()` is SHA-256. `HKDF(ikm, salt, info, L)` is HKDF-SHA256 (RFC 5869). Sizes use binary units (KiB, MiB). Throughput figures in KB/s mean 1,000 bytes per second.

# 2. Terminology

| Term | Definition |
|---|---|
| Sender | The person and device displaying a code and holding the plaintext. |
| Receiver | The person and device scanning the code and obtaining the file. |
| Envelope | The encrypted container for one transfer: manifest plus segmented payload (§8). |
| CEK | Content encryption key: 256-bit random key per Envelope. |
| Wrap | An HPKE encapsulation of the CEK to one recipient public key. |
| Claim secret (cs) | 128-bit one-time secret carried in a displayed code; grants the right to request a file. |
| Check code (SAS) | Six-digit short authentication string shown on both devices to detect substitution. |
| Device key | Hardware-bound P-256 key pair per app installation (agreement and signing). |
| Sigchain | Append-only signed log of a user's devices; defines identity (§6.3). |
| Identity fingerprint | SHA-256 of the first sigchain link. |
| Prekey | Signed P-256 public key published for forward-secret delivery (§6.4). |
| Relay | Sealed's server-blind backend (§9). |
| Facet | Sealed's screen-to-camera optical codec (§7). |
| Tier | A Facet density profile (T0–T3). |

# 3. Modes and user flows

## 3.1 Mode model

Every mode is a combination of a **transport** (stored, live, optical) and a **trust** mechanism (claim, pinned, reverse-optical, open). See ADR-0001.

| Mode | Pitch | Transport | Trust | Recipients | Network |
|---|---|---|---|---|---|
| Direct | Hand a file to the person in front of you | stored (optical fallback) | claim | 1 | both online |
| Room | Share with everyone present at once | stored | claim, multi-use | up to cap | both online |
| Paired | Pair once in person, share privately forever | live or stored | pinned | contact's devices | either |
| Air-gap | Move files where networks are not allowed | optical | reverse-optical or pinned | 1 | none required |
| Broadcast | If you can see the screen, you get the file | optical | open, publisher-signed | anyone in view | none required |

## 3.2 User-visible actions

The interface offers two primary actions; the client resolves the mode.

| Action | Condition | Resolved mode |
|---|---|---|
| Share | first claim on a transfer | Direct |
| Share | sender enables "Let a room join" or a second device claims before approval | Room |
| Share to contact | recipient is a pinned contact | Paired |
| Share offline | sender camera available | Air-gap (secure) |
| Share offline | no sender camera, or sender chooses "Anyone watching" | Broadcast (open) |

If Direct or Room cannot reach the relay within 5 seconds, the client offers Share offline with the same selection.

## 3.3 Direct flow (happy path)

1. Sender selects files (local, camera roll, Google Drive, other source).
2. Sender taps Share; client builds and encrypts the Envelope and begins uploading. The code appears as soon as the transfer ID exists; upload continues in the background.
3. Receiver scans with the Sealed app, or with any camera app (which opens the web receiver).
4. Both screens show the same six-digit check code. Sender sees the receiver's device label and whether its key is hardware-protected.
5. Sender approves with Face ID, fingerprint or passkey.
6. Receiver's progress bar runs; the file is saved inside Sealed's protected storage, with an Export action.

Target: scan to approval prompt in under 1.5 s at p50 on LTE (§13).

## 3.4 Room flow

Sender enables "Let a room join", optionally sets a window (default 15 min) and cap (default 200), and chooses Approve each, Approve in batches, or Auto-approve. The code stays on screen (for example on a projector). The sender's device shows a live list of joined devices with per-device revoke.

## 3.5 Paired flow

Pairing: two people tap Pair, scan each other's codes (or one scans and both compare the check code), confirm the six digits, and the contact appears in both apps. Sending: choose a contact, pick files, send. Recipient devices receive a push notification; if any is online the transfer runs live, otherwise it waits in their mailbox for up to 30 days.

## 3.6 Air-gap flow

Sender taps Share offline. The receiver (which may be in airplane mode or on a disconnected device) taps Receive offline and shows a small key code; the sender's camera scans it. Both show a check code. The sender's screen then streams Facet frames; the receiver points its camera until the coverage display reaches 100%. If the receiver is a pinned contact, the key-code step is skipped.

## 3.7 Broadcast flow

Sender taps Share offline → Anyone watching. The stream begins immediately and loops. Each receiver captures independently and may join at any time. If the publisher has a published identity (for example an agency), receivers show "Signed by" with the publisher's verified name; otherwise "Unsigned broadcast."

# 4. System architecture

## 4.1 Components

| Component | Technology | Responsibility |
|---|---|---|
| `sealed-core` | Rust 2024 | Envelope, crypto, protocol state machines, sigchain verification |
| `sealed-facet` | Rust + WGSL (wgpu) | Optical encoder and decoder, calibration, FEC |
| `@sealed/core` | WASM + TypeScript | Web binding of the core, runs in a Worker |
| `SealedKit` / `sealed-android` | UniFFI bindings | Swift and Kotlin bindings; platform KeyStore and capture |
| Web app | TypeScript, Vite, React | Sender and receiver UI for browsers |
| iOS app | Swift, SwiftUI, AVFoundation, CryptoKit | Native client with Secure Enclave keys and high-fps capture |
| Android app | Kotlin, Compose, CameraX, Keystore | Native client with StrongBox/TEE keys |
| Relay | Cloudflare Workers, Durable Objects, R2, D1, Queues, Realtime TURN | Ciphertext storage, claims, identities, signaling |
| Self-hosted relay | `workerd`, MinIO, SQLite or Postgres, coturn | Same relay code for isolated networks |

## 4.2 Data flow (Direct)

```
 Sender device                         Relay (blind)                    Receiver device
 ─────────────                         ─────────────                    ───────────────
 select files ─► build Envelope
 CEK ─► encrypt segments ── upload ──► R2: ciphertext
 cs ─► display code (fragment)        TransferDO: H(cs)
                                                         ◄── scan code ── read cs
                                       verify H(cs),     ◄── claim{cs, receiver_pub}
 ◄── WebSocket: claim pending ──────── consume claim
 show SAS + label                                                        show SAS
 biometric approve
 wrap = HPKE(CEK → receiver_pub) ────► store wrap ─── approved + token ─►
                                                         ◄── GET segments, wrap
                                                                         unwrap (biometric)
                                                                         decrypt, verify
```

## 4.3 Trust boundaries

1. **Device secure hardware** — holds device private keys; trusted.
2. **Sealed app process** — handles plaintext and CEKs in memory; trusted while the OS is uncompromised.
3. **Relay** — untrusted for confidentiality and authenticity; trusted only for availability.
4. **Network and TURN** — untrusted.
5. **Optical channel** — public; anything displayed is assumed observed.
6. **Cloud sources (Google Drive etc.)** — trusted by the user for their own files; Sealed accesses only user-picked items.

# 5. Cryptography

## 5.1 Algorithms

| Function | Algorithm | Parameters |
|---|---|---|
| KEM | DHKEM(P-256, HKDF-SHA256) | HPKE KEM ID 0x0010 |
| KDF | HKDF-SHA256 | HPKE KDF ID 0x0001 |
| AEAD (wraps) | AES-256-GCM | HPKE AEAD ID 0x0002 |
| AEAD (content) | AES-256-GCM, STREAM | 1 MiB segments, 12-byte nonce |
| Signature | ECDSA P-256 / SHA-256 | RFC 6979 deterministic, DER on wire, low-S normalized |
| Hash | SHA-256 | — |
| Random | OS CSPRNG | `getrandom` / `crypto.getRandomValues` / `SecRandomCopyBytes` |

A `fips` build MUST link the AWS-LC FIPS module for all software primitives. Point encodings: uncompressed SEC1 (65 bytes) in HPKE `enc`; compressed SEC1 (33 bytes) in codes and sigchain links where space matters.

## 5.2 Key inventory

| Key | Type | Location | Lifetime | Purpose |
|---|---|---|---|---|
| Device agreement key (DAK) | P-256 | Secure Enclave / StrongBox / TEE / WebCrypto non-extractable | install | HPKE recipient; wraps local at-rest keys |
| Device signing key (DSK) | P-256 | same | install | Sigchain links, manifests, signaling, request auth |
| Medium-term prekey (MPK) | P-256 | software, wrapped by DAK | 7 days | Paired fallback recipient |
| One-time prekeys (OPK) | P-256 | software, wrapped by DAK | until used | Paired forward secrecy |
| Paper key | P-256 signing | printed by user only | until revoked | Recovery: revoke and add devices |
| CEK | 256-bit | memory; wrapped only | per Envelope | Content key |
| Local file key | 256-bit | wrapped by DAK | per received file | At-rest protection of received files |
| Claim secret | 128-bit | code fragment; relay stores hash | ≤ transfer TTL | Right to request |

Hardware gating per ADR-0005: iOS `.biometryCurrentSet` (user may relax to `.userPresence`), Android `setUserAuthenticationRequired(true)` with `AUTH_BIOMETRIC_STRONG | AUTH_DEVICE_CREDENTIAL`, web WebAuthn assertion with `userVerification: "required"`.

## 5.3 Derivations

All derivations use HKDF-SHA256 with the following labels. `transfer_id` is 16 bytes.

| Output | ikm | salt | info | L |
|---|---|---|---|---|
| Payload key PK | CEK | `transfer_id` | `"sealed/v1/payload"` | 32 |
| Manifest key MK | CEK | `transfer_id` | `"sealed/v1/manifest"` | 32 |
| Direct/Room SAS | cs | `transfer_id` | `"sealed/v1/sas" ∥ receiver_pub(33)` | 3 |
| Pairing SAS | nA ∥ nB | empty | `"sealed/v1/pair" ∥ fpA ∥ fpB` (fingerprints sorted) | 3 |
| Air-gap SAS | rn | `stream_id` | `"sealed/v1/airgap" ∥ receiver_pub(33) ∥ sender_pub(33)` | 3 |
| Local file key | random | — | — | 32 |

## 5.4 HPKE wraps

| Context | Mode | Sender key | Recipient key | info |
|---|---|---|---|---|
| Direct, Room | Base | ephemeral | receiver DAK | `"sealed/v1/wrap" ∥ transfer_id` |
| Paired | Auth | sender DAK | recipient OPK or MPK | `"sealed/v1/paired" ∥ transfer_id ∥ prekey_id` |
| Air-gap reverse-optical | Base | ephemeral | receiver DAK | `"sealed/v1/airgap" ∥ stream_id` |
| Air-gap pinned | Auth | sender DAK | recipient DAK | `"sealed/v1/airgap" ∥ stream_id` |

HPKE `aad` is empty; `info` binds context. Plaintext is the 32-byte CEK. A wrap is serialized as CBOR `{1: kem_id, 2: kdf_id, 3: aead_id, 4: enc, 5: ct, 6: recipient_key_id}` where `recipient_key_id = H(recipient_pub_compressed)[0..8]`.

## 5.5 Signed objects

Signatures cover a domain-separated digest: `sig = ECDSA(DSK, H("sealed/v1/sig/" ∥ type ∥ 0x00 ∥ canonical_cbor(object)))`. Types: `manifest`, `link`, `prekey`, `signal`, `broadcast`, `request`.

## 5.6 Short authentication strings

A SAS is the first 20 bits of the HKDF output interpreted big-endian, rendered as a six-digit decimal number zero-padded (values 0–1,048,575 rendered modulo 1,000,000 — the 4.6% bias is accepted), displayed as two groups of three digits ("482 113"). An attacker who substitutes a key must match a 20-bit value chosen after the substitution is fixed; success probability per attempt is about 1 in 1,000,000, and each failure is visible to both users.

# 6. Protocols

## 6.1 Direct

### 6.1.1 Create

`POST /v1/transfers`

```json
{
  "mode": "direct",
  "claim_hash": "base64url(H(cs))",
  "size_bucket": 3145728,
  "segments": 3,
  "ttl_seconds": 86400,
  "sender_auth": "<WebAuthn assertion over transfer request>"
}
```

Response `201`:

```json
{
  "transfer_id": "base64url(16 bytes)",
  "upload": { "kind": "r2-multipart", "upload_id": "…", "part_urls": ["…"] },
  "sender_ws": "wss://relay.sealed.to/v1/transfers/{id}/ws?token=…"
}
```

The client MUST display the code before upload completes. Displayed code content:

`https://sealed.to/c/{transfer_id}#{base64url(cs)}`

encoded as a QR code (version chosen by length, EC level M). The Sealed app registers universal links / app links for `sealed.to/c/*` so native receivers open directly; other cameras open the web receiver, which reads the fragment client-side.

### 6.1.2 Claim

Receiver `POST /v1/transfers/{id}/claims`

```json
{
  "cs": "base64url(16 bytes)",
  "receiver_pub": "base64url(33 bytes, DAK compressed)",
  "receiver_sig_pub": "base64url(33 bytes, DSK compressed)",
  "label": "Pixel 8",
  "key_protection": "strongbox | secure-enclave | tee | browser",
  "attestation": "base64url(optional platform attestation)"
}
```

The TransferDO MUST compare `H(cs)` in constant time, and in Direct mode MUST atomically transition `claim_state: open → consumed`. Response `202 {"claim_id": "…", "status": "pending", "receiver_ws": "…"}`; replays return `409 claim_consumed`; unknown or expired transfer returns `404`.

The TransferDO pushes to the sender: `{"event":"claim","claim_id":…,"receiver_pub":…,"label":…,"key_protection":…}`.

### 6.1.3 Approve

Both clients compute the SAS (§5.3). The sender UI MUST show label, key protection and SAS, and require user verification. Then:

`POST /v1/transfers/{id}/claims/{claim_id}/approve`

```json
{ "wrap": "base64url(cbor wrap)", "sender_auth": "<WebAuthn assertion>" }
```

The relay stores the wrap and issues the receiver a download token (opaque, 256-bit, scoped to this claim, expiring with the transfer). Deny: `POST …/deny`. Unanswered claims expire after 120 s and the code becomes claimable again only if the sender regenerates `cs`.

### 6.1.4 Download

`GET /v1/transfers/{id}/manifest`, `GET /v1/transfers/{id}/segments/{n}`, `GET /v1/transfers/{id}/claims/{claim_id}/wrap`, each with `Authorization: Bearer {download_token}`. Segments MAY be fetched in parallel (default 4 concurrent). The receiver unwraps the CEK once (one biometric prompt), decrypts the manifest, verifies the sender signature if present, then streams segments to protected storage, verifying each tag.

### 6.1.5 Optical fallback

If the receiver cannot reach the relay but the sender can, the sender MAY switch the displayed code to an Air-gap stream (§6.5) for the same Envelope, using the reverse key code to bind the receiver.

## 6.2 Room

Identical to Direct except:

| Field | Room behavior |
|---|---|
| `mode` | `"room"` |
| `room.window_seconds` | default 900, max 3600 per window, renewable by sender |
| `room.cap` | default 200, max 1,000 (Teams), 5,000 (Enterprise) |
| `room.approval` | `each`, `batch`, `auto` |
| Claim state | `open` until window end or cap; each claim gets its own `claim_id` and wrap |
| Revocation | `DELETE /v1/transfers/{id}/claims/{claim_id}` deletes wrap and token; `410` thereafter |

In `auto` mode the sender's client wraps automatically on each claim event while the sender's session remains unlocked; the SAS is shown in the joined-device list for spot checks. A Room transfer's TTL MUST NOT exceed 7 days.

## 6.3 Identity and pairing

### 6.3.1 Sigchain links

A link is deterministic CBOR:

```
link = {
  1: seq,               ; uint, 0 for the first link
  2: prev,              ; bstr(32) H(prev link) or null for seq 0
  3: ts,                ; uint seconds
  4: statement,         ; map, see below
  5: signer,            ; bstr(33) DSK or paper key public key
  6: sig                ; bstr ECDSA over the link without field 6
}
statement = add_device{agreement_pub, signing_pub, label, attestation?, cosig}
          | revoke_device{signing_pub, reason}
          | add_paper_key{signing_pub}
          | revoke_paper_key{signing_pub}
          | rotate_mpk{device, mpk_pub, mpk_id, expires}
```

Rules: link 0 MUST be `add_device` self-signed by that device. `cosig` in `add_device` is the new device's signature over the statement, proving possession. A signer MUST be valid (added and not revoked) as of `seq − 1`. Clients MUST verify the entire chain from link 0, or from a locally cached verified head, on every update. A chain with two different links at the same `seq` is a fork and MUST block delivery to that identity.

### 6.3.2 Pairing codes

Pairing code payload (QR, EC level M): `sealed-pair:1:{base64url(fp)}:{base64url(head_hash)}:{base64url(n)}` where `n` is a 16-byte nonce.

### 6.3.3 Ceremony

1. A displays its pairing code; B scans and fetches A's chain via `GET /v1/identities/{fpA}/chain`, verifying `H(link_0) = fpA` and that the head matches.
2. B displays its pairing code; A scans and verifies likewise.
3. Both compute the pairing SAS (§5.3) and display it; each user confirms the match on their own device.
4. Each client stores a contact record `{fp, display_name, pinned_head, paired_at}` in its encrypted sync blob and posts nothing about the pairing to the relay.

One-sided variant: only B scans A; B posts `{nB, fpB, head}` to A through A's identity mailbox, signed by B's DSK; A verifies B's chain and both compare the SAS. This variant MUST require SAS confirmation on both sides because the return path is relay-mediated.

### 6.3.4 Adding a device

The new device creates its key pairs and shows `sealed-add:1:{agreement_pub}:{signing_pub}:{nonce}`. An existing device scans, shows the SAS of the two public keys, collects the new device's cosignature over the relay, appends `add_device`, and posts the link. The new device downloads the user's encrypted sync blob, re-encrypted by the existing device to the new DAK.

### 6.3.5 Recovery

The paper key is generated during onboarding (strongly encouraged, skippable) and shown once as a printable QR plus 24-word BIP-39-style encoding. With all devices lost, a fresh install scans or types the paper key, signs `add_device` for itself and `revoke_device` for lost devices. The sync blob is encrypted to a key derived from the paper key as well, so contacts survive recovery. Without a paper key or a remaining device, the identity is unrecoverable by design.

## 6.4 Paired delivery

### 6.4.1 Prekeys

Each device maintains 100 OPKs (replenish below 20) and one MPK (rotate every 7 days, previous MPK retained 7 days for in-flight deliveries). `POST /v1/identities/{fp}/devices/{dsk_id}/prekeys` uploads signed OPKs. `POST /v1/identities/{fp}/prekeys/claim {devices: [...]}` returns, per device, one OPK (removed from the pool atomically by the identity Durable Object) or the MPK with `"fallback": true`.

### 6.4.2 Stored delivery

1. Sender builds and encrypts the Envelope, signs the manifest, uploads ciphertext (`mode: "paired"`).
2. Sender claims prekeys for each valid recipient device and for the sender's own other devices (so the sent item appears on them).
3. Sender posts `POST /v1/mailbox/{fp_recipient} {transfer_id, wraps: [{device_id, prekey_id, wrap}]}` signed by its DSK.
4. The recipient identity DO stores the entry and sends push notifications (APNs, FCM, Web Push) containing only `transfer_id`.
5. Recipient device fetches its wrap, unwraps (Auth mode verifies the sender's DAK from the pinned chain), deletes the used OPK private key, downloads and decrypts.

### 6.4.3 Live delivery

If the recipient's presence socket reports a device online, the sender sends a signed `offer` through the recipient identity DO containing SDP, ICE candidates and the DTLS fingerprint. The recipient verifies the signature against the pinned chain and answers. Envelope segments flow over a reliable ordered data channel (64 KiB messages). If ICE fails or no progress occurs for 15 s, both sides switch to stored delivery transparently. TURN credentials are short-lived (10 min) and issued per session via Cloudflare Realtime TURN.

## 6.5 Air-gap (secure)

1. Receiver taps Receive offline; generates a 16-byte nonce `rn` and displays the **reverse key code**: `sealed-rk:1:{base64url(receiver_pub)}:{base64url(rn)}:{capability_tier}:{label}`.
2. Sender's camera scans it. Sender generates `stream_id` (4 bytes random) and computes the Air-gap SAS; the sender's first Facet descriptor frame carries `sender_pub` and `stream_id` so the receiver computes the same SAS. Both screens display it; the sender confirms after the receiver shows a matching value.
3. Sender wraps the CEK to `receiver_pub` (Base mode, or Auth mode if the receiver is a pinned contact and the sender has its own DAK) and begins streaming Facet frames for the Envelope at the negotiated tier.
4. Receiver decodes descriptor frames (wrap, OTI, encrypted manifest), then data frames, recovers source blocks via RaptorQ, decrypts segments as each 1 MiB segment completes, and verifies.

If the sender has no camera, Air-gap secure is unavailable unless the receiver is a pinned contact, in which case the sender wraps to the receiver's known DAK and no reverse code is needed.

## 6.6 Broadcast (open)

The Envelope is still encrypted (uniform format), but the CEK is carried in clear in the descriptor frame, so anyone who captures the stream can decrypt. If the publisher has an identity, the descriptor frame carries a signature over the manifest digest and the publisher's chain head; receivers that have the publisher pinned (or that can reach the relay to fetch the chain) display "Signed by {name}". Receivers without either display "Signature present, publisher not verified." The client MUST warn before starting a Broadcast that anyone in view can receive the file.

## 6.7 Sources

The `Source` interface: `list(selection) → entries`, `read_stream(entry) → bytes`, `export(entry, format) → bytes`. Google Drive uses the Picker API with `drive.file` scope only; Google-native documents export to PDF or Office formats chosen by the sender. OneDrive (Graph + File Picker v8), Dropbox (Chooser) and the system document pickers follow the same pattern. All reads happen on the sender's client; OAuth tokens never reach the relay. The pipeline streams source → zstd → STREAM encrypt → multipart upload with a 16 MiB working set.

# 7. Facet optical codec

## 7.1 Overview

A Facet stream is a sequence of frames displayed full-screen on the sender. Frame types: **calibration**, **descriptor**, **data**, **end-of-stream marker** (Broadcast loops instead). T0 frames are standard QR codes; T1–T3 frames use the Facet grid.

## 7.2 Grid geometry (T1–T3)

| Element | Specification |
|---|---|
| Grid | N × N cells; N = 112 (T1, T2) or 144 (T3) |
| Quiet zone | 2 cells of background on all sides (outside N) |
| Anchors | 8 × 8 cells at each corner: concentric square rings; ring count 3/4/5/6 identifies TL/TR/BR/BL |
| Header strips | rows 0–1 and rows N−2…N−1, columns 9…N−10; 1 bit per cell, black/white |
| Data region | all remaining cells |
| Background | #0B0908 (warm near-black) |
| Minimum display size | 6 px per cell on the sender's screen; client chooses largest integer cell size that fits |

Capacity per frame:

| Tier | Data cells | Bits/cell | Raw bytes | RS codewords | Payload T (bytes) |
|---|---|---|---|---|---|
| T1 | 11,912 | 6 | 8,934 | 35 | 7,240 |
| T2 | 11,912 | 7 | 10,423 | 40 | 8,280 |
| T3 | 19,976 | 7 | 17,479 | 68 | 14,072 |

Unused bits after the last codeword are filled with a PRNG pattern seeded by `stream_id ∥ frame counter` to keep color statistics uniform.

## 7.3 Tiers and timing

| Tier | Refresh holds @ 60 Hz | Data fps | Raw payload rate | Target goodput (15% loss) | Default receivers |
|---|---|---|---|---|---|
| T0 | 6 | 10 | 8.4 KB/s | 6–8 KB/s | any QR decoder |
| T1 | 6 | 10 | 72.4 KB/s | ≈ 60 KB/s | web receivers |
| T2 | 4 | 15 | 124 KB/s | ≈ 105 KB/s | native, 60 fps capture |
| T3 | 3 | 20 | 281 KB/s | ≈ 240 KB/s | native, ≥ 120 fps capture |

On 120 Hz displays hold counts double. The sender MUST render via `requestAnimationFrame` (web) or `CADisplayLink`/`Choreographer` (native) and count presented frames, not timers. Targets are revised from corpus measurements at milestone M1 (§16).

## 7.4 Symbol alphabet

Each data cell carries `b_c` color bits and 4 shape bits.

- **Shapes:** 16 glyphs drawn inside the cell at 80% of cell size: filled square, filled circle, four quarter-triangles, two half-bars (horizontal/vertical), plus, cross, ring, four corner-dots patterns, diamond. Final glyph set is selected by maximizing minimum Hamming-like distance of downsampled 4×4 luminance templates under blur σ = 0.6 cell.
- **Colors:** T1 uses 4 colors (`b_c` = 2), T2/T3 use 8 (`b_c` = 3). Initial candidates in sRGB: cyan #00E5FF, magenta #FF2BD6, yellow #FFE600, white #F5F5F5 (T1); plus red #FF3B30, green #34FF5C, blue #2F6BFF, amber #FF9F0A (T2/T3). The palette is finalized by optimizing minimum ΔE2000 after calibration across the corpus.
- Bit order within a cell: color bits are most significant.
- Cell order: data cells are filled in a fixed pseudo-random permutation (seeded by tier ID) so RS codewords interleave spatially.

## 7.5 Error correction and framing

**Frame header** (12 bytes, RS(20,12) over GF(256), written in both header strips):

| Byte | Field | Notes |
|---|---|---|
| 0 | magic (high nibble 0xF) ∥ version (low nibble, 1) | |
| 1 | tier (3 bits) ∥ frame type (3 bits) ∥ flags (2 bits) | types: 0 calibration, 1 descriptor, 2 data, 3 end; flags: loop, signed |
| 2–5 | stream_id | random per stream |
| 6 | SBN | RaptorQ source block number |
| 7–9 | ESI | RaptorQ encoding symbol ID |
| 10–11 | CRC-16/CCITT-FALSE | over bytes 0–9 and the first 64 data bytes |

**Inner code:** data bytes are split into RS(255,207) codewords; codeword bytes are assigned to cells by the permutation in §7.4.

**Outer code:** RaptorQ (RFC 6330) with symbol size T from §7.2, alignment Al = 8, one encoding symbol per data frame. Source blocks hold up to 8 Envelope segments (≤ 8 MiB + manifest). The sender emits all source symbols of block 0, then interleaves source symbols of the next block with repair symbols of previous blocks in a 3:1 ratio, then repair symbols round-robin. The Object Transmission Information (F, T, Z, N, Al) is carried in descriptor frames.

**Descriptor frame payload** (CBOR, padded to T): `{1: stream_id, 2: OTI, 3: tier, 4: sender_pub?, 5: wrap? | cek? (Broadcast), 6: encrypted manifest, 7: signature?, 8: chain_head?}`. Descriptor frames are sent at stream start (3 times) and then every 32 frames.

**Calibration frame:** the data region is tiled with every palette color in each shape, in a known layout, plus gray ramps. Sent first (3 times) and every 64 frames.

## 7.6 Capture and decode pipeline

1. **Acquire** raw frames (AVCaptureVideoDataOutput, CameraX ImageAnalysis, MediaStreamTrackProcessor or rVFC + OffscreenCanvas). Never via a video encoder.
2. **Detect anchors** at reduced resolution (live pass, every frame), estimate homography.
3. **Decode headers** from both strips; accept the first strip that RS-decodes and passes CRC. Update coverage UI.
4. **Rectify** the data region on GPU into an N × N × 4-sample buffer.
5. **Color-correct** with the 3×3 matrix and per-channel gamma fitted from the latest calibration frame.
6. **Classify** each cell: color by nearest calibrated centroid in Lab; shape by correlation against 16 templates. Emit hard decisions plus per-cell confidence.
7. **RS-decode** codewords, using low-confidence cells as erasures (up to 48 erasures, or 24 errors, per codeword).
8. **Fuse:** if the same (SBN, ESI) is captured more than once, combine per-cell confidences before decoding (temporal fusion).
9. **Salvage torn frames:** if header CRCs of top and bottom strips disagree, split the frame by scanline at the transition estimate and decode each part against its own header's permutation.
10. **RaptorQ-decode** each source block once K′ + 2 symbols are held; decrypt and verify the completed segments.

The heavy pass runs on a ring buffer of rectified data regions (≈ 0.5 MB per frame at T2, budget 300 MB native, 120 MB web), dropping frames whose (SBN, ESI) is already decoded.

## 7.7 Capability negotiation

During the first second of capture the receiver measures delivered fps, resolution at the code's location, and GPU decode time per frame, and selects the highest tier whose requirements it meets:

| Tier | Min capture fps | Min px per cell at sensor | Max decode ms/frame (heavy pass, amortized) |
|---|---|---|---|
| T1 | 24 | 4.0 | 90 |
| T2 | 50 | 4.5 | 60 |
| T3 | 110 | 5.0 | 45 |

Reporting: via relay when online; via the reverse key code's `capability_tier` field in Air-gap; not at all in Broadcast, where the sender interleaves T1 and T0 frames for the same stream (2:1), so web receivers and constrained receivers both make progress.

# 8. Envelope format

## 8.1 Layout

```
Envelope := header ∥ sealed_manifest ∥ sealed_segment[0..n-1]
header   := "SEAL" ∥ version(u8=1) ∥ flags(u8) ∥ transfer_id(16) ∥ manifest_len(u32)
sealed_manifest := AES-256-GCM(MK, nonce=0^12, aad=header, manifest_cbor)
sealed_segment[i] := AES-256-GCM(PK, nonce=u88_be(i) ∥ last_flag(u8), aad=header, segment_i)
```

Segment plaintext size is 1 MiB except the last. The ciphertext is padded with trailing random bytes after the last segment to the size bucket; `manifest.payload_len` gives the true length.

## 8.2 Manifest (deterministic CBOR)

| Key | Field | Type |
|---|---|---|
| 1 | version | uint (1) |
| 2 | transfer_id | bstr(16) |
| 3 | created | uint seconds |
| 4 | expires | uint seconds |
| 5 | files | array of {1: path (UTF-8, `/`-separated, NFC), 2: size, 3: media_type, 4: sha256, 5: mtime?} |
| 6 | compression | 0 none, 1 zstd |
| 7 | segment_size | uint (1,048,576) |
| 8 | segment_count | uint |
| 9 | payload_len | uint (compressed length) |
| 10 | sender | {1: fp?, 2: signing_pub, 3: label}? |
| 11 | signature | bstr? over keys 1–10 (§5.5, type `manifest`) |
| 12 | source | {1: kind ("local", "gdrive", …)}? |

Paths MUST be validated on extraction: no absolute paths, no `..` segments, no NUL, maximum 4,096 bytes, maximum 10,000 entries. Receivers MUST reject manifests failing these rules.

## 8.3 Size buckets

64 KiB, 256 KiB, 1 MiB, then powers of two to 1 GiB, then 256 MiB steps to the plan maximum (Free 2 GiB, Plus 20 GiB, Teams 50 GiB, Enterprise configurable).

# 9. Relay

## 9.1 Services

| Service | Implementation | State |
|---|---|---|
| API | Workers (Hono, TypeScript) | stateless |
| TransferDO | Durable Object per transfer | claim state, approvals, sender/receiver sockets |
| IdentityDO | Durable Object per identity fingerprint | prekey pool, mailbox index, presence, signaling |
| Object store | R2 bucket `sealed-transfers` | ciphertext, wraps; lifecycle expiry |
| Metadata DB | D1 | identities, chains, devices, accounts, plans |
| Jobs | Queues + Cron Triggers | expiry sweeps, abuse signals, prekey low-water alerts |
| TURN | Cloudflare Realtime TURN | short-lived credentials |
| Push | APNs, FCM, Web Push from Workers | transfer IDs only |

## 9.2 API summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /v1/transfers | account + device sig | create transfer |
| PUT | (presigned R2 part URLs) | presigned | upload ciphertext |
| POST | /v1/transfers/{id}/finalize | device sig | complete upload |
| GET | /v1/transfers/{id}/ws | sender token | claim events |
| POST | /v1/transfers/{id}/claims | claim secret | submit claim |
| GET | /v1/claims/{claim_id}/ws | claim token | approval events |
| POST | /v1/transfers/{id}/claims/{cid}/approve | account + device sig + UV | post wrap |
| POST | /v1/transfers/{id}/claims/{cid}/deny | account + device sig | deny |
| DELETE | /v1/transfers/{id}/claims/{cid} | account + device sig | revoke (Room) |
| GET | /v1/transfers/{id}/manifest, /segments/{n}, /claims/{cid}/wrap | download token | download |
| POST | /v1/identities | device sig (link 0) | create identity |
| GET | /v1/identities/{fp}/chain?since={seq} | none | fetch chain |
| POST | /v1/identities/{fp}/links | device sig | append link |
| POST | /v1/identities/{fp}/devices/{d}/prekeys | device sig | upload prekeys |
| POST | /v1/identities/{fp}/prekeys/claim | device sig | claim prekeys for delivery |
| POST | /v1/mailbox/{fp} | device sig | deliver wraps |
| GET | /v1/mailbox | device sig | list pending deliveries |
| GET | /v1/presence/ws | device sig | presence and signaling |
| POST | /v1/reports | receiver token or device sig | abuse report |

**Device-signed requests:** header `Sealed-Signature: keyid={dsk_id}, ts={unix}, sig={b64url}` where the signature covers `H(method ∥ path ∥ ts ∥ H(body))` with type `request`; the relay rejects timestamps outside ±120 s and replayed signatures (5-minute nonce cache in the DO).

**Accounts:** sender accounts authenticate with passkeys (WebAuthn) bound to `sealed.to`. An account links to an identity fingerprint. Receivers need no account for Direct and Room.

## 9.3 D1 schema (v1)

```sql
CREATE TABLE identities (fp BLOB PRIMARY KEY, created_at INTEGER NOT NULL, head_seq INTEGER NOT NULL, head_hash BLOB NOT NULL);
CREATE TABLE links (fp BLOB NOT NULL, seq INTEGER NOT NULL, hash BLOB NOT NULL, body BLOB NOT NULL, PRIMARY KEY (fp, seq));
CREATE TABLE devices (fp BLOB NOT NULL, dsk_id BLOB NOT NULL, dak_pub BLOB NOT NULL, dsk_pub BLOB NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','revoked')), PRIMARY KEY (fp, dsk_id));
CREATE TABLE accounts (account_id BLOB PRIMARY KEY, fp BLOB UNIQUE, plan TEXT NOT NULL, created_at INTEGER NOT NULL, org_id BLOB);
CREATE TABLE passkeys (credential_id BLOB PRIMARY KEY, account_id BLOB NOT NULL, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL);
CREATE TABLE transfers (transfer_id BLOB PRIMARY KEY, account_id BLOB NOT NULL, mode TEXT NOT NULL, size_bucket INTEGER NOT NULL, created_hour INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE orgs (org_id BLOB PRIMARY KEY, name TEXT NOT NULL, policy BLOB NOT NULL);
CREATE INDEX transfers_expiry ON transfers(expires_at);
```

Claims, prekey pools and mailbox entries live in Durable Object storage, not D1, for single-writer consistency.

## 9.4 Storage lifecycle

R2 objects carry a `expires` custom metadata field; a lifecycle rule deletes objects older than 8 days, and the hourly sweeper deletes objects past `expires` sooner. Wraps are deleted on revocation, on transfer expiry, and (Direct) 1 hour after the receiver confirms completion.

## 9.5 Self-hosted relay

Docker Compose stack: `workerd` running the relay bundle, MinIO (R2-compatible via S3 API), SQLite (single node) or Postgres (HA) via a D1-compatible adapter, coturn for TURN, and an optional local push gateway. Supports air-gapped installation from an offline bundle with SHA-256 manifest signed by Sealed's release key.

# 10. Clients

## 10.1 Platform capability matrix

| Capability | iOS native | Android native | Web (Chromium, Android) | Web (Safari, iOS) | Web desktop |
|---|---|---|---|---|---|
| Hardware device key | Secure Enclave | StrongBox / TEE | No (non-extractable WebCrypto) | No | No |
| Biometric gate | Face ID / Touch ID | BiometricPrompt | WebAuthn UV | WebAuthn UV | WebAuthn UV |
| Send Direct/Room/Paired | Yes | Yes | Yes | Yes | Yes |
| Receive Direct/Room/Paired | Yes | Yes | Yes | Yes | Yes |
| Facet send (any tier) | Yes | Yes | Yes | Yes | Yes |
| Facet receive tier | T3 (≥ 120 fps devices), else T2 | T2–T3 by device | T1 | T1 or T0 | T1 (webcam) |
| Reverse key code scan (sender camera) | Yes | Yes | Yes | Yes | Webcam |
| Background download | Yes (URLSession background) | Yes (WorkManager) | Tab open | Tab open | Tab open |

## 10.2 Protected storage

Received files are stored encrypted under per-file local keys wrapped by the DAK. iOS: app container with `NSFileProtectionComplete`; Android: app-private storage; web: OPFS with keys in IndexedDB. Export writes a plaintext copy to the system share sheet or Files and is logged locally.

## 10.3 Accessibility and design

All flows MUST be completable with VoiceOver/TalkBack. Check codes are read aloud in groups. Facet streams pause on reduce-motion settings until the user confirms, and display a static warning about flashing content; frame transitions avoid full-screen luminance flashes above 3 Hz by holding the background constant and limiting luminance change in the data region.

# 11. Security model

## 11.1 Assets

User file contents; file metadata (names, types, counts, sizes); identity relationships; device keys; availability of transfers.

## 11.2 Adversaries

| Adversary | Capability |
|---|---|
| Observer | sees or records any displayed code or stream |
| Network attacker | full control of networks between devices and relay |
| Malicious relay | full control of Sealed servers, storage and TURN |
| Lost-device finder | holds a locked or unlocked device |
| Malicious recipient | legitimately receives a file, then acts badly |
| Abuser | uses Sealed to distribute harmful content |

## 11.3 Threats and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Observer photographs a Direct code | Claim secret is one-time; approval with SAS required; observer's claim is visible to sender | Sender approves without checking SAS |
| Observer races the intended recipient | First claim wins and is shown with label and SAS; sender denies and regenerates | Minor delay |
| Relay substitutes receiver key | SAS derived from cs (unknown to relay) and receiver_pub mismatches on screens | User ignores mismatch |
| Relay reads stored files | Content encrypted under CEK; CEK only in HPKE wraps to device keys | None for content; metadata per §12 |
| Relay injects a device into a contact's identity | Sigchain links require valid device signatures; clients verify full chain and pin fingerprint | Compromise of a user's device |
| Network attacker on live transfer | Signed signaling binds DTLS fingerprints; Envelope encryption end-to-end | None for content |
| Optical eavesdropper (Air-gap secure) | Stream is ciphertext; CEK wrapped to receiver key captured before streaming | Visual SAS skipped by users |
| Optical eavesdropper (Broadcast) | By design anyone in view decrypts; explicit warning | Intended |
| Spoofed Broadcast publisher | Publisher signatures and pinned or fetched chains | Unverified broadcasts shown as unsigned |
| Lost device, locked | Keys gated by biometric/passcode; hardware non-exportable | OS-level exploits |
| Lost device, unlocked | Unwrap still requires biometric per transfer; remote revoke via sigchain | Files already exported |
| Long-term key compromise | OPKs give forward secrecy for stored Paired deliveries; Direct uses per-transfer ephemeral sender keys | Unconsumed MPK window (≤ 14 days) |
| Malicious Envelope (parser attack) | Rust core, fuzzed parsers, strict path validation | Unknown bugs; audited |
| Malicious frame (decoder attack) | Bounded buffers, fuzzed decoder, GPU kernels with fixed-size outputs | Unknown bugs |
| Downgrade to weaker tier or mode | Mode and tier carried in signed or SAS-bound data; clients refuse Base wraps from pinned contacts | None identified |
| Abuse distribution | No public links, sender accounts, limits, receiver reports (ADR-0015) | Cannot scan encrypted content |
| Harvest-now-decrypt-later (quantum) | Short TTLs; KEM agility for hybrid PQ (planned ADR-0016) | P-256 wraps on stored data until PQ hybrid ships |

## 11.4 Security assurance

- External cryptographic design review before public beta; full penetration test and code audit of core, relay and clients before general availability; annual thereafter.
- Public bug bounty at launch.
- Reproducible builds for web bundles; published hashes of the WASM core per release.

# 12. Privacy and metadata

| Data | Relay sees | Retention |
|---|---|---|
| File contents, names, types, counts | No | — |
| Ciphertext size | Bucketed (§8.3) | Transfer TTL |
| Sender account | Yes | Account lifetime |
| Receiver identity (Direct/Room) | Device public key hash and self-declared label | Transfer TTL |
| Paired relationships | Delivery events between identity fingerprints | Mailbox TTL; aggregates only after |
| IP addresses | Hashed with daily rotating key | 7 days unless abuse report |
| Timestamps | Rounded to the hour in logs | 90 days |
| Contact lists | No (encrypted sync blob) | — |

Sealed publishes a transparency report semi-annually and a plain-language statement of what it can and cannot produce in response to legal process.

# 13. Performance targets

| Metric | Target |
|---|---|
| Code displayed after tapping Share (≤ 50 MB selection) | ≤ 400 ms p50 |
| Scan to approval prompt on sender (LTE) | ≤ 1.5 s p50, ≤ 3 s p95 |
| Approval to first byte on receiver | ≤ 800 ms p50 |
| Direct download throughput | ≥ 90% of measured link throughput |
| Facet goodput (corpus median) | T1 ≥ 50 KB/s (gate), T2 ≥ 90 KB/s, T3 ≥ 200 KB/s |
| Facet time to first verified segment | ≤ 1 s after calibration lock + segment time |
| Relay availability | 99.9% monthly |
| Web WASM core size | ≤ 1.5 MB gzipped |
| Receiver memory (Facet, native) | ≤ 400 MB peak |

# 14. Verification plan

## 14.1 Test pyramid

| Layer | Tooling | Scope |
|---|---|---|
| Unit | `cargo test`, Vitest, XCTest, JUnit | functions and state machines |
| Property | `proptest` | Envelope round trips, chain verification, mode resolution |
| Vectors | JSON golden files | HPKE, SAS, sigchain, Envelope, Facet frames |
| Fuzz | `cargo-fuzz` (libFuzzer) | frame parser, CBOR, Envelope, sigchain, decoder |
| Integration | Miniflare / `workerd` + Playwright | relay + web client end to end |
| Device | device farm (iOS, Android) | keys, capture, interop |
| Corpus | recorded captures | Facet goodput and regressions |
| Security | external audit, bug bounty | whole system |

Each ADR names its paired test suite; an ADR is not *Accepted* in code until its suite exists and passes.

## 14.2 Cryptographic vectors

The repository holds `vectors/hpke.json` (CFRG set for suite 0x0010/0x0001/0x0002), `vectors/sas.json`, `vectors/sigchain.json`, `vectors/envelope/` and `vectors/facet/`. All bindings (Rust, WASM, Swift, Kotlin) run the same vectors in CI.

## 14.3 End-to-end scenarios

Every mode has scripted scenarios covering: happy path, wrong SAS, deny, expiry, replay, network loss mid-transfer, relay restart, and (optical) partial capture with resume. Scenarios run nightly against the Cloudflare staging relay and the self-hosted Compose stack.

## 14.4 Optical capture corpus

- Launch target: ≥ 20 phone models (spanning 2019–2026, iOS and Android, low and high end) × ≥ 10 displays (laptop LCD and OLED, phone OLED, 4K monitor, projector, TV).
- Conditions: distance 15–60 cm (phones) and 1–5 m (projector), angles 0–35°, ambient light 50–5,000 lux, hand-held and tripod.
- Recording format: raw frames (YUV) with device metadata, stored with Git LFS; ground-truth stream definitions regenerate expected symbols.
- CI decodes a sampled subset on every change to `sealed-facet`; the full corpus runs nightly and publishes per-tier goodput distributions.

## 14.5 Release gates

| Gate | Requirement |
|---|---|
| Private beta | All P0 suites green; external crypto design review complete with no unresolved high findings |
| Public launch | Penetration test complete; bug bounty live; fuzzing ≥ 30 CPU-days with zero open crashes |
| Air-gap GA | M1 corpus gate met; Air-gap scenarios green on ≥ 15 devices |
| FIPS build | Builds against AWS-LC FIPS module; algorithm self-tests pass |

# 15. Repository and tooling

## 15.1 Layout

```
sealed/
├── crates/
│   ├── sealed-crypto/       HPKE suite, STREAM, signatures, SAS
│   ├── sealed-envelope/     manifest CBOR, segmentation, padding
│   ├── sealed-protocol/     sans-IO state machines (claim, pairing, delivery)
│   ├── sealed-identity/     sigchain types and verification
│   ├── sealed-facet/        encoder, decoder, WGSL kernels, FEC
│   └── sealed-ffi/          UniFFI and wasm-bindgen surfaces
├── packages/
│   ├── core-wasm/           @sealed/core (TypeScript wrapper)
│   └── tokens/              design tokens shared by web and native
├── apps/
│   ├── web/                 Vite + React + TypeScript
│   ├── ios/                 SwiftUI app + SealedKit
│   └── android/             Kotlin + Compose app
├── services/
│   └── relay/               Workers (Hono), Durable Objects, D1 migrations
├── deploy/
│   └── selfhost/            docker-compose.yml, workerd config, MinIO, coturn
├── vectors/                 golden test vectors
├── corpus/                  optical captures (Git LFS)
├── docs/                    adr/, spec/
├── Taskfile.yml
└── .env.example
```

## 15.2 Taskfile targets

| Task | Action |
|---|---|
| `task setup` | install Rust toolchain targets, wasm-pack, pnpm, uniffi-bindgen; copy `.env.example` |
| `task install` | `pnpm install` and `cargo fetch` |
| `task typecheck` | `cargo check --workspace --all-targets`, `pnpm -r typecheck` |
| `task test` | Rust, TypeScript, vectors; `task test:device` and `task test:corpus` separately |
| `task fuzz` | run fuzz targets for a configurable duration |
| `task dev` | relay in `wrangler dev`, web app in Vite, WASM in watch mode |
| `task db:migrate` / `task db:reset` | apply or reset D1 migrations locally and in staging |
| `task up` / `task down` | full self-hosted stack via Docker Compose (workerd, MinIO, SQLite/Postgres, coturn) |
| `task build` | release builds for web, WASM, relay; `task build:ios` and `task build:android` on capable hosts |
| `task bench:facet` | synthetic channel and corpus benchmarks with per-tier report |

## 15.3 Environment variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Cloudflare deploys |
| `R2_BUCKET` | ciphertext bucket name |
| `D1_DATABASE_ID` | metadata database |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Realtime TURN credential issuance |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | passkey relying party |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` | iOS push |
| `FCM_SERVICE_ACCOUNT_JSON` | Android push |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_PICKER_API_KEY` | Drive Picker (client-side) |
| `SELFHOST_S3_ENDPOINT`, `SELFHOST_S3_KEY`, `SELFHOST_S3_SECRET` | self-hosted object storage |

# 16. Milestones

| Milestone | Month | Exit criteria |
|---|---|---|
| M0 Foundations | 1 | Repo, CI, Taskfile, vectors scaffold; crypto and Envelope crates passing vectors |
| M1 Facet gate | 3 | T0 + T1 encoder/decoder; initial corpus (8 phones × 5 displays); T1 ≥ 50 KB/s median or revised tiers |
| M2 Private beta | 6 | Direct and Paired on web, iOS, Android; relay on Cloudflare; external crypto design review |
| M3 Public launch | 9 | Room; Google Drive source; bug bounty; pen test complete |
| M4 Teams + Air-gap beta | 12 | Teams plan (admin, policies, SSO); Air-gap secure T1/T2; Broadcast with publisher signatures |
| M5 Government readiness | 15 | Self-hosted relay; FIPS build; first government or regulated pilot |
| M6 Seed readiness | 18 | T3 on supported devices; growth and revenue metrics per the operating plan |

# 17. Open questions

1. Final Facet palette and glyph set (resolved by corpus optimization at M1).
2. Whether T3's 144-cell grid or a 128-cell grid at higher fps yields better goodput on mid-range devices.
3. PRF-extension adoption on web for stronger web device keys (ADR-0005).
4. Post-quantum hybrid KEM choice and timing (planned ADR-0016).
5. Teams group model on MLS (planned ADR-0017) versus fan-out wraps for small teams.
6. Accreditation path for the self-hosted relay and optical channel in classified environments (planned ADR-0018), including whether an optical one-way transfer can be presented within existing cross-domain policy frameworks.
