# Sealed

Show a code. Hand over a file. End-to-end encrypted file transfer between people in the same room, between
paired contacts anywhere, and — with no network at all — through a screen and a camera.

| Mode | What it is for |
| --- | --- |
| **Direct** | Hand files to the person in front of you: they scan your code, you both see the same check code, you approve. |
| **Room** | The same code on a projector; everyone in the room gets their own copy, encrypted to their device. |
| **Paired** | Pair once in person; afterwards send to each other from anywhere — live over WebRTC, or stored in their inbox. |
| **Air-gap** | No network: the receiver shows a key code, the sender's screen streams the file as coloured frames only that device can open. |
| **Broadcast** | No network, open by design: a looping stream anyone in view can receive, optionally signed. |

The relay never sees file names, contents or keys. Device keys are hardware-backed on phones (Secure Enclave,
Android Keystore) and non-exportable WebCrypto keys in browsers.

## Repository

```
packages/core      @sealed/core — crypto (HPKE RFC 9180, P-256, AES-GCM STREAM), Envelope, identity sigchain,
                   protocols (claim/approve, pairing, prekeys, live signaling), RaptorQ + Reed–Solomon,
                   Facet optical codec. Isomorphic TypeScript, used by everything below.
packages/tokens    Design tokens shared by web and mobile.
services/relay     Cloudflare Workers relay (Hono, Durable Objects, R2, D1) + Docker self-host (Miniflare).
apps/web           Web client (Vite, React 19): every mode, passkeys, WebRTC, optical send/receive.
apps/mobile        iOS + Android (Expo SDK 57): every mode, hardware keys, encrypted storage, push.
docs/spec          Technical specification.
docs/adr           Architecture decision records (0016 lists where the implementation departs from the spec).
docs/whitepaper    White paper.
deploy/selfhost    Self-hosted relay (docker compose).
tools/fec-vectors  Rust harness that produces RaptorQ parity vectors.
```

## Quick start

Requirements: Node ≥ 22, pnpm 10 (`corepack enable`). Optional: [go-task](https://taskfile.dev).

```sh
pnpm install
pnpm --filter @sealed/relay dev        # relay on http://localhost:8787 (local D1/R2/DO via wrangler)
pnpm --filter @sealed/web dev          # web client on http://localhost:5173
```

Open the web client in two browsers (or a browser and a phone on the same network) to try Direct, Room,
Paired and the offline modes. For the phone app see [`apps/mobile/README.md`](apps/mobile/README.md); it needs a
development build on a physical device.

Self-hosting the relay:

```sh
cp deploy/selfhost/.env.example deploy/selfhost/.env
docker compose -f deploy/selfhost/docker-compose.yml up -d --build
curl http://localhost:8787/v1/health
```

## Checks

```sh
pnpm -r typecheck
pnpm -r test                            # core, relay, web and mobile unit tests
pnpm --filter @sealed/web e2e           # Playwright: every mode across two browser contexts
cd apps/mobile && npx expo export --platform ios --platform android
```

or `task check`.

## Status and limitations

This is a first, complete implementation of the specification, not yet production-hardened. Read
[ADR-0016](docs/adr/0016-implementation-deviations.md) before relying on it. In short:

- **Optical modes are slow.** Facet decoding runs in JavaScript on the CPU (~0.5–0.8 s per captured frame in
  Node, slower on phones). Air-gap and Broadcast work end to end, but at a fraction of the spec's data rates
  until a native or GPU decoder replaces it.
- **Native keystore code is unbuilt here.** The Swift and Kotlin modules were written without Xcode or the
  Android SDK available; build and test them on real devices first.
- **No independent security audit yet.** The cryptography uses audited libraries and passes published test
  vectors, but the protocol composition has only been reviewed internally.
- Contacts do not sync between a person's devices yet; paper keys are base32 text rather than words.

## Licence

Proprietary — all rights reserved, until a licence is chosen.
