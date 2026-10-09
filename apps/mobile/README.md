# Sealed mobile (iOS and Android)

Expo SDK 57 / React Native 0.86, expo-router, TypeScript. Every mode from the spec:

| Mode | Screens |
| --- | --- |
| Direct and Room share | `app/share.tsx` — code, live claims with check codes, approve each / in batches / auto-approve |
| Receive (claim) | `app/receive.tsx` → `app/c/[transferId].tsx` — scan, check code, download, files stored encrypted |
| Paired | `app/p.tsx` (pairing ceremony), `app/contacts/*` (send, live WebRTC with mailbox fallback), `app/inbox.tsx` |
| Identity | `app/welcome.tsx` (create / join / paper-key restore), `app/devices.tsx`, `app/d.tsx` (add a device) |
| Air-gap | `app/offline/send.tsx` (scan key code, stream), `app/offline/receive.tsx` (show key code, capture) |
| Broadcast | `app/broadcast/index.tsx`, `app/broadcast/receive.tsx` |

## How it differs from the web client

- **Device keys in hardware.** `modules/sealed-keystore` is a local Expo module (Swift: Secure Enclave via
  CryptoKit + LocalAuthentication; Kotlin: Android Keystore with StrongBox when present, BiometricPrompt).
  Keys are non-exportable P-256, gated by Face ID / fingerprint (or passcode, per policy). `src/lib/native-keys.ts`
  adapts them to core's `AgreementKey` / `SigningKey`. Signing reuses a 5-minute authenticated window;
  approvals, adding/revoking devices and paper keys always prompt (`fresh`).
- **Approvals use device UV.** The relay accepts `{kind:"device"}` user verification from hardware-protected
  keys, so a phone approves with Face ID instead of a passkey.
- **Files at rest are encrypted.** Each received file is re-encrypted as it arrives (AES-256-GCM, 1 MiB
  chunks) under a per-file key wrapped to the hardware agreement key (`src/lib/received.ts`). Opening one
  prompts once, decrypts into a temporary copy for the share sheet, and deletes the copy.
- **Local state is encrypted.** Profile, settings, contacts and prekeys live in AES-GCM-sealed files keyed
  from the Keychain / Keystore (`src/lib/storage.ts`).
- **Codes never enter navigation state.** Universal links / app links and in-app scans stash the code in
  memory (`src/lib/code-stash.ts`, `app/+native-intent.tsx`); routes carry only an opaque `?ref=`.
- **Optical.** VisionCamera 5 delivers raw RGB frames to a worklet, which copies the buffer to JS while a
  cross-runtime flag drops frames during decode (`src/components/OpticalCapture.tsx`). Streams are drawn with
  Skia, refresh-counted, at full brightness with the screen kept awake (`src/components/FacetStream.tsx`).
- **Push.** The relay sends silent APNs / FCM pushes with only a transfer id; a background task posts a
  local "Files are waiting" notification (`src/lib/push.ts`).

## Run

```sh
pnpm install                       # from the repo root
cp apps/mobile/.env.example apps/mobile/.env   # set EXPO_PUBLIC_RELAY_URL to your relay
pnpm --filter @sealed/relay dev    # local relay on :8787
cd apps/mobile
npx expo prebuild                  # generates ios/ and android/ (not committed)
npx expo run:ios --device          # or: npx expo run:android --device
```

A development build is required (Expo Go lacks the native modules). Use a physical device: simulators have
no camera, and the iOS simulator has no Secure Enclave (keys fall back to software and cannot approve).

Universal links need the web origin to serve `/.well-known/apple-app-site-association` and
`/.well-known/assetlinks.json` naming this app's team / package and signing certificate (see
`apps/web/public/.well-known/`).

## Checks

```sh
pnpm --filter @sealed/mobile typecheck
pnpm --filter @sealed/mobile test        # vitest: storage, at-rest encryption, keys, routing, optical decode
npx expo-doctor
npx expo export --platform ios --platform android   # full Metro/Hermes bundle of both platforms
```

The unit tests run in Node with in-memory stand-ins for Expo modules (`test/mocks`). The optical test feeds
Facet frames laid out the way the camera delivers them (BGRA, padded, upscaled) through the same conversion
and decoder the app uses.

## Known limitations

- The Swift and Kotlin keystore code has not been compiled in this repository's CI (no Xcode / Android SDK
  there); build it once on a Mac and on Android before shipping.
- Facet decoding runs in JavaScript on the JS thread (~0.5–0.8 s per frame in Node, slower on Hermes), so a
  phone receives optical streams far below the spec's target rates. The app reports T1 until it has measured
  itself, then picks the tier from the measurement. A native decoder is the planned fix (ADR-0016).
- Expo pins TypeScript ~6.0 for SDK 57; the monorepo stays on 5.9.3 (`expo.install.exclude`).
